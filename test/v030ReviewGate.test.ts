import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/core/analyzeProject.js';
import { extractModuleSpecifiers } from '../src/scanner/moduleSpecifiers.js';

type Scenario = {
  name: string;
  source: string;
  module: boolean;
  used: boolean;
};
const cases: readonly Scenario[] = [
  {
    name: 'export member multiplication',
    source: `const box = { export: 1 }; const from = 2; box.export * from\n'candidate';`,
    module: false,
    used: false,
  },
  {
    name: 'optional export member multiplication',
    source: `const box = { export: 1 }; const from = 2; box?.export * from\n'candidate';`,
    module: false,
    used: false,
  },
  {
    name: 'private export member multiplication',
    source: `class Box { #export = 1; method() { const from = 2; this.#export * from\n'candidate'; } }`,
    module: false,
    used: false,
  },
  {
    name: 'authentic star reexport',
    source: `export * from 'candidate';`,
    module: true,
    used: true,
  },
  {
    name: 'authentic named reexport',
    source: `export { value as renamed } from 'candidate';`,
    module: true,
    used: true,
  },
  ...['g', 'divisor'].flatMap((divisor) =>
    ['', ' '].map((space) => ({
      name: `identifier divisor ${divisor}, space=${String(space.length)}`,
      source: `var await = 4, ${divisor} = 2; await /require('candidate')/${space}${divisor};`,
      module: false,
      used: true,
    })),
  ),
  ...['=== 1', '&& 1', '|| 1', '?.value', '.value'].map((tail) => ({
    name: `flag-like divisor followed by ${tail}`,
    source: `var await = 4, g = 2; await /require('candidate')/g ${tail};`,
    module: false,
    used: true,
  })),
  ...[
    '===',
    '!==',
    '==',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
    '<<',
    '>>',
    '>>>',
    '*',
    '%',
    '&',
    '|',
    '^',
    '??',
    '&&',
    '||',
  ].map((operator) => ({
    name: `awaited regex then ${operator}`,
    source: `await /require('candidate')/ ${operator} 1;`,
    module: true,
    used: false,
  })),
  {
    name: 'parenthesized await permits exponentiation',
    source: `const value = (await /require('candidate')/) ** 1;`,
    module: true,
    used: false,
  },
  ...['in', 'instanceof'].map((operator) => ({
    name: `awaited regex then keyword ${operator}`,
    source: `await /require('candidate')/ ${operator} Object;`,
    module: true,
    used: false,
  })),
  {
    name: 'awaited apostrophe regex comparison',
    source: `await /don't/ === 1;`,
    module: true,
    used: false,
  },
  {
    name: 'awaited regex comparison without spaces',
    source: `await /require('candidate')/===1;`,
    module: true,
    used: false,
  },
  // These continuations admit a script operand after the second division operator.
  ...['+2', '-2', '.5', '(2)', '[2][0]', '`text`'].map((tail) => ({
    name: `ambiguous operand ${tail} keeps script mode`,
    source: `var await = 4; await /require('candidate')/ ${tail};`,
    module: false,
    used: true,
  })),
  {
    name: 'separate export settles flagged regex',
    source: `await /require('candidate')/g; export {};`,
    module: true,
    used: false,
  },
];
const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const clean = 'DepVitals\n\nNo dependency issues found.\n';

function project(work: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-v030-regressions-')));
  return work(root).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}
function write(root: string, name: string, text: string): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function compiled(root: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, root], {
    cwd: tmpdir(),
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('v0.3 review: export properties and await mode boundaries', () => {
  it.each(cases)('$name: syntax oracle and detected/explicit lexical modes', (scenario) => {
    const syntax = spawnSync(
      process.execPath,
      ['--check', `--input-type=${scenario.module ? 'module' : 'commonjs'}`],
      {
        input: scenario.source,
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    expect(syntax.error).toBeUndefined();
    expect(syntax.status, syntax.stderr).toBe(0);
    if (scenario.module) {
      const script = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: scenario.source,
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(script.error).toBeUndefined();
      expect(script.status, script.stderr).not.toBe(0);
    }
    const names = scenario.used ? ['candidate'] : [];
    for (const module of ['detect', scenario.module] as const) {
      expect(
        extractModuleSpecifiers(scenario.source, { module }).map(({ specifier }) => specifier),
      ).toEqual(names);
    }
  });

  for (const declared of [false, true]) {
    it.each(cases)(
      `$name: findings and CLI channels, declared=${String(declared)}`,
      async (scenario) => {
        await project(async (root) => {
          const dependencies = { outside: '*', ...(declared ? { candidate: '*' } : {}) };
          const source = `${scenario.source}\nrequire('outside');`;
          const unused = declared && !scenario.used ? ['candidate'] : [];
          const missing = !declared && scenario.used ? ['candidate'] : [];
          const expected = {
            status: unused.length || missing.length ? 1 : 0,
            stdout: unused.length
              ? 'DepVitals\n\nUnused dependencies (1)\n  candidate\n'
              : missing.length
                ? 'DepVitals\n\nMissing dependencies (1)\n  candidate\n'
                : clean,
            stderr: '',
          };
          // .js detection, explicit nearest type, and extension override are independent paths.
          for (const mode of ['detected', 'type', 'extension'] as const) {
            const manifest = JSON.stringify({
              dependencies,
              ...(mode !== 'detected' ? { type: scenario.module ? 'module' : 'commonjs' } : {}),
            });
            const file = `index.${mode === 'extension' ? (scenario.module ? 'mjs' : 'cjs') : 'js'}`;
            write(root, 'package.json', manifest);
            write(root, file, source);
            const analysis = await analyzeProject(root);
            expect(analysis.unusedDependencies).toEqual(unused);
            expect(analysis.unusedDevDependencies).toEqual([]);
            expect(analysis.missingDependencies).toEqual(missing);
            expect(compiled(root)).toEqual(expected);
            expect(readFileSync(join(root, file), 'utf8')).toBe(source);
            expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
            rmSync(join(root, file));
          }
        });
      },
    );
  }

  it('keeps nearest no-type/commonjs/module scopes and extension precedence', async () => {
    await project(async (root) => {
      write(root, 'package.json', '{"type":"module"}');
      write(root, 'index.js', `await /require('root-decoy')/ === 1;`);
      write(root, 'child/package.json', '{}');
      write(root, 'child/index.js', `var await = 4, g = 2; await /require('child-real')/g;`);
      write(root, 'child/esm.js', `await /don't/ === 1;`);
      write(root, 'child/forced.mjs', `await /require('extension-decoy')/g;`);
      write(root, 'script/package.json', '{"type":"commonjs"}');
      write(root, 'script/index.js', `var await = 4, g = 2; await /require('script-real')/g;`);
      write(root, 'script/forced.mjs', `await /require('mjs-decoy')/ === 1;`);
      write(root, 'module/package.json', '{"type":"module"}');
      write(root, 'module/index.js', `await /require('module-decoy')/g;`);
      write(root, 'module/forced.cjs', `var await = 4, g = 2; await /require('cjs-real')/g;`);
      expect((await analyzeProject(root)).missingDependencies).toEqual([
        'child-real',
        'cjs-real',
        'script-real',
      ]);
      expect(compiled(root)).toEqual({
        status: 1,
        stdout: 'DepVitals\n\nMissing dependencies (3)\n  child-real\n  cjs-real\n  script-real\n',
        stderr: '',
      });
    });
  });
});
