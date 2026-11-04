#!/usr/bin/env node
/** Verify the current public npm release through npx on every CI OS/Node entry. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'depvitals@latest';
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?\n$/;

/** npx.cmd needs cmd.exe; all arguments are fixed options or task-owned paths. */
function runNpx(args, options) {
  const spawnOptions = {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 90_000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  };
  if (process.platform === 'win32') {
    const command = ['npx.cmd', ...args].map((value) => `"${value}"`).join(' ');
    return spawnSync(command, { ...spawnOptions, shell: true });
  }
  return spawnSync('npx', args, spawnOptions);
}

function snapshot(directory) {
  const entries = [];
  function walk(current) {
    for (const item of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(current, item.name);
      entries.push([path, item.isDirectory() ? 'directory' : readFileSync(path).toString('hex')]);
      if (item.isDirectory()) walk(path);
    }
  }
  walk(directory);
  return entries;
}

/** The injected runner keeps regular tests offline; CI uses the real npx process. */
export function verifyPublishedNpx(execute = runNpx) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals npx smoke-')));
  const consumer = join(root, 'consumer');
  const cache = join(root, 'npm-cache');
  const clean = join(consumer, 'clean');
  const findings = join(consumer, 'findings');
  const invalid = join(consumer, 'invalid');
  const env = { ...process.env };
  // npm exec also exposes local bins. Remove inherited pnpm/npm project-bin entries.
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const inheritedPath = pathKeys.map((key) => env[key] ?? '').join(delimiter);
  for (const key of pathKeys) delete env[key];
  Object.assign(env, {
    PATH: inheritedPath
      .split(delimiter)
      .filter((entry) => !/[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry))
      .join(delimiter),
    CI: '1',
    DEPVITALS_NO_UPDATE_CHECK: '1',
    npm_config_cache: cache,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_loglevel: 'error',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_fetch_timeout: '30000',
    npm_config_fetch_retries: '1',
  });

  try {
    for (const directory of [consumer, clean, findings, invalid]) {
      mkdirSync(directory, { recursive: true });
    }
    // A neutral project stops npm looking up the checkout's package/local executables.
    writeFileSync(join(consumer, 'package.json'), '{"name":"npx-consumer","private":true}');
    const marker = join(consumer, 'TARGET_CODE_WAS_EXECUTED');
    writeFileSync(
      join(clean, 'package.json'),
      JSON.stringify({
        dependencies: { 'smoke-used': '1' },
        scripts: { preinstall: 'node lifecycle.cjs' },
      }),
    );
    writeFileSync(
      join(clean, 'lifecycle.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\n`,
    );
    writeFileSync(
      join(clean, 'index.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');\nrequire('smoke-used');\n`,
    );
    writeFileSync(
      join(findings, 'package.json'),
      JSON.stringify({
        dependencies: { 'smoke-unused': '1' },
        devDependencies: { 'smoke-unused-tool': '1' },
      }),
    );
    writeFileSync(join(findings, 'index.cjs'), "require('smoke-missing');\n");
    writeFileSync(join(invalid, 'package.json'), '{');
    const before = snapshot(consumer);

    function invoke(label, args, status) {
      const result = execute(['--yes', `--package=${PACKAGE}`, 'depvitals', ...args], {
        cwd: consumer,
        env,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null, `${label}: process terminated by a signal`);
      assert.equal(result.status, status, `${label}: ${result.stderr || result.stdout}`);
      return {
        stdout: (result.stdout ?? '').replaceAll('\r\n', '\n'),
        stderr: (result.stderr ?? '').replaceAll('\r\n', '\n'),
      };
    }

    const version = invoke('version', ['--version'], 0);
    assert.match(version.stdout, VERSION, 'npx must print the resolved package version');
    assert.equal(version.stderr, '');
    console.log(`Published npx smoke: ${PACKAGE} resolved to ${version.stdout.trim()}`);
    console.log(`Runtime: ${process.platform}/${process.arch} ${process.version}`);

    const help = invoke('help', ['--help'], 0);
    assert.match(help.stdout, /^DepVitals\n/);
    assert.match(help.stdout, /Usage:/);
    assert.equal(help.stderr, '');

    const cleanResult = invoke('clean scan', [clean], 0);
    assert.equal(cleanResult.stdout, 'DepVitals\n\nNo dependency issues found.\n');
    assert.equal(cleanResult.stderr, '');

    const findingsResult = invoke('findings scan', [findings], 1);
    assert.equal(
      findingsResult.stdout,
      'DepVitals\n\nUnused dependencies (1)\n  smoke-unused\n\n' +
        'Unused devDependencies (1)\n  smoke-unused-tool\n\n' +
        'Missing dependencies (1)\n  smoke-missing\n',
    );
    assert.equal(findingsResult.stderr, '');

    const error = invoke('invalid manifest', [invalid], 1);
    assert.equal(error.stdout, '');
    assert.equal(error.stderr, `${join(invalid, 'package.json')} is not valid JSON\n`);
    assert.deepEqual(
      snapshot(consumer),
      before,
      'npx/scanning must not mutate the consumer or targets',
    );
    console.log(
      'Published npx smoke passed: version, help, clean, findings, error and non-mutation.',
    );
    return { version: version.stdout.trim(), checks: 5 };
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyPublishedNpx();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
