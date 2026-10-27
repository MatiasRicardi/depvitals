import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  extractModuleSpecifiers,
  type ModuleSpecifierOccurrence,
} from '../../../src/scanner/moduleSpecifiers.js';

type Reproduction = {
  readonly id: string;
  readonly fileName: string;
  readonly source: string;
  readonly jsx?: boolean;
  readonly module?: boolean;
};

const expected: readonly ModuleSpecifierOccurrence[] = [{ specifier: 'real', kind: 'require' }];
const reproductions: readonly Reproduction[] = [
  {
    id: 'F1.1 generic template in function declaration',
    fileName: 'index.ts',
    source: `async function f<T = \`x\${string}\`>(x: T) {
      await /require("fake")/;
      require("real");
    }`,
  },
  {
    id: 'F1.2 generic template in arrow',
    fileName: 'index.ts',
    source: `const f = async <T = \`x\${string}\`>(x: T) => {
      await /require("fake")/; require("real");
    };`,
  },
  {
    id: 'F1.3 generic template in method',
    fileName: 'index.ts',
    source: `class C { async f<T = \`x\${string}\`>(x: T) {
      await /require("fake")/; require("real");
    } }`,
  },
  {
    id: 'F2.1 inline class in class heritage',
    fileName: 'index.cjs',
    source: `class C extends class {} {
      async run() { await /require('fake')/; require('real'); }
    }`,
  },
  {
    id: 'F2.2 class expression with class property in heritage',
    fileName: 'index.cjs',
    source: `const C = class extends base.class {} / require('real') / 2;`,
  },
  {
    id: 'F2.3 class property before ordinary object method',
    fileName: 'index.cjs',
    source: `async function outer() {
      const o = { x: base.class,
        run(await) { return await / require('real') / 2; }
      };
    }`,
  },
  {
    id: 'F3.1 prefix increment after arrow ASI',
    fileName: 'index.cjs',
    source: `const f = async () => value
      ++await / require('real') / 2;`,
  },
  {
    id: 'F3.2 prefix decrement after arrow ASI',
    fileName: 'index.cjs',
    source: `const f = async () => value
      --await / require('real') / 2;`,
  },
  {
    id: 'F4.1 Unicode identifier suffix',
    fileName: 'index.cjs',
    source: `const πrequire = () => {};
      πrequire('fake');
      require('real');`,
  },
  {
    id: 'F4.2 escaped require identifier',
    fileName: 'index.cjs',
    source: String.raw`requ\u0069re('real');`,
  },
  {
    id: 'F5.1 private require member call',
    fileName: 'index.cjs',
    source: `class C {
      #require() {}
      run() { this.#require('fake'); require('real'); }
    }`,
  },
  {
    id: 'F5.2 private import member call',
    fileName: 'index.cjs',
    source: `class C {
      #import() {}
      run() { this.#import('fake'); require('real'); }
    }`,
  },
  {
    id: 'F6.1 export variable followed by string statement',
    fileName: 'index.mjs',
    module: true,
    source: `const from = 1;
      export const x = from
      'fake';
      require('real');`,
  },
  {
    id: 'F6.2 local export followed by from string statements',
    fileName: 'index.mjs',
    module: true,
    source: `const x = 1, from = 2;
      export { x };
      from
      'fake';
      require('real');`,
  },
  {
    id: 'F7.1 for-of regex operand',
    fileName: 'index.cjs',
    source: `for (const x of /require('fake')/.source) {
      require('real');
    }`,
  },
  {
    id: 'F7.2 for-of regex apostrophe',
    fileName: 'index.cjs',
    source: `for (const x of /don't/.source) {
      require('real');
    }`,
  },
  {
    id: 'F8.1 return line terminator before object block',
    fileName: 'index.cjs',
    source: `function f() {
      return
      {} /require('fake')/.test('');
      require('real');
    }`,
  },
  {
    id: 'F8.2 break line terminator before regex',
    fileName: 'index.cjs',
    source: `while (flag) {
      break
      /require('fake')/.test('');
      require('real');
    }`,
  },
  {
    id: 'F9.1 generic TypeScript as expression',
    fileName: 'index.ts',
    source: `type Num<T> = number;
      const n = 1 as Num<string> / require('real') / 2;`,
  },
  {
    id: 'F9.2 generic TypeScript satisfies expression',
    fileName: 'index.ts',
    source: `type Num<T> = number;
      const n = 1 satisfies Num<string> / require('real') / 2;`,
  },
  {
    id: 'F9.3 TypeScript non-null assertion',
    fileName: 'index.ts',
    source: `const value: number | undefined = 1;
      const n = value! / require('real') / 2;`,
  },
  {
    id: 'F10 export default function declaration',
    fileName: 'index.mjs',
    module: true,
    source: `export default function f() {}
      /require('fake')/.test('');
      require('real');`,
  },
  {
    id: 'F11.1 Annex B opening HTML comment',
    fileName: 'index.cjs',
    source: `<!-- require('fake')
      require('real');`,
  },
  {
    id: 'F11.2 Annex B closing HTML comment',
    fileName: 'index.cjs',
    source: `--> require('fake')
      require('real');`,
  },
  {
    id: 'F12.1 ordinary nested function parameter grammar',
    fileName: 'index.cjs',
    source: `async function outer() {
      function inner(x = await / require('real') / 2) {}
    }`,
  },
  {
    id: 'F12.2 ordinary method parameter grammar',
    fileName: 'index.cjs',
    source: `async function outer() {
      const o = { inner(x = await / require('real') / 2) {} };
    }`,
  },
  {
    id: 'F13 instance field initializer has its own await grammar',
    fileName: 'index.cjs',
    source: `async function outer() {
      class C { value = await / require('real') / 2; }
    }`,
  },
  {
    id: 'F14 generic call does not become an arrow signature',
    fileName: 'index.ts',
    source: `const value = a ? b ? c : f<T>() : async () => {
      await /require('fake')/;
      require('real');
    };`,
  },
  {
    id: 'F15 multiline abstract constructor field type',
    fileName: 'index.ts',
    source: `class C {
      value!: abstract
        new () => object
      async run() { await /require('fake')/; require('real'); }
    }`,
  },
  {
    id: 'F16 JSX implements boolean attributes',
    fileName: 'index.jsx',
    jsx: true,
    source: `const view = <P implements enabled>require('fake')</P>;
      require('real');`,
  },
  {
    id: 'F17.1 module mode in JSX project',
    fileName: 'index.jsx',
    jsx: true,
    module: true,
    source: `const view = <p />;
      await /require('fake')/;
      require('real');
      export {};`,
  },
  {
    id: 'F17.2 module mode in TSX project',
    fileName: 'index.tsx',
    jsx: true,
    module: true,
    source: `const view = <p />;
      await /require('fake')/;
      require('real');
      export {};`,
  },
  {
    id: 'F18.1 arrow expression context ends at outer conditional colon',
    fileName: 'index.cjs',
    source: `async function outer() {
      const f = flag ? () => 0 : await /require('fake')/;
      require('real');
    }`,
  },
  {
    id: 'F18.2 async arrow context ends at outer conditional colon',
    fileName: 'index.cjs',
    source: `const f = flag ? async () => 0 : await / require('real') / 2;`,
  },
  {
    id: 'F19.1 default arrow context removed after outer declaration',
    fileName: 'index.cjs',
    source: `async function outer() {
      const f = (cb = () => 0) => 0;
      await /require('fake')/;
      require('real');
    }`,
  },
  {
    id: 'F19.2 async default arrow context removed before CommonJS await',
    fileName: 'index.cjs',
    source: `const f = (cb = async () => 0) => 0;
      await / require('real') / 2;`,
  },
  {
    id: 'F20.1 newline inside generic async arrow parameters',
    fileName: 'index.ts',
    source: `const f = async <T,
      U>(x: T) => {
      await /require('fake')/;
      require('real');
    };`,
  },
  {
    id: 'F20.2 newline inside generic async constraint',
    fileName: 'index.ts',
    source: `const f = async <T extends
      object>(x: T) => {
      await /require('fake')/;
      require('real');
    };`,
  },
];

type Control = {
  readonly name: string;
  readonly source: string;
  readonly expected?: readonly ModuleSpecifierOccurrence[];
  readonly jsx?: boolean;
  readonly module?: boolean;
  readonly typescript?: boolean;
};

const controls: readonly Control[] = [
  {
    name: 'generic defaults preserve type imports, neighboring methods, order and duplicates',
    typescript: true,
    source: `import type { T } from 'types';
      async function f<U = { value: \`x\${string}\` }>(value: U) {
        await /require('fake')/; require('real'); require('real');
      }
      class C { async run<U = () => object>(value: U) {
        await /require('fake')/; require('real');
      } }`,
    expected: [
      { specifier: 'types', kind: 'import' },
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'nested templates in mapped, parameter, field and return types retain literal imports',
    typescript: true,
    source: `import type { Foo } from 'types';
      type M<T> = { [K in keyof T as \`x\${K & string}\`]: T[K] };
      type Nested = \`x\${\`y\${string}\`}\`;
      function f(x: { tag: \`x\${string}\` }, y: import('types').Foo): { tag: \`x\${string}\` } {
        return { tag: \`x\${String(y)}\` };
      }
      class C { value!: { tag: \`x\${string}\` }; }
      require('real');`,
    expected: [
      { specifier: 'types', kind: 'import' },
      { specifier: 'types', kind: 'dynamic-import' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'nested class heritage and property names retain method owner',
    source: `class C extends factory(class {}) {
      run(await) { return await / require('real') / 2; }
    }`,
  },
  {
    name: 'Unicode names and identifier escapes respect exact identifier identity',
    source: `const xrequire = () => {}; const πimport = () => {};
      xrequire('fake'); πimport('fake');
      requ\\u0069re('real');`,
  },
  {
    name: 'private optional calls do not become globals',
    source: `class C {
      #require() {} #import() {}
      run() { this?.#require('fake'); this?.#import('fake'); require('real'); }
    }`,
  },
  {
    name: 'module local exports do not consume later from strings',
    module: true,
    typescript: true,
    source: `const from = 1, x = 2;
      export type { T } from 'types';
      export { x };
      from
      /* comment */ 'fake';
      export { x as y } from 'real';`,
    expected: [
      { specifier: 'types', kind: 'export-from' },
      { specifier: 'real', kind: 'export-from' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'for-of context does not reserve ordinary of or properties',
    source: `const of = /require('real')/.source;
      obj.of / require('real') / 2;
      for (const x of (/require('fake')/.source)) require('real');`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'postfix updates end operands without merging separated prefix punctuation',
    source: `let n = 0; const obj = { n: 0 };
      const a = n++ / require('real') / 2;
      const b = obj.n-- / require('real') / 2;
      const c = n + +obj.n;
      const d = --n + obj.n++;`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'line terminator after return does not change same-line return expression',
    source: `function f() {
      return {} / require('real') / 2;
      require('real');
    }`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'restricted productions preserve regex statements across line terminators and comments',
    source: `function f() {
        return /*\r\n*/ {} /require('fake-return')/.test('');
      }
      function* g() { yield\u2028/require('fake-yield')/.test(''); }
      while (flag) { break /*\u2029*/ /require('fake-break')/.test(''); }
      outer: while (flag) { continue\r outer; }
      require('real');`,
  },
  {
    name: 'TypeScript type operators do not change prefix and comparison meanings',
    typescript: true,
    source: `const value: number | undefined = 1;
      const a = !value !== (value! < 2);
      type Num<T> = number;
      const b = 1 as Num<Array<string>> / require('real') / 2;
      const c = 1 satisfies Num<Array<string>> / require('real') / 2;`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'TypeScript postfix assertions remain distinct from prefix and comparison operators',
    typescript: true,
    source: `const value: number | undefined = 1;
      const a = !value !== (value! < 2);
      const b = value != null;
      const c = value !== 0;
      const d = value! / require('real') / 2;`,
  },
  {
    name: 'exported function expressions remain expressions',
    module: true,
    source: `export default (function f() {}) / require('real') / 2;`,
  },
  {
    name: 'default generator declaration leaves following regex inert',
    module: true,
    source: `export default function* f() { yield /require('fake')/; }
      /require('fake-too')/.test('');
      require('real');`,
  },
  {
    name: 'HTML comments are script-only and line-anchored',
    source: `  <!-- require('fake')
      require('real');`,
  },
  {
    name: 'outer async parameters do not affect ordinary function parameters',
    source: `async function outer() {
      function inner(x = await / require('real') / 2) {}
      class C { value = await / require('real') / 2; }
    }`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'generic calls, nested conditional arrows and class initializers restore contexts',
    typescript: true,
    source: `const value = a ? b ? c : f<T>() : async () => {
        await /require('fake')/; require('real');
      };
      async function outer() {
        const f = flag ? () => 0 : await /require('fake')/;
        const g = (cb = async () => 0) => 0;
        class C { value!: abstract
          new () => object
          run(await) { return await / require('real') / 2; }
          field = await / require('real') / 2; }
      }`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'require' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
  {
    name: 'an arrow-owned ternary colon does not end its expression context',
    source: `const f = async () => flag ? await /require('fake')/ : await /require('fake')/;
      require('real');`,
  },
  {
    name: 'nested default arrows retire before the outer declaration ends',
    source: `async function outer() {
        const f = (cb = async () => { await /require('fake')/; }) => 0;
        await /require('fake-too')/;
        require('real');
      }`,
  },
  {
    name: 'async line break is only checked before generic parameters',
    typescript: true,
    source: `const f = async <T,
        U extends object>(x: T, y: U) => {
        await /require('fake')/;
        require('real');
      };`,
  },
  {
    name: 'TypeScript TSX generic async list accepts line breaks and JSX tags',
    typescript: true,
    jsx: true,
    source: `const f = async <T extends
        object, U = { value: \`x\${string}\` }>(x: T, y: U) => {
        const view = <P implements enabled>require('fake-jsx')</P>;
        await /require('fake')/; require('real');
      };`,
  },
  {
    name: 'module JSX option and module syntax preserve exact occurrence kind',
    jsx: true,
    module: true,
    source: `const view = <p />;
      await /require('fake')/; require('real');
      export { view } from 'real'; import('real');`,
    expected: [
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'export-from' },
      { specifier: 'real', kind: 'dynamic-import' },
    ] satisfies readonly ModuleSpecifierOccurrence[],
  },
];

describe('PR #76 twenty parser families', () => {
  it.each(reproductions)('$id', ({ source, jsx, module }) => {
    expect(extractModuleSpecifiers(source, { jsx: jsx ?? false, module: module ?? false })).toEqual(
      expected,
    );
  });

  it.each(controls)('control: $name', ({ source, expected: explicit, jsx, module }) => {
    expect(extractModuleSpecifiers(source, { jsx: jsx ?? false, module: module ?? false })).toEqual(
      explicit ?? expected,
    );
  });

  it('checks every JavaScript reproduction without executing its body', () => {
    for (const reproduction of reproductions.filter(
      (entry) => entry.fileName.endsWith('.cjs') || entry.fileName.endsWith('.mjs'),
    )) {
      const result = spawnSync(
        process.execPath,
        ['--check', `--input-type=${reproduction.module ? 'module' : 'commonjs'}`],
        {
          input: reproduction.source,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.error, reproduction.id).toBeUndefined();
      expect(result.status, `${reproduction.id}\n${result.stderr}`).toBe(0);
    }
  });

  it('checks TypeScript and JSX/TSX syntax with the existing development compiler', () => {
    for (const reproduction of reproductions.filter(
      (entry) =>
        entry.fileName.endsWith('.ts') ||
        entry.fileName.endsWith('.tsx') ||
        entry.fileName.endsWith('.jsx'),
    )) {
      const result = ts.transpileModule(reproduction.source, {
        fileName: reproduction.fileName,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: reproduction.module ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.Preserve,
          allowJs: reproduction.fileName.endsWith('.jsx'),
        },
      });
      expect(result.diagnostics, reproduction.id).toEqual([]);
    }

    for (const control of controls.filter((entry) => entry.typescript === true)) {
      const fileName = control.jsx === true ? 'control.tsx' : 'control.ts';
      const result = ts.transpileModule(control.source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          target: ts.ScriptTarget.ESNext,
          module: control.module ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.Preserve,
        },
      });
      expect(result.diagnostics, control.name).toEqual([]);
    }
  });

  it.each([
    `require('real'); const value = 'unterminated`,
    `require('real'); /* unterminated`,
    `require('real'); const value = /unterminated`,
    'require("real"); const value = `unterminated',
    'require("real"); const value = <p>',
  ])('keeps incomplete lexical input as an error without partial extraction', (source) => {
    expect(() => extractModuleSpecifiers(source, { jsx: source.includes('<p>') })).toThrow();
  });

  it.each([String.raw`requ\u{110000}ire('real')`, String.raw`requ\u00G0ire('real')`])(
    'keeps invalid identifier escapes on the lexical error channel',
    (source) => {
      expect(() => extractModuleSpecifiers(source)).toThrow('Invalid Unicode escape in identifier');
    },
  );

  it('checks the syntax of every control without executing JavaScript bodies', () => {
    for (const control of controls) {
      if (control.typescript === true || control.jsx === true) {
        const result = ts.transpileModule(control.source, {
          fileName: control.jsx === true ? 'control.tsx' : 'control.ts',
          reportDiagnostics: true,
          compilerOptions: {
            target: ts.ScriptTarget.ESNext,
            module: control.module ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.Preserve,
          },
        });
        expect(result.diagnostics, control.name).toEqual([]);
        continue;
      }

      const result = spawnSync(
        process.execPath,
        ['--check', `--input-type=${control.module ? 'module' : 'commonjs'}`],
        {
          input: control.source,
          encoding: 'utf8',
          timeout: 10_000,
        },
      );
      expect(result.error, control.name).toBeUndefined();
      expect(result.status, `${control.name}\n${result.stderr}`).toBe(0);
    }
  });
});
