// These sources keep their delimiters and line breaks to exercise arrow retirement.
export const arrowAssertionCases = ['as', 'satisfies'].flatMap((operator) =>
  [
    {
      name: `semicolon restores async grammar after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const g = () => 1 ${operator} Num<string>;
  await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `semicolon restores ordinary grammar after ${operator}`,
      source: `type Num<T> = number;
function f(await) {
  const g = async () => 1 ${operator} Num<string>;
  return await / require('real') / 2;
}`,
    },
    {
      name: `comma after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const g = () => 1 ${operator} Num<string>, x = await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `argument closing parenthesis after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  use(() => 1 ${operator} Num<string>);
  await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `array closing bracket after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const items = [() => 1 ${operator} Num<string>];
  await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `object closing brace after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const o = { g: () => 1 ${operator} Num<string> };
  await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `outer conditional colon after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const g = flag ? () => 1 ${operator} Num<string> : await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `template interpolation closing brace after ${operator}`,
      source:
        'type Num<T> = number; async function f() { const text = `${() => 1 ' +
        operator +
        " Num<string>}`; await /require('fake')/; require('real'); }",
    },
    {
      name: `nested arrows retire together after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const g = () => () => 1 ${operator} Num<string>;
  await /require('fake')/;
  require('real');
}`,
    },
    {
      name: `ASI restores async grammar after ${operator}`,
      source: `type Num<T> = number;
async function f() {
  const g = () => 1 ${operator} Num<string>
  await /require('fake')/;
  require('real');
}`,
    },
  ].map((scenario) => ({
    ...scenario,
    fileName: 'index.ts',
    expected: [{ specifier: 'real', kind: 'require' }] as const,
  })),
);
