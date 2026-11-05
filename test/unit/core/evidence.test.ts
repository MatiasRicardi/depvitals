import { posix, win32 } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  compareEvidence,
  compareStrings,
  declarationGroupsFor,
  evidenceIdentity,
  evidencePath,
  jsonPointer,
  sortedUniqueEvidence,
  DECLARATION_GROUPS,
  FINDING_CATEGORIES,
  PACKAGE_STATUSES,
  type Evidence,
  type SourceEvidence,
  type ScriptEvidence,
  type ConfigEvidence,
} from '../../../src/core/evidence.js';

const source: SourceEvidence = {
  kind: 'source',
  file: 'src/Index.ts',
  reference: 'import',
  specifier: 'pkg/sub',
  position: { offset: 9, line: 1, column: 10 },
};
const script: ScriptEvidence = {
  kind: 'script',
  file: 'package.json',
  pointer: '/scripts/test',
  command: 'pkg',
  via: 'direct',
  occurrence: 0,
};
const config: ConfigEvidence = {
  kind: 'config',
  file: 'package.json',
  pointer: '/jest/preset',
  value: 'pkg',
  detector: 'jest',
};

describe('internal evidence primitives', () => {
  it('pins declaration, finding and status precedence independently', () => {
    expect(DECLARATION_GROUPS).toEqual([
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]);
    expect(FINDING_CATEGORIES).toEqual([
      'unusedDependencies',
      'unusedDevDependencies',
      'missingDependencies',
    ]);
    expect(PACKAGE_STATUSES).toEqual([
      'excluded',
      'missing',
      'unused',
      'used',
      'declared',
      'unknown',
    ]);
  });

  it('uses exact own declaration keys without validating or folding package identities', () => {
    const inventory = {
      dependencies: JSON.parse('{"__proto__":"1","":"2","Mixed":"3","all":"4"}') as Record<
        string,
        string
      >,
      devDependencies: { all: '5' },
      peerDependencies: { all: '6', peer: '1' },
      optionalDependencies: { all: '7' },
    };
    expect(declarationGroupsFor('all', inventory)).toEqual([
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]);
    expect(declarationGroupsFor('__proto__', inventory)).toEqual(['dependencies']);
    expect(declarationGroupsFor('constructor', inventory)).toEqual([]);
    expect(declarationGroupsFor('', inventory)).toEqual(['dependencies']);
    expect(declarationGroupsFor('mixed', inventory)).toEqual([]);
    expect(declarationGroupsFor('peer', inventory)).toEqual(['peerDependencies']);
  });

  it('sorts strings by UTF-16 rather than locale or Unicode code point', () => {
    expect(['é', 'a', '\ue000', '😀', 'Z', ''].sort(compareStrings)).toEqual([
      '',
      'Z',
      'a',
      'é',
      '😀',
      '\ue000',
    ]);
  });

  it.each([
    [posix, '/repo', '/repo/src/Index.ts', 'src/Index.ts'],
    [posix, '/repo', '/repo/src/a\\b.ts', 'src/a\\b.ts'],
    [posix, '/repo', '/repo/..literal.ts', '..literal.ts'],
    [win32, 'C:\\repo', 'C:\\repo\\Src\\Index.ts', 'Src/Index.ts'],
    [win32, '\\\\server\\share\\repo', '\\\\server\\share\\repo\\Src\\x.ts', 'Src/x.ts'],
  ])('serializes lexical project-relative paths: %s %s %s', (paths, root, file, expected) => {
    expect(evidencePath(root, file, paths)).toBe(expected);
  });

  it.each([
    [posix, '/repo', '/repo'],
    [posix, '/repo', '/repo-other/x'],
    [posix, '/repo', '/repo/../x'],
    [posix, 'repo', '/repo/x'],
    [posix, '/repo', 'x'],
    [win32, 'C:\\repo', 'D:\\repo\\x'],
    [win32, 'C:\\repo', 'C:\\repo-other\\x'],
    [win32, 'C:\\repo', 'C:\\repo'],
    [win32, '\\\\server\\share\\repo', '\\\\server\\other\\repo\\x'],
  ])('rejects root, relative and outside evidence locations: %s %s %s', (paths, root, file) => {
    expect(() => evidencePath(root, file, paths)).toThrow();
  });

  it('escapes pointers without URL encoding or losing empty tokens', () => {
    expect(jsonPointer()).toBe('');
    expect(jsonPointer('scripts', 'check/node~')).toBe('/scripts/check~1node~0');
    expect(jsonPointer('', '~1/😀\n%')).toBe('//~01~1😀\n%');
  });

  it('orders kind before file and file before variant fields', () => {
    const records: Evidence[] = [
      config,
      script,
      { ...source, file: 'z.ts', position: { offset: 0, line: 1, column: 1 } },
      source,
    ];
    expect(sortedUniqueEvidence(records)).toEqual([source, records[2], script, config]);
    expect(records[0]).toBe(config);
  });

  it('orders every variant tie-breaker independently', () => {
    const pairs: [Evidence, Evidence][] = [
      [source, { ...source, position: { offset: 10, line: 1, column: 11 } }],
      [source, { ...source, reference: 'export-from' }],
      [
        { ...source, reference: 'export-from' },
        { ...source, reference: 'dynamic-import' },
      ],
      [
        { ...source, reference: 'dynamic-import' },
        { ...source, reference: 'require' },
      ],
      [source, { ...source, specifier: 'z' }],
      [script, { ...script, pointer: '/scripts/z' }],
      [script, { ...script, occurrence: 10 }],
      [script, { ...script, via: 'mapping' }],
      [
        { ...script, via: 'mapping' },
        { ...script, via: 'runner' },
      ],
      [
        { ...script, via: 'runner' },
        { ...script, via: 'node-preload' },
      ],
      [script, { ...script, command: 'z' }],
      [config, { ...config, pointer: '/z' }],
      [{ ...config, detector: 'eslint' }, config],
      [config, { ...config, value: 'z' }],
    ];
    for (const [first, second] of pairs) {
      expect(compareEvidence(first, second)).toBeLessThan(0);
      expect(compareEvidence(second, first)).toBeGreaterThan(0);
      expect(sortedUniqueEvidence([second, first])).toEqual([first, second]);
    }
  });

  it('breaks otherwise equal source ties by numeric line and column in either input order', () => {
    const first: SourceEvidence = {
      ...source,
      position: { ...source.position, line: 2, column: 2 },
    };
    const laterColumn: SourceEvidence = {
      ...source,
      position: { ...source.position, line: 2, column: 10 },
    };
    const laterLine: SourceEvidence = {
      ...source,
      position: { ...source.position, line: 10, column: 1 },
    };
    const expected = [first, laterColumn, laterLine];

    expect(compareEvidence(first, laterColumn)).toBeLessThan(0);
    expect(compareEvidence(laterColumn, laterLine)).toBeLessThan(0);
    expect(sortedUniqueEvidence(expected)).toEqual(expected);
    expect(sortedUniqueEvidence([...expected].reverse())).toEqual(expected);
    expect(sortedUniqueEvidence([laterLine, first, laterColumn, { ...first }])).toEqual(expected);
  });

  it('deduplicates complete semantic records regardless of property insertion order', () => {
    const reordered: SourceEvidence = {
      position: { column: 10, line: 1, offset: 9 },
      specifier: 'pkg/sub',
      reference: 'import',
      file: 'src/Index.ts',
      kind: 'source',
    };
    expect(evidenceIdentity(reordered)).toBe(evidenceIdentity(source));
    const distinct: Evidence[] = [
      source,
      { ...source, position: { offset: 20, line: 2, column: 4 } },
      script,
      { ...script, occurrence: 1 },
      config,
      { ...config, pointer: '/jest/transform/0' },
    ];
    expect(
      sortedUniqueEvidence([...distinct, reordered, { ...script }, { ...config }]),
    ).toHaveLength(6);
    expect(new Set(distinct.map(evidenceIdentity)).size).toBe(6);
    // A bad collector coordinate must not silently collide with a complete record.
    expect(evidenceIdentity({ ...source, position: { ...source.position, column: 11 } })).not.toBe(
      evidenceIdentity(source),
    );
  });
});
