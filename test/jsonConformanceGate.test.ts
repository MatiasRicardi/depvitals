import { deepStrictEqual, equal, ok } from 'node:assert/strict';
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
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const categories = ['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'] as const;
const groups = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const references = ['import', 'export-from', 'dynamic-import', 'require'] as const;
const vias = ['direct', 'mapping', 'runner', 'node-preload'] as const;
const detectors = ['eslint', 'jest'] as const;

type Category = (typeof categories)[number];
type Group = (typeof groups)[number];
type Source = {
  kind: 'source';
  file: string;
  reference: (typeof references)[number];
  specifier: string;
  position: { offset: number; line: number; column: number };
};
type Evidence =
  | Source
  | {
      kind: 'script';
      file: string;
      pointer: string;
      command: string;
      via: (typeof vias)[number];
      occurrence: number;
    }
  | {
      kind: 'config';
      file: string;
      pointer: string;
      value: string;
      detector: (typeof detectors)[number];
    };
type Package = {
  name: string;
  status: string;
  declaredIn: Group[];
  excluded: boolean;
  underlyingFindings: Category[];
  findings: Category[];
  evidence: Evidence[];
};
type Report = {
  schemaVersion: 1;
  tool: { name: 'depvitals'; version: string };
  mode: 'scan' | 'explain';
  project: { root: string };
  scope: {
    sourceExtensions: string[];
    excludedDirectories: string[];
    ignorePaths: string[];
    ignoreDependencies: string[];
  };
  findings: Record<Category, string[]>;
  counts: Record<Category, number>;
  packages: Package[];
  query: { packageName: string; known: boolean } | null;
};

const schemaDir = new URL('../schemas/', import.meta.url);
const examplesDir = new URL('examples/', schemaDir);
const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

function readJson(url: URL): unknown {
  return JSON.parse(readFileSync(url, 'utf8'));
}

const schema = readJson(new URL('report-v1.schema.json', schemaDir)) as {
  $schema: string;
  properties: { schemaVersion: { const: number } };
};
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const { version } = readJson(new URL('../package.json', import.meta.url)) as { version: string };

function checkSchema(value: unknown): asserts value is Report {
  equal(validate(value), true, ajv.errorsText(validate.errors));
}

function example(name: string): Report {
  const report = readJson(new URL(name + '.json', examplesDir));
  checkSchema(report);
  return report;
}

function ordered<T>(values: readonly T[], allowed: readonly T[], message: string): void {
  deepStrictEqual(
    values,
    allowed.filter((value) => values.includes(value)),
    message,
  );
}

function sortedStrings(values: readonly string[], message: string): void {
  deepStrictEqual(values, [...new Set(values)].sort(), message);
}

// Each tuple contains the documented sort keys and all semantic identity fields. Extra wire
// properties and insertion order cannot turn duplicate evidence into a distinct record.
function evidenceKeys(evidence: Evidence): readonly (number | string)[] {
  switch (evidence.kind) {
    case 'source':
      return [
        0,
        evidence.file,
        evidence.position.offset,
        references.indexOf(evidence.reference),
        evidence.specifier,
        evidence.position.line,
        evidence.position.column,
      ];
    case 'script':
      return [
        1,
        evidence.file,
        evidence.pointer,
        evidence.occurrence,
        vias.indexOf(evidence.via),
        evidence.command,
      ];
    case 'config':
      return [
        2,
        evidence.file,
        evidence.pointer,
        detectors.indexOf(evidence.detector),
        evidence.value,
      ];
  }
}

function compareKeys(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  for (const [i, left] of a.entries()) {
    const right = b[i];
    if (right === undefined || left > right) return 1;
    if (left < right) return -1;
  }
  return a.length - b.length;
}

function checkSemantics(report: Report): void {
  ok(
    posix.isAbsolute(report.project.root) || win32.isAbsolute(report.project.root),
    'absolute root',
  );
  for (const key of [
    'sourceExtensions',
    'excludedDirectories',
    'ignorePaths',
    'ignoreDependencies',
  ] as const) {
    sortedStrings(report.scope[key], 'scope order: ' + key);
  }

  sortedStrings(
    report.packages.map(({ name }) => name),
    'package order and identity',
  );
  if (report.mode === 'scan') {
    for (const name of report.scope.ignoreDependencies) {
      ok(
        report.packages.some((pkg) => pkg.name === name),
        'scan includes excluded name',
      );
    }
  } else {
    const [pkg] = report.packages;
    ok(pkg && report.query);
    equal(report.query.packageName, pkg.name, 'query identity');
    equal(report.query.known, pkg.status !== 'unknown', 'query known');
  }

  for (const pkg of report.packages) {
    ordered(pkg.declaredIn, groups, 'declaration group order');
    equal(pkg.excluded, report.scope.ignoreDependencies.includes(pkg.name), 'exclusion policy');
    const hasRuntime = pkg.declaredIn.includes('dependencies');
    const hasDev = pkg.declaredIn.includes('devDependencies');
    const isDeclared = pkg.declaredIn.length > 0;
    const hasEvidence = pkg.evidence.length > 0;
    const missing = !isDeclared && pkg.evidence.some((item) => item.kind === 'source');
    const unused = !hasEvidence && (hasRuntime || hasDev);
    const underlying = [
      ...(!hasEvidence && hasRuntime ? ['unusedDependencies'] : []),
      ...(!hasEvidence && hasDev ? ['unusedDevDependencies'] : []),
      ...(missing ? ['missingDependencies'] : []),
    ];
    deepStrictEqual(pkg.underlyingFindings, underlying, 'underlying findings');
    deepStrictEqual(pkg.findings, pkg.excluded ? [] : underlying, 'visible package findings');
    const expectedStatus = pkg.excluded
      ? 'excluded'
      : missing
        ? 'missing'
        : unused
          ? 'unused'
          : hasEvidence
            ? 'used'
            : isDeclared
              ? 'declared'
              : 'unknown';
    equal(pkg.status, expectedStatus, 'package status');
    let previous: readonly (number | string)[] | undefined;
    for (const fact of pkg.evidence) {
      ok(
        fact.file.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
        'evidence path',
      );
      if (fact.kind !== 'source') {
        ok(hasRuntime || hasDev, 'script/config declaration gate');
        ok(!/~(?![01])/.test(fact.pointer), 'pointer escape');
      }
      const keys = evidenceKeys(fact);
      if (previous) ok(compareKeys(previous, keys) < 0, 'evidence order and identity');
      previous = keys;
    }
  }
  for (const category of categories) {
    const expected = report.packages
      .filter((pkg) => pkg.findings.includes(category))
      .map((pkg) => pkg.name);
    deepStrictEqual(report.findings[category], expected, 'envelope findings');
    equal(report.counts[category], expected.length, 'envelope count');
  }
}

const issueManifest = { dependencies: { unused: '1' }, devDependencies: { 'unused-tool': '1' } };
const issueFiles = { 'src/index.ts': "import item from 'missing';\n" };
const examples = [
  { name: 'scan-clean', manifest: {}, files: {}, exit: 0 },
  { name: 'scan-findings', manifest: issueManifest, files: issueFiles, exit: 1 },
  {
    name: 'explain-missing',
    manifest: issueManifest,
    files: issueFiles,
    query: 'missing',
    exit: 1,
  },
  {
    name: 'explain-excluded',
    manifest: { dependencies: { unused: '1' } },
    files: { 'depvitals.config.json': '{"ignoreDependencies":["unused"]}' },
    query: 'unused',
    exit: 0,
  },
  { name: 'explain-unknown', manifest: {}, files: {}, query: 'absent', exit: 1 },
  {
    name: 'explain-node-preload',
    manifest: {
      devDependencies: { preload: '1' },
      scripts: {
        'check/node~':
          'unlisted-tool && node --import=preload/esm --import=preload/esm ./entry.cjs',
      },
    },
    files: { 'entry.cjs': '' },
    query: 'preload',
    exit: 0,
  },
] as const;

function withProject(
  manifest: object,
  files: Readonly<Record<string, string>>,
  check: (root: string) => void,
): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-json-conformance-')));
  const inputs = { 'package.json': JSON.stringify(manifest), ...files };
  try {
    for (const [file, text] of Object.entries(inputs)) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    const paths = readdirSync(root, { recursive: true }).sort();
    check(root);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(paths);
    for (const [file, text] of Object.entries(inputs)) {
      expect(readFileSync(join(root, file), 'utf8')).toBe(text);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function compiled(
  root: string,
  query?: string,
): { status: number | null; stdout: string; stderr: string } {
  const args = query === undefined ? [] : ['--explain', query];
  const result = spawnSync(process.execPath, [entry, root, '--format', 'json', ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: '', DEPVITALS_NO_UPDATE_CHECK: '1' },
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function assertCompiled(root: string, expected: Report, exit: number, query?: string): void {
  const result = compiled(root, query);
  expect(result).toMatchObject({ status: exit, stderr: '' });
  const actual: unknown = JSON.parse(result.stdout);
  checkSchema(actual);
  checkSemantics(actual);
  expect(result.stdout).toBe(JSON.stringify(expected, null, 2) + '\n');
  expect(compiled(root, query)).toEqual(result);
}

describe('public Draft 7 schema and compiled producer', () => {
  it('identifies the published schema and its six target-release examples', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.properties.schemaVersion.const).toBe(1);
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(
      readdirSync(examplesDir)
        .filter((file) => file.endsWith('.json'))
        .sort(),
    ).toEqual(examples.map(({ name }) => name + '.json').sort());
  });

  it.each(examples)(
    'matches the independently authored $name document byte for byte',
    (scenario) => {
      const expected = example(scenario.name);
      checkSemantics(expected);
      expect(expected.tool.version).toBe('0.4.0');
      withProject(scenario.manifest, scenario.files, (root) => {
        assertCompiled(
          root,
          { ...expected, tool: { name: 'depvitals', version }, project: { root } },
          scenario.exit,
          'query' in scenario ? scenario.query : undefined,
        );
      });
    },
  );

  it('preserves mixed evidence, UTF-16 positions, escaped pointers and preload ordinals', () => {
    // A backslash is a literal filename character on POSIX. The enclosing directory still becomes
    // a forward-slash component on Windows.
    const file = process.platform === 'win32' ? 'Src/Mixed.cjs' : 'Src/Mixed\\literal.cjs';
    const text =
      '\uFEFF// 😀\r\n\t"😀"; require("ts-jest/a");\u2028require("ts-jest/b");\rrequire("lost");\n';
    const manifest = {
      optionalDependencies: { 'ts-jest': '1' },
      peerDependencies: { 'ts-jest': '1' },
      devDependencies: { unused: '1', 'ts-jest': '1', discarded: '1' },
      dependencies: { unused: '1', 'ts-jest': '1' },
      scripts: {
        'mix/~':
          'unlisted-tool && node -r discarded --unknown && node --import=ts-jest/esm --import=ts-jest/esm app.cjs',
      },
      jest: { transform: { 'pattern/~': ['ts-jest', { ignored: 'decoy' }] } },
    };

    const source = (specifier: string, position: Source['position']): Source => ({
      kind: 'source',
      file,
      reference: 'require',
      specifier,
      position,
    });
    // The undeclared tool and the two outer Node commands precede the accepted preloads.
    // The rejected "discarded" candidate consumes no ordinal.
    const preload = (occurrence: number): Evidence => ({
      kind: 'script',
      file: 'package.json',
      pointer: '/scripts/mix~1~0',
      command: 'ts-jest/esm',
      via: 'node-preload',
      occurrence,
    });

    withProject(manifest, { [file]: text }, (root) => {
      const expected: Report = {
        ...example('scan-clean'),
        tool: { name: 'depvitals', version },
        project: { root },
        findings: {
          unusedDependencies: ['unused'],
          unusedDevDependencies: ['discarded', 'unused'],
          missingDependencies: ['lost'],
        },
        counts: { unusedDependencies: 1, unusedDevDependencies: 2, missingDependencies: 1 },
        packages: [
          {
            name: 'discarded',
            status: 'unused',
            declaredIn: ['devDependencies'],
            excluded: false,
            underlyingFindings: ['unusedDevDependencies'],
            findings: ['unusedDevDependencies'],
            evidence: [],
          },
          {
            name: 'lost',
            status: 'missing',
            declaredIn: [],
            excluded: false,
            underlyingFindings: ['missingDependencies'],
            findings: ['missingDependencies'],
            evidence: [source('lost', { offset: 67, line: 4, column: 9 })],
          },
          {
            name: 'ts-jest',
            status: 'used',
            declaredIn: [
              'dependencies',
              'devDependencies',
              'peerDependencies',
              'optionalDependencies',
            ],
            excluded: false,
            underlyingFindings: [],
            findings: [],
            evidence: [
              source('ts-jest/a', { offset: 23, line: 2, column: 16 }),
              source('ts-jest/b', { offset: 45, line: 3, column: 9 }),
              preload(3),
              preload(4),
              {
                kind: 'config',
                file: 'package.json',
                pointer: '/jest/transform/pattern~1~0/0',
                value: 'ts-jest',
                detector: 'jest',
              },
            ],
          },
          {
            name: 'unused',
            status: 'unused',
            declaredIn: ['dependencies', 'devDependencies'],
            excluded: false,
            underlyingFindings: ['unusedDependencies', 'unusedDevDependencies'],
            findings: ['unusedDependencies', 'unusedDevDependencies'],
            evidence: [],
          },
        ],
      };
      checkSchema(expected);
      checkSemantics(expected);
      assertCompiled(root, expected, 1);

      const selected = expected.packages.find(({ name }) => name === 'ts-jest');
      ok(selected);
      assertCompiled(
        root,
        {
          ...expected,
          mode: 'explain',
          findings: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
          counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 0 },
          packages: [selected],
          query: { packageName: 'ts-jest', known: true },
        },
        0,
        'ts-jest',
      );
    });
  });

  it('keeps stdout empty when unrelated retained input fails before projection', () => {
    withProject(
      { dependencies: { used: '1' } },
      {
        'a.cjs': 'require("used");\n',
        'z.cjs': 'require("unfinished',
      },
      (root) => {
        for (const query of [undefined, 'used']) {
          const result = compiled(root, query);
          expect(result).toMatchObject({ status: 1, stdout: '' });
          expect(result.stderr).toContain(join(root, 'z.cjs') + ' could not be analyzed:');
          expect(compiled(root, query)).toEqual(result);
        }
      },
    );
  });
});

function first<T>(items: readonly T[]): T {
  const [item] = items;
  ok(item !== undefined);
  return item;
}

function alterEvidence(name: string, change: (fact: Evidence) => object): unknown {
  const report = example(name);
  const pkg = first(report.packages);
  return { ...report, packages: [{ ...pkg, evidence: [change(first(pkg.evidence))] }] };
}

describe('structural rejection by Draft 7', () => {
  it.each([
    ['unsupported schema version', () => ({ ...example('scan-clean'), schemaVersion: 2 })],
    ['missing required field', () => ({ ...example('scan-clean'), counts: undefined })],
    [
      'wrong count type',
      () => {
        const doc = example('scan-clean');
        return { ...doc, counts: { ...doc.counts, missingDependencies: '0' } };
      },
    ],
    [
      'query with a trailing newline',
      () => ({
        ...example('explain-unknown'),
        query: { packageName: 'absent\n', known: false },
      }),
    ],
    [
      'more than one query record',
      () => {
        const doc = example('explain-missing');
        return { ...doc, packages: [...doc.packages, ...example('scan-findings').packages] };
      },
    ],
    [
      'unselected source reference',
      () => alterEvidence('explain-missing', (fact) => ({ ...fact, reference: 'require-resolve' })),
    ],
    [
      'evidence tag with the wrong required fields',
      () => alterEvidence('explain-missing', (fact) => ({ ...fact, kind: 'config' })),
    ],
    [
      'unselected script route',
      () => alterEvidence('explain-node-preload', (fact) => ({ ...fact, via: 'cross-env' })),
    ],
    [
      'negative script ordinal',
      () => alterEvidence('explain-node-preload', (fact) => ({ ...fact, occurrence: -1 })),
    ],
    [
      'fractional script ordinal',
      () => alterEvidence('explain-node-preload', (fact) => ({ ...fact, occurrence: 0.5 })),
    ],
    [
      'negative source offset',
      () =>
        alterEvidence('explain-missing', (fact) => ({
          ...fact,
          position: { offset: -1, line: 1, column: 1 },
        })),
    ],
    [
      'fractional source offset',
      () =>
        alterEvidence('explain-missing', (fact) => ({
          ...fact,
          position: { offset: 0.5, line: 1, column: 1 },
        })),
    ],
    [
      'zero source line',
      () =>
        alterEvidence('explain-missing', (fact) => ({
          ...fact,
          position: { offset: 0, line: 0, column: 1 },
        })),
    ],
    [
      'zero source column',
      () =>
        alterEvidence('explain-missing', (fact) => ({
          ...fact,
          position: { offset: 0, line: 1, column: 0 },
        })),
    ],
  ] as const)('rejects %s', (_label, mutation) => {
    // Round-trip to JSON so the validator sees only values present on the wire.
    const invalid: unknown = JSON.parse(JSON.stringify(mutation()));
    expect(validate(invalid)).toBe(false);
  });

  it('accepts additive fields and tool versions independently of schema version', () => {
    const doc = example('explain-missing');
    const pkg = first(doc.packages);
    const fact = first(pkg.evidence);
    ok(fact.kind === 'source');
    const extended = {
      ...doc,
      future: { enabled: true },
      tool: { ...doc.tool, version: '9.8.7-test' },
      project: { root: 'C:\\Example\\Project' },
      scope: { ...doc.scope, future: 7 },
      packages: [
        {
          ...pkg,
          future: 'annotation',
          evidence: [{ ...fact, position: { ...fact.position, future: 'position hint' } }],
        },
      ],
    };
    checkSchema(extended);
    checkSemantics(extended);
  });
});

describe('semantic rejections beyond the wire schema', () => {
  const mutations: readonly (readonly [
    example: string,
    reason: string,
    mutate: (doc: Report) => void,
  ])[] = [
    [
      'scan-findings',
      'envelope count',
      (doc) => {
        doc.counts.missingDependencies = 0;
      },
    ],
    [
      'explain-missing',
      'envelope findings',
      (doc) => {
        doc.findings.unusedDependencies = ['unused'];
        doc.counts.unusedDependencies = 1;
      },
    ],
    [
      'scan-clean',
      'scope order: ignorePaths',
      (doc) => {
        doc.scope.ignorePaths = ['z', 'A'];
      },
    ],
    ['scan-findings', 'package order and identity', (doc) => doc.packages.reverse()],
    [
      'scan-findings',
      'package order and identity',
      (doc) => doc.packages.unshift(structuredClone(first(doc.packages))),
    ],
    [
      'scan-findings',
      'declaration group order',
      (doc) => {
        const pkg = doc.packages.find(({ name }) => name === 'unused');
        ok(pkg);
        pkg.declaredIn.unshift('devDependencies');
      },
    ],
    [
      'explain-node-preload',
      'evidence order and identity',
      (doc) => first(doc.packages).evidence.reverse(),
    ],
    [
      'explain-node-preload',
      'evidence order and identity',
      (doc) => {
        const { evidence } = first(doc.packages);
        const duplicate = { future: 'annotation', ...first(evidence) };
        evidence.unshift(duplicate);
      },
    ],
    [
      'explain-node-preload',
      'pointer escape',
      (doc) => {
        const fact = first(first(doc.packages).evidence);
        ok(fact.kind === 'script');
        fact.pointer = '/scripts/bad~2key';
      },
    ],
    [
      'explain-missing',
      'evidence path',
      (doc) => {
        first(first(doc.packages).evidence).file = 'src/../index.ts';
      },
    ],
    [
      'explain-missing',
      'query identity',
      (doc) => {
        ok(doc.query);
        doc.query.packageName = 'unused';
      },
    ],
    [
      'explain-unknown',
      'query known',
      (doc) => {
        ok(doc.query);
        doc.query.known = true;
      },
    ],
    [
      'explain-excluded',
      'exclusion policy',
      (doc) => {
        first(doc.packages).excluded = false;
      },
    ],
    [
      'explain-node-preload',
      'package status',
      (doc) => {
        first(doc.packages).status = 'declared';
      },
    ],
  ];

  it.each(mutations)('rejects a mutation of %s violating %s', (name, reason, mutate) => {
    const report = example(name);
    checkSemantics(report);
    mutate(report);
    checkSchema(report);
    expect(() => {
      checkSemantics(report);
    }).toThrow(reason);
  });
});
