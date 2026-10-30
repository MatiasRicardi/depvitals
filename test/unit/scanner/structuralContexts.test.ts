import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  ModuleSpecifierError,
  extractModuleSpecifiers,
} from '../../../src/scanner/moduleSpecifiers.js';

import { expressionOwnerCases } from '../../helpers/expressionOwnerCases.js';

import { requireFunctionParameterCases } from '../../helpers/requireFunctionParameterCases.js';

const memberPrefixes = [
  ['two bare fields', 'a\nb', false],
  ['initialized then bare', 'a = 1\nb', false],
  ['arrow initializer then bare', 'a = () => 0\nb', false],
  ['function type', 'callback!: () => number', true],
  ['function type with parameter', 'callback!: (value: string) => void', true],
] as const;

function assertSyntax(source: string, typescript: boolean): void {
  if (typescript) {
    const result = ts.transpileModule(source, {
      fileName: 'case.ts',
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext },
    });
    expect(result.diagnostics).toEqual([]);
  } else {
    const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
}

describe('Step 68.9 structural contexts', () => {
  it.each(memberPrefixes)('%s preserves the generator context', (_name, prefix, typescript) => {
    const source = `class C {
      ${prefix}
      *run() {
        yield /require('fake')/;
        require('real');
      }
    }`;
    assertSyntax(source, typescript);
    expect(extractModuleSpecifiers(source)).toEqual([{ specifier: 'real', kind: 'require' }]);
  });

  it.each(['a', 'a;\nb;', 'callback!: (() => number)'])(
    'preserves the existing field control: %s',
    (prefix) => {
      expect(
        extractModuleSpecifiers(`class C { ${prefix}
          *run() { yield /require('fake')/; require('real'); }
        }`),
      ).toEqual([{ specifier: 'real', kind: 'require' }]);
    },
  );

  it('does not turn multiplication into a generator boundary', () => {
    const source = `class C {
      value = (2 * require('real')) / 4;
      async run() { await /require('fake')/; require('after'); }
    }`;
    assertSyntax(source, false);
    expect(extractModuleSpecifiers(source)).toEqual([
      { specifier: 'real', kind: 'require' },
      { specifier: 'after', kind: 'require' },
    ]);
  });
});

type Scenario = {
  readonly name: string;
  readonly source: string;
  readonly typescript?: boolean;
  readonly jsx?: boolean;
  readonly expected: readonly string[];
  readonly typeImports?: readonly string[];
};

const realBody = `yield /require('fake-generator')/; yield /don't/; require('inside');`;
const ordinaryBody = `return await / require('inside') / 2;`;
const asyncBody = `await /require('fake-async')/; await /don't/; require('inside');`;
const wrapClass = (members: string): string =>
  `require('before'); class C { ${members} } require('after');`;
const scenarios: Scenario[] = [];

for (const [boundaryName, boundary] of [
  ['semicolon', ';'],
  ['LF', '\n'],
  ['CRLF', '\r\n'],
  ['CR', '\r'],
  ['LS', '\u2028'],
  ['PS', '\u2029'],
  ['block comment with LF', '/*\n*/'],
  ['comment without LF and semicolon', '/* inert require("fake-comment") */;'],
  ['line comment', '// inert require("fake-comment")\n'],
] as const) {
  for (const [prefixName, fields] of [
    ['bare chain', ['a', 'b', 'c']],
    ['initialized then bare', ['a = 1', 'b', 'c']],
    ['arrow then bare', ['a = () => 0', 'b', 'c']],
  ] as const) {
    scenarios.push({
      name: `${boundaryName}: ${prefixName}`,
      source: wrapClass(`${fields.join(boundary)}${boundary} *run() { ${realBody} }`),
      expected: ['before', 'inside', 'after'],
    });
  }
}

for (const [name, field] of [
  ['simple', 'value'],
  ['private', '#value'],
  ['computed', `[require('key')]`],
  ['async name', 'async'],
  ['get name', 'get'],
  ['set name', 'set'],
  ['of name', 'of'],
  ['await name', 'await'],
  ['yield name', 'yield'],
  ['in name', 'in'],
  ['static modifier', 'static value'],
  ['readonly modifier', 'readonly value'],
  ['decorator', `@decorate(require('decorator')) value`],
] as const) {
  for (const [typeName, type] of [
    ['simple type', 'number'],
    ['function type', '() => number'],
    ['parameterized function type', '(x: string) => void'],
  ] as const) {
    scenarios.push({
      name: `${name}: ${typeName}`,
      source: wrapClass(`${field}!: ${type}\n *run() { ${realBody} }`),
      typescript: true,
      expected: [
        'before',
        ...(name === 'computed' ? ['key'] : name === 'decorator' ? ['decorator'] : []),
        'inside',
        'after',
      ],
    });
  }
}

for (const [name, type] of [
  ['parenthesized function', '(() => number)'],
  ['nested generic', 'Map<string, Promise<import("type-pkg").Value>>'],
  ['union function', 'number | ((x: string) => void)'],
  ['object type', '{ call: () => void; value: number }'],
  ['intersection', '{ a: number } & { b: string }'],
  ['conditional type', 'T extends { value: number } ? () => void : null'],
  ['template type', '`value${number}`'],
] as const) {
  scenarios.push({
    name: `owned field type: ${name}`,
    source: wrapClass(`value!: ${type}\n *run() { ${realBody} }`),
    typescript: true,
    expected: ['before', ...(name === 'nested generic' ? ['type-pkg'] : []), 'inside', 'after'],
    typeImports: name === 'nested generic' ? ['type-pkg'] : [],
  });
}

for (const [name, initializer, inside] of [
  ['number', '1', []],
  ['string', `"require('fake-string')"`, []],
  ['call', `require('initializer')`, ['initializer']],
  ['array', `[require('initializer')]`, ['initializer']],
  ['object', `{ value: require('initializer') }`, ['initializer']],
  ['regex', `/require('fake-regex')/`, []],
  ['template', '`require("fake-template") ${require("initializer")}`', ['initializer']],
  ['ternary', `flag ? require('initializer') : 0`, ['initializer']],
  ['arrow', `() => require('initializer')`, ['initializer']],
  ['block arrow', `() => { require('initializer'); }`, ['initializer']],
  ['function expression', `function () { require('initializer'); }`, ['initializer']],
  ['class expression', `class { method() { require('initializer'); } }`, ['initializer']],
] as const) {
  for (const [memberName, member] of [
    ['ordinary', `run(await) { ${ordinaryBody} }`],
    ['async', `async run() { ${asyncBody} }`],
    ['generator after bare', `bare\n *run() { ${realBody} }`],
  ] as const) {
    scenarios.push({
      name: `initializer ${name}: ${memberName}`,
      source: wrapClass(`value = ${initializer}\n ${member}`),
      expected: ['before', ...inside, 'inside', 'after'],
    });
  }
}

for (const [name, initializer] of [
  ['function expression', 'function () {}'],
  ['class expression', 'class {}'],
] as const) {
  scenarios.push(
    {
      name: `${name}: explicit boundary before generator`,
      source: wrapClass(`handle = ${initializer};
        *run() { ${realBody} }`),
      expected: ['before', 'inside', 'after'],
    },
    {
      name: `${name}: newline multiplication continues initializer`,
      source: wrapClass(`handle = ${initializer}
        * require('operand') / 2
        async load() { ${asyncBody} }`),
      expected: ['before', 'operand', 'inside', 'after'],
    },
  );
}

for (const [name, member, computed] of [
  ['ordinary', `run(await) { ${ordinaryBody} }`, false],
  ['async', `async run() { ${asyncBody} }`, false],
  ['generator', `*run() { ${realBody} }`, false],
  ['async generator', `async *run() { ${asyncBody} ${realBody} }`, false],
  ['computed', `async [require('method-key')]() { ${asyncBody} }`, true],
  ['private', `async #run() { ${asyncBody} }`, false],
  ['static block', `static { require('static-body'); } async run() { ${asyncBody} }`, false],
] as const) {
  for (const prefix of ['a', 'a\nb\nc', 'callback!: (x: string) => void']) {
    scenarios.push({
      name: `next ${name}: ${prefix}`,
      source: wrapClass(`${prefix}\n ${member}`),
      typescript: prefix.includes(':'),
      expected: [
        'before',
        ...(computed ? ['method-key'] : name === 'static block' ? ['static-body'] : []),
        'inside',
        ...(name === 'async generator' ? ['inside'] : []),
        'after',
      ],
    });
  }
}

const signatureCases = [
  [
    'declaration with object return',
    `async function f(): Promise<{ ok: boolean }> { ${asyncBody} }`,
  ],
  [
    'expression with function return',
    `const f = async function(): () => void { ${asyncBody} } / require('division') / 2;`,
  ],
  ['arrow with function return', `const f = async (): (() => void) => { ${asyncBody} };`],
  ['method with function return', `class C { async f(): () => void { ${asyncBody} } }`],
  ['nested default function', `async function f(cb = function(): void {}) { ${asyncBody} }`],
  ['nested default arrow', `async function f(cb = (): void => {}) { ${asyncBody} }`],
  [
    'parameter function type',
    `async function f(cb: (x: import('param-type').X) => void) { ${asyncBody} }`,
  ],
  [
    'typed parameter default',
    `async function f(cb: () => void = () => {}, x: number = 1) { ${asyncBody} }`,
  ],
  ['overload', `function f(): void; function f(): void { require('inside'); }`],
  [
    'declare signature',
    `declare function f(): () => void; const g = async () => { ${asyncBody} };`,
  ],
  [
    'interface signatures',
    `interface I { f(): () => void; g(): import('return-type').X; } const g = async () => { ${asyncBody} };`,
  ],
  [
    'semicolonless declare',
    `declare function f(): () => void
    const g = async () => { ${asyncBody} };`,
  ],
  [
    'semicolonless overload',
    `class C { f(): void
    f() { require('inside'); } }`,
  ],
  [
    'semicolonless interface',
    `interface I { f(): () => void
    g(): number }
    const g = async () => { ${asyncBody} };`,
  ],
  [
    'multiline function field',
    `class C { callback!: () =>
    void
    *run() { ${realBody} } }`,
  ],
  [
    'multiline conditional type',
    `class C { callback!: T extends
    { value: number } ? () => void : null
    *run() { ${realBody} } }`,
  ],
  [
    'generic adjacent initializer',
    `class C { callback: Map<string, number>=new Map()
    bare
    *run() { ${realBody} } }`,
  ],
  [
    'generic adjacent async initializer',
    `class C {
    callback: Array<() => Promise<void>>=[async () => { ${asyncBody} }]
    bare
    *run() { yield /require('fake-generator')/; }
  }`,
  ],
  ['template typed parameter', `async function f(value: \`value\${number}\`) { ${asyncBody} }`],
  ['multiline template return', `async function f(): \`value\${\n number\n}\` { ${asyncBody} }`],
  [
    'field typed initializer',
    `class C { callback: () => number = () => 1\n bare\n *run() { ${realBody} } }`,
  ],
] as const;
for (const [name, source] of signatureCases) {
  scenarios.push({
    name: `signature: ${name}`,
    source: `require('before'); ${source} require('after');`,
    typescript: true,
    typeImports:
      name === 'parameter function type'
        ? ['param-type']
        : name === 'interface signatures'
          ? ['return-type']
          : [],
    expected: [
      'before',
      ...(name === 'parameter function type' ? ['param-type'] : []),
      ...(name === 'interface signatures' ? ['return-type'] : []),
      'inside',
      ...(name === 'expression with function return' ? ['division'] : []),
      'after',
    ],
  });
}

for (const [name, source] of [
  ['object ternary colon', `const o = { value: cond ? f() : async () => { ${asyncBody} } };`],
  ['computed property colon', `const o = { [f()]: async () => { ${asyncBody} } };`],
  ['class ternary colon', `class C { value = cond ? f() : async () => { ${asyncBody} }; }`],
  [
    'multiplication',
    `class C { value = 2\n * require('inside') / 4; async run() { await /require('fake')/; } }`,
  ],
  [
    'comparison',
    `class C { value = 1 === require('inside')\n bare\n *run() { yield /require('fake')/; } }`,
  ],
  [
    'multiline ternary',
    `class C { value = cond ?\n require('inside')\n : 0\n bare\n *run() { yield /require('fake')/; } }`,
  ],
  [
    'nested classes',
    `class C { value = class D { a\nb\n *run() { ${realBody} } }\n bare\n async run() { await /require('fake')/; } }`,
  ],
  [
    'ordinary inside async',
    `async function outer() { class C { a\nb\n run(await) { ${ordinaryBody} } } await /require('fake')/; }`,
  ],
  [
    'ordinary inside generator',
    `function* outer() { class C { a\nb\n run(await) { ${ordinaryBody} } } yield /require('fake')/; }`,
  ],
  [
    'neighbor restore',
    `async function before() { await /require('fake-before')/; } class C { a\nb\n *run() { ${realBody} } } async function after() { await /require('fake-after')/; }`,
  ],
  [
    'newline breaks async modifier',
    `class C { async
      run(await) { ${ordinaryBody} }
    }`,
  ],
] as const) {
  scenarios.push({
    name,
    source: `require('before'); ${source} require('after');`,
    expected: ['before', 'inside', 'after'],
  });
}

for (const [name, source, jsx, typescript] of [
  [
    'template',
    '`inert require("fake-template") ${(() => { class C { a\nb\n *run() { ' +
      realBody +
      ' } } })()}`;',
    false,
    false,
  ],
  [
    'JSX',
    `const view = <p>require('fake-text'){(() => { class C { a\nb\n *run() { ${realBody} } } })()}</p>;`,
    true,
    false,
  ],
  [
    'TSX generic',
    `const view = <T,>(value: T) => <p>require('fake-text'){(() => { class C { callback!: () => number\n *run() { ${realBody} } } })()}</p>;`,
    true,
    true,
  ],
] as const) {
  scenarios.push({
    name: `overlay: ${name}`,
    source: `require('before'); ${source} require('after');`,
    jsx,
    typescript,
    expected: ['before', 'inside', 'after'],
  });
}

describe('deterministic structural matrix', () => {
  it.each(scenarios)('$name', ({ source, expected, jsx, typeImports }) => {
    expect(extractModuleSpecifiers(source, { jsx: jsx ?? false })).toEqual(
      expected.map((specifier) => ({
        specifier,
        kind: typeImports?.includes(specifier) === true ? 'dynamic-import' : 'require',
      })),
    );
  });

  it('checks the syntax of structurally distinct JavaScript families without executing them', () => {
    const sources = scenarios
      .filter((scenario) => !scenario.typescript && !scenario.jsx)
      .map((scenario) => `{ ${scenario.source} }`);
    assertSyntax(sources.join('\n'), false);
  });

  it('checks the syntax of the new TypeScript and TSX families', () => {
    for (const scenario of scenarios.filter(
      (scenario) => (scenario.typescript ?? false) || (scenario.jsx ?? false),
    )) {
      const result = ts.transpileModule(scenario.source, {
        fileName: scenario.jsx ? 'case.tsx' : 'case.ts',
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve },
      });
      expect(result.diagnostics, scenario.name).toEqual([]);
    }
  });

  it('retains encounter order, duplicates and exact kinds through owned types and bodies', () => {
    expect(
      extractModuleSpecifiers(`import 'before';
        class C {
          callback!: () => import('types').Value
          bare
          *run() { yield /require('fake')/; require('same'); require('same'); }
        }
        export { value } from 'after';`),
    ).toEqual([
      { specifier: 'before', kind: 'import' },
      { specifier: 'types', kind: 'dynamic-import' },
      { specifier: 'same', kind: 'require' },
      { specifier: 'same', kind: 'require' },
      { specifier: 'after', kind: 'export-from' },
    ]);
  });

  it.each([`'unterminated`, '/* unterminated', '`unterminated', '/unterminated'])(
    'does not return successful partial evidence before a lexical error: %s',
    (ending) => {
      expect(() => extractModuleSpecifiers(`require('real'); ${ending}`)).toThrow(
        ModuleSpecifierError,
      );
    },
  );

  it.each(['= >', '=/* comment */>', '=\n>'])(
    'does not merge separated punctuation into a runtime arrow: %s',
    (punctuation) => {
      // Intentionally synthetic lexical fragments, not valid programs.
      expect(
        extractModuleSpecifiers(`async function outer() {
          async ${punctuation} await /require('fake')/; require('real');
        }`),
      ).toEqual([{ specifier: 'real', kind: 'require' }]);
    },
  );

  it.each(['value?', 'value!', 'await', 'yield', 'in'])(
    'ends an uninitialized name or TS suffix field: %s',
    (field) => {
      const source = wrapClass(`${field}
      *run() { ${realBody} }`);
      assertSyntax(source, true);
      expect(extractModuleSpecifiers(source)).toEqual([
        { specifier: 'before', kind: 'require' },
        { specifier: 'inside', kind: 'require' },
        { specifier: 'after', kind: 'require' },
      ]);
    },
  );
});

describe('Step 74 function and class expression ownership', () => {
  it.each(expressionOwnerCases)(
    '$name retains distinct inner and exterior evidence',
    (scenario) => {
      assertSyntax(scenario.source, scenario.fileName.endsWith('.ts'));
      expect(extractModuleSpecifiers(scenario.source).map(({ specifier }) => specifier)).toEqual(
        scenario.expected,
      );
    },
  );

  it.each([
    "function declared() {} /require('fake-function')/.test('');",
    "async function declared() {} /require('fake-async')/.test('');",
    "function* declared() {} /require('fake-generator')/.test('');",
    "async function* declared() {} /require('fake-async-generator')/.test('');",
    "class Declared {} /require('fake-class')/.test('');",
    "function f() { return\nfunction declared() {} /require('fake-return')/.test(''); }",
  ])('preserves a declaration followed by regex: %s', (source) => {
    assertSyntax(source, false);
    expect(extractModuleSpecifiers(source + " require('real-after');")).toEqual([
      { specifier: 'real-after', kind: 'require' },
    ]);
  });
});

describe('Step 79 require parameter bindings in explicit functions', () => {
  it.each(requireFunctionParameterCases)('$name', (scenario) => {
    assertSyntax(scenario.source, scenario.fileName.endsWith('.ts'));
    expect(extractModuleSpecifiers(scenario.source).map(({ specifier }) => specifier)).toEqual(
      scenario.expected,
    );
  });
});
