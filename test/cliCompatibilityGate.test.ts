import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JsonReport } from '../src/reporters/jsonReporter.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const env = { ...process.env, NODE_OPTIONS: '', DEPVITALS_NO_UPDATE_CHECK: '1' };
const categories = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'] as const;
const clean = 'DepVitals\n\nNo dependency issues found.\n';
const findingsTerminal = [
  'DepVitals',
  '',
  'Unused dependencies (1)',
  '  unused',
  '',
  'Unused devDependencies (2)',
  '  rejected',
  '  unused',
  '',
  'Missing dependencies (1)',
  '  missing',
  '',
].join('\n');
const packageEvidence = {
  kind: 'script',
  file: 'package.json',
  pointer: '/scripts/check',
  command: 'preload/register',
  via: 'node-preload',
  occurrence: 1,
};
const missingEvidence = {
  kind: 'source',
  file: 'index.cjs',
  reference: 'require',
  specifier: 'missing',
  position: { offset: 8, line: 1, column: 9 },
};
const cases = [
  {
    name: 'preload',
    status: 'used',
    groups: ['devDependencies'],
    evidence: [packageEvidence],
    keys: [],
    exit: 0,
  },
  {
    name: 'peer',
    status: 'declared',
    groups: ['peerDependencies'],
    evidence: [],
    keys: [],
    exit: 0,
  },
  { name: 'ignored', status: 'excluded', groups: [], evidence: [], keys: [], exit: 0 },
  {
    name: 'unused',
    status: 'unused',
    groups: ['dependencies', 'devDependencies'],
    evidence: [],
    keys: ['unusedDependencies', 'unusedDevDependencies'],
    exit: 1,
  },
  {
    name: 'missing',
    status: 'missing',
    groups: [],
    evidence: [missingEvidence],
    keys: ['missingDependencies'],
    exit: 1,
  },
  { name: 'Preload', status: 'unknown', groups: [], evidence: [], keys: [], exit: 1 },
] as const;

type Result = { status: number | null; stdout: string; stderr: string };
let scratch: string;
let root: string;

function write(path: string, data: string): void {
  writeFileSync(join(root, path), data);
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-cli-compatibility-')));
  root = join(scratch, 'why');
  mkdirSync(root);
  write(
    'package.json',
    JSON.stringify({
      dependencies: { unused: '1' },
      devDependencies: { preload: '1', rejected: '1', unused: '1' },
      peerDependencies: { peer: '1' },
      scripts: {
        check: 'node -r preload/register app.cjs',
        rollback: 'node -r rejected --unknown',
      },
    }),
  );
  write('depvitals.config.json', '{"ignoreDependencies":["ignored"]}');
  write('index.cjs', "require('missing');\n");
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function inputHash(): string {
  const entries = readdirSync(root, { withFileTypes: true, recursive: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return [path, entry.isDirectory() ? null : readFileSync(path, 'hex')] as const;
    })
    .sort(([a], [b]) => (a < b ? -1 : Number(a > b)));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function run(args: readonly string[], cwd = root, preload?: string): Result {
  const nodeArgs = preload === undefined ? [] : ['--import', pathToFileURL(preload).href];
  const result = spawnSync(process.execPath, [...nodeArgs, entry, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function repeat(args: readonly string[], cwd = root, preload?: string): Result {
  const result = run(args, cwd, preload);
  expect(run(args, cwd, preload)).toEqual(result);
  return result;
}

function json(result: Result, status: number): JsonReport {
  expect(result.status).toBe(status);
  expect(result.stderr).toBe('');
  const report = JSON.parse(result.stdout) as JsonReport;
  expect(result.stdout).toBe(JSON.stringify(report, null, 2) + '\n');
  return report;
}

describe('compiled scan and explanation compatibility', () => {
  it('preserves terminal scan bytes across cwd, relative why and absolute paths', () => {
    const before = inputHash();
    for (const [args, cwd] of [
      [[], root],
      [['why'], scratch],
      [[root], scratch],
      [['--format', 'terminal', 'why'], scratch],
    ] as const) {
      expect(repeat(args, cwd)).toEqual({ status: 1, stdout: findingsTerminal, stderr: '' });
    }

    const report = json(repeat(['why', '--format', 'json'], scratch), 1);
    expect(report).toMatchObject({
      schemaVersion: 1,
      tool: { name: 'depvitals', version },
      project: { root },
      mode: 'scan',
      query: null,
      scope: { ignorePaths: [], ignoreDependencies: ['ignored'] },
      findings: {
        unusedDependencies: ['unused'],
        unusedDevDependencies: ['rejected', 'unused'],
        missingDependencies: ['missing'],
      },
      counts: { unusedDependencies: 1, unusedDevDependencies: 2, missingDependencies: 1 },
    });
    expect(report.packages.map(({ name, status }) => [name, status])).toEqual([
      ['ignored', 'excluded'],
      ['missing', 'missing'],
      ['peer', 'declared'],
      ['preload', 'used'],
      ['rejected', 'unused'],
      ['unused', 'unused'],
    ]);
    expect(report.packages.find(({ name }) => name === 'preload')?.evidence).toEqual([
      packageEvidence,
    ]);
    expect(report.packages.find(({ name }) => name === 'rejected')?.evidence).toEqual([]);
    expect(inputHash()).toBe(before);
  });

  it('reports a clean scan on stdout with exit zero in both formats', () => {
    write('package.json', '{}');
    write('depvitals.config.json', '{}');
    write('index.cjs', 'module.exports = 1;\n');
    const before = inputHash();
    expect(repeat([])).toEqual({ status: 0, stdout: clean, stderr: '' });
    expect(json(repeat(['--format', 'json', root], scratch), 0)).toMatchObject({
      mode: 'scan',
      project: { root },
      findings: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
      counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 0 },
      packages: [],
      query: null,
    });
    expect(inputHash()).toBe(before);
  });

  it.each(cases)('reports only $name with status $status in either format', (query) => {
    const { name, status, groups, evidence, exit } = query;
    const keys: readonly string[] = query.keys;
    const before = inputHash();
    const human = repeat(['--explain', name, 'why'], scratch);
    expect(human.status).toBe(exit);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain(
      [
        'DepVitals',
        '',
        `Package: ${name}`,
        `Status: ${status}`,
        `Declared in: ${groups.join(', ') || 'none'}`,
        `Excluded: ${status === 'excluded' ? 'yes' : 'no'}`,
        `Underlying findings: ${keys.join(', ') || 'none'}`,
        `Findings: ${keys.join(', ') || 'none'}`,
        '',
      ].join('\n'),
    );
    expect(human.stdout.match(/^Package: .+$/gm)).toEqual([`Package: ${name}`]);
    expect(human.stdout).toContain(`\nEvidence (${String(evidence.length)})\n`);
    expect(human.stdout.endsWith('  Ignored dependency names: "ignored"\n')).toBe(true);

    const args = ['--format', 'json', 'why', '--explain', name];
    const machine = repeat(args, scratch);
    expect(run(['--explain', name, '--format', 'json'], root)).toEqual(machine);
    const report = json(machine, exit);
    expect(report).toMatchObject({
      mode: 'explain',
      project: { root },
      query: { packageName: name, known: status !== 'unknown' },
      scope: { ignorePaths: [], ignoreDependencies: ['ignored'] },
    });
    expect(report.packages).toEqual([
      {
        name,
        status,
        declaredIn: groups,
        excluded: status === 'excluded',
        underlyingFindings: keys,
        findings: keys,
        evidence,
      },
    ]);
    expect(report.findings).toEqual(
      Object.fromEntries(categories.map((key) => [key, keys.includes(key) ? [name] : []])),
    );
    expect(report.counts).toEqual(
      Object.fromEntries(categories.map((key) => [key, keys.includes(key) ? 1 : 0])),
    );
    expect(inputHash()).toBe(before);
  });
});

const hint = "Run 'depvitals --help' for available commands.\n";

// Load instrumentation from outside the target tree. Patch only the selected root's I/O, leaving
// Node's module loading and the CLI's own version read intact.
function hook(body: string): string {
  const file = join(scratch, 'io-hook.mjs');
  writeFileSync(
    file,
    `import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, sep } from 'node:path';
const root = ${JSON.stringify(root)};
${body}
syncBuiltinESMExports();
`,
  );
  return file;
}

describe('compiled argument precedence', () => {
  it('handles standalone meta and invalid arguments before touching the target tree', () => {
    write('package.json', '{');
    write('depvitals.config.json', '{');
    write('.eslintrc.json', '{');
    const before = inputHash();
    const guard = hook(`
for (const key of ['lstat', 'readdir', 'readFile']) {
  const original = fs[key];
  fs[key] = (path, ...args) => {
    if (typeof path === 'string' && (path === root || path.startsWith(root + sep))) {
      process.stderr.write('unexpected target access\\n');
      throw new Error('target access prohibited');
    }
    return original(path, ...args);
  };
}
`);
    const help = repeat(['--help'], root, guard);
    expect(help).toMatchObject({ status: 0, stderr: '' });
    expect(help.stdout).toContain(
      '  --format <format>    Output format: terminal or json (default: terminal)\n',
    );
    expect(help.stdout).toContain(
      '  --explain <package>  Explain one exact package root (default: full scan)\n',
    );
    expect(repeat(['--version'], root, guard)).toEqual({
      status: 0,
      stderr: '',
      stdout: version + '\n',
    });

    const bad = [
      [['--format', 'XML', '--help'], 'Option --help must be used alone.'],
      [
        ['--format', 'json', '--explain', 'preload', '--version'],
        'Option --version must be used alone.',
      ],
      [
        ['--format', 'json', '--explain', 'preload/register'],
        'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.',
      ],
      [['--format', 'json', '--format', 'json'], 'Option --format may be specified only once.'],
      [
        ['--explain', 'preload', '--explain', 'preload'],
        'Option --explain may be specified only once.',
      ],
      [['--explain', '--format', 'json'], 'Option --explain requires a value.'],
      [['--format=json'], 'Unknown option: --format=json'],
      [['--format', 'json', '', 'why'], 'Too many arguments: expected at most one project path.'],
      [[''], 'Invalid project path: project path must not be empty.'],
    ] as const;
    for (const [args, error] of bad) {
      expect(repeat(args, root, guard)).toEqual({
        status: 1,
        stdout: '',
        stderr: error + '\n' + hint,
      });
    }

    // Positive control proves that the preload intercepts filesystem operations of the actual CLI.
    expect(run([], root, guard).stderr).toContain('unexpected target access\n');
    expect(inputHash()).toBe(before);
  });
});

describe('compiled operational failures in every mode', () => {
  function assertFatal(stderr: string | RegExp, preload?: string): void {
    const before = inputHash();
    for (const args of [
      [],
      ['--format', 'json'],
      ['--explain', 'preload'],
      ['--explain', 'preload', '--format', 'json'],
    ]) {
      const result = repeat(args, root, preload);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      if (typeof stderr === 'string') expect(result.stderr).toBe(stderr);
      else expect(result.stderr).toMatch(stderr);
    }
    expect(inputHash()).toBe(before);
  }

  it('validates root manifest, strict policy and active ESLint JSON in precedence order', () => {
    write('package.json', '{');
    write('depvitals.config.json', '{"ignorePaths":null}');
    write('.eslintrc.json', '{');
    write('index.cjs', "require('unfinished");

    assertFatal(join(root, 'package.json') + ' is not valid JSON\n');
    write(
      'package.json',
      '{"devDependencies":{"preload":"1"},"scripts":{"check":"node -r preload index.cjs"}}',
    );
    assertFatal(
      join(root, 'depvitals.config.json') + ' field ignorePaths must be an array of strings\n',
    );
    write('depvitals.config.json', '{}');
    assertFatal(
      '.eslintrc.json at ' +
        join(root, '.eslintrc.json') +
        ' is not valid JSON. DepVitals reads strict JSON only, so JavaScript-style comments inside .eslintrc.json are not supported.\n',
    );
    write('.eslintrc.json', '{}');
    const prefix = 'Source file ' + join(root, 'index.cjs') + ' could not be analyzed: ';
    assertFatal(new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]+\\n$'));
  });

  it('requires unrelated nested metadata before an apparently decidable query', () => {
    mkdirSync(join(root, 'nested'));
    write('nested/package.json', '[]');
    write('nested/file.cjs', 'module.exports = 1;\n');
    assertFatal(join(root, 'nested/package.json') + ' must contain a JSON object\n');
  });

  it('treats a denied read of unrelated retained source as an operational error', () => {
    const preload = hook(`
const readFile = fs.readFile;
fs.readFile = (path, ...args) => path === join(root, 'index.cjs')
  ? Promise.reject(Object.assign(new Error('injected source access denied'), { code: 'EACCES' }))
  : readFile(path, ...args);
`);
    assertFatal(
      'Could not read source file ' + join(root, 'index.cjs') + ': injected source access denied\n',
      preload,
    );
  });

  it('uses the unexpected fallback for a fault outside the filesystem read', () => {
    const preload = hook(`
const readFile = fs.readFile;
fs.readFile = (path, ...args) => path === join(root, 'index.cjs')
  ? Promise.resolve({ toString() { throw new Error('injected internal fault'); } })
  : readFile(path, ...args);
`);
    assertFatal(
      'Unexpected error while analyzing project ' + root + ': injected internal fault\n',
      preload,
    );
  });
});
