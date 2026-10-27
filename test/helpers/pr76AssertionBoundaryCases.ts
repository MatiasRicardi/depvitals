// Keep line breaks and punctuation: these cases exercise ASI and assertion boundaries.
// prettier-ignore
export const assertionBoundaryCases = [
  {
    name: 'A1',
    fileName: 'index.ts',
    source: `const n = 1 as number & {} / require('real') / 2;`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'A2',
    fileName: 'index.ts',
    source: `const n = 1 satisfies number & {} / require('real') / 2;`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'A3',
    fileName: 'index.ts',
    source: `class C {
  field = 1 as number & {}
  async run() { await /require('fake')/; require('real'); }
}`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'B1',
    fileName: 'index.ts',
    source: `type Num<T> = number;
const n = 1 as Num<string> | Num<number> / require('real') / 2;`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'B2',
    fileName: 'index.ts',
    source: `type Num<T> = number;
const n = 1 satisfies Num<string> & Num<number> / require('real') / 2;`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'B3',
    fileName: 'index.ts',
    source: `type Num<T> = number;
const n = 1 as Num<string> extends number ? Num<string> : Num<number> / require('real') / 2;`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'B4',
    fileName: 'index.ts',
    source: `type Num<T> = number;
class C {
  field = 1 as Num<string> | Num<number>
  async run() { await /require('fake')/; require('real'); }
}`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'C1',
    fileName: 'index.ts',
    source: `declare module 'types' { export type Num<T> = number; }
const n = 1 as import('types').Num<string> / require('real') / 2;`,
    expected: [{ specifier: 'types', kind: 'dynamic-import' }, { specifier: 'real', kind: 'require' }],
  },
  {
    name: 'C2',
    fileName: 'index.ts',
    source: `declare module 'types' { export type Num<T> = number; }
const n = 1 satisfies import('types').Num<string> / require('real') / 2;`,
    expected: [{ specifier: 'types', kind: 'dynamic-import' }, { specifier: 'real', kind: 'require' }],
  },
  {
    name: 'D1',
    fileName: 'index.cjs',
    source: `const as = 0, x = 1;
x
as < x > /require('fake')/.source.length;
require('real');`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
  {
    name: 'D2',
    fileName: 'index.cjs',
    source: `const satisfies = 0, x = 1;
x
satisfies < x > /require('fake')/.source.length;
require('real');`,
    expected: [{ specifier: 'real', kind: 'require' }],
  },
] as const;
