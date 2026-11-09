import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { format } from 'prettier';
import { describe, expect, it } from 'vitest';

const recipe = new URL('../docs/examples/ci/', import.meta.url);
const adapter = fileURLToPath(new URL('verify-report.mjs', recipe));
const clean = {
  schemaVersion: 1,
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
const json = (value: object): string => JSON.stringify(value) + '\n';

function verify(
  report: string | undefined,
  diagnostics: string,
  status: string,
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
    const result = spawnSync(process.execPath, [adapter, ...paths], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

describe('consumer report verification', () => {
  it('accepts a clean scan and additive data', () => {
    expect(verify(json({ ...clean, annotation: { future: true } }), '', '0\n')).toEqual({
      status: 0,
      stdout: 'DepVitals scan passed.\n',
      stderr: '',
    });
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
      error: 'Package status disagrees with findings.',
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
    ['wrong schema', json({ ...clean, schemaVersion: 2 }), '', '0\n'],
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
