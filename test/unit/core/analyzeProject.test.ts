import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  analyzeProject,
  AnalysisError,
  type AnalysisResult,
} from '../../../src/core/analyzeProject.js';

/**
 * Fixture directory. Every scenario is a real directory tree with a `package.json` and supported
 * source files, so the analysis runs the complete pipeline against real files on disk.
 */
const FIXTURES = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

function fixture(path: string): string {
  return join(FIXTURES, path);
}

/**
 * Run the analyzer and return the rejection instead of throwing, so tests can assert on the error.
 */
async function captureAnalysisError(run: () => Promise<AnalysisResult>): Promise<AnalysisError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AnalysisError) {
      return error;
    }

    throw error;
  }

  throw new Error('Expected analyzeProject to reject, but it resolved');
}

async function analyzeTemporaryProject(
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): Promise<AnalysisResult> {
  const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-function-context-'));

  try {
    writeFileSync(join(sandbox, 'package.json'), JSON.stringify(manifest));

    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(sandbox, name), source);
    }

    return await analyzeProject(sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// A narrowly targeted mock of node:fs/promises.readFile: it preserves the real implementation for
// every path and only simulates an EACCES failure for a single, explicitly selected source file.
// This is deterministic across platforms, unlike a chmod-based test. hoisted.target is set inside
// the test that needs it and reset afterwards so the mock never affects other tests.
const hoisted = vi.hoisted(() => {
  return { target: '' };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();

  return {
    ...actual,
    readFile: vi.fn((path: string, encoding?: BufferEncoding) => {
      if (path === hoisted.target) {
        const error = new Error('EACCES: permission denied, open') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }

      return actual.readFile(path, encoding);
    }),
  };
});

describe('analyzeProject', () => {
  describe('function contexts and module await', () => {
    it('finds a require divided by await in an ordinary function nested in async code', async () => {
      const result = await analyzeTemporaryProject(
        { name: 'nested-async', version: '0.0.0' },
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

      expect(result.projectRoot).toBeTruthy();
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual(['real']);
    });

    it('treats top-level await as a module keyword for mjs and module-type js', async () => {
      const moduleSource = `await /require('fake')/;`;
      const mjs = await analyzeTemporaryProject(
        { name: 'module-mjs', version: '0.0.0' },
        { 'index.mjs': moduleSource },
      );
      const typedJs = await analyzeTemporaryProject(
        { name: 'module-js', version: '0.0.0', type: 'module' },
        { 'index.js': moduleSource },
      );

      expect(mjs.missingDependencies).toEqual([]);
      expect(typedJs.missingDependencies).toEqual([]);
    });

    it('keeps cjs as script when the package type is module', async () => {
      const result = await analyzeTemporaryProject(
        { name: 'module-cjs', version: '0.0.0', type: 'module' },
        { 'index.cjs': `await / require('real') / 2;` },
      );

      expect(result.missingDependencies).toEqual(['real']);
    });

    it('falls back to script behavior for an unknown package type value', async () => {
      const result = await analyzeTemporaryProject(
        { name: 'unknown-type', version: '0.0.0', type: { unexpected: true } },
        { 'index.js': `await / require('real') / 2;` },
      );

      expect(result.missingDependencies).toEqual(['real']);
    });

    it('does not credit a dependency inside an async arrow expression regex', async () => {
      const result = await analyzeTemporaryProject(
        {
          name: 'arrow-expression',
          version: '0.0.0',
          dependencies: { fake: '1.0.0' },
        },
        { 'index.js': `const f = async () => await /require('fake')/;` },
      );

      expect(result.unusedDependencies).toEqual(['fake']);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('basic pipeline', () => {
    it('classifies used, unused and missing dependencies', async () => {
      const result = await analyzeProject(fixture('basic'));

      // dependencies: axios, lodash, left-pad, @scope/formatter are all referenced from source.
      expect(result.unusedDependencies).toEqual([]);

      // devDependencies: eslint (scripts), vitest (source), moment (never referenced).
      expect(result.unusedDevDependencies).toEqual(['moment']);

      // zod is imported but undeclared; react (peer), node:fs (builtin) and ./util (relative) are
      // never reported as missing.
      expect(result.missingDependencies).toEqual(['zod']);
    });

    it('uses the manifest root as the project root', async () => {
      const result = await analyzeProject(fixture('basic'));

      expect(result.projectRoot).toBe(resolve(fixture('basic')));
    });
  });

  describe('clean project', () => {
    it('returns three empty arrays when everything is used', async () => {
      const result = await analyzeProject(fixture('clean'));

      expect(result).toEqual({
        projectRoot: resolve(fixture('clean')),
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
    });
  });

  describe('no source files', () => {
    it('reports every declared dependency/devDependency as unused with no missing', async () => {
      const result = await analyzeProject(fixture('no-source'));

      expect(result.unusedDependencies).toEqual(['axios']);
      expect(result.unusedDevDependencies).toEqual(['vitest']);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('peer/optional suppression', () => {
    it('never reports a peer dependency imported from source as missing', async () => {
      // react is declared only in peerDependencies and imported from source in the basic fixture.
      const result = await analyzeProject(fixture('basic'));

      expect(result.missingDependencies).not.toContain('react');
    });
  });

  describe('script-only usage', () => {
    it('suppresses an unused finding for a package used only in scripts', async () => {
      // eslint is declared in devDependencies and referenced only by the "lint" script.
      const result = await analyzeProject(fixture('basic'));

      expect(result.unusedDevDependencies).not.toContain('eslint');
    });

    it('never creates missing findings from a script command', async () => {
      const result = await analyzeProject(fixture('script-only-undeclared'));

      // left-pad is declared but never referenced; the undeclared script command must not create a
      // missing finding.
      expect(result.unusedDependencies).toEqual(['left-pad']);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('comments in source files (Step 68.1)', () => {
    // A `#` comment at a word boundary swallows the rest of the line, so a package named only inside
    // it is not credited. These use a throwaway project so the complete pipeline runs on real files.

    it('does not credit a package used only inside a comment', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-source-comment-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({
            name: 'source-comment',
            version: '0.0.0',
            devDependencies: { typescript: '5.0.0' },
          }),
        );
        writeFileSync(
          join(sandbox, 'index.ts'),
          ['// import typescript from "typescript";', 'export const x = 1;'].join('\n'),
        );

        const result = await analyzeProject(sandbox);

        // The import lives only in a comment, so `typescript` stays unused.
        expect(result.unusedDevDependencies).toEqual(['typescript']);
        expect(result.missingDependencies).toEqual([]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('credits a package used after a newline that ends a comment', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-source-comment-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({
            name: 'source-comment',
            version: '0.0.0',
            devDependencies: { typescript: '5.0.0' },
          }),
        );
        writeFileSync(
          join(sandbox, 'index.ts'),
          [
            '// import typescript from "typescript";',
            'import typescript from "typescript";',
            'export const x = typescript;',
          ].join('\n'),
        );

        const result = await analyzeProject(sandbox);

        // The real import on the next line is outside the comment, so `typescript` is used.
        expect(result.unusedDevDependencies).toEqual([]);
        expect(result.missingDependencies).toEqual([]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('duplicate declaration handling', () => {
    it('reports a package declared in both sections as unused in each independently', async () => {
      const result = await analyzeProject(fixture('duplicate-declaration/unused'));

      expect(result.unusedDependencies).toEqual(['shared']);
      expect(result.unusedDevDependencies).toEqual(['shared']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('omits a used package declared in both sections from both arrays', async () => {
      const result = await analyzeProject(fixture('duplicate-declaration/used'));

      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('subpath normalization and duplicate collapse', () => {
    it('normalizes scoped and unscoped subpaths to their package root', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-analysis-subpath-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({
            name: 'subpath-demo',
            version: '0.0.0',
            dependencies: { lodash: '4.0.0', '@scope/pkg': '1.0.0' },
          }),
        );
        writeFileSync(
          join(sandbox, 'src.ts'),
          [
            "import { map } from 'lodash/map';",
            "import { x } from '@scope/pkg/deep/nested';",
            'export const y = map;',
          ].join('\n'),
        );

        const result = await analyzeProject(sandbox);

        // lodash/map -> lodash and @scope/pkg/deep/nested -> @scope/pkg both resolve to their root.
        expect(result.unusedDependencies).toEqual([]);
        expect(result.missingDependencies).toEqual([]);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('collapses duplicate imports of the same package into one finding', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-analysis-dup-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({ name: 'dup-demo', version: '0.0.0' }),
        );
        writeFileSync(join(sandbox, 'a.ts'), "import 'missing-pkg';\n");
        writeFileSync(join(sandbox, 'b.ts'), "import 'missing-pkg';\n");

        const result = await analyzeProject(sandbox);

        expect(result.missingDependencies).toEqual(['missing-pkg']);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('literal require divided by an object literal', () => {
    it('treats the require as usage instead of swallowing it as a regex literal', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-analysis-division-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({
            name: 'division-demo',
            version: '0.0.0',
            dependencies: { 'declared-division': '1.0.0', 'unused-division': '1.0.0' },
          }),
        );
        // `{}` closes an object literal, so both slashes divide and both calls are real usage.
        // Before the fix the first line opened a regex literal that hid the declared package, and
        // the second failed the whole scan as an unterminated regex.
        writeFileSync(
          join(sandbox, 'src.js'),
          [
            "const ratio = {} / require('declared-division') / 2;",
            "const other = {} / require('missing-division');",
          ].join('\n'),
        );

        const result = await analyzeProject(sandbox);

        expect(result.unusedDependencies).toEqual(['unused-division']);
        expect(result.unusedDevDependencies).toEqual([]);
        expect(result.missingDependencies).toEqual(['missing-division']);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });

  describe('deterministic ordering', () => {
    it('returns sorted results that are stable across repeated calls', async () => {
      const first = await analyzeProject(fixture('basic'));
      const second = await analyzeProject(fixture('basic'));

      expect(second).toEqual(first);

      for (const list of [
        first.unusedDependencies,
        first.unusedDevDependencies,
        first.missingDependencies,
      ]) {
        expect([...list]).toEqual([...list].sort());
      }
    });
  });

  describe('invalid source', () => {
    it('fails with an AnalysisError that identifies the file and preserves the cause', async () => {
      const error = await captureAnalysisError(() => analyzeProject(fixture('invalid-source')));

      expect(error).toBeInstanceOf(AnalysisError);
      expect(error.code).toBe('invalid-source');
      expect(error.message).toContain(join('src', 'broken.ts'));
      expect((error.cause as { name: string }).name).toBe('ModuleSpecifierError');
    });

    it('never returns a partial result for an invalid source file', async () => {
      const error = await captureAnalysisError(() => analyzeProject(fixture('invalid-source')));

      // The lexical error is on the only source file, so a partial success would show no usage
      // evidence. The contract is a hard failure, not a clean-looking result.
      expect(error.message).toContain(join('src', 'broken.ts'));
    });
  });

  describe('unreadable source', () => {
    it('fails with an AnalysisError that identifies the file and preserves the cause', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-analysis-unreadable-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({
            name: 'unreadable-demo',
            version: '0.0.0',
            dependencies: { 'left-pad': '1.0.0' },
          }),
        );
        mkdirSync(join(sandbox, 'src'));
        writeFileSync(
          join(sandbox, 'src', 'index.ts'),
          "import { pad } from 'left-pad';\nexport const value = pad;\n",
        );

        const target = join(sandbox, 'src', 'index.ts');
        hoisted.target = target;

        const error = await captureAnalysisError(() => analyzeProject(sandbox));

        expect(error).toBeInstanceOf(AnalysisError);
        expect(error.code).toBe('unreadable-source');
        expect(error.message).toContain(target);
        expect((error.cause as { code?: string }).code).toBe('EACCES');
      } finally {
        hoisted.target = '';
        rmSync(sandbox, { recursive: true, force: true });
      }
    });

    it('does not interfere with a normal read when no target is selected', async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-analysis-mock-clean-'));

      try {
        writeFileSync(
          join(sandbox, 'package.json'),
          JSON.stringify({ name: 'mock-clean', version: '0.0.0' }),
        );
        mkdirSync(join(sandbox, 'src'));
        writeFileSync(join(sandbox, 'src', 'index.ts'), "import { map } from 'lodash';\n");

        expect(hoisted.target).toBe('');

        const result = await analyzeProject(sandbox);

        expect(result.unusedDependencies).toEqual([]);
        expect(result.missingDependencies).toEqual(['lodash']);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    });
  });
});
