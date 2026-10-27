import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  extractModuleSpecifiers,
  ModuleSpecifierError,
} from '../../../src/scanner/moduleSpecifiers.js';
import { assertionBoundaryCases } from '../../helpers/pr76AssertionBoundaryCases.js';

describe('PR #76 assertion boundaries', () => {
  it.each(assertionBoundaryCases)('$name preserves exact occurrences', ({ source, expected }) => {
    expect(extractModuleSpecifiers(source, { jsx: false, module: false })).toEqual(expected);
  });

  it.each(assertionBoundaryCases)(
    '$name has valid syntax without execution',
    ({ source, fileName }) => {
      if (fileName.endsWith('.cjs')) {
        const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
          input: source,
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      } else {
        expect(
          ts.transpileModule(source, {
            fileName,
            reportDiagnostics: true,
            compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
          }).diagnostics,
        ).toEqual([]);
      }
    },
  );
});

const real = [{ specifier: 'real', kind: 'require' }] as const;
const types = [{ specifier: 'types', kind: 'dynamic-import' }] as const;

const rootTypes = [
  'number',
  'Num<string>',
  'number & {}',
  'number | { ok: boolean }',
  '[number, { ok: boolean }]',
  'number[]',
  '({ ok: boolean } & number)',
  '1',
  '-1',
  '- /* trivia */ 1',
  '`x${keyof { ok: boolean }}`',
  '() => { ok: boolean }',
  'Num<string> | number & ({ ok: boolean } | [number])',
  'Num<string> extends number ? Num<string> : ({ ok: boolean } & number)',
  'number extends number ? number extends string ? {} : Num<number> : never',
  'number extends number ? string : number extends string ? {} : Num<number>',
  'N.Inner.Num<string>',
];

const prelude =
  'type Num<T> = number; namespace N { export namespace Inner { export type Num<T> = number; } }';

for (const operator of ['as', 'satisfies']) {
  describe(`root and nested types with ${operator}`, () => {
    for (const type of rootTypes) {
      it.each([type, `Num<${type}>`])('division after %s', (operand) => {
        const source = `${prelude}
          const n = 1 ${operator} ${operand} / require('real') / 2;
          /require('fake')/.test('');`;
        expect(extractModuleSpecifiers(source)).toEqual(real);
        expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
      });

      it(`class ASI after ${type}`, () => {
        const source = `${prelude}
          class C {
            field = 1 ${operator} ${type}
            async run() { await /require('fake')/; require('real'); }
            other = 1 ${operator} ${type}
            async *generate() { yield /require('fake')/; await /require('fake')/; }
            ordinary(await) { return await / require('real') / 2; }
          }`;
        expect(extractModuleSpecifiers(source)).toEqual([...real, ...real]);
        expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
      });
    }

    it.each([
      "import('types')",
      "typeof import('types')",
      "import('types').Num<string>",
      "import('types').N.Inner.Num<string>",
      "typeof import('types').N.Inner",
      "import('types').Num<string> | number & {}",
    ])('type query %s owns its call and suffix', (type) => {
      const source = `const n = value ${operator} ${type} / require('real') / 2;`;
      expect(extractModuleSpecifiers(source)).toEqual([...types, ...real]);
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
    });

    it.each([
      `async function outer(x = (() => 1 ${operator} Num<string> | number / require('real') / 2)()): Promise<void> { await /require('fake')/; }`,
      `async function outer() { class C { field = (() => 1 ${operator} number & {} / require('real') / 2)()
async run() { await /require('fake')/; } } await /require('fake')/; }`,
      `async function f() { const n = flag ? 1 ${operator} number & {} : await /require('fake')/; require('real'); }`,
      `async function f() { const n = 1 ${operator} Num<string> ? await /require('fake')/ : require('real'); }`,
      'async function f() { const n = 1 ' +
        operator +
        " `x${number extends number ? 'yes' : 'no'}` ? await /require('fake')/ : require('real'); }",
      `const f = (n = 1 ${operator} number & {} / require('real') / 2) => n;`,
      `const f = () => 1 ${operator} Num<string> | number / require('real') / 2;`,
      `function f() { return 1 ${operator} (number & {}) / require('real') / 2; }`,
      `async function f() { const n = 1 ${operator} (() => {}) + await /require('fake')/; require('real'); }`,
      `const a = 1 ${operator} number & {}, b = 2 ${operator} Num<string> / require('real') / 2;`,
      'const text = `${(1 ' +
        operator +
        " number & {}) / require('real') / 2}`; /require('fake')/.test('');",
      'const text = `${1 ' +
        operator +
        " number & {}}`; x > /require('fake')/.source.length; require('real');",
      `const n = (1 ${operator} number & {}) as Num<string> / require('real') / 2;`,
      `const n = 1 ${operator} number & {} satisfies Num<string> / require('real') / 2;`,
      `const n = 1 /* trivia */ ${operator} /*
*/ Num<string> | number / require('real') / 2;`,
    ])('restores the owner at a runtime boundary: %s', (source) => {
      expect(extractModuleSpecifiers(source)).toEqual(real);
      expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
    });
  });
}

describe('runtime lookalikes and assertion error channels', () => {
  it.each([
    "const n = 1 as const / require('real') / 2;",
    "const n = 1 as const satisfies number / require('real') / 2;",
    "const n = 1 as const satisfies Num<string> / require('real') / 2;",
    "const n = 1 as number > /require('fake')/.source.length; require('real');",
    "const n = 1 as number === /require('fake')/.source.length; require('real');",
    "const n = 1 as number || /require('fake')/.source.length; require('real');",
    "const n = 1 as number && /require('fake')/.source.length; require('real');",
    "const n = 1 as number << 2 > /require('fake')/.source.length; require('real');",
  ])('runtime operators retain their role: %s', (source) => {
    expect(extractModuleSpecifiers(source)).toEqual(real);
    expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
  });

  it('keeps runtime and type imports ordered and duplicated', () => {
    const source = `import type { T } from 'types';
      const n = x as import('types').N<T> / require('real') / 2;
      import('types').then(() => /require('fake')/);
      const m = x satisfies typeof import('types') / require('real') / 2;`;
    expect(extractModuleSpecifiers(source)).toEqual([
      { specifier: 'types', kind: 'import' },
      ...types,
      ...real,
      ...types,
      ...types,
      ...real,
    ]);
    expect(ts.transpileModule(source, { reportDiagnostics: true }).diagnostics).toEqual([]);
  });

  for (const operator of ['as', 'satisfies']) {
    it.each([
      `const ${operator} = 0, x = 1; x
/* trivia */ ${operator} < x > /require('fake')/.source.length; require('real');`,
      `const ${operator} = 0; const n = x + ${operator} < x > /require('fake')/.source.length; require('real');`,
      `const obj = { ${operator}: 0 }; obj.${operator} < x > /require('fake')/.source.length; require('real');`,
      `const ${operator} = 0; const n = () => ${operator} << 1 > /require('fake')/.source.length; require('real');`,
    ])('JavaScript variable/property/comparison: %s', (source) => {
      expect(extractModuleSpecifiers(source)).toEqual(real);
      const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    });
  }

  it.each([
    'require("real"); const n = 1 as Num<string> | `x${string',
    'require("real"); const n = 1 satisfies number & { tag: `x${string',
  ])('incomplete assertion templates throw with the original offset', (source) => {
    expect(() => extractModuleSpecifiers(source)).toThrow(ModuleSpecifierError);
    expect(() => extractModuleSpecifiers(source)).toThrow(
      expect.objectContaining({
        code: 'invalid-source',
        offset: source.indexOf('${'),
      }),
    );
  });
});
