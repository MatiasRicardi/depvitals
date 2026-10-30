/** Parameter ownership only: syntax oracles compile/check these examples without evaluating them. */
const parameterForms = [
  'require',
  'require = loader',
  '...require',
  '{ require }',
  '{ key: require }',
  '{ ...require }',
  '{ nested: { value: require } }',
  '[, { value: require = loader }]',
  "first = require('fake-default'), require = loader",
  "callback = function() { require('fake-default'); }, require = loader",
  "callback = () => require('fake-default'), require = loader",
];

const owners = [
  ['block arrow', (p: string, b: string): string => `const f = (${p}) => { ${b} };`],
  ['async block arrow', (p: string, b: string): string => `const f = async (${p}) => { ${b} };`],
  ['object method', (p: string, b: string): string => `const o = { run(${p}) { ${b} } };`],
  [
    'object async method',
    (p: string, b: string): string => `const o = { async run(${p}) { ${b} } };`,
  ],
  ['object generator', (p: string, b: string): string => `const o = { *run(${p}) { ${b} } };`],
  [
    'object async generator',
    (p: string, b: string): string => `const o = { async *run(${p}) { ${b} } };`,
  ],
  ['class method', (p: string, b: string): string => `class C { run(${p}) { ${b} } }`],
  ['class async method', (p: string, b: string): string => `class C { async run(${p}) { ${b} } }`],
  ['class generator', (p: string, b: string): string => `class C { *run(${p}) { ${b} } }`],
  [
    'class async generator',
    (p: string, b: string): string => `class C { async *run(${p}) { ${b} } }`,
  ],
] as const;

export const requireArrowMethodParameterCases = [
  ...owners.flatMap(([name, wrap]) => [
    ...parameterForms.map((parameters) => ({
      name: `${name}: ${parameters}`,
      fileName: 'index.cjs',
      source: `require('real-before'); ${wrap(parameters, `require('fake-body'); function inner() { require('fake-inner'); } import('real-import');`)} require('real-after');`,
      expected: ['real-before', 'real-import', 'real-after'],
    })),
    ...['{ require: load }', 'value = loader'].map((parameters) => ({
      name: `${name}: unbound ${parameters}`,
      fileName: 'index.cjs',
      source: `${wrap(parameters, "require('real-body');")} require('real-after');`,
      expected: ['real-body', 'real-after'],
    })),
    {
      name: `${name}: type names do not bind`,
      fileName: 'index.ts',
      source: `${wrap('value: require', "require('real-body');")} require('real-after');`,
      expected: ['real-body', 'real-after'],
    },
    {
      name: `${name}: generic default commas do not bind`,
      fileName: 'index.ts',
      source: `${wrap('value = make<string, require, Other>()', "require('real-body');")} require('real-after');`,
      expected: ['real-body', 'real-after'],
    },
  ]),
  ...['require', '(require)', 'async require', 'async (require)'].flatMap((head) =>
    (
      [
        ["require('fake-body')", []],
        ["(require('fake-body'), import('real-import'))", ['real-import']],
        ["() => require('fake-inner')", []],
        ["function() { require('fake-inner'); }", []],
        ["`text${require('fake-template')}`", []],
      ] as const
    ).map(([body, imports]) => ({
      name: `expression arrow ${head}: ${body}`,
      fileName: 'index.cjs',
      source: `require('real-before'); const f = ${head} => ${body}\nrequire('real-after');`,
      expected: ['real-before', ...imports, 'real-after'],
    })),
  ),
  ...(
    [
      ["const a = [(require) => require('fake'), require('real-after')];", ['real-after']],
      ["const a = flag ? (require) => require('fake') : require('real-after');", ['real-after']],
      ["use((require) => require('fake'), require('real-after'));", ['real-after']],
      [
        "function outer() { return (require) => require('fake'); } require('real-after');",
        ['real-after'],
      ],
      ["const f = (require) => require('fake') as Result\nrequire('real-after');", ['real-after']],
      [
        "const f = (require: Loader): Result => require('fake'); require('real-after');",
        ['real-after'],
      ],
      [
        "const f = <T,>(require: Loader): Result => { require('fake'); }; require('real-after');",
        ['real-after'],
      ],
      [
        "class C { run(require: Loader): Result { require('fake'); } next(value: require) { require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "class C { run(require: Loader): Result; run(value: require): Result { require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "class C { constructor(require: Loader) { require('fake'); } } require('real-after');",
        ['real-after'],
      ],
      [
        "class C { static [require('real-key')](require) { require('fake'); } } require('real-after');",
        ['real-key', 'real-after'],
      ],
      [
        "const o = { [require('real-key')](require) { require('fake'); }, require() { require('real-body'); } };",
        ['real-key', 'real-body'],
      ],
      [
        "const f = (require) => ({ [require('fake-key')]: () => require('fake-inner') }); require('real-after');",
        ['real-after'],
      ],
      [
        "const o = { run(require) { const f = (value) => require('fake'); }, next() { require('real-body'); } };",
        ['real-body'],
      ],
      [
        "const f = (require) => { class C { [require('fake-key')]() { require('fake-body'); } } }; require('real-after');",
        ['real-after'],
      ],
      [
        "const o = { run(value = (require) => require('fake-default')) { require('real-body'); } }; require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "const f = (cb = (require) => require('fake-default')) => require('real-body'); require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "const f = (require) => { const requireAlias = require; require('fake'); }; const require = loader; require('real-unsupported-local');",
        ['real-unsupported-local'],
      ],
      [
        "import require from 'real-import'; const f = (value) => require('real-unsupported-alias');",
        ['real-import', 'real-unsupported-alias'],
      ],
      ["const f = () => (require) => require('fake'); require('real-after');", ['real-after']],
      [
        "const f = () => async (require) => { require('fake'); }; require('real-after');",
        ['real-after'],
      ],
      [
        "class C { constructor(public readonly require: Loader) { require('fake'); } } require('real-after');",
        ['real-after'],
      ],
      [
        "class C { set value(require: Loader) { require('fake'); } get require() { return require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "class C { run(require: Loader)\nrun(value: Loader) { require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "class C { run(require: Loader): Result\nrun(value: Loader): Result { require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "const f = (require) => require('fake')\n + require('fake-continuation'); require('real-after');",
        ['real-after'],
      ],
      [
        "const f = (require) => import('real-import', {with: {value: require('fake')}}); require('real-after');",
        ['real-import', 'real-after'],
      ],
      [
        "require = loader; require('real-unsupported-reassigned');",
        ['real-unsupported-reassigned'],
      ],
      [
        "const f = (value = make<string, require, Other>()) => require('real-body'); require('real-after');",
        ['real-body', 'real-after'],
      ],
      ["const f = ([require]) => require('fake'); require('real-after');", ['real-after']],
      [
        "const f = ({ require: load = require('real-default') }) => require('real-body');",
        ['real-default', 'real-body'],
      ],
      [
        "const f = async <T,>(require: Loader): Promise<Result> => require('fake'); require('real-after');",
        ['real-after'],
      ],
      [
        "const f = (require) => require('fake') satisfies Result\nrequire('real-after');",
        ['real-after'],
      ],
      [
        "const f = (require) => `outer${() => require('fake-inner')}`; require('real-after');",
        ['real-after'],
      ],
      [
        "class C { field = (require) => require('fake')\nnext() { require('real-body'); } } require('real-after');",
        ['real-body', 'real-after'],
      ],
      [
        "const o = { run({[require('real-key')]: value}) { require('real-body'); } };",
        ['real-key', 'real-body'],
      ],
      [
        "const f = (require) => { import('real-import'); /require('fake-regex')/.test(''); }; require('real-after');",
        ['real-import', 'real-after'],
      ],
      [
        "abstract class C { abstract run(require: Loader): Result\n[require('real-key')]() { require('real-body'); } } require('real-after');",
        ['real-key', 'real-body', 'real-after'],
      ],
      [
        "abstract class C { abstract run(require: Loader): Result\n[require] } require('real-after');",
        ['real-after'],
      ],
      [
        "const f = flag ? (require): Result => require('fake') : require('real-other'); require('real-after');",
        ['real-other', 'real-after'],
      ],
      [
        "const f = flag ? (a,b) : async (require) => { require('fake'); }; require('real-after');",
        ['real-after'],
      ],
      ["declare class C { run(require: Loader) } require('real-after');", ['real-after']],
      ["declare class C { run(require: Loader): Result } require('real-after');", ['real-after']],
    ] as const
  ).map(([source, expected], index) => ({
    name: `ownership boundary ${String(index)}`,
    fileName: 'index.ts',
    source,
    expected,
  })),
];
