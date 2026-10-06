#!/usr/bin/env node
/**
 * Package consumer smoke test for the DepVitals `v0.0.1` CLI bootstrap.
 *
 * This does not run a dependency scan. It verifies the package exactly as an npm consumer receives
 * it: it packs the real artifact, inspects the tarball, installs the tarball into an isolated
 * temporary project, and executes the installed `depvitals` executable.
 *
 * Node.js standard library only. No runtime or dev dependency is added.
 *
 * Flow:
 *   create temp dir
 *     -> npm pack into temp dir
 *     -> inspect tarball contents
 *     -> create consumer temp project
 *     -> install the local tarball
 *     -> invoke the installed CLI
 *     -> assertions
 *     -> cleanup (always, even on failure)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(SCRIPT_PATH, '..', '..');

/** Required files that must be present inside the packaged `package/` tree. */
const REQUIRED_FILES = [
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/dist/cli/index.js',
];

/** Development-only trees that must never enter the published package. */
const FORBIDDEN_PREFIXES = [
  'src/',
  'test/',
  '.github/',
  'instructions/',
  'coverage/',
  'node_modules/',
];

/**
 * Signal a verification failure by throwing, so control unwinds through the caller's finally block
 * and temporary directories are always cleaned up before the process reports a nonzero exit code.
 */
function fail(message) {
  console.error(`\n\u2716 ${message}\n`);
  throw new Error(message);
}

/**
 * Run a command and return the raw spawn result.
 *
 * On Windows npm and the installed CLI are `.cmd` shims, which need to be launched through a shell
 * with quoted paths. Everywhere else the command runs directly.
 */
function run(command, args, cwd) {
  if (process.platform === 'win32') {
    const shellCommand = [command, ...args].map((value) => `"${value}"`).join(' ');

    return spawnSync(shellCommand, { encoding: 'utf8', cwd, shell: true });
  }

  return spawnSync(command, args, { encoding: 'utf8', cwd });
}

let checksPassed = 0;

/**
 * Record a single assertion. Failing an assertion aborts the verifier immediately.
 */
function check(label, condition, detail) {
  if (condition) {
    checksPassed += 1;
    console.log(`  \u2713 ${label}`);
    return;
  }

  fail(`${label}${detail ? ` (${detail})` : ''}`);
}

/**
 * Read a null-terminated C string from a buffer at the given offset and length.
 */
function readCString(buffer, start, length) {
  let end = start;
  while (end < start + length && end < buffer.length && buffer[end] !== 0) {
    end += 1;
  }

  return buffer.subarray(start, end).toString('utf8').replace(/\s+$/, '');
}

/**
 * Parse an octal field from a tar header (returns 0 for empty/invalid values).
 */
function parseOctal(value) {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return 0;
  }

  return parseInt(trimmed, 8) || 0;
}

/**
 * List every entry name inside a `.tgz` tarball using only the Node.js standard library.
 *
 * Node ships no tar reader, so the gzip stream is decompressed with `zlib` and the classic ustar
 * headers are parsed manually. All entry names in an npm tarball are prefixed with `package/`.
 */
function listTarballEntries(tarballPath) {
  const names = [];
  const tar = gunzipSync(readFileSync(tarballPath));
  const block = 512;
  let offset = 0;

  while (offset + block <= tar.length) {
    const header = tar.subarray(offset, offset + block);

    let allZero = true;

    for (let i = 0; i < block; i += 1) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }

    if (allZero) {
      break;
    }

    const name = readCString(header, 0, 100);
    const typeflag = header[52];
    const size = parseOctal(readCString(header, 24, 12));
    const dataBlocks = Math.ceil(size / block) * block;

    // Skip pax extended/global headers: they carry metadata for the following real entry.
    const isPaxHeader =
      name.startsWith('././@PaxHeader') ||
      name === 'pax_global_header' ||
      typeflag === 88 || // 'x' extended header
      typeflag === 103; // 'g' global header

    if (name.length > 0 && !isPaxHeader) {
      names.push(name);
    }

    offset += block + dataBlocks;
  }

  return names;
}

/**
 * Resolve the installed executable path in a cross-platform way.
 */
function resolveInstalledBin(consumerDir) {
  const binName = process.platform === 'win32' ? 'depvitals.cmd' : 'depvitals';

  return join(consumerDir, 'node_modules', '.bin', binName);
}

const tempDirs = [];

/**
 * Create a tracked temporary directory that is always removed at the end.
 */
function makeTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `depvitals-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run the installed CLI executable against the given arguments.
 */
function runInstalledCli(binPath, consumerDir, args) {
  return run(binPath, args, consumerDir);
}

function main() {
  const rootVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  console.log('DepVitals package consumer smoke test');
  console.log(`Root package version: ${rootVersion}\n`);

  const tempDir = makeTempDir('package');

  try {
    // 1. Pack the real artifact into the temporary directory.
    console.log('Packing the package...');
    const pack = run('npm', ['pack', '--json', '--pack-destination', tempDir], ROOT);

    if (pack.status !== 0) {
      fail(`npm pack failed.\n${pack.stderr || pack.stdout}`);
    }

    let packed;

    try {
      packed = JSON.parse(pack.stdout.trim())[0];
    } catch {
      fail(`Could not parse "npm pack --json" output.\n${pack.stdout || pack.stderr}`);
    }

    if (!packed || !packed.filename) {
      fail(`No tarball metadata returned by "npm pack --json".\n${pack.stdout}`);
    }

    const tarballPath = join(tempDir, packed.filename);

    if (!existsSync(tarballPath)) {
      fail(`Tarball was not created at ${tarballPath}`);
    }

    console.log(`  packed ${packed.filename} (${packed.version})`);

    // 2. Inspect the tarball contents.
    console.log('\nChecking tarball contents...');
    let entries;

    try {
      entries = listTarballEntries(tarballPath);
    } catch (error) {
      fail(`Could not read tarball entries: ${error.message}`);
    }

    for (const required of REQUIRED_FILES) {
      check(`contains ${required}`, entries.includes(required));
    }

    const forbidden = entries.find((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(`package/${prefix}`)),
    );

    check('rejects development-only content', forbidden === undefined, forbidden);

    // 3. Install the tarball into an isolated consumer project.
    console.log('\nInstalling the tarball into an isolated consumer...');
    const consumerDir = makeTempDir('consumer');

    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify({ name: 'depvitals-consumer', version: '1.0.0' }, null, 2)}\n`,
    );

    const install = run('npm', ['install', '--no-audit', '--no-fund', tarballPath], consumerDir);

    if (install.status !== 0) {
      fail(`npm install of the tarball failed.\n${install.stderr || install.stdout}`);
    }

    check(
      'installed depvitals from the local tarball',
      existsSync(join(consumerDir, 'node_modules', 'depvitals', 'package.json')),
    );

    // 4. Invoke the installed executable.
    const binPath = resolveInstalledBin(consumerDir);
    check('installed executable exists', existsSync(binPath));

    console.log('\nValidating the installed CLI...');

    const noArgs = runInstalledCli(binPath, consumerDir, []);
    check('no-args exits 0', noArgs.status === 0);
    check('no-args identifies DepVitals', noArgs.stdout.includes('DepVitals'));
    check(
      'no-args reports the early-development release',
      noArgs.stdout.includes('Early development release.'),
    );
    check('no-args does not claim scanning works', !/scan|unused|missing/i.test(noArgs.stdout));

    const help = runInstalledCli(binPath, consumerDir, ['--help']);
    check('--help exits 0', help.status === 0);
    check('--help identifies DepVitals', help.stdout.includes('DepVitals'));
    check('--help shows usage', help.stdout.includes('Usage:'));
    check(
      '--help lists the supported flags',
      help.stdout.includes('-h, --help') && help.stdout.includes('-v, --version'),
    );

    const version = runInstalledCli(binPath, consumerDir, ['--version']);
    check('--version exits 0', version.status === 0);
    check(
      '--version matches the root package version',
      version.stdout.trim() === rootVersion,
      `${version.stdout.trim()} !== ${rootVersion}`,
    );

    const unknown = runInstalledCli(binPath, consumerDir, ['--scan']);
    check('unknown option exits non-zero', unknown.status !== 0);
    check(
      'unknown option prints a useful stderr message',
      unknown.stderr.includes('Unknown option') && unknown.stderr.includes('depvitals --help'),
    );

    console.log(`\nAll ${checksPassed} checks passed.`);
  } catch (error) {
    // The finally block below already removed the temporary directories; just report the failure.
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  // Any unexpected throw still cleans up via main()'s finally and reports failure.
  console.error(error.message);
  process.exitCode = 1;
}
