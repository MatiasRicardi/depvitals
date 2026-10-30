/** Step 79: explicit function signatures only; no target execution or general name resolver. */
export const requireFunctionParameterCases = [
  ...['function', 'async function', 'function*', 'async function*'].flatMap((keyword) =>
    [
      'require',
      'require = loader',
      '...require',
      '{ require }',
      '{ value: require }',
      '{ nested: { value: require = loader } }',
      '[, require]',
      '[{ value: require }]',
      '{ ...require }',
      '{ value = 1, nested: [require] }',
      "first = require('fake-default'), require = loader",
      "callback = function() { require('fake-default'); }, require = loader",
      "text = `text${require('fake-default')}`, require = loader",
    ].map((parameters) => ({
      name: `${keyword} (${parameters})`,
      fileName: 'index.cjs',
      source: `require('real-before'); ${keyword} local(${parameters}) {
        require('fake-body');
        function inner() { require('fake-inherited'); }
        import('real-import');
      } require('real-after');`,
      expected: ['real-before', 'real-import', 'real-after'],
    })),
  ),
  {
    name: 'property keys and initializer names are not bindings',
    fileName: 'index.cjs',
    source: `function local({ require: loader }, value = require('real-default')) {
      require('real-body');
    } require('real-after');`,
    expected: ['real-default', 'real-body', 'real-after'],
  },
  {
    name: 'template interpolation comma in a binding default is not another binding',
    fileName: 'index.cjs',
    source:
      'function local({value = `text${0, require("real-default")}`}) { require("real-body"); }',
    expected: ['real-default', 'real-body'],
  },
  {
    name: 'type names and property keys do not bind require',
    fileName: 'index.ts',
    source: `function local(value: require, { require: loader }: Shape<require>) {
      require('real-body');
    } require('real-after');`,
    expected: ['real-body', 'real-after'],
  },
  {
    name: 'typed binding and nested callbacks restore the parent scope',
    fileName: 'index.ts',
    source: `require('real-before');
      function local(require: Loader, cb = function(value: require) { require('fake-default'); }) {
        require('fake-body');
        const t = \`text\${function() { require('fake-template'); }}\`;
      }
      function globalAgain(value: require) { require('real-after'); }`,
    expected: ['real-before', 'real-after'],
  },
  {
    name: 'overload signature without a body does not leak its binding',
    fileName: 'index.ts',
    source: `declare function local(require: Loader): void; require('real-after');`,
    expected: ['real-after'],
  },
  ...['function', 'async function', 'function*', 'async function*'].map((keyword) => ({
    name: `anonymous expression ${keyword}`,
    fileName: 'index.cjs',
    source: `require('real-before'); const local = ${keyword}(require) { require('fake-body'); import('real-import'); }; require('real-after');`,
    expected: ['real-before', 'real-import', 'real-after'],
  })),
  {
    name: 'explicit function expression in an object property',
    fileName: 'index.cjs',
    source:
      "const object = { callback: function local(require) { require('fake-body'); } }; require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'explicit function expression in a class field',
    fileName: 'index.cjs',
    source:
      "class C { callback = function(require) { require('fake-body'); }; } require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'computed destructuring keys do not bind their expressions',
    fileName: 'index.cjs',
    source: "function local({ [require('real-key')]: value }) { require('real-body'); }",
    expected: ['real-key', 'real-body'],
  },
  {
    name: 'destructuring initializer with type assertions does not bind a type name',
    fileName: 'index.ts',
    source: "function local({ value = 1 as Pair<string, require> }) { require('real-body'); }",
    expected: ['real-body'],
  },
  {
    name: 'ambient signature without semicolon restores the outer scope',
    fileName: 'index.ts',
    source: "declare function local(require: Loader): void\nrequire('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'renamed string keys and similar names do not bind require',
    fileName: 'index.cjs',
    source:
      "function local({ 'require': loader = require('real-default') }, Require, requireLoader) { require('real-body'); }",
    expected: ['real-default', 'real-body'],
  },
  {
    name: 'generic call type arguments in a destructuring default are not bindings',
    fileName: 'index.ts',
    source:
      "function local({value = make<{x: string}, require, Other>()}) { require('real-body'); }",
    expected: ['real-body'],
  },
  {
    name: 'comparisons in destructuring defaults do not hide a real binding',
    fileName: 'index.cjs',
    source:
      "function local([value = a < b, require, other = d > (e)]) { require('fake-body'); } require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'generic instantiation initializer does not introduce parameter bindings',
    fileName: 'index.ts',
    source: "function local({value = make<string, require, Other>}) { require('real-body'); }",
    expected: ['real-body'],
  },
  {
    name: 'optional typed require parameter still binds',
    fileName: 'index.ts',
    source: "function local(require?: Loader) { require('fake-body'); } require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'bodyless signature with no annotation or semicolon restores globals',
    fileName: 'index.ts',
    source:
      "declare function local(require: Loader)\nrequire('real-first'); require('real-after');",
    expected: ['real-first', 'real-after'],
  },
  {
    name: 'semicolon-free unannotated overload does not leak into implementation',
    fileName: 'index.ts',
    source:
      "function local(require: Loader)\nfunction local(value: Loader) { require('real-implementation'); } require('real-after');",
    expected: ['real-implementation', 'real-after'],
  },
  {
    name: 'return annotation on the next line retains the function scope',
    fileName: 'index.ts',
    source:
      "function local(require: Loader)\n: Return { require('fake-body'); } require('real-after');",
    expected: ['real-after'],
  },
  ...['function', 'async function', 'function*', 'async function*'].map((keyword) => ({
    name: `newline body retains ${keyword} parameter scope`,
    fileName: 'index.cjs',
    source: `${keyword} local(require)\n{ require('fake-body'); } require('real-after');`,
    expected: ['real-after'],
  })),
  {
    name: 'plain default generic type arguments do not become bindings',
    fileName: 'index.ts',
    source: "function local(value = make<string, require, Other>()) { require('real-body'); }",
    expected: ['real-body'],
  },
  {
    name: 'generic default still permits a following real require binding',
    fileName: 'index.ts',
    source:
      "function local(value = make<string, require, Other>(), require: Loader) { require('fake-body'); } require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'generic default followed by a conditional keeps initializer grammar',
    fileName: 'index.ts',
    source:
      "function local(value = make<string, require, Other>() ? 1 : require('real-default')) { require('real-body'); }",
    expected: ['real-default', 'real-body'],
  },
  {
    name: 'consecutive generic defaults preserve real initializer evidence',
    fileName: 'index.ts',
    source:
      "function local(a = make<A, require, B>(), b = make<X, require, Y>(), c = require('real-default')) { require('real-body'); }",
    expected: ['real-default', 'real-body'],
  },
  {
    name: 'generic default does not remove an earlier real require binding',
    fileName: 'index.ts',
    source:
      "function local(require: Loader, value = make<X, require, Y>()) { require('fake-body'); } require('real-after');",
    expected: ['real-after'],
  },
  {
    name: 'regex after an unannotated bodyless signature remains inert',
    fileName: 'index.ts',
    source:
      "declare function local(require: Loader)\n/require('fake-regex')/.test(''); require('real-after');",
    expected: ['real-after'],
  },
] as const;
