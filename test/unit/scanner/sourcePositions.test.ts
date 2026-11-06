import { describe, expect, it } from 'vitest';

import {
  collectModuleSpecifiers,
  extractModuleSpecifiers,
  ModuleSpecifierError,
  type ModuleSpecifierKind,
} from '../../../src/scanner/moduleSpecifiers.js';

type Case = { source: string; kind: ModuleSpecifierKind; offset: number; jsx?: boolean };
const cases: readonly Case[] = [
  { source: "import 'pkg';", kind: 'import', offset: 7 },
  { source: "import value from 'pkg';", kind: 'import', offset: 18 },
  { source: "import type { T } from 'pkg';", kind: 'import', offset: 23 },
  { source: "export * from 'pkg';", kind: 'export-from', offset: 14 },
  { source: "export { value } from 'pkg';", kind: 'export-from', offset: 22 },
  { source: "import('pkg', { with: { type: 'json' } },);", kind: 'dynamic-import', offset: 7 },
  { source: "require('pkg',);", kind: 'require', offset: 8 },
  { source: "type T = import('pkg').T;", kind: 'dynamic-import', offset: 16 },
  { source: "import alias = require('pkg');", kind: 'require', offset: 23 },
  { source: "const x = `${require('pkg')}`;", kind: 'require', offset: 21 },
  {
    source: "const x = <Box label=\"require('fake')\">text{import('pkg')}</Box>;",
    kind: 'dynamic-import',
    offset: 51,
    jsx: true,
  },
  {
    source: "function f(require) { require('fake'); } require('pkg');",
    kind: 'require',
    offset: 49,
  },
];

describe('positioned source occurrence collection', () => {
  it.each(cases)(
    'retains the actual literal token for $source',
    ({ source, kind, offset, jsx }) => {
      const options = { jsx: jsx ?? false };
      expect(collectModuleSpecifiers(source, options)).toEqual([
        { specifier: 'pkg', kind, position: { offset, line: 1, column: offset + 1 } },
      ]);
      expect(extractModuleSpecifiers(source, options)).toEqual([{ specifier: 'pkg', kind }]);
    },
  );

  it('measures original UTF-16 text across BOM, tabs, astral text and every line break', () => {
    const source =
      "\ufeff\t/*😀*/import 'one';\r\n" +
      "require('two');\r" +
      "import(\n  'three',\n);\u2028" +
      "export { x } from 'four';\u2029" +
      "\timport 'five';";
    expect(collectModuleSpecifiers(source)).toEqual([
      { specifier: 'one', kind: 'import', position: { offset: 15, line: 1, column: 16 } },
      { specifier: 'two', kind: 'require', position: { offset: 31, line: 2, column: 9 } },
      { specifier: 'three', kind: 'dynamic-import', position: { offset: 49, line: 4, column: 3 } },
      { specifier: 'four', kind: 'export-from', position: { offset: 79, line: 6, column: 19 } },
      { specifier: 'five', kind: 'import', position: { offset: 95, line: 7, column: 9 } },
    ]);
  });

  it('retains duplicate selectors at distinct offsets and decoded escaped spellings', () => {
    const source = "import 'same'; require('same');\nimport('sa\\x6de');";
    expect(collectModuleSpecifiers(source)).toEqual([
      { specifier: 'same', kind: 'import', position: { offset: 7, line: 1, column: 8 } },
      { specifier: 'same', kind: 'require', position: { offset: 23, line: 1, column: 24 } },
      { specifier: 'same', kind: 'dynamic-import', position: { offset: 39, line: 2, column: 8 } },
    ]);
  });

  it('counts escaped source line continuations without changing the decoded specifier', () => {
    const source = "require('pa\\\r\nckage');\nimport 'next';";
    expect(collectModuleSpecifiers(source)).toEqual([
      { specifier: 'package', kind: 'require', position: { offset: 8, line: 1, column: 9 } },
      { specifier: 'next', kind: 'import', position: { offset: 30, line: 3, column: 8 } },
    ]);
  });

  it('measures UTF-16 positions through skipped JSX text', () => {
    const source = "<Box>\r\n😀{require('pkg')}\u2028</Box>";
    expect(collectModuleSpecifiers(source, { jsx: true })).toEqual([
      { specifier: 'pkg', kind: 'require', position: { offset: 18, line: 2, column: 12 } },
    ]);
  });

  it('never finds an earlier duplicate in inert strings, comments, regex or template text', () => {
    const source =
      "\"require('pkg')\"; /* require('pkg') */ /require('pkg')/; `require('pkg')`;\nrequire('pkg');";
    expect(collectModuleSpecifiers(source)).toEqual([
      { specifier: 'pkg', kind: 'require', position: { offset: 83, line: 2, column: 9 } },
    ]);
  });

  it('keeps options expressions in encounter order without treating option strings as imports', () => {
    const source = "import('pkg', { note: 'fake', value: require('other') });";
    expect(collectModuleSpecifiers(source)).toEqual([
      { specifier: 'pkg', kind: 'dynamic-import', position: { offset: 7, line: 1, column: 8 } },
      { specifier: 'other', kind: 'require', position: { offset: 45, line: 1, column: 46 } },
    ]);
  });

  it('preserves the implicit module probe and its original source coordinates', () => {
    const source = "await /don't/;\nimport 'pkg';";
    expect(collectModuleSpecifiers(source, { module: 'detect' })).toEqual([
      { specifier: 'pkg', kind: 'import', position: { offset: 22, line: 2, column: 8 } },
    ]);
  });

  it.each(['/* unfinished', '"unfinished', '`unfinished', '/unfinished'])(
    'throws rather than returning partial positioned results before %s',
    (tail) => {
      expect(() => collectModuleSpecifiers("import 'before'; " + tail)).toThrow(
        ModuleSpecifierError,
      );
    },
  );

  it('keeps location work linear as references and long trivia grow together', () => {
    const block = '/*' + ' '.repeat(64) + "*/\r\nrequire('repeat');\n";
    const counts: number[] = [];
    for (const repetitions of [64, 256, 1024]) {
      const source = block.repeat(repetitions);
      let reads = 0;
      const methods = {
        length: source.length,
        codePointAt: source.codePointAt.bind(source),
        indexOf: source.indexOf.bind(source),
        startsWith: source.startsWith.bind(source),
        // Count copied units too, so per-occurrence prefix/suffix slicing is not invisible.
        slice: (start: number, end?: number): string => {
          const value = source.slice(start, end);
          reads += value.length;
          return value;
        },
      };
      const measured = new Proxy(methods, {
        get(target, key, receiver): unknown {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads++;
            return source[Number(key)];
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const result = collectModuleSpecifiers(measured as unknown as string);
      expect(result).toHaveLength(repetitions);
      expect(result.at(-1)?.position).toEqual({
        offset: block.length * (repetitions - 1) + 78,
        line: repetitions * 2,
        column: 9,
      });
      expect(reads).toBeGreaterThanOrEqual(source.length);
      expect(reads).toBeLessThanOrEqual(source.length * 8);
      counts.push(reads);
    }
    expect(counts[1]).toBeLessThan((counts[0] ?? 0) * 5);
    expect(counts[2]).toBeLessThan((counts[1] ?? 0) * 5);
  });
});
