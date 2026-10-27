import { spawnSync } from 'node:child_process';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';
import { arrowAssertionCases } from '../../helpers/pr76ArrowAssertionCases.js';

describe('PR #76 arrow retirement after assertions', () => {
  it.each(arrowAssertionCases)('$name extracts exact occurrences', ({ source, expected }) => {
    expect(extractModuleSpecifiers(source)).toEqual(expected);
  });

  it.each(arrowAssertionCases)(
    '$name has valid syntax without executing bodies',
    ({ source, fileName }) => {
      const syntax = ts.transpileModule(source, {
        fileName,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
      });
      expect(syntax.diagnostics).toEqual([]);
      const emitted = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: syntax.outputText,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(emitted.error).toBeUndefined();
      expect(emitted.status, emitted.stderr).toBe(0);
    },
  );
});

const real = [{ specifier: 'real', kind: 'require' }] as const;

const retirementControls = ['as', 'satisfies'].flatMap((operator) => [
  ...[
    'number',
    'Num<string>',
    'number & {}',
    '[number]',
    '(number)',
    '1',
    '-1',
    '`x${number}`',
    'Num<string> | Num<number>',
    'Num<string> extends number ? number : {}',
    '() => number',
  ].map((type) => ({
    name: `ASI and generator grammar after ${operator} ${type}`,
    source: `type Num<T> = number;
async function outer() {
  const g = () => 1 ${operator} ${type}
  await /require('fake')/;
}
function ordinary(await) {
  const g = async () => 1 ${operator} ${type}
  return await / require('real') / 2;
}
function* generate() {
  const g = () => 1 ${operator} ${type}
  yield /require('fake')/;
  require('real');
}`,
    expected: [...real, ...real],
  })),
  ...[
    `function f(await) { const g = async () => 1 ${operator} Num<string> + await /require('fake')/; return await / require('real') / 2; }`,
    `async function f() { const g = () => 1 ${operator} Num<string> + 2; await /require('fake')/; require('real'); }`,
    `function f(await) { const g = async () => flag ? 1 ${operator} Num<string> : await /require('fake')/; return await / require('real') / 2; }`,
    `async function f(cb = () => 1 ${operator} Num<string>) { await /require('fake')/; require('real'); }`,
    `const f = async () => use(() => 1 ${operator} Num<string>) + await /require('fake')/; require('real');`,
    `async function f() { class C { field = () => 1 ${operator} Num<string>
async run() { await /require('fake')/; } } await /require('fake')/; require('real'); }`,
    `const text = \`\${async () => use(() => 1 ${operator} Num<string>) + await /require('fake')/}\`; require('real');`,
    `async function f() { const g = () => 1 ${operator} Num<string, number> & { callback: () => void }; await /require('fake')/; require('real'); }`,
  ].map((source, index) => ({
    name: `${operator} keeps nested owner ${String(index)}`,
    source,
    expected: real,
  })),
  {
    name: `query imports survive arrow retirement with ${operator}`,
    source: `async function f() { const g = () => value ${operator} import('types').Num<string>; await /require('fake')/; require('real'); }`,
    expected: [{ specifier: 'types', kind: 'dynamic-import' }, ...real],
  },
]);

describe('arrow assertion retirement controls', () => {
  it.each(retirementControls)('$name', ({ source, expected }) => {
    expect(extractModuleSpecifiers(source)).toEqual(expected);
  });

  it.each(retirementControls)('$name is syntactically valid', ({ source }) => {
    const syntax = ts.transpileModule(source, {
      fileName: 'control.ts',
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS },
    });
    expect(syntax.diagnostics).toEqual([]);
    const emitted = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
      input: syntax.outputText,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(emitted.error).toBeUndefined();
    expect(emitted.status, emitted.stderr).toBe(0);
  });
});
