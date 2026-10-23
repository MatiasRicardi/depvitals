import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/runCli.js';
import { analyzeProject } from '../src/core/analyzeProject.js';
import { extractModuleSpecifiers, ModuleSpecifierError } from '../src/scanner/moduleSpecifiers.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'analysis');
const CLEAN = 'DepVitals\n\nNo dependency issues found.\n';
const MISSING = 'DepVitals\n\nMissing dependencies (1)\n  real\n';
const OPTIONS = { version: '0.1.2', cwd: tmpdir() };

const GENERICS = [
  `const f = <T,>(x: T) => x;`,
  `const f = <T ,>(x: T) => x;`,
  `const f = <T /* note */,>(x: T) => x;`,
  `const f = <T = string>(x: T) => x;`,
  `const f = <T = string,>(x: T) => x;`,
  `const f = <T /* note */ = string>(x: T) => x;`,
  `const f = <T extends object>(x: T) => x;`,
  `const f = <T /* note */ extends object>(x: T) => x;`,
  `const f = <const T,>(x: T) => x;`,
  `const f = <const /* note */ T,>(x: T) => x;`,
  `type Fn = <T>(x: T) => T;`,
  `type Fn = <T>(x: ')', y: (x: T) => T) /* note */ => T;`,
  `type Fn = <T>(x: T /* ) */) => T;`,
  `const f = <T\n,>(x: T) => x;`,
  `const f = <T\n= string>(x: T) => x;`,
  `const f = <T // note\n,>(x: T) => x;`,
];

const COMPONENTS: readonly (readonly [string, readonly string[]])[] = [
  [`<Comp<string> value="a" />`, []],
  [`<Comp<string> value={require('real')} />`, ['real']],
  [`<Comp<Array<string>> />`, []],
  [`<Comp<{value: string}> />`, []],
  [`<Comp<() => void> />`, []],
  [`<Comp<(value: Array<string>) => {value: string}> />`, []],
  [`<UI.Comp<string>>hello</UI.Comp>`, []],
  [`<Comp<"require('fake')"> />`, []],
  [`<Comp<"require('fake') >"> />`, []],
  [`<Comp<import('types-pkg').Item> />`, ['types-pkg']],
  [`<Comp<Array<import('types-pkg').Item>> />`, ['types-pkg']],
  [`<Comp<string /* > require('fake') */> />`, []],
  [`<Comp<string // > require('fake')\n> />`, []],
  [`<><Comp<string> value={require('real')} />{require('child')}</>`, ['real', 'child']],
  [`<div>{<Comp<string> value={require('real')} />}</div>`, ['real']],
  [`<Comp<{value: "import('fake')"; item: import('types-pkg').Item}> />`, ['types-pkg']],
];

function specifiers(source: string): readonly string[] {
  return extractModuleSpecifiers(source, { jsx: true }).map((entry) => entry.specifier);
}

function expectValidTsx(source: string): void {
  const file = ts.createSourceFile(
    'fixture.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const host: ts.CompilerHost = {
    ...ts.createCompilerHost({ noLib: true }),
    getSourceFile: (name) => (name === 'fixture.tsx' ? file : undefined),
    fileExists: (name) => name === 'fixture.tsx',
    readFile: (name) => (name === 'fixture.tsx' ? source : undefined),
  };
  const program = ts.createProgram(
    ['fixture.tsx'],
    { noLib: true, jsx: ts.JsxEmit.Preserve },
    host,
  );

  expect(
    program
      .getSyntacticDiagnostics(file)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
  ).toEqual([]);
}

describe('Step 68.5 TSX syntax validation (no execution or semantic resolution)', () => {
  it.each(GENERICS)('accepts %s as TSX', (declaration) => {
    expectValidTsx(`${declaration} require('real');`);
  });

  it.each(COMPONENTS)('accepts %s as TSX', (component) => {
    expectValidTsx(`const view = ${component}; require('after');`);
  });
});

describe('Step 68.5 bounded TSX extraction', () => {
  it.each(GENERICS)('preserves the require after %s', (declaration) => {
    expect(specifiers(`${declaration} require('real');`)).toEqual(['real']);
  });

  it.each(COMPONENTS)('preserves exact evidence in %s', (component, expected) => {
    expect(specifiers(`const view = ${component}; require('after');`)).toEqual([
      ...expected,
      'after',
    ]);
  });

  it.each([
    `<div extendsFoo="a">don't</div>`,
    `<div implementsFoo="b" />`,
    `<Comp title="require('fake')" />`,
    `<Comp title="import('fake')" />`,
    `<div>(don't)</div>`,
    `<div>(/* inert text)</div>`,
    `<div>/* inert text</div>`,
  ])('retains normal JSX for %s', (component) => {
    expectValidTsx(`const view = ${component};`);
    expect(specifiers(`const view = ${component}; require('real');`)).toEqual(['real']);
  });

  it('does not join tokens across markup, type arguments or sibling expressions', () => {
    expect(
      specifiers(`const view = <Comp<"fake">>{import}{('fake')}{require}{('fake')}</Comp>;`),
    ).toEqual([]);
  });

  it('restores the nearest async context after typed JSX', () => {
    expect(
      specifiers(`
        async function outer() {
          const view = <Comp<() => void> value={await /require('fake')/} />;
          await /require('fake')/;
          function inner(await) {
            const other = <Comp<string> />;
            return await / require('real') / 2;
          }
        }
      `),
    ).toEqual(['real']);
  });

  it('restores the outer arrow expression context after typed JSX', () => {
    expect(
      specifiers(`
        const render = async () => <Comp<string> value={await /require('fake')/} />;
        const other = await / require('real') / 2;
      `),
    ).toEqual(['real']);
  });

  it.each([
    `const view = <Comp<Array<string`,
    `const view = <Comp<string>`,
    `const view = <Comp<"unterminated`,
    `const view = <Comp<string /* unterminated`,
    `const view = <Comp<string> value={require('real')`,
    `const view = <Comp<string> value={'unterminated} />`,
    'const view = <Comp<string> value={`unterminated} />',
    `const view = <Comp<string> value={/unterminated} />`,
  ])('rejects lexically incomplete TSX: %s', (source) => {
    expect(() => specifiers(source)).toThrow(ModuleSpecifierError);
  });

  it('fails explicitly rather than extracting from unsupported template literal types', () => {
    expect(() => specifiers('const view = <Comp<`require("fake")`> />;')).toThrow(
      'Template literal types in JSX type arguments are not supported',
    );
  });
});

const PROJECTS: readonly (readonly [string, number, string])[] = [
  ['tsx-generic-default', 0, CLEAN],
  ['tsx-generic-comment', 1, MISSING],
  ['tsx-component-clean', 0, CLEAN],
  ['tsx-component-missing', 1, MISSING],
  ['tsx-component-declared', 0, CLEAN],
  ['tsx-type-string', 1, 'DepVitals\n\nUnused dependencies (1)\n  fake\n'],
  ['tsx-type-import', 1, 'DepVitals\n\nMissing dependencies (1)\n  types-pkg\n'],
];

function snapshot(project: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    readdirSync(project).map((name) => [name, readFileSync(join(project, name), 'utf8')]),
  );
}

describe('Step 68.5 CLI and analyzer fixtures', () => {
  it.each(PROJECTS)(
    '%s has exact output and is deterministic and read-only',
    async (name, exitCode, stdout) => {
      const project = join(FIXTURES, name);
      const before = snapshot(project);

      expectValidTsx(readFileSync(join(project, 'index.tsx'), 'utf8'));
      const first = await runCli([project], OPTIONS);
      expect(first).toEqual({ exitCode, stdout, stderr: '' });
      expect(await runCli([project], OPTIONS)).toEqual(first);
      expect(snapshot(project)).toEqual(before);
    },
  );

  it('preserves the exact analyzer arrays for a type import', async () => {
    const project = join(FIXTURES, 'tsx-type-import');
    expect(await analyzeProject(project)).toEqual({
      projectRoot: project,
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: ['types-pkg'],
    });
  });

  it('does not return a partial report for incomplete type arguments', async () => {
    const project = join(FIXTURES, 'tsx-types-incomplete');
    const before = snapshot(project);
    const result = await runCli([project], OPTIONS);
    expect(result).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `Source file ${join(FIXTURES, 'tsx-types-incomplete', 'index.tsx')} could not be analyzed: Unterminated JSX type arguments\n`,
    });
    expect(await runCli([project], OPTIONS)).toEqual(result);
    expect(snapshot(project)).toEqual(before);
  });

  it('reports incomplete type arguments through the compiled CLI without partial stdout', () => {
    const project = join(FIXTURES, 'tsx-types-incomplete');
    const result = spawnSync(process.execPath, [join(ROOT, 'dist', 'cli', 'index.js'), project], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 1,
      stdout: '',
      stderr: `Source file ${join(project, 'index.tsx')} could not be analyzed: Unterminated JSX type arguments\n`,
    });
  });

  it.each(PROJECTS)('%s also works through the compiled CLI', (name, status, stdout) => {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'dist', 'cli', 'index.js'), join(FIXTURES, name)],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
        env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
        timeout: 10_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status,
      stdout,
      stderr: '',
    });
  });
});
