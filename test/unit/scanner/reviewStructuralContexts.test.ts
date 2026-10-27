import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  extractModuleSpecifiers,
  ModuleSpecifierError,
  type ModuleSpecifierOccurrence,
} from '../../../src/scanner/moduleSpecifiers.js';

type Scenario = {
  name: string;
  source: string;
  typescript?: boolean;
  jsx?: boolean;
  module?: boolean;
  expected?: readonly ModuleSpecifierOccurrence[];
};
const real: readonly ModuleSpecifierOccurrence[] = [{ specifier: 'real', kind: 'require' }];
const asyncBody = `await /require('fake')/; require('real');`;
const generatorBody = `yield /require('fake')/; require('real');`;
const ordinaryBody = `return await / require('real') / 2;`;
const cases: Scenario[] = [];

for (const [typeName, type, imports] of [
  ['object template', '{ tag: `x${string}` }', []],
  ['mapped template', '{ [K in keyof T as `get${K & string}`]: T[K] }', []],
  ['nested template', '{ tag: `x${`y${string}`}` }', []],
  ['internal delimiters', '{ tag: `x${keyof { a: [string, number] }}` }', []],
  ['conditional interpolation', '{ tag: `x${T extends { a: number } ? "a" : "b"}` }', []],
  [
    'literal type import',
    '{ tag: `x${import("types").Name}` }',
    [{ specifier: 'types', kind: 'dynamic-import' }],
  ],
] as const) {
  for (const [owner, source] of [
    ['field', `class C { value!: ${type}; } require('real');`],
    ['parameter', `function f(x: ${type}) {} require('real');`],
    ['return', `function f(): ${type} { require('real'); return null as never; }`],
  ] as const) {
    cases.push({
      name: `templates: ${owner} / ${typeName}`,
      source,
      typescript: true,
      expected: [...imports, ...real],
    });
  }
}

for (const container of ['object', 'class'] as const) {
  for (const name of ['run', 'return', "'run'", '1', '[key]', 'function']) {
    for (const [modifier, parameters, body] of [
      ['', 'await', ordinaryBody],
      ['async ', '', asyncBody],
      ['*', '', generatorBody],
      ['async *', '', `${asyncBody} yield /require('fake-yield')/;`],
    ] as const) {
      const member = `${modifier}${name}(${parameters}) { ${body} }`;
      cases.push({
        name: `methods: ${container} / ${modifier}${name}`,
        source: `async function outer() {
          ${container === 'object' ? `const o = { ${member} };` : `class C { ${member} }`}
          await /require('fake-outer')/;
        }`,
      });
    }
  }
}

for (const generic of [
  'T extends { value: number }',
  'T extends (object)',
  'T = () => void',
  'T extends Map<string, { call: (x: number) => void }>',
  'T = (x: { value: number }) => Promise<{ ok: boolean }>',
]) {
  for (const [shape, source] of [
    ['arrow', `const f = async <${generic}>(x: T) => { ${asyncBody} };`],
    ['method', `class C { async run<${generic}>(x: T) { ${asyncBody} } }`],
    ['function', `async function f<${generic}>(x: T) { ${asyncBody} }`],
    [
      'TSX arrow',
      `const f = async <${generic},>(x: T) => { const view = <p>require('fake-jsx')</p>; ${asyncBody} };`,
    ],
  ] as const) {
    cases.push({
      name: `generics: ${shape} / ${generic}`,
      source,
      typescript: true,
      jsx: shape === 'TSX arrow',
    });
  }
}

for (const operator of ['++', '--']) {
  for (const operand of ['n', 'obj.value', 'obj[key]']) {
    cases.push(
      {
        name: `postfix: ${operand}${operator} division`,
        source: `let n = 1; const value = ${operand}${operator} / require('real') / 2;`,
      },
      {
        name: `postfix: field ${operand}${operator}`,
        source: `let n = 1; class C { value = ${operand}${operator}
        async run() { ${asyncBody} } }`,
      },
      {
        name: `prefix: ${operator}${operand} division`,
        source: `let n = 1; const value = ${operator}${operand} / require('real') / 2;`,
      },
    );
  }
}

for (const operator of ['in', 'instanceof']) {
  for (const boundary of ['\n', '\r\n', '\r', '\u2028', '\u2029', '/*\n*/']) {
    for (const field of [false, true]) {
      cases.push({
        name: `word continuation: ${operator} / ${JSON.stringify(boundary)} / field=${String(field)}`,
        source: `${field ? 'class C { value' : 'const f'} = async () => value${boundary}${operator} /* comment */ Object ? await /require('fake')/ : require('real');${field ? ' }' : ''}`,
      });
    }
  }
}

for (const declaration of [
  'class {}',
  'class Named {}',
  'class extends Base {}',
  'class Named extends Base {}',
  'class extends factory({ value: 1 }) {}',
  'class extends (class {}) {}',
]) {
  for (const [position, source] of [
    ['assignment', `const value = ${declaration} / require('real') / 2;`],
    ['argument', `consume(${declaration} / require('real') / 2);`],
    ['return', `function f() { return ${declaration} / require('real') / 2; }`],
    ['arrow return', `const f = () => ${declaration} / require('real') / 2;`],
    ['field', `class C { handle = ${declaration}\n / require('real') / 2; }`],
  ] as const) {
    cases.push({ name: `class expression: ${position} / ${declaration}`, source });
  }
}

cases.push(
  {
    name: 'control: actual return of async arrow',
    source: `function f() { return async () => { ${asyncBody} }; }`,
  },
  {
    name: 'control: actual return and parenthesized expression',
    source: `async function f() { return (await /require('fake')/) || require('real'); }`,
  },
  {
    name: 'control: ordinary call is not a method',
    source: `async function f() { obj.return(await /require('fake')/); require('real'); }`,
  },
  {
    name: 'control: class declaration before regex',
    source: `class C {} /require('fake')/.test(value); require('real');`,
  },
  {
    name: 'control: derived class declaration before regex',
    source: `class C extends Base {} /require('fake')/.test(value); require('real');`,
  },
  {
    name: 'control: exported default class declaration before regex',
    source: `export default class C {} /require('fake')/.test(value); require('real');`,
    module: true,
  },
  {
    name: 'control: anonymous default class declaration before regex',
    source: `export default class {} /require('fake')/.test(value); require('real');`,
    module: true,
  },
  {
    name: 'control: derived declaration with nested heritage before regex',
    source: `class C extends factory({ value: 1 }) {} /require('fake')/.test(value); require('real');`,
  },
  { name: 'control: separated plus punctuation', source: `const v = n + +require('real') / 2;` },
  { name: 'control: separated minus punctuation', source: `const v = n - -require('real') / 2;` },
  {
    name: 'control: plus separated by a comment is not an update',
    source: `const v = n + /* trivia */ +require('real') / 2;`,
  },
  {
    name: 'control: prefix before regex operand',
    source: `const v = ++/require('fake')/.lastIndex; require('real');`,
  },
  {
    name: 'control: postfix with intervening same-line trivia',
    source: `let n = 1; const v = n /* trivia */ ++ / require('real') / 2;`,
  },
  {
    name: 'control: postfix cannot cross a comment line break',
    source: `let n = 1; n /*\n*/ ++obj.value / require('real') / 2;`,
  },
  {
    name: 'control: postfix cannot cross a line break',
    source: `let n = 1; n\n ++obj.value / require('real') / 2;`,
  },
  {
    name: 'control: arrow ends before ordinary await identifier',
    source: `const f = async () => value\n await / require('real') / 2;`,
  },
  {
    name: 'control: property in is not an operator',
    source: `const f = async () => obj.in\n await / require('real') / 2;`,
  },
  {
    name: 'control: property instanceof is not an operator',
    source: `const f = async () => obj.instanceof\n await / require('real') / 2;`,
  },
  {
    name: 'control: property in ends a class field before a method',
    source: `class C { value = async () => obj.in
      async run() { ${asyncBody} } }`,
  },
  {
    name: 'control: property instanceof ends a class field before a method',
    source: `class C { value = async () => obj.instanceof
      async run() { ${asyncBody} } }`,
  },
  {
    name: 'control: comparison is not generic parameters',
    source: `const value = a < b && c > require('real');`,
  },
  {
    name: 'preserves decoded strings, kinds, ordering and duplicates across fixes',
    typescript: true,
    source:
      'import type { A } from "types"; function f(x: { tag: `x${import("types").Name}` }) {} const v = class {} / require("re\\u0061l") / 2; export { A } from "types"; require("real"); import("real");',
    expected: [
      { specifier: 'types', kind: 'import' },
      { specifier: 'types', kind: 'dynamic-import' },
      { specifier: 'real', kind: 'require' },
      { specifier: 'types', kind: 'export-from' },
      { specifier: 'real', kind: 'require' },
      { specifier: 'real', kind: 'dynamic-import' },
    ],
  },
);

describe('PR 76 review structural regressions', () => {
  it.each(cases)('$name', ({ source, expected, jsx, module }) => {
    expect(extractModuleSpecifiers(source, { jsx: jsx ?? false, module: module ?? false })).toEqual(
      expected ?? real,
    );
  });

  it('validates new JavaScript syntax without running analyzed code', () => {
    const source = cases
      .filter((entry) => !entry.typescript && !entry.module)
      .map((entry) => `{ ${entry.source} }`)
      .join('\n');
    const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    for (const entry of cases.filter((entry) => entry.module)) {
      const checked = spawnSync(process.execPath, ['--check', '--input-type=module'], {
        input: entry.source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(checked.error).toBeUndefined();
      expect(checked.status, checked.stderr).toBe(0);
    }
  });

  it('validates new TypeScript and TSX syntax', () => {
    for (const entry of cases.filter((entry) => entry.typescript)) {
      const result = ts.transpileModule(entry.source, {
        fileName: entry.jsx ? 'case.tsx' : 'case.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve },
      });
      expect(result.diagnostics, entry.name).toEqual([]);
    }
  });

  it.each([
    'function f(x: { tag: `x${string',
    'class C { value!: { tag: `x${keyof { a: number }',
    'function f(): { tag: `x${`nested${string}`}',
  ])('keeps genuinely incomplete type templates as lexical errors: %s', (source) => {
    expect(() => extractModuleSpecifiers(`require('real'); ${source}`)).toThrow(
      ModuleSpecifierError,
    );
  });
});
