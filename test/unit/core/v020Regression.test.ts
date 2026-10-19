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
 * - Active positive mappings (`tsc` in command position -> `typescript` used, `docsify serve docs`
 *   -> `docsify-cli` used). Enabled in Steps 23 and 24; the fixtures are asserted as positive
 *   findings while their adjacent negative controls stay green.
 *
 * MAPPING INVARIANT (for Steps 23-24): enabling binary-to-package mappings must never break a
 * negative control added here. Concretely, when command-position mappings are active:
 *   - `tsc` in command position -> `typescript` used, but `echo tsc` and `node script.js --tool=tsc`
 *     must NOT count as `typescript` usage.
 *   - `docsify serve docs` -> `docsify-cli` used, but `env VAR=docsify other-command` must NOT count
 *     as `docsify-cli` usage.
 * Each future mapping test must also keep asserting `missingDependencies: []` for undeclared
 * `typescript` / `docsify-cli`, since script evidence never produces a missing finding.
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
  describe('Step 23: `tsc` in command position marks declared `typescript` as used', () => {
    it('does not report typescript as unused when build runs tsc', async () => {
      const result = await analyzeProject(fixturePath('tsc-command'));

      // `tsc` is the direct executable, so the mapped `typescript` package is used and no longer
      // reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('leaves unrelated declared dependencies unused when build runs tsc', async () => {
      const result = await analyzeProject(fixturePath('tsc-with-unrelated'));

      // Only `typescript` is mapped from `tsc`; `lodash` has no evidence and stays unused.
      expect(result.unusedDependencies).toEqual(['lodash']);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared typescript from a tsc script', async () => {
      const result = await analyzeProject(fixturePath('tsc-undeclared'));

      // The mapped candidate `typescript` is not declared, so it is dropped, not reported as missing.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('Step 24: `docsify serve docs` in command position marks declared `docsify-cli` as used', () => {
    it('does not report docsify-cli as unused when docs runs docsify', async () => {
      const result = await analyzeProject(fixturePath('docsify-command'));

      // `docsify` is the direct executable, so the mapped `docsify-cli` package is used and no longer
      // reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared docsify-cli from a docsify script', async () => {
      const result = await analyzeProject(fixturePath('docsify-undeclared'));

      // The mapped candidate `docsify-cli` is not declared, so it is dropped, not reported as missing.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });
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
