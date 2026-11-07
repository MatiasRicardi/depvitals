import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { AnalysisFindings } from '../src/core/analyzeProject.js';
import type { Evidence } from '../src/core/evidence.js';
import type { JsonReport } from '../src/reporters/jsonReporter.js';

type Control = {
  id: string;
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  source: string;
  ignoreDependencies: string[];
  afterF1: AnalysisFindings;
  afterF1Exit: number;
  expectedEvidenceAfterF1?: Record<string, Evidence[]>;
};

const { cases } = JSON.parse(
  readFileSync(
    new URL('./fixtures/external-corpus/repros/node-preload-flags.json', import.meta.url),
    'utf8',
  ),
) as { cases: Control[] };
const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const env = {
  ...process.env,
  DEPVITALS_NO_UPDATE_CHECK: '1',
  NODE_OPTIONS: undefined,
  NODE_PATH: undefined,
};

function run(
  root: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
    env,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function fixture(
  manifest: object,
  source: string,
  ignored: string[],
  check: (root: string) => void,
): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-preload-')));
  const files = {
    'package.json': JSON.stringify(manifest),
    'entry.cjs': source,
    'depvitals.config.json': JSON.stringify({ ignoreDependencies: ignored }),
  };
  try {
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(root, name), bytes);
    check(root);
    for (const [name, bytes] of Object.entries(files))
      expect(readFileSync(join(root, name), 'utf8')).toBe(bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function terminal(findings: AnalysisFindings): string {
  const sections = [
    ['Unused dependencies', findings.unusedDependencies],
    ['Unused devDependencies', findings.unusedDevDependencies],
    ['Missing dependencies', findings.missingDependencies],
  ] as const;
  const text = sections
    .filter(([, names]) => names.length > 0)
    .map(([label, names]) =>
      [label + ' (' + String(names.length) + ')', ...names.map((name) => '  ' + name)].join('\n'),
    );
  return (
    'DepVitals\n\n' + (text.length === 0 ? 'No dependency issues found.' : text.join('\n\n')) + '\n'
  );
}

describe('frozen F1 Node preload controls', () => {
  it.each(cases)('matches $id in compiled terminal and JSON scans', (control) => {
    fixture(
      {
        scripts: control.scripts,
        devDependencies: control.devDependencies,
        peerDependencies: control.peerDependencies,
      },
      control.source,
      control.ignoreDependencies,
      (root) => {
        const json = run(root, ['--format', 'json']);
        expect(json.status).toBe(control.afterF1Exit);
        expect(json.stderr).toBe('');
        const doc = JSON.parse(json.stdout) as JsonReport;
        expect(doc.findings).toEqual(control.afterF1);
        for (const [name, evidence] of Object.entries(control.expectedEvidenceAfterF1 ?? {})) {
          expect(doc.packages.find((pkg) => pkg.name === name)?.evidence).toEqual(evidence);
        }
        if (control.id === 'peer-only-no-credit') {
          expect(doc.packages.find((pkg) => pkg.name === 'peer-preload')).toMatchObject({
            status: 'declared',
            evidence: [],
          });
        }
        if (control.id === 'undeclared-no-missing') {
          expect(doc.packages.some((pkg) => pkg.name === 'absent-preload')).toBe(false);
        }
        if (control.id === 'dependency-exclusion') {
          expect(doc.packages.find((pkg) => pkg.name === 'preload-alpha')).toMatchObject({
            status: 'excluded',
            underlyingFindings: [],
            findings: [],
            evidence: [
              {
                kind: 'script',
                file: 'package.json',
                pointer: '/scripts/check',
                command: 'preload-alpha',
                via: 'node-preload',
                occurrence: 1,
              },
            ],
          });
        }
        expect(run(root, [])).toEqual({
          status: control.afterF1Exit,
          stdout: terminal(control.afterF1),
          stderr: '',
        });
      },
    );
  });

  it('credits a production dependency and retains the ordinal for an optional-only candidate', () => {
    fixture(
      {
        dependencies: { preload: '1' },
        optionalDependencies: { optional: '1' },
        scripts: { check: 'node -r optional -r preload ./entry.cjs' },
      },
      '',
      [],
      (root) => {
        const result = run(root, ['--format', 'json']);
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        const { packages } = JSON.parse(result.stdout) as JsonReport;
        expect(packages.find((pkg) => pkg.name === 'optional')).toMatchObject({
          status: 'declared',
          evidence: [],
        });
        expect(packages.find((pkg) => pkg.name === 'preload')).toMatchObject({
          status: 'used',
          evidence: [
            {
              kind: 'script',
              file: 'package.json',
              pointer: '/scripts/check',
              command: 'preload',
              via: 'node-preload',
              occurrence: 2,
            },
          ],
        });
      },
    );
  });

  it('produces the normative JSON query and both human provenance rows from an actual script', () => {
    fixture(
      {
        devDependencies: { preload: '1' },
        scripts: {
          'check/node~':
            'unlisted-tool && node --import=preload/esm --import=preload/esm ./entry.cjs',
        },
      },
      '',
      [],
      (root) => {
        const expected = JSON.parse(
          readFileSync(
            new URL('../schemas/examples/explain-node-preload.json', import.meta.url),
            'utf8',
          ),
        ) as JsonReport;
        const version = (
          JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
            version: string;
          }
        ).version;
        const json = run(root, ['--explain', 'preload', '--format', 'json']);
        expect(json).toEqual({
          status: 0,
          stderr: '',
          stdout:
            JSON.stringify(
              { ...expected, project: { root }, tool: { name: 'depvitals', version } },
              null,
              2,
            ) + '\n',
        });
        const human = run(root, ['--explain', 'preload']);
        expect(human.status).toBe(0);
        expect(human.stderr).toBe('');
        expect(human.stdout).toContain('Package: preload\nStatus: used\n');
        expect(human.stdout).toContain(
          'Evidence (2)\n  script "package.json"#"/scripts/check~1node~0" node-preload "preload/esm" (occurrence 2)\n' +
            '  script "package.json"#"/scripts/check~1node~0" node-preload "preload/esm" (occurrence 3)\n',
        );
      },
    );
  });
});
