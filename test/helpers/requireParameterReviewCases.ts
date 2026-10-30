/** Step 80 review regressions and adjacent controls; source is never evaluated. */
export const requireParameterReviewCases = [
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
