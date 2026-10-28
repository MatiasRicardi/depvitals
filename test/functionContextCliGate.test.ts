/**
 * Function boundaries, async signatures and source module mode survive the compiled entrypoint.
 *
 * The scanner unit tests cover the lexical decisions directly. These cases also run the built CLI
 * in a child process so analyzer wiring, output channels and exit codes remain covered together.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/core/analyzeProject.js';
import { expressionOwnerCases } from './helpers/expressionOwnerCases.js';
import { arrowAssertionCases } from './helpers/pr76ArrowAssertionCases.js';
import { assertionBoundaryCases } from './helpers/pr76AssertionBoundaryCases.js';
import { remainingParserCases } from './helpers/pr76RemainingCases.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

type RunResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runBuilt(project: string): RunResult {
  const result = spawnSync(process.execPath, [BUILT_ENTRY, project], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DEPVITALS_NO_UPDATE_CHECK: '1',
    },
    timeout: 10_000,
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).not.toBeNull();

  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runProject(
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): RunResult {
  const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-4-cli-'));

  try {
    writeFileSync(join(project, 'package.json'), JSON.stringify(manifest));

    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(project, name), source);
    }

    const result = runBuilt(project);
    expect(readdirSync(project).sort()).toEqual(['package.json', ...Object.keys(files)].sort());
    expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(JSON.stringify(manifest));
    for (const [name, source] of Object.entries(files)) {
      expect(readFileSync(join(project, name), 'utf8')).toBe(source);
    }
    return result;
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe('Step 68.4 compiled CLI gate', () => {
  it('reports a nested ordinary function require as missing', () => {
    const result = runProject(
      { name: 'nested-function', version: '0.0.0' },
      {
        'index.cjs': `
          async function outer() {
            function inner(await) {
              return await / require('real') / 2;
            }
          }
        `,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('DepVitals\n\nMissing dependencies (1)\n  real\n');
    expect(result.stderr).toBe('');
  });

  describe('Step 68.9 structural contexts through the compiled CLI', () => {
    const cases = [
      ...remainingParserCases,
      {
        name: 'assertion function types do not change the surrounding async grammar',
        fileName: 'index.ts',
        source: `async function outer() {
          const value = 1 as Num<() => number> + await /require('fake')/;
          require('real');
        }`,
      },
      {
        name: 'consecutive fields',
        fileName: 'index.cjs',
        source: `class C { a = () => 0
          b
          c
          *run() { yield /require('fake')/; require('real'); }
        }`,
      },
      {
        name: 'block arrow initializer before async method',
        fileName: 'index.cjs',
        source: `class C { handle = () => {}
          async load() { await /require('fake')/; require('real'); }
        }`,
      },
      {
        name: 'function initializer before generator',
        fileName: 'index.cjs',
        source: `class C { handle = function () {};
          *run() { yield /require('fake')/; require('real'); }
        }`,
      },
      {
        name: 'class expression initializer before async method',
        fileName: 'index.cjs',
        source: `class C { handle = class {}
          async load() { await /require('fake')/; require('real'); }
        }`,
      },
      {
        name: 'function-typed field',
        fileName: 'index.ts',
        source: `class C { callback!: (value: string) => void
          *run() { yield /require('fake')/; require('real'); }
        }`,
      },
      {
        name: 'mixed expression and return annotation',
        fileName: 'index.ts',
        source: `const o = { value: cond ? f() : async (): Promise<{ ok: boolean }> => {
          await /require('fake')/; require('real'); return { ok: true };
        } };`,
      },
      {
        name: 'template interpolation inside object types',
        fileName: 'index.ts',
        source:
          'function f(x: { tag: `x${string}` }) {} class C { value!: { tag: `x${string}` }; } require("real");',
      },
      {
        name: 'special method names and ordinary string methods',
        fileName: 'index.cjs',
        source: `async function outer() {
          const o = { async return() { await /require('fake')/; require('real'); },
            'run'(await) { return await / require('real') / 2; },
            *function() { yield /require('fake')/; require('real'); } };
          class C { 1(await) { return await / require('real') / 2; } }
        }`,
      },
      {
        name: 'nested generic arrow and method signatures',
        fileName: 'index.ts',
        source: `const f = async <T extends { value: number }>(x: T) => {
          await /require('fake')/; require('real'); };
          class C { async run<T = (x: { value: number }) => void>(x: T) {
            await /require('fake')/; require('real'); } }`,
      },
      {
        name: 'postfix division and field boundary',
        fileName: 'index.cjs',
        source: `let n = 1; const value = n++ / require('real') / 2;
          class C { value = n--
            async run() { await /require('fake')/; require('real'); } }`,
      },
      {
        name: 'word operators continue async expression bodies',
        fileName: 'index.cjs',
        source: `const f = async () => value
          instanceof Object ? await /require('fake')/ : require('real');
          class C { value = async () => value /*\n*/ in Object
            ? await /require('fake')/ : require('real'); }`,
      },
      {
        name: 'for-of regex and restricted line terminators',
        fileName: 'index.cjs',
        source: `for (const x of /require('fake')/.source) { require('real'); }
          function f() { return
            {} /require('fake-too')/.test('');
          }
          while (flag) { break
            /require('fake-break')/.test('');
          }`,
      },
      {
        name: 'TypeScript assertion and abstract constructor type boundaries',
        fileName: 'index.ts',
        source: `type Num<T> = number;
          const value = 1 as Num<Array<string>> / require('real') / 2;
          class C { value!: abstract
            new () => object
            async run() { await /require('fake')/; require('real'); }
          }`,
      },
      {
        name: 'parameter and field grammar restore outer async contexts',
        fileName: 'index.cjs',
        source: `async function outer() {
          function inner(value = await / require('real') / 2) {}
          class C { value = await / require('real') / 2; }
          const f = flag ? () => 0 : await /require('fake')/;
          const g = (callback = async () => { await /require('fake-too')/; }) => 0;
          require('real');
        }`,
      },
      {
        name: 'class expressions divide but declarations permit regex',
        fileName: 'index.cjs',
        source: `const value = class {} / require('real') / 2;
          class C { handle = class Named extends Base {}
            / require('real') / 2; }
          /require('fake')/.test(value);`,
      },
    ];

    it.each(cases)('$name: clean with only real declared', ({ fileName, source }) => {
      expect(
        runProject(
          { name: 'structural-clean', version: '0.0.0', dependencies: { real: '*' } },
          { [fileName]: source },
        ),
      ).toEqual({
        status: 0,
        stdout: 'DepVitals\n\nNo dependency issues found.\n',
        stderr: '',
      });
    });

    it.each(cases)('$name: only real is missing', ({ fileName, source }) => {
      expect(
        runProject({ name: 'structural-missing', version: '0.0.0' }, { [fileName]: source }),
      ).toEqual({
        status: 1,
        stdout: 'DepVitals\n\nMissing dependencies (1)\n  real\n',
        stderr: '',
      });
    });

    it.each(cases)('$name: the declared decoy stays unused', ({ fileName, source }) => {
      expect(
        runProject(
          {
            name: 'structural-unused',
            version: '0.0.0',
            dependencies: { real: '*', fake: '*' },
          },
          { [fileName]: source },
        ),
      ).toEqual({
        status: 1,
        stdout: 'DepVitals\n\nUnused dependencies (1)\n  fake\n',
        stderr: '',
      });
    });

    it.each(cases)(
      '$name: a lexical error prevents a partial clean report',
      ({ fileName, source }) => {
        const result = runProject(
          { name: 'structural-invalid', version: '0.0.0', dependencies: { real: '*' } },
          { [fileName]: `${source}\n'unterminated` },
        );
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`Source file `);
        expect(result.stderr).toContain(
          `${fileName} could not be analyzed: Unterminated string literal`,
        );
        expect(result.stderr).not.toContain('No dependency issues found');
      },
    );

    it('keeps an incomplete object-type template on the operational error channel', () => {
      const result = runProject(
        { name: 'invalid-type-template', version: '0.0.0', dependencies: { real: '*' } },
        { 'index.ts': 'require("real"); function f(x: { tag: `x${string' },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(
        'index.ts could not be analyzed: Unterminated template literal',
      );
    });

    const moduleJsxCases = [
      {
        fileName: 'index.jsx',
        source: `const view = <p />;
          await /require('fake')/;
          require('real');
          export {};`,
      },
      {
        fileName: 'index.tsx',
        source: `const view = <p />;
          await /require('fake')/;
          require('real');
          export {};`,
      },
    ];

    it.each(moduleJsxCases)(
      '$fileName honors package type module for top-level await',
      ({ fileName, source }) => {
        expect(
          runProject(
            {
              name: 'module-jsx',
              version: '0.0.0',
              type: 'module',
              dependencies: { real: '*' },
            },
            { [fileName]: source },
          ),
        ).toEqual({
          status: 0,
          stdout: 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        });
      },
    );

    it.each(moduleJsxCases)(
      '$fileName does not hide a missing real module dependency',
      ({ fileName, source }) => {
        expect(
          runProject(
            { name: 'module-jsx-missing', version: '0.0.0', type: 'module' },
            { [fileName]: source },
          ),
        ).toEqual({
          status: 1,
          stdout: 'DepVitals\n\nMissing dependencies (1)\n  real\n',
          stderr: '',
        });
      },
    );

    it.each(moduleJsxCases)(
      '$fileName keeps the inert regex decoy unused',
      ({ fileName, source }) => {
        expect(
          runProject(
            {
              name: 'module-jsx-unused',
              version: '0.0.0',
              type: 'module',
              dependencies: { real: '*', fake: '*' },
            },
            { [fileName]: source },
          ),
        ).toEqual({
          status: 1,
          stdout: 'DepVitals\n\nUnused dependencies (1)\n  fake\n',
          stderr: '',
        });
      },
    );
  });

  it('does not report regex text from top-level await in an mjs module', () => {
    const result = runProject(
      { name: 'top-level-module', version: '0.0.0' },
      { 'index.mjs': `await /require('fake')/; require('real');` },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('DepVitals\n\nMissing dependencies (1)\n  real\n');
    expect(result.stderr).toBe('');
  });
});

describe('Steps 68.6 and 68.7 function contexts through analyzer and compiled CLI', () => {
  const cases = [
    {
      name: 'A: newline before an ordinary block arrow',
      source: `async\nx => { return await / require('real') / 2; };`,
      dependency: 'real',
      isUsage: true,
    },
    {
      name: 'B: multiline async expression arrow parameters',
      source: `const f = async (\n value\n) => await /require('fake')/;`,
      dependency: 'fake',
      isUsage: false,
    },
    {
      name: 'C: async function expression followed by division',
      source: `const n = async function () {} / require('real') / 2;`,
      dependency: 'real',
      isUsage: true,
    },
    {
      name: 'A1: default function callback',
      source: `async function outer(cb = function () {}) { await /require('fake')/; }`,
      dependency: 'fake',
      isUsage: false,
    },
    {
      name: 'A2: default block arrow callback',
      source: `async function outer(cb = () => {}) { await /require('fake')/; }`,
      dependency: 'fake',
      isUsage: false,
    },
    {
      name: 'A3: apostrophe regex and real require',
      source: `async function outer(cb = function () {}) { await /don't/; require("real"); }`,
      dependency: 'real',
      isUsage: true,
    },
    {
      name: 'B1: control statements inside an async property function',
      source: `const obj = { f: async function () {
        if (ok) /require('fake-head')/.test(text);
        if (ok) { await /require('fake-block')/; }
      } / require('real') / 2 };`,
      dependency: 'real',
      isUsage: true,
    },
    ...['', 'async '].flatMap((modifier) => [
      {
        name: `B1: ${modifier}function property`,
        source: `const obj = { f: ${modifier}function () {} / require("real") / 2 };`,
        dependency: 'real',
        isUsage: true,
      },
      {
        name: `B2: ${modifier}function conditional alternative`,
        source: `const n = flag ? function () {} : ${modifier}function () {} / require("real") / 2;`,
        dependency: 'real',
        isUsage: true,
      },
    ]),
  ];

  for (const declared of [false, true]) {
    it.each(cases)('$name with declared=' + String(declared), async (scenario) => {
      const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-6-'));
      const manifest = JSON.stringify({
        name: 'async-boundaries',
        version: '0.0.0',
        ...(declared ? { dependencies: { [scenario.dependency]: '*' } } : {}),
      });

      try {
        writeFileSync(join(project, 'package.json'), manifest);
        writeFileSync(join(project, 'index.cjs'), scenario.source);

        const missing = scenario.isUsage && !declared ? [scenario.dependency] : [];
        const unused = !scenario.isUsage && declared ? [scenario.dependency] : [];
        const expected = {
          projectRoot: project,
          unusedDependencies: unused,
          unusedDevDependencies: [],
          missingDependencies: missing,
        };

        expect(await analyzeProject(project)).toEqual(expected);
        expect(await analyzeProject(project)).toEqual(expected);
        expect(runBuilt(project)).toEqual({
          status: missing.length + unused.length > 0 ? 1 : 0,
          stdout:
            missing.length > 0
              ? 'DepVitals\n\nMissing dependencies (1)\n  real\n'
              : unused.length > 0
                ? 'DepVitals\n\nUnused dependencies (1)\n  fake\n'
                : 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        });
        expect(readdirSync(project).sort()).toEqual(['index.cjs', 'package.json']);
        expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
        expect(readFileSync(join(project, 'index.cjs'), 'utf8')).toBe(scenario.source);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }

  it('does not treat a template ? as a ternary that turns a labeled block into a division', async () => {
    const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-7-template-'));
    const manifest = JSON.stringify({ name: 'template-punct', version: '0.0.0' });
    try {
      writeFileSync(join(project, 'package.json'), manifest);
      // A `?` inside template text is inert: the trailing `label: {}` stays a block, so the `/`
      // starts a regex and 'fake-template' must NOT be reported as a dependency. This pins the
      // reviewer's "template punctuation creates false dependencies" scenario end to end.
      writeFileSync(
        join(project, 'index.cjs'),
        `let note = \`value ? more\`\nlabel: {} /require('fake-template') / 2;`,
      );

      expect(await analyzeProject(project)).toEqual({
        projectRoot: project,
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
      expect(runBuilt(project)).toEqual({
        status: 0,
        stdout: 'DepVitals\n\nNo dependency issues found.\n',
        stderr: '',
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  describe('Step 68.8 frame and typed-return boundaries through analyzer and CLI', () => {
    const cases = [
      // Each frame case keeps a real usage next to the decoy, so a scanner that stops scanning
      // inside the frame cannot pass by accident.
      {
        name: 'A1 template text does not terminate an async arrow',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const f = async () => \`,\` + require('real') + (await /require('fake')/);`,
      },
      {
        name: 'A2 ordinary arrow finds a require after template text',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `async function outer() { const f = () => \`,\` + await / require("real") / 2; }`,
      },
      {
        name: 'A3 closing an interpolation does not terminate an async arrow',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: "const f = async () => `${0}` + require('real') + (await /require('fake')/);",
      },
      {
        name: 'A4 JSX containers do not terminate an async arrow',
        fileName: 'index.tsx',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const f = async () => (
          <p>
            {0}
            {require('real')}
            {await /require('fake')/}
          </p>
        );`,
      },
      {
        name: 'B1 typed async function does not leak into its body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `async function check(): Promise<{ ok: boolean }> { const ok = await /require('fake')/; require('real'); return { ok }; }`,
      },
      {
        name: 'B3 typed async arrow does not leak into its body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const check = async (): Promise<{ ok: boolean }> => { await /require('fake')/; return { ok: true }; }; require("real");`,
      },
      {
        name: 'B3 typed async method does not leak into its body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `class C { async check(): Promise<{ ok: boolean }> { await /require('fake')/; return { ok: true }; } } require("real");`,
      },
      {
        name: 'B4 typed function expression preserves division',
        fileName: 'index.ts',
        dependencies: [{ name: 'real', used: true }],
        source: `const n = async function (): Promise<{ ok: boolean }> { return { ok: true }; } / require("real") / 2;`,
      },
      {
        name: 'typed callback return keeps the real body boundary',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `async function check(): () => void { await /require('fake')/; } require("real");`,
      },
      {
        name: 'C1 intersection return type keeps the real body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `async function check(): Promise<void> & { ok: boolean } { await /require('fake')/; require("real"); }`,
      },
      {
        name: 'C2 template literal return type keeps the real body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source:
          "async function check(): `a${number}b` { await /require('fake')/; require('real'); }",
      },
      {
        name: 'C3 a signature ending in a semicolon does not swallow the next async arrow',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `declare function checkAgain(): Promise<void>;
const check = async (): Promise<void> => { await /require('fake')/; require("real"); };`,
      },
      {
        name: 'C4 a signature ending in a semicolon does not swallow a JSX element',
        fileName: 'index.tsx',
        dependencies: [{ name: 'real', used: true }],
        source: `declare function check(): Promise<void>;
const view = <p>hi</p>;
require('real');`,
      },
      {
        name: 'C5 function type return on an arrow keeps the real body',
        fileName: 'index.ts',
        dependencies: [{ name: 'real', used: true }],
        source: `const make = (): (() => void) => { require("real"); return () => 0; };`,
      },
      {
        name: 'C6 generic async arrow keeps its async body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const check = async <T,>(value: T): Promise<T> => { await /require('fake')/; require("real"); return value; };`,
      },
      {
        name: 'C7 generic async method keeps its async body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `class C {
  async check<T>(): Promise<T> {
    await /require('fake')/;
    require("real");
    throw new Error('unreachable');
  }
}`,
      },
      {
        name: 'C8 a ternary call before an async method keeps its async body',
        fileName: 'index.ts',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const flag = false;
const service = { x: flag ? 1 : 2, async run(): Promise<void> { await /require('fake')/; require("real"); } };`,
      },
      // The `:` of a conditional expression never starts a return annotation, so the async arrow
      // keeps its body and the decoy regex stays inert.
      {
        name: 'D1 a `new` ternary branch keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const o = {
  x: cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D2 a `typeof` ternary branch keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const o = {
  x: cond ? typeof f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D3 a `void` ternary branch keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const o = {
  x: cond ? void f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D4 a multiplication ternary branch keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const o = {
  x: cond ? 2 * f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D5 an `await` ternary branch keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `async function outer() {
  const o = {
    x: cond ? await f() : async () => {
      await /require('fake')/;
      require('real');
    }
  };
}`,
      },
      {
        name: 'D6 a class field ternary keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `class C {
  field = cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  };
}`,
      },
      {
        name: 'D7 a computed property key ternary keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'fake', used: false },
          { name: 'real', used: true },
        ],
        source: `const o = {
  [cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  }]: 1
};`,
      },
      {
        name: 'D8 an empty object before multiplication does not mark a generator',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const o = {
  x: cond ? {} * f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D9 a populated object before multiplication does not mark a generator',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const o = {
  x: cond ? { x: 1 } * f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D10 a class field ternary keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = cond ? {} * f() : async () => {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D11 a computed property key ternary keeps the async arrow body',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const o = {
  [cond ? {} * f() : async () => {
    await /require('fake')/;
    require('real');
  }]: 1
};`,
      },
      ...(
        [
          ['number', '1'],
          ['string', "'text'"],
          ['array', '[]'],
          ['call', 'getValue()'],
        ] as const
      ).map(([label, initializer]) => ({
        name: `D12 an async class method follows a newline-terminated ${label} field`,
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = ${initializer}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      })),
      {
        name: 'D13 an async class method with return annotation follows a field',
        fileName: 'index.ts',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = 1
  async run(): Promise<void> {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D14 an explicit semicolon still separates a class field and method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = 1;
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D15 an apostrophe in a regex does not cause an operational error',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = 1
  async run() {
    await /don't/;
    require('real');
  }
}`,
      },
      {
        name: 'D16 a legitimate generator method retains its generator context',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const o = {
  *run() {
    yield /require('fake')/;
    require('real');
  }
};`,
      },
      {
        name: 'D17 a line-continued multiplication is not a class generator boundary',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = cond ? {}
    * f() : async () => {
      await /require('fake')/;
      require('real');
    }
}`,
      },
      {
        name: 'D18 a static initialization block separates the next async method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  static {}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D19 an apostrophe in a regex after a static block is inert',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  static {}
  async run() {
    await /don't/;
    require('real');
  }
}`,
      },
      ...(['new', 'typeof', 'void'] as const).map((operator) => ({
        name: `D20 a field initializer continues after the ${operator} operator`,
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = cond ? ${operator}
    F() : async () => {
      await /require('fake')/;
      require('real');
    };
}`,
      })),
      {
        name: 'D21 a regex field initializer ends before an async method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = /abc/
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D22 a template field initializer ends before an async method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value = \`require("fake")\`
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D23 a template interpolation remains executable source for extraction',
        fileName: 'index.cjs',
        dependencies: [
          { name: 'real', used: true },
          { name: 'template-real', used: true },
        ],
        source: `class C {
  value = \`text \${require('template-real')}\`
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D24 a field without an initializer ends before a generator',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  value
  *run() {
    yield /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D25 an of initializer value ends before an async method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const of = 1;
class C {
  value = of
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      {
        name: 'D26 an uninitialized field named of ends before an async method',
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `class C {
  of
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      },
      ...(
        [
          ['definite-assignment typed', 'value!: number', 'index.ts'],
          ['typed', 'value: number', 'index.ts'],
          ['private', '#value', 'index.cjs'],
          ['computed', '[key]', 'index.cjs'],
        ] as const
      ).map(([label, field, fileName]) => ({
        name: `D27 a generator follows an uninitialized ${label} field`,
        fileName,
        dependencies: [{ name: 'real', used: true }],
        source: `const key = 'value';
class C {
  ${field}
  *run() {
    yield /require('fake')/;
    require('real');
  }
}`,
      })),
      ...(['get', 'set', 'async'] as const).map((initializer) => ({
        name: `D28 ${initializer} as a field initializer stays a value`,
        fileName: 'index.cjs',
        dependencies: [{ name: 'real', used: true }],
        source: `const ${initializer} = () => 0;
class C {
  value = ${initializer}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      })),
    ] as const;

    it.each(cases)('$name uses valid source syntax', ({ fileName, source }) => {
      if (fileName.endsWith('.cjs')) {
        const result = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
          input: source,
          encoding: 'utf8',
          timeout: 10_000,
        });

        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return;
      }

      const result = ts.transpileModule(source, {
        fileName,
        compilerOptions: { jsx: ts.JsxEmit.Preserve },
        reportDiagnostics: true,
      });

      expect(
        result.diagnostics?.map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        ),
      ).toEqual([]);
    });

    for (const declared of [false, true]) {
      it.each(cases)(
        '$name through analyzer and compiled CLI, declared=$declared',
        async (scenario) => {
          const project = mkdtempSync(join(tmpdir(), 'depvitals-step68-8-'));
          const manifest = JSON.stringify({
            name: 'frame-and-return-boundaries',
            version: '0.0.0',
            ...(declared
              ? {
                  dependencies: Object.fromEntries(
                    scenario.dependencies.map(({ name }) => [name, '*']),
                  ),
                }
              : {}),
          });
          const sourcePath = join(project, scenario.fileName);

          try {
            writeFileSync(join(project, 'package.json'), manifest);
            writeFileSync(sourcePath, scenario.source);

            const missing = scenario.dependencies
              .filter(({ used }) => used && !declared)
              .map(({ name }) => name);
            const unused = scenario.dependencies
              .filter(({ used }) => !used && declared)
              .map(({ name }) => name);
            const expectedAnalysis = {
              projectRoot: project,
              unusedDependencies: unused,
              unusedDevDependencies: [],
              missingDependencies: missing,
            };
            const sections = ['DepVitals', ''];

            if (missing.length > 0) {
              sections.push(
                `Missing dependencies (${String(missing.length)})`,
                ...missing.map((name) => `  ${name}`),
              );
            }

            if (unused.length > 0) {
              if (missing.length > 0) {
                sections.push('');
              }
              sections.push(
                `Unused dependencies (${String(unused.length)})`,
                ...unused.map((name) => `  ${name}`),
              );
            }

            const expectedCli = {
              status: missing.length + unused.length > 0 ? 1 : 0,
              stdout:
                missing.length + unused.length > 0
                  ? `${sections.join('\n')}\n`
                  : 'DepVitals\n\nNo dependency issues found.\n',
              stderr: '',
            };

            expect(await analyzeProject(project)).toEqual(expectedAnalysis);
            expect(await analyzeProject(project)).toEqual(expectedAnalysis);
            expect(runBuilt(project)).toEqual(expectedCli);
            expect(readdirSync(project).sort()).toEqual([scenario.fileName, 'package.json'].sort());
            expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
            expect(readFileSync(sourcePath, 'utf8')).toBe(scenario.source);
          } finally {
            rmSync(project, { recursive: true, force: true });
          }
        },
      );
    }

    it('reports only the real usage of a ternary async arrow', () => {
      const source = `const o = {
  x: cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  }
};`;
      const declared = runProject(
        { name: 'ternary-async-arrow', version: '0.0.0', dependencies: { real: '*' } },
        { 'index.cjs': source },
      );

      expect(declared).toEqual({
        status: 0,
        stdout: 'DepVitals\n\nNo dependency issues found.\n',
        stderr: '',
      });

      expect(
        runProject({ name: 'ternary-async-arrow', version: '0.0.0' }, { 'index.cjs': source }),
      ).toEqual({
        status: 1,
        stdout: 'DepVitals\n\nMissing dependencies (1)\n  real\n',
        stderr: '',
      });
    });
  });

  it('keeps incomplete source as an operational error without partial output', async () => {
    const project = join(REPO_ROOT, 'test', 'fixtures', 'analysis', 'tsx-types-incomplete');
    const before = readdirSync(project).map((name) => [
      name,
      readFileSync(join(project, name), 'utf8'),
    ]);
    const message = `Source file ${join(project, 'index.tsx')} could not be analyzed: Unterminated JSX type arguments`;

    await expect(analyzeProject(project)).rejects.toThrow(message);
    expect(runBuilt(project)).toEqual({
      status: 1,
      stdout: '',
      stderr: `${message}\n`,
    });
    expect(
      readdirSync(project).map((name) => [name, readFileSync(join(project, name), 'utf8')]),
    ).toEqual(before);
  });
});

// Each report is compared in full: a dependency name in an unused section is not usage evidence.
describe('PR #76 complete assertion boundaries through the compiled CLI', () => {
  const cases = [...assertionBoundaryCases, ...arrowAssertionCases];
  for (const manifestMode of ['missing', 'clean', 'unused'] as const) {
    it.each(cases)(`$name with ${manifestMode} manifest`, async (scenario) => {
      const hasTypes = scenario.expected.some(({ specifier }) => specifier === 'types');
      const dependencies = {
        ...(hasTypes ? { types: '*' } : {}),
        ...(manifestMode !== 'missing' ? { real: '*' } : {}),
        ...(manifestMode === 'unused' ? { fake: '*' } : {}),
      };
      const project = mkdtempSync(join(tmpdir(), 'depvitals-assertion-boundary-'));
      const manifest = JSON.stringify({
        name: 'assertion-boundaries',
        version: '0.0.0',
        dependencies,
      });
      const sourcePath = join(project, scenario.fileName);
      try {
        writeFileSync(join(project, 'package.json'), manifest);
        writeFileSync(sourcePath, scenario.source);
        expect(await analyzeProject(project)).toEqual({
          projectRoot: project,
          unusedDependencies: manifestMode === 'unused' ? ['fake'] : [],
          unusedDevDependencies: [],
          missingDependencies: manifestMode === 'missing' ? ['real'] : [],
        });
        expect(runBuilt(project)).toEqual({
          status: manifestMode === 'clean' ? 0 : 1,
          stdout:
            manifestMode === 'missing'
              ? 'DepVitals\n\nMissing dependencies (1)\n  real\n'
              : manifestMode === 'unused'
                ? 'DepVitals\n\nUnused dependencies (1)\n  fake\n'
                : 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        });
        expect(readdirSync(project).sort()).toEqual([scenario.fileName, 'package.json'].sort());
        expect(readFileSync(sourcePath, 'utf8')).toBe(scenario.source);
        expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }
});

describe('Step 74 expression owners through analyzer and compiled CLI', () => {
  for (const mode of ['missing', 'clean', 'decoy'] as const) {
    it.each(expressionOwnerCases)(`$name with ${mode} manifest`, async (scenario) => {
      const project = mkdtempSync(join(tmpdir(), 'depvitals-expression-owner-'));
      const names = [...scenario.expected].sort();
      const dependencies: Record<string, string> = {};
      if (mode !== 'missing') {
        for (const name of names) {
          dependencies[name] = '*';
        }
      }
      if (mode === 'decoy') {
        dependencies['owner-fake-inner'] = '*';
      }
      const manifest = JSON.stringify({ dependencies });
      try {
        writeFileSync(join(project, 'package.json'), manifest);
        writeFileSync(join(project, scenario.fileName), scenario.source);
        expect(await analyzeProject(project)).toEqual({
          projectRoot: project,
          unusedDependencies: mode === 'decoy' ? ['owner-fake-inner'] : [],
          unusedDevDependencies: [],
          missingDependencies: mode === 'missing' ? names : [],
        });
        expect(runBuilt(project)).toEqual({
          status: mode === 'clean' ? 0 : 1,
          stdout:
            mode === 'missing'
              ? `DepVitals\n\nMissing dependencies (${String(names.length)})\n${names.map((name) => `  ${name}\n`).join('')}`
              : mode === 'decoy'
                ? 'DepVitals\n\nUnused dependencies (1)\n  owner-fake-inner\n'
                : 'DepVitals\n\nNo dependency issues found.\n',
          stderr: '',
        });
        expect(readdirSync(project).sort()).toEqual([scenario.fileName, 'package.json'].sort());
        expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
        expect(readFileSync(join(project, scenario.fileName), 'utf8')).toBe(scenario.source);
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }

  it('keeps a lexical failure after an expression owner operational with no partial report', async () => {
    const project = mkdtempSync(join(tmpdir(), 'depvitals-expression-error-'));
    const source = `const f = () => function() {} / require('owner-divisor') / 2; 'unterminated`;
    try {
      writeFileSync(join(project, 'package.json'), '{}');
      writeFileSync(join(project, 'index.cjs'), source);
      await expect(analyzeProject(project)).rejects.toThrow('Unterminated string');
      const result = runBuilt(project);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Unterminated string');
      expect(readFileSync(join(project, 'index.cjs'), 'utf8')).toBe(source);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
