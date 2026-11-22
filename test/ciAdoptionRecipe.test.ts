import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  symlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

import type { JsonReport } from '../src/reporters/jsonReporter.js';

const recipe = new URL('../docs/examples/ci/', import.meta.url);
const adapter = fileURLToPath(new URL('verify-report.mjs', recipe));
const legacyAdapter = fileURLToPath(
  new URL('./fixtures/report-readers/v0.5.0.mjs', import.meta.url),
);
const require = createRequire(import.meta.url);
const reportSchema = new URL('../schemas/report-v2.schema.json', import.meta.url);

function prepareAdapter(root: string): string {
  const modules = join(root, 'node_modules');
  const schemas = join(modules, 'depvitals', 'schemas');
  const recipeDirectory = join(modules, 'depvitals-local-ci-recipe');
  mkdirSync(schemas, { recursive: true });
  mkdirSync(recipeDirectory, { recursive: true });
  symlinkSync(dirname(require.resolve('ajv/package.json')), join(modules, 'ajv'), 'junction');
  copyFileSync(reportSchema, join(schemas, 'report-v2.schema.json'));
  const verifier = join(recipeDirectory, 'verify-report.mjs');
  copyFileSync(adapter, verifier);
  return verifier;
}

const clean = {
  schemaVersion: 2,
  tool: { name: 'depvitals', version: '0.4.0' },
  mode: 'scan',
  project: { root: '/fixture' },
  scope: {
    sourceExtensions: ['.js'],
    excludedDirectories: ['node_modules'],
    ignorePaths: [],
    ignoreDependencies: [],
  },
  findings: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
  counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 0 },
  packages: [],
  query: null,
};
const findings = {
  ...clean,
  findings: { ...clean.findings, missingDependencies: ['ci-missing'] },
  counts: { ...clean.counts, missingDependencies: 1 },
  packages: [
    {
      name: 'ci-missing',
      status: 'missing',
      declaredIn: [],
      excluded: false,
      underlyingFindings: ['missingDependencies'],
      findings: ['missingDependencies'],
      evidence: [
        {
          kind: 'source',
          file: 'index.js',
          reference: 'import',
          specifier: 'ci-missing',
          position: { offset: 7, line: 1, column: 8 },
        },
      ],
    },
  ],
};
const usedPackage = {
  name: 'ci-used',
  status: 'used',
  declaredIn: ['dependencies'],
  excluded: false,
  underlyingFindings: [],
  findings: [],
  evidence: [
    {
      kind: 'source',
      file: 'index.js',
      reference: 'import',
      specifier: 'ci-used',
      position: { offset: 7, line: 1, column: 8 },
    },
  ],
};
const json = (value: object): string => JSON.stringify(value) + '\n';

function verify(
  report: string | undefined,
  diagnostics: string,
  status: string,
  legacy = false,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const scratch = mkdtempSync(join(tmpdir(), 'depvitals-ci-artifacts-'));
  try {
    const paths = [
      'depvitals-report.json',
      'depvitals-diagnostics.txt',
      'depvitals-status.txt',
    ].map((name) => join(scratch, name));
    for (const [index, contents] of [report, diagnostics, status].entries()) {
      const path = paths[index];
      if (path !== undefined && contents !== undefined) writeFileSync(path, contents);
    }
    const result = spawnSync(
      process.execPath,
      [legacy ? legacyAdapter : prepareAdapter(scratch), ...paths],
      {
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('consumer report verification', () => {
  it('binds the legacy reader and distinguishes the two report versions', () => {
    expect(createHash('sha256').update(readFileSync(legacyAdapter)).digest('hex')).toBe(
      'da69550dfd7d17bd83e3fff9a1df3907a3b6b61dedc767fe57bfc41b1cd807d9',
    );
    const v1 = json({ ...clean, schemaVersion: 1 });
    expect(verify(v1, '', '0\n', true).status).toBe(0);
    expect(verify(json(clean), '', '0\n', true).status).toBe(2);
    expect(verify(v1, '', '0\n').status).toBe(2);
    expect(verify('', 'operational error\n', '1\n', true).status).toBe(1);
  });

  it.each([
    { sourceFilesScanned: '0', nestedPackageSourceFiles: 0, notices: ['no-supported-sources'] },
    { sourceFilesScanned: 1, nestedPackageSourceFiles: 2, notices: ['nested-package-inputs'] },
    {
      sourceFilesScanned: 0,
      nestedPackageSourceFiles: 0,
      notices: ['tsconfig-skipped', 'no-supported-sources'],
    },
  ])('rejects invalid diagnostic shape or semantics %j', (diagnostics) => {
    expect(verify(json({ ...clean, diagnostics }), '', '0\n').status).toBe(2);
  });

  it('accepts a clean scan and additive data', () => {
    const report = {
      ...clean,
      annotation: { future: true },
      packages: [{ ...usedPackage, annotation: { future: true } }],
    };
    expect(verify(json(report), '', '0\n')).toEqual({
      status: 0,
      stdout: 'DepVitals scan passed.\n',
      stderr: '',
    });
  });

  it.each([
    ['evidence', undefined],
    ['evidence', 'not-an-array'],
    ['declaredIn', undefined],
    ['declaredIn', [7]],
    ['excluded', undefined],
    ['excluded', 'false'],
    ['underlyingFindings', undefined],
    ['underlyingFindings', [false]],
  ] as const)('rejects an incomplete or mistyped %s field (%j)', (field, value) => {
    const report = { ...clean, packages: [{ ...usedPackage, [field]: value }] };
    const result = verify(json(report), '', '0\n');
    expect(result).toMatchObject({ status: 2, stdout: '' });
    expect(result.stderr).toMatch(/^Invalid DepVitals analysis artifacts\./);
  });

  it('fails for findings and uses a numeric summary', () => {
    expect(verify(json(findings), '', '1\n')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'DepVitals findings: 0 unused, 0 unused dev, 1 missing.\n',
    });
  });

  it.each([
    {
      label: 'package findings omitted from the summary',
      report: { ...clean, packages: findings.packages },
      status: '0\n',
      error: 'Package findings disagree with report findings.',
    },
    {
      label: 'summary findings with no package record',
      report: { ...findings, packages: [] },
      status: '1\n',
      error: 'Report findings disagree with package findings.',
    },
    {
      label: 'missing package status with empty visible findings',
      report: { ...clean, packages: findings.packages.map((pkg) => ({ ...pkg, findings: [] })) },
      status: '0\n',
      error: 'Package findings disagree with underlying findings.',
    },
  ])('rejects $label', ({ report, status, error }) => {
    expect(verify(json(report), '', status)).toEqual({
      status: 2,
      stdout: '',
      stderr: `Invalid DepVitals analysis artifacts. ${error}\n`,
    });
  });

  it('distinguishes an operational error and leaves raw diagnostics in the artifact', () => {
    expect(verify('', '::error::untrusted diagnostic\n', '1\n')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'DepVitals analysis failed. See the diagnostics artifact.\n',
    });
  });

  it.each([
    ['missing file', undefined, '', '0\n'],
    ['partial JSON', '{"schemaVersion":1', '', '0\n'],
    ['npm banner', 'npm run\n' + json(clean), '', '0\n'],
    ['trailing content', json(clean) + '{}', '', '0\n'],
    ['wrong schema', json({ ...clean, schemaVersion: 1 }), '', '0\n'],
    [
      'query mode',
      json({ ...clean, mode: 'explain', query: { packageName: 'x', known: false } }),
      '',
      '0\n',
    ],
    ['wrong tool', json({ ...clean, tool: { name: 'other', version: '0.4.0' } }), '', '0\n'],
    ['incomplete envelope', json({ ...clean, packages: null }), '', '0\n'],
    [
      'non-string finding',
      json({ ...findings, findings: { ...findings.findings, missingDependencies: [7] } }),
      '',
      '1\n',
    ],
    ['inconsistent counts', json({ ...findings, counts: clean.counts }), '', '1\n'],
    ['clean with failure status', json(clean), '', '1\n'],
    ['findings with success status', json(findings), '', '0\n'],
    ['completed report with diagnostics', json(clean), 'unexpected\n', '0\n'],
    ['silent operational failure', '', '', '1\n'],
    ['status missing LF', json(clean), '', '0'],
    ['terminated process', '', 'terminated\n', '143\n'],
    ['missing executable', '', 'not found\n', '127\n'],
  ] as const)('rejects %s as invalid artifacts', (_name, report, diagnostics, status) => {
    const result = verify(report, diagnostics, status);
    expect(result).toMatchObject({ status: 2, stdout: '' });
    expect(result.stderr).toMatch(/^Invalid DepVitals analysis artifacts\./);
  });
});

it('keeps the example workflow parseable, pinned and enforcing outcomes after upload', async () => {
  const workflow = readFileSync(new URL('check-dependencies.yml', recipe), 'utf8');
  await expect(format(workflow, { parser: 'yaml' })).resolves.toContain('name: Check dependencies');
  const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);
  expect(actions).toHaveLength(3);
  for (const action of actions) expect(action).toMatch(/^actions\/[\w-]+@[a-f0-9]{40}$/);
  expect(workflow).toContain('contents: read');
  expect(workflow).toContain('run: npm ci --ignore-scripts --include=dev');
  expect(workflow).toContain('run: bash .github/depvitals/capture-report.sh "$REPORT_DIR"');
  expect(workflow).toMatch(
    /name: Upload DepVitals result\n\s+if: always\(\)[\s\S]*name: Verify report and enforce scan outcome\n\s+if: always\(\)/,
  );
  expect(workflow).toContain('node .github/depvitals/verify-report.mjs');
  expect(workflow).not.toContain('continue-on-error:');
});

const captureScript = fileURLToPath(new URL('capture-report.sh', recipe));
const compiledCli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const actualVersion = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const validateReport = new Ajv({ allErrors: true }).compile(
  JSON.parse(readFileSync(reportSchema, 'utf8')) as object,
);
function snapshotProject(root: string): unknown {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: relative(root, path),
        directory: entry.isDirectory(),
        mode: statSync(path).mode,
        bytes: entry.isFile() ? readFileSync(path).toString('hex') : null,
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
const quoteShell = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";

// The package smoke separately runs these capture modes against an actual npm-ci-installed tarball.
describe.skipIf(process.platform === 'win32')('real CLI capture recipe', () => {
  it.each([
    { name: 'default clean', args: [], source: undefined, exit: 0, diagnostic: undefined },
    {
      name: 'zero-source diagnostic notice',
      args: ['--diagnostics'],
      source: undefined,
      exit: 0,
      diagnostic: {
        sourceFilesScanned: 0,
        nestedPackageSourceFiles: 0,
        notices: ['no-supported-sources'],
      },
    },
    {
      name: 'diagnostic findings',
      args: ['--diagnostics'],
      source: "require('ci-missing');\n",
      exit: 1,
      diagnostic: { sourceFilesScanned: 1, nestedPackageSourceFiles: 0, notices: [] },
    },
    {
      name: 'diagnostic fatal error',
      args: ['--diagnostics'],
      source: "require('unfinished",
      exit: 1,
      diagnostic: undefined,
    },
  ])('captures $name and preserves exact channels, script status and inputs', (row) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-ci-capture-')));
    try {
      const project = join(scratch, 'project');
      const output = join(scratch, 'report');
      mkdirSync(join(project, 'node_modules/.bin'), { recursive: true });
      writeFileSync(
        join(project, 'node_modules/.bin/depvitals'),
        '#!/bin/sh\nexec ' +
          quoteShell(process.execPath) +
          ' ' +
          quoteShell(compiledCli) +
          ' "$@"\n',
        { mode: 0o755 },
      );
      const marker = join(scratch, 'executed');
      writeFileSync(
        join(project, 'package.json'),
        JSON.stringify({
          name: 'ci-recipe-fixture',
          version: '1.0.0',
          devDependencies: { depvitals: actualVersion },
          scripts: {
            'check:dependencies':
              'depvitals --format json' + (row.args.length ? ' --diagnostics' : ''),
            postinstall: 'node -e "process.exit(99)"',
          },
        }),
      );
      if (row.source !== undefined)
        writeFileSync(
          join(project, 'index.cjs'),
          (row.name.includes('fatal')
            ? ''
            : `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`) + row.source,
        );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: '1',
        DEPVITALS_NO_UPDATE_CHECK: '1',
        HOME: join(scratch, 'home'),
        USERPROFILE: join(scratch, 'home'),
        XDG_CACHE_HOME: join(scratch, 'cache'),
        LOCALAPPDATA: join(scratch, 'cache'),
      };
      delete env['NODE_OPTIONS'];
      delete env['NODE_PATH'];
      delete env['NODE_V8_COVERAGE'];
      const verifier = prepareAdapter(project);
      const before = snapshotProject(project);
      const result = spawnSync('bash', [captureScript, output, ...row.args], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
      const paths = [
        'depvitals-report.json',
        'depvitals-diagnostics.txt',
        'depvitals-status.txt',
      ].map((name) => join(output, name));
      const [report, stderr, status] = paths.map((path) => readFileSync(path, 'utf8'));
      expect(status).toBe(String(row.exit) + '\n');
      if (row.name.includes('fatal')) {
        expect(report).toBe('');
        expect(stderr).toContain('index.cjs');
      } else {
        expect(stderr).toBe('');
        const document = JSON.parse(report ?? '') as JsonReport;
        expect(validateReport(document), JSON.stringify(validateReport.errors)).toBe(true);
        expect(document.tool.version).toBe(actualVersion);
        expect(document.findings).toEqual({
          unusedDependencies: [],
          unusedDevDependencies: [],
          missingDependencies: row.source === undefined ? [] : ['ci-missing'],
        });
        if (row.diagnostic === undefined) expect(document).not.toHaveProperty('diagnostics');
        else expect(document.diagnostics).toEqual(row.diagnostic);
      }
      const verified = spawnSync(process.execPath, [verifier, ...paths], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(verified.error).toBeUndefined();
      expect(verified.status).toBe(row.exit);
      const silent = spawnSync('npm', ['run', '--silent', 'check:dependencies'], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(silent.error).toBeUndefined();
      expect(silent.status).toBe(row.exit);
      expect(silent.stdout).toBe(report);
      expect(silent.stderr).toBe(stderr);
      expect(snapshotProject(project)).toEqual(before);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(
    [
      [],
      ['--unknown'],
      ['--diagnostics=true'],
      ['--diagnostics', 'extra'],
      ['--diagnostics; touch injected'],
    ].map((args) => ({ args })),
  )('rejects invalid optional arguments $args without a partial directory', ({ args }) => {
    const scratch = mkdtempSync(join(tmpdir(), 'depvitals-ci-bad-args-'));
    try {
      const directory = join(scratch, 'report');
      const argv = args.length === 0 ? [] : [directory, ...args];
      const result = spawnSync('bash', [captureScript, ...argv], {
        cwd: scratch,
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toBe('');
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(join(scratch, 'injected'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

it.each([
  { sourceFilesScanned: 0, nestedPackageSourceFiles: 0, notices: ['no-supported-sources'] },
  { sourceFilesScanned: 4, nestedPackageSourceFiles: 1, notices: ['nested-package-inputs'] },
])('checks v2 diagnostic facts separately from findings %j', (diagnostics) => {
  expect(verify(json({ ...clean, diagnostics }), '', '0\n')).toEqual({
    status: 0,
    stdout: 'DepVitals scan passed.\n',
    stderr: '',
  });
  expect(verify(json({ ...findings, diagnostics }), '', '1\n').status).toBe(1);
});
