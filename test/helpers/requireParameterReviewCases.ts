/** Step 80 review regressions and adjacent controls; source is never evaluated. */
export const requireParameterReviewCases = [
  ...['void', 'instanceof', '>'].map((operator) => ({
    name: `newline runtime callback after ${operator} is not a type method`,
    fileName: 'case.mjs',
    source: `const f = load => left < ({value: ${operator === 'void' ? 'void' : `flag ${operator}`}\ncall((require) => { require('fake'); })}) > (0); require('outside');`,
    expected: ['outside'],
  })),
  {
    name: 'newline runtime async callback keeps regex text inert',
    fileName: 'case.mjs',
    source:
      "const f = load => left < ({value: void\ncall(async () => { await /import('fake')/; })}) > (0); require('outside');",
    expected: ['outside'],
  },
  {
    name: 'newline type method with a literal parameter annotation remains valid',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => make<{a(): void\nb(tag: 'literal'): void}, Other>(require('fake')) : () => {}; require('outside');",
    expected: ['outside'],
  },
  ...['\n', '\r\n', ' /*\n*/ ', ';\n'].flatMap((separator) =>
    (['require', 'load'] as const).map((parameter) => ({
      name: `newline type method (${parameter}): ${JSON.stringify(separator)}`,
      fileName: 'case.ts',
      source: `const f = flag ? (${parameter}): Result => make<{a(): void${separator}b(require: Loader): void}, Other>(require('${parameter === 'require' ? 'fake' : 'real'}')) : () => {}; require('outside');`,
      expected: parameter === 'require' ? ['outside'] : ['real', 'outside'],
    })),
  ),
  ...['Pair<A, B>', '{value: A}', '(value: A) => B', '`literal`', "'literal'", '123'].flatMap(
    (returnType) =>
      (['require', 'load'] as const).map((parameter) => ({
        name: `newline type method after ${returnType} (${parameter})`,
        fileName: 'case.ts',
        source: `const f = flag ? (${parameter}): Result => make<{a(): ${returnType}\nb(): void}, Other>(require('${parameter === 'require' ? 'fake' : 'real'}')) : () => {}; require('outside');`,
        expected: parameter === 'require' ? ['outside'] : ['real', 'outside'],
      })),
  ),
  {
    name: 'newline accessor type member',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => make<{a(): void\nget b(): Result}, Other>(require('fake')) : () => {}; require('outside');",
    expected: ['outside'],
  },
  {
    name: 'newline type member after a template query preserves the import',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => make<{a(): `${import('real-type').Name}`\nb(): void}, Other>(require('fake')) : () => {}; require('outside');",
    expected: ['real-type', 'outside'],
  },
  ...['+', '&&'].map((operator) => ({
    name: `newline runtime operand after ${operator} is not a type member`,
    fileName: 'case.mjs',
    source: `const f = load => left < ({value: flag ${operator}\ncall((require) => require('fake'))}) > (0); require('outside');`,
    expected: ['outside'],
  })),
  {
    name: 'runtime comparison method bodies keep their own parameter scopes',
    fileName: 'case.mjs',
    source:
      "const f = load => left < ({ run(require) { require('fake'); } }) > (0); require('outside');",
    expected: ['outside'],
  },
  {
    name: 'runtime comparison template callbacks keep their own parameter scopes',
    fileName: 'case.mjs',
    source: "const f = load => left < `${(require) => require('fake')}` > (0); require('outside');",
    expected: ['outside'],
  },
  {
    name: 'runtime comparison template calls remain evidence',
    fileName: 'case.mjs',
    source: "const f = load => left < `${require('real')}` > (0); require('outside');",
    expected: ['real', 'outside'],
  },
  {
    name: 'multiline template type imports remain evidence',
    fileName: 'case.ts',
    source:
      "const f = require => make<`${\nimport('real-type').Name\n}`, B>(require('fake')); require('outside');",
    expected: ['real-type', 'outside'],
  },
  ...['CALL', '(CALL)', '[CALL]', '({ value: CALL })'].flatMap((value) =>
    (['require', 'load'] as const).map((parameter) => ({
      name: `runtime comparison keeps its scope (${parameter}): ${value}`,
      fileName: 'case.mjs',
      source: `const f = ${parameter} => left < ${value.replace('CALL', parameter === 'require' ? "require('fake')" : "require('real')")} > (0); require('outside');`,
      expected: parameter === 'require' ? ['outside'] : ['real', 'outside'],
    })),
  ),
  ...[
    "`${import('real-type').Name}`",
    "`inert import('fake') ${import('real-type').Name}`",
    "`${Pair<import('real-type').A, import('other-type').B>}`",
    "`outer${`inner${import('real-type').Name}`}`",
  ].map((type) => ({
    name: `template type retains interpolated imports: ${type}`,
    fileName: 'case.ts',
    source: `const f = require => make<${type}, B>(require('fake')); require('outside');`,
    expected: type.includes("'other-type'")
      ? ['real-type', 'other-type', 'outside']
      : ['real-type', 'outside'],
  })),
  {
    name: 'failed outer comparison probe does not discard a nested generic call',
    fileName: 'case.ts',
    source: "const f = require => left < make<A, B>(require('fake')); require('outside');",
    expected: ['outside'],
  },
  ...[
    'CALL as Pair<A, B>',
    'CALL satisfies Pair<A, B>',
    'CALL as Pair<A, Pair<B, C>>',
    'CALL as Pair<{ value: A; next: B }, [A, B]>',
    'CALL as Pair<(a: A, b: B) => C, D>',
    'CALL as Pair<A extends B ? C : D, E>',
    'CALL as Pair<`a,b`, B>',
    'CALL as Pair<A /* comma, colon: */ , B>',
    'CALL as Pair<A, B> + 1',
    'make<A, B>(CALL)',
    'make<A, Pair<B, C>>(CALL)',
    'CALL + value < other',
    'CALL + (a < b, c > d)',
  ].flatMap((body) =>
    (['require', 'load'] as const).map((parameter) => ({
      name: `conditional typed arrow type arguments (${parameter}): ${body}`,
      fileName: 'case.ts',
      source: `const f = flag ? (${parameter}): Result => ${body.replace('CALL', parameter === 'require' ? "require('fake')" : "require('real')")} : () => {}; require('outside');`,
      expected: parameter === 'require' ? ['outside'] : ['real', 'outside'],
    })),
  ),
  {
    name: 'conditional typed arrow comparisons remain expressions',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => require('fake') + (a < b ? 1 : 2) : () => {}; require('outside');",
    expected: ['outside'],
  },
  {
    name: 'conditional type argument import remains real evidence',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => require('fake') as Pair<import('real-type').A, B> : () => {}; require('outside');",
    expected: ['real-type', 'outside'],
  },
  {
    name: 'generic type arguments in a default callback cannot bind its enclosing parameters',
    fileName: 'case.ts',
    source:
      "const f = (cb = (require) => make<A, require, B>(require('fake')), load) => require('real'); require('outside');",
    expected: ['real', 'outside'],
  },
  {
    name: 'generic call type imports remain evidence inside a bound arrow',
    fileName: 'case.ts',
    source:
      "const f = flag ? (require): Result => make<import('real-type').A, B>(require('fake')) : () => {}; require('outside');",
    expected: ['real-type', 'outside'],
  },
  {
    name: 'comparison commas cannot borrow a later declaration as type arguments',
    fileName: 'case.mjs',
    source:
      "const f = flag ? (require) : other => a < b, next = 1 > 0; require('real'); require('outside');",
    expected: ['real', 'outside'],
  },
  ...['other =>', '(other) =>', '() =>'].map((alternative) => ({
    name: `plain parenthesized consequent and alternate ${alternative}`,
    fileName: 'case.mjs',
    source: `const f = flag ? (require) : ${alternative} require('real'); require('outside');`,
    expected: ['real', 'outside'],
  })),
  ...['require', 'require: Loader'].map((parameter) => ({
    name: `typed arrow consequent (${parameter}) retains its parameter scope`,
    fileName: 'case.ts',
    source: `const f = flag ? (${parameter}): Result => require('fake') : require('real'); require('outside');`,
    expected: ['real', 'outside'],
  })),
  ...[
    "const o = { list: [0, foo(require)], value: require('real') }; require('outside');",
    "const o = { value: call(0, foo(require), require('real')) }; require('outside');",
    "class C { list = [0, foo(require)]; value = require('real'); } require('outside');",
    "class C { value = call(0, foo(require), require('real')); } require('outside');",
    "const o = { list: [0, foo(require)], run(require) { require('fake'); }, value: require('real') }; require('outside');",
    "class C { list = [0, foo(require)]; run(require) { require('fake'); } value = require('real'); } require('outside');",
    "const o = { list: [{ run(require) { require('fake'); } }], value: require('real') }; require('outside');",
    "const o = { list: [class C { run(require) { require('fake'); } }], value: require('real') }; require('outside');",
  ].map((source, index) => ({
    name: `method container depth ${String(index)}`,
    fileName: 'case.ts',
    source,
    expected: ['real', 'outside'],
  })),
  ...['() =>', 'async () =>', 'value =>'].flatMap((head) =>
    ['other =>', '(other) =>', '() =>'].map((alternative) => ({
      name: `parenthesized body ${head} and alternative ${alternative}`,
      fileName: 'case.mjs',
      source: `const f = flag ? ${head} (require) : ${alternative} require('real');\nrequire('outside');`,
      expected: ['real', 'outside'],
    })),
  ),
  ...['', 'async '].map((modifier) => ({
    name: `default export ${modifier}arrow`,
    fileName: 'case.ts',
    source: `export default ${modifier}(require) => require('fake'); require('outside');`,
    expected: ['outside'],
  })),
  ...[
    '<p>foo (bar</p>',
    "<p>don't</p>",
    '<p>foo )bar</p>',
    '<p>// not a comment (</p>',
    '<p>/* ( still text</p>',
    '<p>` unmatched template (</p>',
    "<><p>foo (</p><p>don't</p></>",
    '<p title="don\'t ( )">text (</p>',
    '<p title={">"}>text (</p>',
    '<p>{call(1, 2)}text (</p>',
    "<p>{<span>don't (</span>}text (</p>",
    '<p>{({value: "("}).value}text (</p>',
  ].flatMap((value) => [
    {
      name: `JSX default bound: ${value}`,
      fileName: 'case.tsx',
      source: `const f = (value = ${value}, require) => require('fake'); require('outside');`,
      expected: ['outside'],
    },
    {
      name: `JSX default unbound: ${value}`,
      fileName: 'case.tsx',
      source: `const f = (value = ${value}, load) => require('real'); require('outside');`,
      expected: ['real', 'outside'],
    },
  ]),
  {
    name: 'actual nested arrow parameters after an arrow',
    fileName: 'case.ts',
    source: "const f = () => (require) => require('fake'); require('outside');",
    expected: ['outside'],
  },
  {
    name: 'actual nested typed arrow parameters after an arrow',
    fileName: 'case.ts',
    source: "const f = () => (require: Loader): Result => require('fake'); require('outside');",
    expected: ['outside'],
  },
  {
    name: 'parenthesized arrow body with a real call',
    fileName: 'case.ts',
    source: "const f = () => (require('real')); require('outside');",
    expected: ['real', 'outside'],
  },
  ...['require', 'require: Loader'].map((parameter) => ({
    name: `typed nested conditional arrow (${parameter})`,
    fileName: 'case.ts',
    source: `const f = flag ? () => (${parameter}): Result => require('fake') : () => require('real'); require('outside');`,
    expected: ['real', 'outside'],
  })),
  {
    name: 'inner conditional in the alternate does not prove arrow parameters',
    fileName: 'case.mjs',
    source:
      "const f = flag ? () => (require) : x => other ? require('real') : require('other-real'); require('outside');",
    expected: ['real', 'other-real', 'outside'],
  },
  {
    name: 'JSX expression calls stay evidence with nested generic tags',
    fileName: 'case.tsx',
    source:
      "const f = (value = <Box<Result> title={require('real')}><p>don't (</p></Box>, load) => require('outside');",
    expected: ['real', 'outside'],
  },
];
