import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../src/cli/entry.js';
import { parseCliArgs } from '../src/cli/parseCliArgs.js';
import { runCli } from '../src/cli/runCli.js';
import { collectUpdateNotice } from '../src/cli/notifier/updateCheck.js';
import { UPDATE_CACHE_FILE_NAME } from '../src/cli/notifier/updateCache.js';
import type { JsonReport } from '../src/reporters/jsonReporter.js';

const hint = "Run 'depvitals --help' for available commands.";
const cwd = resolve('/workspace');
const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/notifierFetchProbe.mjs', import.meta.url));

describe('format/explain argument grammar', () => {
  const parts = [['project'], ['--format', 'json'], ['--explain', '@Scope/Pkg']];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  it.each(orders)('accepts token ordering %j', (...order) => {
    const args = order.flatMap((index) => parts[index] ?? []);
    expect(parseCliArgs(args, cwd)).toEqual({
      kind: 'scan',
      projectPath: resolve(cwd, 'project'),
      format: 'json',
      explain: '@Scope/Pkg',
    });
  });
  it.each([
    [['--format', 'terminal'], { format: 'terminal' }],
    [['--format', 'json'], { format: 'json' }],
    [['--explain', 'fs'], { explain: 'fs' }],
    [['--explain', 'CasePkg'], { explain: 'CasePkg' }],
    [['--explain', 'a'.repeat(214)], { explain: 'a'.repeat(214) }],
  ] as const)('accepts exact values %j', (args, extra) => {
    expect(parseCliArgs(args, cwd)).toEqual({ kind: 'scan', projectPath: cwd, ...extra });
  });
  it.each([
    [['--format'], 'Option --format requires a value.'],
    [['--format', ''], 'Option --format requires a value.'],
    [['--format', '--explain', 'pkg'], 'Option --format requires a value.'],
    [['--explain'], 'Option --explain requires a value.'],
    [['--explain', ''], 'Option --explain requires a value.'],
    [['--explain', '-pkg'], 'Option --explain requires a value.'],
    [['--format', 'JSON'], 'Invalid value for --format: JSON. Expected terminal or json.'],
    [['--format', 'json', '--format', 'json'], 'Option --format may be specified only once.'],
    [['--explain', 'pkg', '--explain'], 'Option --explain may be specified only once.'],
    [['--format=json'], 'Unknown option: --format=json'],
    [['--explain=pkg'], 'Unknown option: --explain=pkg'],
    [['--json'], 'Unknown option: --json'],
    [['--why'], 'Unknown option: --why'],
    [['--'], 'Unknown option: --'],
    [
      ['--format', 'bad', '--unknown'],
      'Invalid value for --format: bad. Expected terminal or json.',
    ],
    [['--unknown', '--format', 'bad'], 'Unknown option: --unknown'],
    [['', 'other', '--format', 'json'], 'Too many arguments: expected at most one project path.'],
    [['--format', 'json', ''], 'Invalid project path: project path must not be empty.'],
    [['--format', 'json', '--help'], 'Option --help must be used alone.'],
    [['--explain', '--version'], 'Option --version must be used alone.'],
  ] as const)('rejects %j with the accepted precedence', (args, body) => {
    expect(parseCliArgs(args, cwd)).toEqual({ kind: 'error', message: body + '\n' + hint });
  });
  it.each(['pkg/sub', '@s/p/sub', 'pkg@1', '*', 'pkg\n', ' pkg', 'a'.repeat(215)])(
    'rejects non-root query %j',
    (name) => {
      expect(parseCliArgs(['--explain', name], cwd)).toEqual({
        kind: 'error',
        message:
          'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.\n' +
          hint,
      });
    },
  );
  it('escapes interpolated control characters in argument diagnostics', () => {
    expect(parseCliArgs(['--format', '\u001b[2J\n'], cwd)).toEqual({
      kind: 'error',
      message:
        String.raw`Invalid value for --format: \u001b[2J\u000a. Expected terminal or json.` +
        '\n' +
        hint,
    });
    expect(parseCliArgs(['--bad\r'], cwd)).toEqual({
      kind: 'error',
      message: String.raw`Unknown option: --bad\u000d` + '\n' + hint,
    });
  });
});

let scratch = '';
let root: string;
let broken: string;
let invalid: string;
const inputs = {
  'package.json': JSON.stringify({
    dependencies: { used: '1', prod: '1', dual: '1', excluded: '1' },
    devDependencies: { dev: '1', dual: '1' },
    peerDependencies: { peer: '1' },
    optionalDependencies: { optional: '1' },
  }),
  'index.cjs': "require('used'); require('missing');",
  'depvitals.config.json': '{"ignoreDependencies":["excluded","ignore-only"]}',
};
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-cli-formats-')));
  root = join(scratch, 'why');
  broken = join(scratch, 'broken');
  invalid = join(scratch, 'invalid');
  for (const dir of [root, broken, invalid]) await mkdir(dir);
  for (const [name, text] of Object.entries(inputs)) await writeFile(join(root, name), text);
  await writeFile(join(broken, 'package.json'), inputs['package.json']);
  await writeFile(join(broken, 'a.cjs'), "require('used');");
  await writeFile(join(broken, 'z.cjs'), '"unfinished');
  await writeFile(join(invalid, 'package.json'), '{}');
  await writeFile(join(invalid, 'depvitals.config.json'), '{ invalid');
});
afterAll(async () => {
  if (scratch === '') return;
  try {
    for (const [name, text] of Object.entries(inputs))
      expect(await readFile(join(root, name), 'utf8')).toBe(text);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
function child(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: scratch,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1', ...extraEnv },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('compiled format/query outcomes', () => {
  it('keeps why a project path and explicit terminal scan byte-compatible', () => {
    const legacy = child(['why']);
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toBe('');
    expect(child(['--format', 'terminal', 'why'])).toEqual(legacy);
    const json = child(['why', '--format', 'json']);
    const doc = JSON.parse(json.stdout) as JsonReport;
    expect(json.status).toBe(1);
    expect(json.stderr).toBe('');
    expect(doc.mode).toBe('scan');
    expect(doc.project.root).toBe(root);
    expect(doc.tool.version).toBe(version);
    expect(doc.findings).toEqual({
      unusedDependencies: ['dual', 'prod'],
      unusedDevDependencies: ['dev', 'dual'],
      missingDependencies: ['missing'],
    });
    expect(doc.counts).toEqual({
      unusedDependencies: 2,
      unusedDevDependencies: 2,
      missingDependencies: 1,
    });
    expect(doc.query).toBeNull();
    expect(doc.scope.ignoreDependencies).toEqual(['excluded', 'ignore-only']);
    expect(json.stdout).toBe(JSON.stringify(doc, null, 2) + '\n');
  });
  it.each([
    ['used', 'used', 0],
    ['prod', 'unused', 1],
    ['dev', 'unused', 1],
    ['dual', 'unused', 1],
    ['missing', 'missing', 1],
    ['excluded', 'excluded', 0],
    ['ignore-only', 'excluded', 0],
    ['peer', 'declared', 0],
    ['optional', 'declared', 0],
    ['absent', 'unknown', 1],
  ] as const)('projects %s as %s with exit %s in both formats', (name, status, exit) => {
    const human = child([root, '--explain', name]);
    expect(human.status).toBe(exit);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain(`Package: ${name}\nStatus: ${status}\n`);
    const json = child(['--explain', name, '--format', 'json', root]);
    expect(json.status).toBe(exit);
    expect(json.stderr).toBe('');
    const doc = JSON.parse(json.stdout) as JsonReport;
    expect(doc.mode).toBe('explain');
    expect(doc.packages).toHaveLength(1);
    expect(doc.packages[0]?.status).toBe(status);
    expect(doc.query).toEqual({ packageName: name, known: status !== 'unknown' });
    for (const values of Object.values(doc.findings))
      expect(values.every((value) => value === name)).toBe(true);
    expect(doc.counts).toEqual({
      unusedDependencies: doc.findings.unusedDependencies.length,
      unusedDevDependencies: doc.findings.unusedDevDependencies.length,
      missingDependencies: doc.findings.missingDependencies.length,
    });
    if (name === 'used')
      expect(doc.findings).toEqual({
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
  });
  it.each(['terminal', 'json'])(
    'preserves operational failure channels for %s scans/queries',
    (format) => {
      for (const path of [broken, invalid, join(scratch, 'missing')])
        for (const query of [[], ['--explain', 'used']]) {
          const result = child([path, '--format', format, ...query]);
          expect(result.status).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).not.toBe('');
        }
    },
  );
  it('handles no-path JSON clean scan and standalone meta without reading invalid config', async () => {
    const clean = join(scratch, 'clean');
    await mkdir(clean);
    await writeFile(join(clean, 'package.json'), '{}');
    const result = await runCli(['--format', 'json'], { cwd: clean, version: '7.8.9' });
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as JsonReport).tool.version).toBe('7.8.9');
    for (const args of [['--help'], ['--version']]) {
      const meta = await runCli(args, { cwd: invalid, version });
      expect(meta.exitCode).toBe(0);
      expect(meta.stderr).toBe('');
    }
  });
});

describe('entry suppresses the notifier before collaborator invocation', () => {
  it.each(['throw', 'stall', 'fresh-cache'] as const)(
    'makes zero collector/cache/transport calls with %s',
    async (behavior) => {
      const cache = join(scratch, 'cache-' + behavior);
      await mkdir(cache);
      const cachePath = join(cache, UPDATE_CACHE_FILE_NAME);
      const text = JSON.stringify({ latest: '999.0.0', checkedAt: 1234 });
      await writeFile(cachePath, text);
      const now = vi.fn(() => 1234);
      const fetchImpl = vi.fn(() => Promise.reject(new Error('No transport allowed')));
      const collector = vi.fn((request: Parameters<typeof collectUpdateNotice>[0]) => {
        if (behavior === 'throw') throw new Error('No collector allowed');
        if (behavior === 'stall')
          return new Promise<string | undefined>(() => {
            /* A deliberately stalled collaborator must never be invoked. */
          });
        return collectUpdateNotice(request, { cacheDir: cache, now, fetchImpl });
      });
      const cases = [
        ['--help'],
        ['--version'],
        ['--unknown'],
        ['--format'],
        [broken],
        [invalid],
        [root, '--format', 'json'],
        [root, '--format', 'json', '--explain', 'used'],
        [root, '--explain', 'prod'],
        [root, '--explain', 'absent'],
        [broken, '--format', 'json', '--explain', 'used'],
      ];
      for (const args of cases) {
        const out: string[] = [];
        const err: string[] = [];
        const baseline = await runCli(args, { cwd: root, version });
        const code = await runCliEntry(args, {
          cwd: root,
          version,
          env: {},
          stdout: { isTTY: true, write: (value) => out.push(value) },
          stderr: { isTTY: true, write: (value) => err.push(value) },
          updateNotice: collector,
        });
        expect(code).toBe(baseline.exitCode);
        expect(out.join('')).toBe(baseline.stdout);
        expect(err.join('')).toBe(baseline.stderr);
      }
      expect(collector).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(cachePath, 'utf8')).toBe(text);
    },
  );
  it('preserves the optional notice for completed explicit terminal scans', async () => {
    const collect = vi.fn(() => Promise.resolve('notice\n'));
    const err: string[] = [];
    const code = await runCliEntry([root, '--format', 'terminal'], {
      cwd: root,
      version,
      env: {},
      stdout: { isTTY: true, write: () => undefined },
      stderr: { isTTY: true, write: (s) => err.push(s) },
      updateNotice: collect,
    });
    expect(code).toBe(1);
    expect(err).toEqual(['notice\n']);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]).toEqual([
      { commandKind: 'scan', currentVersion: version, env: {}, stdoutTTY: true, stderrTTY: true },
    ]);
  });
  it('leaves compiled forced-TTY JSON/query runs free of cache/transport work', () => {
    const marker = join(scratch, 'network.log');
    const cache = join(scratch, 'isolated-cache');
    for (const args of [
      [root, '--format', 'json'],
      [root, '--explain', 'used'],
      [root, '--format', 'json', '--explain', 'absent'],
      [broken, '--format', 'json'],
    ]) {
      const result = child(args, {
        NODE_OPTIONS: '--import=' + pathToFileURL(probe).href,
        DEPVITALS_NO_UPDATE_CHECK: '0',
        DEPVITALS_TEST_FORCE_TTY: '1',
        DEPVITALS_TEST_REQUEST_FILE: marker,
        XDG_CACHE_HOME: cache,
        LOCALAPPDATA: cache,
      });
      expect(result.stderr).not.toContain('New DepVitals');
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });
});
