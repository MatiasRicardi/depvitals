import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JsonReport } from '../src/reporters/jsonReporter.js';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const schemas = new URL('../schemas/', import.meta.url);
const historicalSchema = readFileSync(
  new URL('./fixtures/report-schemas/v0.4.1.schema.json', import.meta.url),
);
const validate = new Ajv({ allErrors: true }).compile(
  JSON.parse(readFileSync(new URL('report-v1.schema.json', schemas), 'utf8')) as object,
);
// Exact schema bytes from the verified published v0.4.1 archive, SHA-256
// a5f241de21a61018fd4a3023bc56bb0db9789c2ac5052e369b9ec0229bcd5285.
// CI reads this fixture directly and never needs npm, Git history or local plans.
const validateHistorical = new Ajv({ allErrors: true }).compile(
  JSON.parse(historicalSchema.toString('utf8')) as object,
);
const identityModule = new URL('../scripts/evaluate-corpus.mjs', import.meta.url).href;
const { identifySnapshot } = (await import(identityModule)) as {
  identifySnapshot: (root: string) => unknown;
};
const clean = 'DepVitals\n\nNo dependency issues found.\n';
const missing = 'DepVitals\n\nMissing dependencies (1)\n  leaf-only\n';
const nestedFiles = {
  'src/a.js': '',
  'child/package.json': '{"dependencies":{"leaf-only":"1"}}',
  'child/deep/use.cjs': "require('leaf-only');",
};
type Scenario = {
  name: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  sources: number;
  nested: number;
  notices: readonly string[];
  terminalSection: string;
  exit: number;
  missing: readonly string[];
};
const scenarios: readonly Scenario[] = [
  {
    name: 'script-only tool with inert lifecycle write probe',
    manifest: {
      devDependencies: { typescript: '1' },
      scripts: {
        check: 'tsc',
        postinstall: `node -e "require('fs').writeFileSync('executed', 'bad')"`,
      },
    },
    files: {},
    sources: 0,
    nested: 0,
    notices: ['no-supported-sources'],
    terminalSection: '  No supported source files were scanned.\n',
    exit: 0,
    missing: [],
  },
  {
    name: 'unsupported-only Vue',
    manifest: {},
    files: { 'component.vue': 'unsupported syntax' },
    sources: 0,
    nested: 0,
    notices: ['no-supported-sources'],
    terminalSection: '  No supported source files were scanned.\n',
    exit: 0,
    missing: [],
  },
  {
    name: 'root-owned source with inert write probe',
    manifest: {},
    files: { 'src/a.js': "require('node:fs').writeFileSync('executed', 'bad');" },
    sources: 1,
    nested: 0,
    notices: [],
    terminalSection: '',
    exit: 0,
    missing: [],
  },
  {
    name: 'nested scope without workspace declaration',
    manifest: {},
    files: nestedFiles,
    sources: 2,
    nested: 1,
    notices: ['nested-package-inputs'],
    terminalSection:
      '  Some source files belong to nested packages. Findings use the selected root inventory. Scan a nested package separately to use its inventory.\n',
    exit: 1,
    missing: ['leaf-only'],
  },
  {
    name: 'nested scope with root workspace declaration',
    manifest: { workspaces: { packages: ['child/**'] } },
    files: nestedFiles,
    sources: 2,
    nested: 1,
    notices: ['nested-package-inputs', 'workspace-declared'],
    terminalSection:
      '  Some source files belong to nested packages. Findings use the selected root inventory. Scan a nested package separately to use its inventory.\n  The root package.json declares workspaces. This scan uses only the selected root inventory.\n',
    exit: 1,
    missing: ['leaf-only'],
  },
  {
    name: 'ignored child with declaration retained',
    manifest: { workspaces: ['child'] },
    files: { ...nestedFiles, 'depvitals.config.json': '{"ignorePaths":["child"]}' },
    sources: 1,
    nested: 0,
    notices: ['workspace-declared'],
    terminalSection:
      '  The root package.json declares workspaces. This scan uses only the selected root inventory.\n',
    exit: 0,
    missing: [],
  },
  {
    name: 'declared workspace with no members',
    manifest: { workspaces: ['packages/*'] },
    files: {},
    sources: 0,
    nested: 0,
    notices: ['no-supported-sources', 'workspace-declared'],
    terminalSection:
      '  No supported source files were scanned.\n  The root package.json declares workspaces. This scan uses only the selected root inventory.\n',
    exit: 0,
    missing: [],
  },
  {
    name: 'settings-only pnpm workspace file',
    manifest: {},
    files: { 'pnpm-workspace.yaml': 'packages: ["child"]' },
    sources: 0,
    nested: 0,
    notices: ['no-supported-sources'],
    terminalSection: '  No supported source files were scanned.\n',
    exit: 0,
    missing: [],
  },
];
let scratch: string;
let root: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-diagnostics-process-')));
  root = join(scratch, 'project');
  mkdirSync(root);
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});
function project(manifest: Record<string, unknown>, files: Readonly<Record<string, string>>): void {
  for (const [file, text] of Object.entries({
    'package.json': JSON.stringify(manifest),
    ...files,
  })) {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
}
function run(
  args: readonly string[],
  selectedRoot: string | null = root,
): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const before = identifySnapshot(root);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: '1',
    DEPVITALS_NO_UPDATE_CHECK: '1',
    XDG_CACHE_HOME: join(scratch, 'cache'),
    LOCALAPPDATA: join(scratch, 'cache'),
    HOME: join(scratch, 'home'),
    USERPROFILE: join(scratch, 'home'),
  };
  delete env['NODE_OPTIONS'];
  delete env['NODE_PATH'];
  const result = spawnSync(
    process.execPath,
    [cli, ...(selectedRoot === null ? [] : [selectedRoot]), ...args],
    {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  expect(identifySnapshot(root)).toEqual(before);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function report(args: readonly string[], selectedRoot = root): JsonReport {
  const output = run(['--format', 'json', ...args], selectedRoot);
  expect(output.stderr).toBe('');
  const doc = JSON.parse(output.stdout) as JsonReport;
  expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
  expect(validateHistorical(doc), JSON.stringify(validateHistorical.errors)).toBe(true);
  return doc;
}

describe('compiled diagnostics compatibility', () => {
  it('pins the exact archived schema fixture', () => {
    expect(createHash('sha256').update(historicalSchema).digest('hex')).toBe(
      'cbaad82487d992bbe7352ea31e4fceaedb79d846599639174a931957630fab2e',
    );
  });

  it.each(scenarios)('matches authored counts, notices and channels for $name', (scenario) => {
    project(scenario.manifest, scenario.files);
    const expected = scenario.exit === 0 ? clean : missing;
    expect(run([])).toEqual({ status: scenario.exit, stdout: expected, stderr: '' });
    expect(run(['--diagnostics'])).toEqual({
      status: scenario.exit,
      stdout:
        expected +
        '\nScan diagnostics\n' +
        `  Source files scanned: ${String(scenario.sources)}\n` +
        `  Nested-package source files: ${String(scenario.nested)}\n` +
        scenario.terminalSection,
      stderr: '',
    });
    const ordinary = report([]);
    const diagnostic = report(['--diagnostics']);
    const { diagnostics, ...rest } = diagnostic;
    expect(rest).toEqual(ordinary);
    expect(ordinary).not.toHaveProperty('diagnostics');
    expect(ordinary.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: scenario.missing,
    });
    expect(diagnostics).toEqual({
      sourceFilesScanned: scenario.sources,
      nestedPackageSourceFiles: scenario.nested,
      notices: scenario.notices,
    });
    expect(run(['--format', 'json', '--diagnostics']).status).toBe(scenario.exit);
    expect(Object.keys(diagnostic).slice(-2)).toEqual(['query', 'diagnostics']);
    expect(Object.keys(diagnostics ?? {})).toEqual([
      'sourceFilesScanned',
      'nestedPackageSourceFiles',
      'notices',
    ]);
    expect(diagnostics?.nestedPackageSourceFiles).toBeLessThanOrEqual(
      diagnostics?.sourceFilesScanned ?? -1,
    );
    expect(diagnostics?.notices.includes('no-supported-sources')).toBe(scenario.sources === 0);
    expect(diagnostics?.notices.includes('nested-package-inputs')).toBe(scenario.nested > 0);
    expect(run(['--format', 'json', '--diagnostics'])).toEqual(
      run(['--format', 'json', '--diagnostics']),
    );
    if (scenario.name.startsWith('script-only')) {
      expect(ordinary.packages.find((pkg) => pkg.name === 'typescript')?.evidence).toEqual([
        {
          kind: 'script',
          file: 'package.json',
          pointer: '/scripts/check',
          command: 'tsc',
          via: 'mapping',
          occurrence: 0,
        },
      ]);
    }
  });

  it('resets ownership for a separately selected child inventory', () => {
    project({}, nestedFiles);
    expect(run(['--diagnostics'], join(root, 'child'))).toEqual({
      status: 0,
      stdout:
        clean + '\nScan diagnostics\n  Source files scanned: 1\n  Nested-package source files: 0\n',
      stderr: '',
    });
    expect(report(['--diagnostics'], join(root, 'child')).findings.missingDependencies).toEqual([]);
  });

  it('counts declarations under nameless manifests and skips links, ignored paths and unsupported files', () => {
    project(
      {},
      {
        'a.cjs': '',
        'child/package.json': '{}',
        'child/types.d.ts': '',
        'component.vue': 'unsupported',
        'upper.JS': 'unsupported',
        'ignored/broken.cjs': "'unfinished",
        'depvitals.config.json': '{"ignorePaths":["ignored"]}',
      },
    );
    symlinkSync(join(root, 'a.cjs'), join(root, 'linked.cjs'), 'file');
    symlinkSync(join(root, 'child'), join(root, 'linked-directory'), 'junction');
    expect(report(['--diagnostics']).diagnostics).toEqual({
      sourceFilesScanned: 2,
      nestedPackageSourceFiles: 1,
      notices: ['nested-package-inputs'],
    });
  });

  it('keeps dependency policy independent of source counts', () => {
    project(
      {},
      { ...nestedFiles, 'depvitals.config.json': '{"ignoreDependencies":["leaf-only"]}' },
    );
    const doc = report(['--diagnostics']);
    expect(doc.findings.missingDependencies).toEqual([]);
    expect(doc.diagnostics).toEqual({
      sourceFilesScanned: 2,
      nestedPackageSourceFiles: 1,
      notices: ['nested-package-inputs'],
    });
    expect(doc.packages[0]?.evidence).toHaveLength(1);
    expect(run(['--diagnostics']).status).toBe(0);
  });

  it.each([
    {
      name: 'root manifest before config',
      files: { 'package.json': '{invalid', 'depvitals.config.json': '{invalid' },
      diagnostic: 'package.json',
    },
    {
      name: 'strict policy',
      files: { 'depvitals.config.json': '{"unknown":true}' },
      diagnostic: 'depvitals.config.json',
    },
    {
      name: 'detector JSON',
      files: { '.eslintrc.json': '{invalid' },
      diagnostic: '.eslintrc.json',
    },
    {
      name: 'nested manifest after readable source',
      files: { 'a.cjs': '', 'z/package.json': '{invalid', 'z/a.cjs': '' },
      diagnostic: 'package.json',
    },
    {
      name: 'retained source after readable source',
      files: { 'a.cjs': '', 'z.cjs': "'unfinished" },
      diagnostic: 'could not be analyzed',
    },
  ])('keeps $name fail-closed in both formats', ({ files, diagnostic }) => {
    project({}, files);
    const ordinary = run([]);
    expect(ordinary.status).toBe(1);
    expect(ordinary.stdout).toBe('');
    expect(ordinary.stderr).toContain(diagnostic);
    expect(run(['--diagnostics'])).toEqual(ordinary);
    expect(run(['--format', 'json', '--diagnostics'])).toEqual(ordinary);
  });

  it('fails on linked mandatory manifests without partial counts', () => {
    project({}, { 'a.cjs': '', 'z/a.cjs': '' });
    symlinkSync(join(root, 'package.json'), join(root, 'z/package.json'), 'file');
    for (const args of [['--diagnostics'], ['--format', 'json', '--diagnostics']]) {
      expect(run(args)).toMatchObject({ status: 1, stdout: '' });
      expect(run(args).stderr).toContain('regular file');
    }
  });

  it('preserves query and meta modes and validates arguments before project access', () => {
    project({}, nestedFiles);
    const json = report(['--explain', 'leaf-only']);
    expect(json.mode).toBe('explain');
    expect(json).not.toHaveProperty('diagnostics');
    expect(json.query).toEqual({ packageName: 'leaf-only', known: true });
    expect(run(['--explain', 'leaf-only']).stdout).toContain('Status: missing');
    writeFileSync(join(root, 'package.json'), '{invalid');
    expect(run(['--diagnostics', '--explain', 'leaf-only'])).toEqual({
      status: 1,
      stdout: '',
      stderr:
        "Option --diagnostics cannot be combined with --explain.\nRun 'depvitals --help' for available commands.\n",
    });
    // Meta flags stay standalone. Use a root-free invocation for their ordinary modes.
    for (const flag of ['--help', '--version']) {
      const result = run([flag], null);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toBe('');
    }
  });

  it.each(['@scope/_demo', '@scope/-demo'])(
    'accepts current compiled explanation %s under the repaired schema',
    (name) => {
      project({}, { 'index.mjs': `import '${name}';` });
      const output = run(['--format', 'json', '--explain', name]);
      expect(output.status).toBe(1);
      expect(output.stderr).toBe('');
      const doc = JSON.parse(output.stdout) as JsonReport;
      expect(validate(doc), JSON.stringify(validate.errors)).toBe(true);
      expect(validateHistorical(doc)).toBe(false);
      expect(doc.query).toEqual({ packageName: name, known: true });
      expect(doc.packages[0]?.status).toBe('missing');
      expect(doc.packages[0]?.evidence[0]).toMatchObject({ kind: 'source', specifier: name });
    },
  );
}, 30_000);
