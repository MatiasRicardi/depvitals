/** Shared static-only probes: every real occurrence has a distinct package name. */
export type ExpressionOwnerCase = {
  readonly name: string;
  readonly source: string;
  readonly fileName: string;
  readonly expected: readonly string[];
};

const forms = [
  ['ordinary', "function(await) { return await / require('owner-inside') / 2; }"],
  ['async', "async function() { await /require('owner-fake-inner')/; require('owner-inside'); }"],
  ['generator', "function*() { yield /require('owner-fake-inner')/; require('owner-inside'); }"],
  [
    'async-generator',
    "async function*() { await /require('owner-fake-await')/; yield /require('owner-fake-inner')/; require('owner-inside'); }",
  ],
  [
    'class',
    "class { async run() { await /require('owner-fake-inner')/; require('owner-inside'); } }",
  ],
] as const;

const basicCases: readonly ExpressionOwnerCase[] = forms.flatMap(([form, value]) => {
  const expression = `${value} / require('owner-divisor') / 2`;
  const contexts = [
    ['assignment', `const value = ${expression};`],
    ['arrow', `const f = () => ${expression};`],
    [
      'await',
      `async function outer() { await ${expression}; await /require('owner-fake-outer')/; }`,
    ],
    ['yield', `function* outer() { yield ${expression}; yield /require('owner-fake-outer')/; }`],
    ['interpolation', 'const text = `${' + expression + '}`;'],
  ] as const;
  return contexts.map(([context, source]) => ({
    name: `${context} / ${form}`,
    fileName: 'index.cjs',
    source: `require('owner-before'); ${source} require('owner-after');`,
    expected: ['owner-before', 'owner-inside', 'owner-divisor', 'owner-after'],
  }));
});

const yieldDeclarationCases: readonly ExpressionOwnerCase[] = [
  'function declared() {}',
  'async function declared() {}',
  'function* declared() {}',
  'async function* declared() {}',
  'class Declared {}',
].flatMap((declaration) =>
  ['function*', 'async function*'].flatMap((outer) =>
    ['\n', ' /* restricted line break\n */ '].map((lineBreak) => ({
      name: `yield statement before ${declaration} in ${outer}, trivia=${JSON.stringify(lineBreak)}`,
      fileName: 'index.cjs',
      source: `require('owner-before');
        ${outer} outer() {
          yield${lineBreak}${declaration}
          /require('owner-fake-inner')/.test('');
          require('owner-inside');
        }
        require('owner-after');`,
      expected: ['owner-before', 'owner-inside', 'owner-after'],
    })),
  ),
);

export const expressionOwnerCases: readonly ExpressionOwnerCase[] = [
  ...basicCases,
  ...yieldDeclarationCases,
  {
    name: 'nested async arrow restores its ordinary function and outer async owner',
    fileName: 'index.cjs',
    source: `require('owner-before');
      async function outer() {
        const f = () => function(await) {
          const inner = async () => { await /require('owner-fake-inner')/; require('owner-inside'); };
          return await / require('owner-inner-divisor') / 2;
        } / require('owner-divisor') / 2;
        await /require('owner-fake-outer')/;
      }
      require('owner-after');`,
    expected: [
      'owner-before',
      'owner-inside',
      'owner-inner-divisor',
      'owner-divisor',
      'owner-after',
    ],
  },
  {
    name: 'typed class members and static blocks preserve the enclosing expression arrow',
    fileName: 'index.ts',
    source: `require('owner-before');
      const f = async () => class {
        value!: { callback: () => void };
        static { require('owner-static'); }
        async run<T extends { value: number }>() {
          function inner(await) { return await / require('owner-inside') / 2; }
          await /require('owner-fake-inner')/;
        }
      } / require('owner-divisor') / 2 + await /require('owner-fake-outer')/;
      require('owner-after');`,
    expected: ['owner-before', 'owner-static', 'owner-inside', 'owner-divisor', 'owner-after'],
  },
];
