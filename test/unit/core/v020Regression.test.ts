/**
 * v0.2.0 regression fixtures for script-command executable mappings and their negatives.
 *
 * This file is intentionally separate from `analysisFixtures.test.ts`, which keeps the v0.1.0
 * golden scenarios (esm/commonjs/typescript/declarations/ignored-directories/...). Reuse of those
 * existing fixtures preserves their coverage; this file focuses on the v0.2.0 additions.
 *
 * Two kinds of cases live here:
 *
 * - Active negative controls (`echo tsc`, `echo docsify`, `node -e "console.log('tsc')"`, incidental
 *   strings/arguments, undeclared script commands). These assert the current, correct behavior: a
 *   package name that only appears inside a script *argument* or *string* never becomes usage
 *   evidence, and script evidence never creates a missing-dependency finding. They must stay green.
 * - Future positive mappings (`tsc` in command position -> `typescript` used, `docsify serve docs`
 *   -> `docsify-cli` used). These are recorded with `it.todo` so the fixtures are ready to activate
 *   in Steps 23 and 24 without leaving red tests on the default CI suite.
 *
 * No analyzed-project script is ever executed; every assertion runs the static pipeline offline.
 */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../../../src/core/analyzeProject.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

function fixturePath(name: string): string {
  return resolve(join(FIXTURES, name));
}

describe('v0.2.0 script-command executable mappings', () => {
  describe('future positive mappings (activated by Steps 23-24)', () => {
    it.todo('Step 23: `tsc` in command position marks declared `typescript` as used (tsc-command)');

    it.todo(
      'Step 24: `docsify serve docs` in command position marks declared `docsify-cli` as used (docsify-command)',
    );
  });

  describe('negative controls that must stay green now', () => {
    it('does not treat `echo tsc` as TypeScript usage evidence', async () => {
      const result = await analyzeProject(fixturePath('echo-tsc'));

      // `tsc` is only the argument of `echo`, never a command position, so typescript stays unused.
      expect(result.unusedDevDependencies).toEqual(['typescript']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not treat `echo docsify` as docsify-cli usage evidence', async () => {
      const result = await analyzeProject(fixturePath('echo-docify'));

      expect(result.unusedDevDependencies).toEqual(['docsify-cli']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not treat `node -e "console.log(\'tsc\')"` as TypeScript usage evidence', async () => {
      const result = await analyzeProject(fixturePath('node-e-tsc'));

      expect(result.unusedDevDependencies).toEqual(['typescript']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not create usage evidence from incidental strings or arguments', async () => {
      const result = await analyzeProject(fixturePath('incidental-arguments'));

      // `eslint` and `prettier` appear only inside echo text or as a trailing argument, never as a
      // command position.
      expect(result.unusedDevDependencies).toEqual(['eslint', 'prettier']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('never creates a missing finding from an undeclared script command', async () => {
      // Reuses the v0.1.0 fixture that already models an undeclared executable in a script.
      const result = await analyzeProject(fixturePath('script-only-undeclared'));

      expect(result.unusedDependencies).toEqual(['left-pad']);
      expect(result.missingDependencies).toEqual([]);
    });
  });
});
