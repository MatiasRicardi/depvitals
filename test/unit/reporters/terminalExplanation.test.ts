import * as fs from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PackageExplanation } from '../../../src/core/analyzeProject.js';
import type { Evidence, PackageFact } from '../../../src/core/evidence.js';
import { formatTerminalExplanation } from '../../../src/reporters/terminalReporter.js';

vi.mock('node:fs/promises', () => {
  const forbidden = (): never => {
    throw new Error('Explanation reporters must not access files');
  };
  return { readFile: vi.fn(forbidden), readdir: vi.fn(forbidden), lstat: vi.fn(forbidden) };
});
afterEach(() => {
  expect(fs.readFile).not.toHaveBeenCalled();
  expect(fs.readdir).not.toHaveBeenCalled();
  expect(fs.lstat).not.toHaveBeenCalled();
});

const source: Evidence = {
  kind: 'source',
  file: 'src/index.ts',
  reference: 'import',
  specifier: 'example',
  position: { offset: 19, line: 1, column: 20 },
};
function explanation(
  overrides: Partial<PackageFact> = {},
  config: PackageExplanation['config'] = { ignorePaths: [], ignoreDependencies: [] },
): PackageExplanation {
  const pkg: PackageFact = {
    name: 'example',
    status: 'used',
    declaredIn: ['dependencies'],
    excluded: false,
    underlyingFindings: [],
    findings: [],
    evidence: [source],
    ...overrides,
  };
  const findings = {
    unusedDependencies: pkg.findings.includes('unusedDependencies') ? [pkg.name] : [],
    unusedDevDependencies: pkg.findings.includes('unusedDevDependencies') ? [pkg.name] : [],
    missingDependencies: pkg.findings.includes('missingDependencies') ? [pkg.name] : [],
  };
  return {
    projectRoot: '/nonexistent/private/project',
    config,
    findings,
    counts: {
      unusedDependencies: findings.unusedDependencies.length,
      unusedDevDependencies: findings.unusedDevDependencies.length,
      missingDependencies: findings.missingDependencies.length,
    },
    packages: [pkg],
    query: { packageName: pkg.name, known: pkg.status !== 'unknown' },
    exitCode:
      pkg.status === 'unused' || pkg.status === 'missing' || pkg.status === 'unknown' ? 1 : 0,
  };
}
function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const item of Object.values(value)) freezeDeep(item);
  Object.freeze(value);
}

describe('formatTerminalExplanation', () => {
  it('renders the exact contract example with one final LF', () => {
    expect(formatTerminalExplanation(explanation())).toBe(
      [
        'DepVitals',
        '',
        'Package: example',
        'Status: used',
        'Declared in: dependencies',
        'Excluded: no',
        'Underlying findings: none',
        'Findings: none',
        '',
        'Supported usage evidence was found within the effective scope.',
        '',
        'Evidence (1)',
        '  source "src/index.ts":1:20 import "example"',
        '',
        'Scope',
        '  Ignored source paths: none',
        '  Ignored dependency names: none',
        '',
      ].join('\n'),
    );
  });

  it.each([
    {
      status: 'unused',
      declaredIn: ['dependencies', 'devDependencies'],
      excluded: false,
      underlyingFindings: ['unusedDependencies', 'unusedDevDependencies'],
      findings: ['unusedDependencies', 'unusedDevDependencies'],
      reason:
        'No supported usage evidence was found within the effective scope. Review before removing the package.',
      groups: 'dependencies, devDependencies',
      underlying: 'unusedDependencies, unusedDevDependencies',
      visible: 'unusedDependencies, unusedDevDependencies',
    },
    {
      status: 'declared',
      declaredIn: ['peerDependencies', 'optionalDependencies'],
      excluded: false,
      underlyingFindings: [],
      findings: [],
      reason:
        'Declared only in peerDependencies and/or optionalDependencies without supported usage evidence. These groups are not checked for unused.',
      groups: 'peerDependencies, optionalDependencies',
      underlying: 'none',
      visible: 'none',
    },
    {
      status: 'unknown',
      declaredIn: [],
      excluded: false,
      underlyingFindings: [],
      findings: [],
      reason:
        'No declaration, supported source reference or dependency exclusion was found for this package.',
      groups: 'none',
      underlying: 'none',
      visible: 'none',
    },
    {
      status: 'excluded',
      declaredIn: [],
      excluded: true,
      underlyingFindings: [],
      findings: [],
      reason:
        'An exact ignoreDependencies rule suppresses findings for this package. Exclusion is not usage evidence.',
      groups: 'none',
      underlying: 'none',
      visible: 'none',
    },
  ] as const)('renders the exact empty-evidence $status report', (row) => {
    const config = row.excluded ? { ignorePaths: [], ignoreDependencies: ['example'] } : undefined;
    const input = explanation(
      {
        status: row.status,
        declaredIn: row.declaredIn,
        excluded: row.excluded,
        underlyingFindings: row.underlyingFindings,
        findings: row.findings,
        evidence: [],
      },
      config,
    );
    expect(formatTerminalExplanation(input)).toBe(
      [
        'DepVitals',
        '',
        'Package: example',
        `Status: ${row.status}`,
        `Declared in: ${row.groups}`,
        `Excluded: ${row.excluded ? 'yes' : 'no'}`,
        `Underlying findings: ${row.underlying}`,
        `Findings: ${row.visible}`,
        '',
        row.reason,
        '',
        'Evidence (0)',
        '  none',
        '',
        'Scope',
        '  Ignored source paths: none',
        `  Ignored dependency names: ${row.excluded ? '"example"' : 'none'}`,
        '',
      ].join('\n'),
    );
  });

  it.each([false, true])(
    'preserves source provenance and underlying missing membership when excluded=%s',
    (excluded) => {
      const input = explanation(
        {
          status: excluded ? 'excluded' : 'missing',
          declaredIn: [],
          excluded,
          underlyingFindings: ['missingDependencies'],
          findings: excluded ? [] : ['missingDependencies'],
        },
        { ignorePaths: ['generated'], ignoreDependencies: excluded ? ['example'] : [] },
      );
      expect(formatTerminalExplanation(input)).toBe(
        [
          'DepVitals',
          '',
          'Package: example',
          `Status: ${excluded ? 'excluded' : 'missing'}`,
          'Declared in: none',
          `Excluded: ${excluded ? 'yes' : 'no'}`,
          'Underlying findings: missingDependencies',
          `Findings: ${excluded ? 'none' : 'missingDependencies'}`,
          '',
          excluded
            ? 'An exact ignoreDependencies rule suppresses findings for this package. Exclusion is not usage evidence.'
            : 'Supported source evidence references this package, but no dependency group declares it.',
          '',
          'Evidence (1)',
          '  source "src/index.ts":1:20 import "example"',
          '',
          'Scope',
          '  Ignored source paths: "generated"',
          `  Ignored dependency names: ${excluded ? '"example"' : 'none'}`,
          '',
        ].join('\n'),
      );
    },
  );

  it('orders groups, finding labels, all provenance variants and scope rules without mutation', () => {
    const evidence: Evidence[] = [
      {
        kind: 'config',
        file: 'package.json',
        pointer: '/jest/preset',
        detector: 'jest',
        value: 'ts-jest',
      },
      {
        kind: 'script',
        file: 'package.json',
        pointer: '/scripts/z',
        via: 'node-preload',
        command: 'example/sub',
        occurrence: 3,
      },
      {
        kind: 'source',
        file: 'src/z.ts',
        reference: 'require',
        specifier: 'example/sub',
        position: { offset: 40, line: 3, column: 8 },
      },
      {
        kind: 'script',
        file: 'package.json',
        pointer: '/scripts/a~1~0',
        via: 'runner',
        command: 'example',
        occurrence: 2,
      },
      {
        kind: 'script',
        file: 'package.json',
        pointer: '/scripts/a~1~0',
        via: 'mapping',
        command: 'tool',
        occurrence: 1,
      },
      {
        kind: 'script',
        file: 'package.json',
        pointer: '/scripts/a~1~0',
        via: 'direct',
        command: 'example',
        occurrence: 0,
      },
      {
        kind: 'source',
        file: 'src/a.ts',
        reference: 'dynamic-import',
        specifier: 'example/b',
        position: { offset: 25, line: 2, column: 4 },
      },
      {
        kind: 'config',
        file: '.ESLINTRC.JSON',
        pointer: '/extends/1',
        detector: 'eslint',
        value: 'prettier',
      },
      {
        kind: 'source',
        file: 'src/a.ts',
        reference: 'export-from',
        specifier: 'example/a',
        position: { offset: 3, line: 1, column: 4 },
      },
    ];
    const input = explanation(
      {
        declaredIn: ['optionalDependencies', 'devDependencies', 'peerDependencies', 'dependencies'],
        evidence,
      },
      { ignorePaths: ['z', 'A', 'a'], ignoreDependencies: ['z', 'B', 'b'] },
    );
    freezeDeep(input);
    const before = JSON.stringify(input);
    const output = formatTerminalExplanation(input);
    expect(
      output.split('\n').filter((line) => /^ {2}(?:source|script|config) /u.test(line)),
    ).toEqual([
      '  source "src/a.ts":1:4 export-from "example/a"',
      '  source "src/a.ts":2:4 dynamic-import "example/b"',
      '  source "src/z.ts":3:8 require "example/sub"',
      '  script "package.json"#"/scripts/a~1~0" direct "example" (occurrence 0)',
      '  script "package.json"#"/scripts/a~1~0" mapping "tool" (occurrence 1)',
      '  script "package.json"#"/scripts/a~1~0" runner "example" (occurrence 2)',
      '  script "package.json"#"/scripts/z" node-preload "example/sub" (occurrence 3)',
      '  config ".ESLINTRC.JSON"#"/extends/1" eslint "prettier"',
      '  config "package.json"#"/jest/preset" jest "ts-jest"',
    ]);
    expect(output).toContain(
      'Declared in: dependencies, devDependencies, peerDependencies, optionalDependencies\n',
    );
    expect(output).toContain('  Ignored source paths: "A", "a", "z"\n');
    expect(output).toContain('  Ignored dependency names: "B", "b", "z"\n');
    expect(output).not.toContain(input.projectRoot);
    expect(
      formatTerminalExplanation({
        ...input,
        packages: [{ ...input.packages[0], evidence: [...evidence].reverse() }],
      }),
    ).toBe(output);
    expect(JSON.stringify(input)).toBe(before);
    const unused = explanation({
      status: 'unused',
      evidence: [],
      underlyingFindings: ['unusedDevDependencies', 'unusedDependencies'],
      findings: ['unusedDevDependencies', 'unusedDependencies'],
    });
    expect(formatTerminalExplanation(unused)).toContain(
      'Underlying findings: unusedDependencies, unusedDevDependencies\nFindings: unusedDependencies, unusedDevDependencies\n',
    );
  });

  it('quotes slashes and quotes, and escapes hostile controls in every arbitrary displayed field', () => {
    const input = explanation(
      {
        name: 'pkg\u001b[2J\n',
        evidence: [
          {
            kind: 'source',
            file: 'src/"x\\\t.cjs',
            reference: 'require',
            specifier: 'pkg\r\n\u009b31m',
            position: { offset: 0, line: 7, column: 9 },
          },
          {
            kind: 'script',
            file: 'package.json',
            pointer: '/scripts/a\n\u001b[0m',
            via: 'direct',
            command: 'tool"\\\u0000',
            occurrence: 4,
          },
          {
            kind: 'config',
            file: 'cfg\u007f\u0085.json',
            pointer: '/x~1y\r',
            detector: 'jest',
            value: 'value\u001b]0;title\u0007',
          },
        ],
      },
      { ignorePaths: ['a\tb"\\'], ignoreDependencies: ['pkg\n\u009f'] },
    );
    const output = formatTerminalExplanation(input);
    expect(output).toContain(String.raw`Package: pkg\u001b[2J\u000a` + '\n');
    expect(output).toContain(
      String.raw`  source "src/\"x\\\u0009.cjs":7:9 require "pkg\u000d\u000a\u009b31m"` + '\n',
    );
    expect(output).toContain(
      String.raw`  script "package.json"#"/scripts/a\u000a\u001b[0m" direct "tool\"\\\u0000" (occurrence 4)` +
        '\n',
    );
    expect(output).toContain(
      String.raw`  config "cfg\u007f\u0085.json"#"/x~1y\u000d" jest "value\u001b]0;title\u0007"` +
        '\n',
    );
    expect(output).toContain(String.raw`  Ignored source paths: "a\u0009b\"\\"` + '\n');
    expect(output).toContain(String.raw`  Ignored dependency names: "pkg\u000a\u009f"` + '\n');
    expect(output.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    expect(output.split('\n')).toHaveLength(20);
  });

  it.each(['script', 'config'] as const)(
    'distinguishes newlines from literal Unicode escape text in %s pointers',
    (kind) => {
      const pointers = ['/scripts/a\nb', String.raw`/scripts/a\u000ab`];
      const evidence: Evidence[] = pointers.map((pointer) =>
        kind === 'script'
          ? {
              kind,
              file: 'package.json',
              pointer,
              via: 'direct',
              command: 'example',
              occurrence: 0,
            }
          : { kind, file: 'package.json', pointer, detector: 'jest', value: 'example' },
      );
      const output = formatTerminalExplanation(explanation({ evidence }));
      const rows = output.split('\n').filter((line) => line.startsWith(`  ${kind} `));
      expect(rows).toEqual(
        kind === 'script'
          ? [
              String.raw`  script "package.json"#"/scripts/a\u000ab" direct "example" (occurrence 0)`,
              String.raw`  script "package.json"#"/scripts/a\\u000ab" direct "example" (occurrence 0)`,
            ]
          : [
              String.raw`  config "package.json"#"/scripts/a\u000ab" jest "example"`,
              String.raw`  config "package.json"#"/scripts/a\\u000ab" jest "example"`,
            ],
      );
      expect(new Set(rows).size).toBe(2);
    },
  );

  it.each(Array.from({ length: 65 }, (_, i) => (i < 32 ? i : i + 95)))(
    'escapes display control U+%i without raw output',
    (code) => {
      const raw = String.fromCharCode(code);
      const output = formatTerminalExplanation(
        explanation({
          name: 'a' + raw + 'b',
          evidence: [{ ...source, specifier: 'a' + raw + 'b' }],
        }),
      );
      const escaped = '\\u' + code.toString(16).padStart(4, '0');
      expect(output).toContain('Package: a' + escaped + 'b\n');
      expect(output).toContain('import "a' + escaped + 'b"\n');
      if (code !== 10) expect(output).not.toContain(raw);
    },
  );

  it('keeps all large evidence lists and repeated occurrences complete without truncation', () => {
    const evidence: Evidence[] = Array.from({ length: 2048 }, (_, offset) => ({
      kind: 'source',
      file: 'src/é😀.cjs',
      reference: 'require',
      specifier: 'example/sub',
      position: { offset, line: offset + 1, column: 1 },
    }));
    const output = formatTerminalExplanation(explanation({ evidence: [...evidence].reverse() }));
    const rows = output.split('\n').filter((line) => line.startsWith('  source '));
    expect(output).toContain('Evidence (2048)\n');
    expect(rows).toHaveLength(2048);
    expect(rows[0]).toBe('  source "src/é😀.cjs":1:1 require "example/sub"');
    expect(rows[2047]).toBe('  source "src/é😀.cjs":2048:1 require "example/sub"');
    expect(output).not.toContain('...');
    const repeated = formatTerminalExplanation(
      explanation({
        evidence: [source, { ...source, position: { offset: 70, line: 5, column: 2 } }],
      }),
    );
    expect(repeated).toContain('Evidence (2)\n');
    expect(repeated).toContain('  source "src/index.ts":5:2 import "example"\n');
  });
});
