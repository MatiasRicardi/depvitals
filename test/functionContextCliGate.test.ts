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

    return runBuilt(project);
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
      {
        name: 'A1 template text does not terminate an async arrow',
        fileName: 'index.cjs',
        dependencies: [{ name: 'fake', used: false }],
        source: `const f = async () => \`,\` + (await /require('fake')/);`,
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
        dependencies: [{ name: 'fake', used: false }],
        source: "const f = async () => `${0}` + (await /require('fake')/);",
      },
      {
        name: 'A4 JSX containers do not terminate an async arrow',
        fileName: 'index.tsx',
        dependencies: [{ name: 'fake', used: false }],
        source: `const f = async () => (
          <p>
            {0}
            {await /require('fake')/}
          </p>
        );`,
      },
      {
        name: 'B1 typed async function does not leak into its body',
        fileName: 'index.ts',
        dependencies: [{ name: 'fake', used: false }],
        source: `async function check(): Promise<{ ok: boolean }> { const ok = await /require('fake')/; return { ok }; }`,
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
