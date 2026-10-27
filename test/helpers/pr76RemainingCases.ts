export const remainingParserCases = [
  {
    name: 'R1',
    fileName: 'index.cjs',
    source: `const of = 6;
for (const x of of / require('real') / 2 ? [] : []) {}`,
  },
  {
    name: 'R2',
    fileName: 'index.cjs',
    source: `const as = 0, x = 1;
as < x > /require('fake')/.source.length;
require('real');`,
  },
  {
    name: 'R2b',
    fileName: 'index.cjs',
    source: `const satisfies = 0, x = 1;
satisfies < x > /require('fake')/.source.length;
require('real');`,
  },
  {
    name: 'R3',
    fileName: 'index.ts',
    source: `class Base<T> {}
class C extends Base<{ ok: boolean }> {
  async run() { await /require('fake')/; require('real'); }
}`,
  },
  {
    name: 'R3b',
    fileName: 'index.ts',
    source: `interface I<T> {}
class C implements I<{ ok: boolean }> {
  async run() { await /require('fake')/; require('real'); }
}`,
  },
  {
    name: 'R4',
    fileName: 'index.ts',
    source: `namespace N { export type Num<T> = number; }
const n = 1 as N.Num<string> / require('real') / 2;`,
  },
  {
    name: 'R4b',
    fileName: 'index.ts',
    source: `namespace N { export type Num<T> = number; }
const n = 1 satisfies N.Num<string> / require('real') / 2;`,
  },
  {
    name: 'R5',
    fileName: 'index.ts',
    source: `type Num<T> = number;
const n = 1 as Num<keyof { ok: boolean }> / require('real') / 2;`,
  },
  {
    name: 'R5b',
    fileName: 'index.ts',
    source: `type Num<T> = number;
const n = 1 satisfies Num<keyof { ok: boolean }> / require('real') / 2;`,
  },
  {
    name: 'R6',
    fileName: 'index.cjs',
    source: `/* comment */ --> require('fake')
require('real');`,
  },
  {
    name: 'R6b',
    fileName: 'index.cjs',
    source: `const x = 1; /* comment
*/ --> require('fake')
require('real');`,
  },
] as const;
