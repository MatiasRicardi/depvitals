import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  extractModuleSpecifiers,
  ModuleSpecifierError,
} from '../../../src/scanner/moduleSpecifiers.js';
import { remainingParserCases } from '../../helpers/pr76RemainingCases.js';

const real = [{ specifier: 'real', kind: 'require' }] as const;

const forControls = [
  `for (const x of /require('fake')/.source) { require('real'); }`,
  `for (const x of /don't/.source) { require('real'); }`,
  `const of = 6; for (const of of of / require('real') / 2 ? [] : []) {}`,
  `const obj = { of: 6 }; for (const x of obj.of / require('real') / 2 ? [] : []) {}`,
  `const of = 6; for (let x = 0; x < of / require('real') / 2; x++) {}`,
  `const of = 6; for (const x in of / require('real') / 2 ? {} : {}) {}`,
  `async function f() { for await (const x of /require('fake')/.source) { require('real'); } }`,
  `const of = 6; for (const { x } of (of / require('real') / 2 ? [] : [])) {}`,
  `const of = 6; for (const [x] of (() => { for (const y of /require('fake')/.source) {} return of / require('real') / 2 ? [] : []; })()) {}`,
  `const of = 6; for (const x of []) {} of / require('real') / 2;`,
];

const assertionTypes = [
  'number',
  'Num<string>',
  'N.Inner.Num<Array<string>>',
  'Num<keyof { ok: boolean }>',
  'Num<readonly [number, { ok: boolean }]>',
  'Num<{ [K in keyof T as `get${K & string}`]: T[K] }>',
  'Num<() => { ok: boolean; value: Array<string> }>',
  'Num<abstract new (x: { ok: boolean }) => object>',
  'Num<[string, number] | ({ ok: boolean } & { n: number })>',
  'Num<`x${keyof { ok: boolean }}`>',
];

const comparisonControls = [
  `const as = 0, satisfies = 1; as < satisfies > /require('fake')/.source.length; require('real');`,
  `const obj = { as: 0, satisfies: 0 }; obj.as < x > /require('fake')/.source.length; obj.satisfies < x > /require('fake')/.source.length; require('real');`,
  `const as = 0; const f = () => as < x > /require('fake')/.source.length; require('real');`,
  `const as = 0; if (as < x) {} x > /require('fake')/.source.length; require('real');`,
  `const satisfies = 0; const n = satisfies << 2 >> 1; n > /require('fake')/.source.length; require('real');`,
  'const as = 0; const text = `${as < n}`; x > /require("fake")/.source.length; require("real");',
  `const as = 0; const value = as < n
{} x > /require('fake')/.source.length; require('real');`,
  `const as = 0; class C {} as < x > /require('fake')/.source.length; require('real');`,
  `const satisfies = 0; function f() {} satisfies < x > /require('fake')/.source.length; require('real');`,
  `const as = 0; if (flag) as < x > /require('fake')/.source.length; require('real');`,
  `class C extends (a < b > /require('fake')/.source.length ? Base : Other) {
    async run() { await /require('fake')/; require('real'); }
  }`,
];

describe('PR #76 remaining parser families', () => {
  it.each([
    'require("real"); const value = 1 as Num<`x${string',
    'require("real"); class C extends Base<`x${string',
  ])('keeps incomplete type templates on the original error channel: %s', (source) => {
    expect(() => extractModuleSpecifiers(source)).toThrow(
      expect.objectContaining({
        name: 'ModuleSpecifierError',
        code: 'invalid-source',
        offset: source.indexOf('${'),
      }),
    );
    expect(() => extractModuleSpecifiers(source)).toThrow(ModuleSpecifierError);
  });

  it.each([
    'Num<() => number>',
    'Num<(x: number) => number>',
    'Num<new () => { ok: boolean }>',
    'Num<`x${string}`>',
  ])('type %s cannot create a runtime function context', (type) => {
    const source = `async function outer() {
      const n = 1 as ${type} + await /require('fake')/;
      require('real');
    }`;
    expect(extractModuleSpecifiers(source)).toEqual(real);
    expect(
      ts.transpileModule(source, {
        fileName: 'assertion.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      }).diagnostics,
    ).toEqual([]);
  });

  it('preserves type imports, occurrence kinds, order and duplicates in assertions', () => {
    const source = `import type { Foo } from 'types';
      const a = value as N.Box<import('types').Foo> / require('real') / 2;
      const b = value as number satisfies N.Box<string> / require('real') / 2;
      const c = value as Num<string>, d = /require('fake')/;
      require('real');`;
    expect(extractModuleSpecifiers(source)).toEqual([
      { specifier: 'types', kind: 'import' },
      { specifier: 'types', kind: 'dynamic-import' },
      ...real,
      ...real,
      ...real,
    ]);
    expect(
      ts.transpileModule(source, {
        fileName: 'assertion.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      }).diagnostics,
    ).toEqual([]);
  });

  it('allows assertions on properties whose names are also declaration keywords', () => {
    const source = `const a = obj.class as N.Num<string> / require('real') / 2;
      const b = obj.type satisfies Num<keyof { ok: boolean }> / require('real') / 2;`;
    expect(extractModuleSpecifiers(source)).toEqual([...real, ...real]);
    expect(
      ts.transpileModule(source, {
        fileName: 'assertion.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      }).diagnostics,
    ).toEqual([]);
  });

  it.each([
    `class C extends class Base<T extends { ok: boolean }> {} {
      async run() { await /require('fake')/; require('real'); }
    }`,
    `const C = class extends Base<{ ok: boolean }> {
      async run() { await /require('fake')/; }
    } / require('real') / 2;`,
    `const C = class Named extends factory(class extends Base<{ ok: boolean }> {}) {
      async run() { await /require('fake')/; require('real'); }
    };`,
    `class C<T extends { ok: boolean }> extends base.class<{ ok: boolean }> implements I<[number, string]> {
      *generate() { yield /require('fake')/; require('real'); }
    }`,
    `class C extends factory<{ ok: boolean }>() {
      async run() { await /require('fake')/; require('real'); }
    }`,
    `const view = <p>require('fake')</p>;
      class C extends Base<{ ok: boolean }> {
        async run() { await /require('fake')/; require('real'); }
      }`,
  ])('nested and expression class header: %s', (source) => {
    const jsx = source.includes('<p>');
    expect(extractModuleSpecifiers(source, { jsx })).toEqual(real);
    expect(
      ts.transpileModule(source, {
        fileName: jsx ? 'heritage.tsx' : 'heritage.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve },
      }).diagnostics,
    ).toEqual([]);
  });

  for (const lineTerminator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    it.each([
      `/* first */ /* second */ --> require('fake')${lineTerminator}require('real');`,
      `const x = 1; /* comment${lineTerminator}*/ /* second */ --> require('fake')${lineTerminator}require('real');`,
      `let x = 1 <!-- require('fake')${lineTerminator}require('real');`,
      `require('real');${lineTerminator}/* comment */ --> require('fake')`,
    ])(`HTML trivia with ${JSON.stringify(lineTerminator)}: %s`, (source) => {
      expect(extractModuleSpecifiers(source)).toEqual(real);
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(syntax.error).toBeUndefined();
      expect(syntax.status, syntax.stderr).toBe(0);
    });
  }

  it('keeps inline decrement/comparison after a block comment as code', () => {
    const source = `let x = 2; x /* comment */ --> require('real');`;
    expect(extractModuleSpecifiers(source)).toEqual(real);
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(syntax.error).toBeUndefined();
    expect(syntax.status, syntax.stderr).toBe(0);
  });

  it.each(['<!--', '-->'])('does not enable %s after block trivia in modules', (marker) => {
    expect(
      extractModuleSpecifiers(`/* comment */ ${marker} require('real');`, { module: true }),
    ).toEqual(real);
  });

  for (const header of ['extends Base', 'implements I', 'extends N.Inner.Base']) {
    it.each([
      '{ ok: boolean }',
      '{ nested: { ok: boolean }; value: Array<string> }',
      '(x: { ok: boolean }) => { value: string }',
      '[string, { ok: boolean }]',
      '`x${keyof { ok: boolean }}`',
      '{ ok: boolean }, () => object',
    ])(`class header ${header}<%s>`, (type) => {
      const source = `class C ${header}<${type}> {
        value = () => {}
        other
        async run() { await /require('fake')/; require('real'); }
        *generate() { yield /require('fake')/; }
        ordinary(await) { return await / require('real') / 2; }
      }`;
      expect(extractModuleSpecifiers(source)).toEqual([...real, ...real]);
      const syntax = ts.transpileModule(source, {
        fileName: 'heritage.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      });
      expect(syntax.diagnostics).toEqual([]);
    });
  }

  for (const operator of ['as', 'satisfies']) {
    it.each(assertionTypes)(`${operator} owns type %s`, (type) => {
      const source = `const value = 1 ${operator} ${type} / require('real') / 2;
        /require('fake')/.test('');
        require('real');`;
      expect(extractModuleSpecifiers(source)).toEqual([...real, ...real]);
      const syntax = ts.transpileModule(source, {
        fileName: 'assertion.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext },
      });
      expect(syntax.diagnostics).toEqual([]);
    });
  }

  it.each(comparisonControls)('comparison control: %s', (source) => {
    expect(extractModuleSpecifiers(source)).toEqual(real);
    const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(forControls)('for header ownership: %s', (source) => {
    expect(extractModuleSpecifiers(source)).toEqual(real);
    const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(remainingParserCases)('$name extracts exactly the real require', ({ source }) => {
    expect(extractModuleSpecifiers(source, { jsx: false, module: false })).toEqual(real);
  });

  it.each(remainingParserCases)('$name has valid syntax without executing code', (scenario) => {
    if (scenario.fileName.endsWith('.ts')) {
      const result = ts.transpileModule(scenario.source, {
        fileName: scenario.fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
      });
      expect(result.diagnostics).toEqual([]);
    } else {
      const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: scenario.source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    }
  });
});
