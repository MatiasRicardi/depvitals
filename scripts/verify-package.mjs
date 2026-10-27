#!/usr/bin/env node
/**
 * Package consumer smoke test for the DepVitals `v0.1.0` CLI.
 *
 * It verifies the package exactly as an npm consumer receives it: it packs the real artifact,
 * inspects the tarball, installs the tarball into an isolated temporary project, and executes the
 * installed `depvitals` executable against two minimal, deterministic fixture projects so the smoke
 * test exercises the real dependency scanner end to end.
 *
 * Node.js standard library only. No runtime or dev dependency is added.
 *
 * Flow:
 *   create temp dir
 *     -> npm pack into temp dir
 *     -> inspect tarball contents
 *     -> create consumer temp project
 *     -> install the local tarball
 *     -> create clean and findings fixture projects
 *     -> invoke the installed CLI (help, version, clean scan, findings scan, errors)
 *     -> assert the fixtures were not mutated
 *     -> cleanup (always, even on failure)
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  'scripts/',
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
function run(command, args, cwd, env = process.env) {
  if (process.platform === 'win32') {
    const shellCommand = [command, ...args].map((value) => `"${value}"`).join(' ');

    return spawnSync(shellCommand, { encoding: 'utf8', cwd, env, shell: true, timeout: 120_000 });
  }

  return spawnSync(command, args, { encoding: 'utf8', cwd, env, timeout: 120_000 });
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
  return run(binPath, args, consumerDir, { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' });
}

function checkProductionImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      checkProductionImports(path);
    } else if (entry.name.endsWith('.js')) {
      const source = readFileSync(path, 'utf8');
      const imports = [
        ...source.matchAll(/^(?:import|export)\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/gm),
      ];
      const external = imports.find((match) => !/^(?:node:|\.\.?\/)/.test(match[1]));
      check(
        `production imports are internal or Node builtins: ${entry.name}`,
        !external,
        external?.[1],
      );
    }
  }
}

/**
 * Snapshot the contents of every file inside the given fixture directories, keyed by absolute
 * path, so a scan can be asserted to leave them byte-for-byte unchanged.
 */
function snapshotFixtures(dirs) {
  const snapshot = {};

  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      snapshot[join(dir, entry)] = readFileSync(join(dir, entry), 'utf8');
    }
  }

  return snapshot;
}

/**
 * Whether two fixture snapshots are identical: they track the same set of file paths and every
 * tracked file has identical contents. Comparing the complete before-and-after snapshots (rather
 * than only the files that still exist) detects modified, deleted, and newly created files.
 */
function snapshotsEqual(before, after) {
  const beforePaths = Object.keys(before);
  const afterPaths = Object.keys(after);

  // Different path counts mean a file was added or deleted.
  if (beforePaths.length !== afterPaths.length) {
    return false;
  }

  for (const path of afterPaths) {
    // A path missing from `before` (a new file) or with different contents (a modified file) is a
    // mutation; `before[path]` is `undefined` for a path absent from `before`.
    if (before[path] !== after[path]) {
      return false;
    }
  }

  return true;
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
    const installedRoot = join(consumerDir, 'node_modules', 'depvitals');
    const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    check(
      'installed manifest has no runtime or optional dependencies',
      installedManifest.dependencies === undefined &&
        installedManifest.optionalDependencies === undefined,
    );
    check(
      'consumer did not install development dependencies',
      readdirSync(join(consumerDir, 'node_modules'))
        .filter((name) => !name.startsWith('.'))
        .every((name) => name === 'depvitals'),
    );
    checkProductionImports(join(installedRoot, 'dist'));

    // 4. Create two minimal, deterministic fixture projects inside the consumer temp dir. They
    //    stand in for real scanned projects and keep the smoke test independent of the DepVitals
    //    repository fixtures or source tree.
    const cleanDir = join(consumerDir, 'smoke-clean');
    const findingsDir = join(consumerDir, 'smoke-findings');

    mkdirSync(cleanDir, { recursive: true });
    mkdirSync(findingsDir, { recursive: true });

    writeFileSync(
      join(cleanDir, 'package.json'),
      `${JSON.stringify({ name: 'smoke-clean', version: '0.0.0', dependencies: { lodash: '4.17.21' } }, null, 2)}\n`,
    );
    writeFileSync(
      join(cleanDir, 'index.js'),
      ["import { chunk } from 'lodash';", 'export const parts = chunk([1, 2], 2);', ''].join('\n'),
    );

    writeFileSync(
      join(findingsDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'smoke-findings',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', 'unused-dep': '1.0.0' },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(findingsDir, 'index.js'),
      [
        "import { chunk } from 'lodash';",
        "import { missing } from 'missing-pkg';",
        '',
        'export const parts = chunk([1, 2], 2);',
        'export const m = missing;',
        '',
      ].join('\n'),
    );

    const structuralDirs = [
      [
        'consecutive-fields',
        'index.cjs',
        `class C { a = () => 0
          b
          c
          *run() { yield /require('fake')/; require('real'); }
        }`,
      ],
      [
        'function-typed-field',
        'index.ts',
        `class C { callback!: (value: string) => void
          *run() { yield /require('fake')/; require('real'); }
        }`,
      ],
      [
        'multiplication-division',
        'index.cjs',
        `class C {
          value = (2 * require('real')) / 4;
          async run() { await /require('fake')/; require('real'); }
        }`,
      ],
    ].map(([name, fileName, source]) => {
      const directory = join(consumerDir, name);
      mkdirSync(directory);
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', dependencies: { real: '*' } }),
      );
      writeFileSync(join(directory, fileName), source);
      return directory;
    });
    const fixtureDirs = [cleanDir, findingsDir, ...structuralDirs];
    const before = snapshotFixtures(fixtureDirs);

    // 5. Invoke the installed executable.
    const binPath = resolveInstalledBin(consumerDir);
    check('installed executable exists', existsSync(binPath));

    console.log('\nValidating the installed CLI...');

    // Help and version keep working.
    const help = runInstalledCli(binPath, consumerDir, ['--help']);
    check('--help exits 0', help.status === 0);
    check('--help identifies DepVitals', help.stdout.includes('DepVitals'));
    check('--help shows usage', help.stdout.includes('Usage:'));
    check('--help lists the project argument', help.stdout.includes('depvitals [project]'));
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

    // A clean project scans with exit 0 and prints no findings, passed through an explicit
    // project-path argument rather than the current working directory.
    const clean = runInstalledCli(binPath, consumerDir, [cleanDir]);
    check('clean scan exits 0', clean.status === 0, `status=${clean.status}`);
    check(
      'clean scan reports no issues',
      clean.stdout === 'DepVitals\n\nNo dependency issues found.\n',
      JSON.stringify(clean.stdout),
    );
    check('clean scan leaves stderr empty', clean.stderr === '');

    // A project with findings scans with exit 1 and prints the report to stdout, passed through
    // an explicit project-path argument.
    const findings = runInstalledCli(binPath, consumerDir, [findingsDir]);
    check('findings scan exits 1', findings.status === 1, `status=${findings.status}`);
    check(
      'findings scan prints the report to stdout',
      findings.stdout ===
        'DepVitals\n\nUnused dependencies (1)\n  unused-dep\n\nMissing dependencies (1)\n  missing-pkg\n',
      JSON.stringify(findings.stdout),
    );
    check('findings scan leaves stderr empty', findings.stderr === '');

    for (const directory of structuralDirs) {
      const result = runInstalledCli(binPath, consumerDir, [directory]);
      check(`structural consumer exits 0: ${directory}`, result.status === 0, result.stderr);
      check(
        `structural consumer reports clean: ${directory}`,
        result.stdout === 'DepVitals\n\nNo dependency issues found.\n',
        result.stdout,
      );
      check(`structural consumer leaves stderr empty: ${directory}`, result.stderr === '');
    }

    // No-args scans the actual working directory.
    const noArgs = runInstalledCli(binPath, cleanDir, []);
    check('no-args scans cwd and exits 0', noArgs.status === 0);
    check(
      'no-args scans cwd with no issues',
      noArgs.stdout === 'DepVitals\n\nNo dependency issues found.\n',
    );

    // An invalid project path fails with exit 1 and a concise, path-identifying stderr message.
    const missingManifest = runInstalledCli(binPath, consumerDir, ['no-such-project']);
    check('invalid project path exits 1', missingManifest.status === 1);
    check(
      'invalid project path prints a concise error',
      missingManifest.stderr.includes('No package.json found at'),
    );
    check('invalid project path leaves stdout empty', missingManifest.stdout === '');

    // An unknown option still fails with a useful stderr message.
    const unknown = runInstalledCli(binPath, consumerDir, ['--scan']);
    check('unknown option exits non-zero', unknown.status !== 0);
    check(
      'unknown option prints a useful stderr message',
      unknown.stderr.includes('Unknown option') && unknown.stderr.includes('depvitals --help'),
    );

    // Capture the fixtures again after every scan, then compare the complete before-and-after
    // snapshots so added, deleted, and modified files are all detected.
    const after = snapshotFixtures(fixtureDirs);

    // The scanner must not mutate the fixtures it reads.
    check('scan does not mutate the fixtures', snapshotsEqual(before, after));

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
