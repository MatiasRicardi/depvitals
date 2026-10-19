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

  describe('Step 28: `ng`/`nest` in command position mark the declared CLI package as used', () => {
    it('does not report @angular/cli as unused when build runs ng', async () => {
      const result = await analyzeProject(fixturePath('ng-command'));

      // `ng` is the direct executable of the @angular/cli package, so @angular/cli is used and no
      // longer reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not report @nestjs/cli as unused when build runs nest', async () => {
      const result = await analyzeProject(fixturePath('nest-command'));

      // `nest` is the direct executable of the @nestjs/cli package, so @nestjs/cli is used and no
      // longer reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('leaves unrelated declared dependencies unused when build runs ng or nest', async () => {
      const ngResult = await analyzeProject(fixturePath('ng-with-unrelated'));
      const nestResult = await analyzeProject(fixturePath('nest-with-unrelated'));

      // Only the mapped CLI package is used; lodash has no evidence and stays unused.
      expect(ngResult.unusedDependencies).toEqual(['lodash']);
      expect(ngResult.unusedDevDependencies).toEqual([]);
      expect(ngResult.missingDependencies).toEqual([]);
      expect(nestResult.unusedDependencies).toEqual(['lodash']);
      expect(nestResult.unusedDevDependencies).toEqual([]);
      expect(nestResult.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared CLI from an ng or nest script', async () => {
      const ngResult = await analyzeProject(fixturePath('ng-undeclared'));
      const nestResult = await analyzeProject(fixturePath('nest-undeclared'));

      // The mapped candidates are not declared, so they are dropped, not reported as missing.
      expect(ngResult.unusedDependencies).toEqual([]);
      expect(ngResult.unusedDevDependencies).toEqual([]);
      expect(ngResult.missingDependencies).toEqual([]);
      expect(nestResult.unusedDependencies).toEqual([]);
      expect(nestResult.unusedDevDependencies).toEqual([]);
      expect(nestResult.missingDependencies).toEqual([]);
    });

    it('does not treat `echo ng`/`echo nest` as CLI usage evidence', async () => {
      const ngResult = await analyzeProject(fixturePath('echo-ng'));
      const nestResult = await analyzeProject(fixturePath('echo-nest'));

      // `ng`/`nest` are only the argument of `echo`, never a command position, so the CLI packages
      // stay unused.
      expect(ngResult.unusedDevDependencies).toEqual(['@angular/cli']);
      expect(nestResult.unusedDevDependencies).toEqual(['@nestjs/cli']);
      expect(ngResult.missingDependencies).toEqual([]);
      expect(nestResult.missingDependencies).toEqual([]);
    });

    it('does not treat `node -e "ng"`/`node -e "nest"` as CLI usage evidence', async () => {
      const ngResult = await analyzeProject(fixturePath('node-e-ng'));
      const nestResult = await analyzeProject(fixturePath('node-e-nest'));

      expect(ngResult.unusedDevDependencies).toEqual(['@angular/cli']);
      expect(nestResult.unusedDevDependencies).toEqual(['@nestjs/cli']);
      expect(ngResult.missingDependencies).toEqual([]);
      expect(nestResult.missingDependencies).toEqual([]);
    });

    it('does not fabricate usage for framework runtime dependencies', async () => {
      // `ng build` maps only to @angular/cli; the declared @angular/core runtime stays unused.
      const result = await analyzeProject(fixturePath('ng-framework-runtime'));

      expect(result.unusedDependencies).toEqual(['@angular/core']);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('Step 29: `babel`/`swc` in command position mark the declared CLI package as used', () => {
    it('does not report @babel/cli as unused when build runs babel', async () => {
      const result = await analyzeProject(fixturePath('babel-command'));

      // `babel` is the direct executable of the @babel/cli package, so @babel/cli is used and no
      // longer reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not report @swc/cli as unused when build runs swc', async () => {
      const result = await analyzeProject(fixturePath('swc-command'));

      // `swc` is the direct executable of the @swc/cli package, so @swc/cli is used and no longer
      // reported as unused. Script evidence never creates a missing finding.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('leaves unrelated declared dependencies unused when build runs babel or swc', async () => {
      const babelResult = await analyzeProject(fixturePath('babel-with-unrelated'));
      const swcResult = await analyzeProject(fixturePath('swc-with-unrelated'));

      // Only the mapped CLI package is used; lodash has no evidence and stays unused.
      expect(babelResult.unusedDependencies).toEqual(['lodash']);
      expect(babelResult.unusedDevDependencies).toEqual([]);
      expect(babelResult.missingDependencies).toEqual([]);
      expect(swcResult.unusedDependencies).toEqual(['lodash']);
      expect(swcResult.unusedDevDependencies).toEqual([]);
      expect(swcResult.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared CLI from a babel or swc script', async () => {
      const babelResult = await analyzeProject(fixturePath('babel-undeclared'));
      const swcResult = await analyzeProject(fixturePath('swc-undeclared'));

      // The mapped candidates are not declared, so they are dropped, not reported as missing.
      expect(babelResult.unusedDependencies).toEqual([]);
      expect(babelResult.unusedDevDependencies).toEqual([]);
      expect(babelResult.missingDependencies).toEqual([]);
      expect(swcResult.unusedDependencies).toEqual([]);
      expect(swcResult.unusedDevDependencies).toEqual([]);
      expect(swcResult.missingDependencies).toEqual([]);
    });

    it('does not treat `echo babel`/`echo swc` as CLI usage evidence', async () => {
      const babelResult = await analyzeProject(fixturePath('echo-babel'));
      const swcResult = await analyzeProject(fixturePath('echo-swc'));

      // `babel`/`swc` are only the argument of `echo`, never a command position, so the CLI packages
      // stay unused.
      expect(babelResult.unusedDevDependencies).toEqual(['@babel/cli']);
      expect(swcResult.unusedDevDependencies).toEqual(['@swc/cli']);
      expect(babelResult.missingDependencies).toEqual([]);
      expect(swcResult.missingDependencies).toEqual([]);
    });

    it('does not fabricate usage for companion core library packages', async () => {
      const babelResult = await analyzeProject(fixturePath('babel-core-runtime'));
      const swcResult = await analyzeProject(fixturePath('swc-core-runtime'));

      // `babel build` maps only to @babel/cli and `swc` only to @swc/cli; the declared companion
      // core libraries are separate packages and stay unused without their own evidence.
      expect(babelResult.unusedDependencies).toEqual(['@babel/core']);
      expect(babelResult.unusedDevDependencies).toEqual([]);
      expect(babelResult.missingDependencies).toEqual([]);
      expect(swcResult.unusedDependencies).toEqual(['@swc/core']);
      expect(swcResult.unusedDevDependencies).toEqual([]);
      expect(swcResult.missingDependencies).toEqual([]);
    });
  });

  describe('Step 30: collision-sensitive `postcss`/`dotenv` mappings', () => {
    it('does not report postcss-cli as unused when build runs postcss', async () => {
      const result = await analyzeProject(fixturePath('postcss-command'));

      // Only the CLI package is declared, so the `postcss` executable marks `postcss-cli` as used.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not report dotenv-cli as unused when start runs dotenv', async () => {
      const result = await analyzeProject(fixturePath('dotenv-command'));

      // `dotenv -e .env -- node index.js` marks the declared `dotenv-cli` as used; nothing after the
      // command token is parsed, so `node` and `index.js` are not evidence for anything.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('leaves unrelated declared dependencies unused when postcss or dotenv runs', async () => {
      const postcssResult = await analyzeProject(fixturePath('postcss-with-unrelated'));
      const dotenvResult = await analyzeProject(fixturePath('dotenv-with-unrelated'));

      expect(postcssResult.unusedDependencies).toEqual(['lodash']);
      expect(postcssResult.unusedDevDependencies).toEqual([]);
      expect(postcssResult.missingDependencies).toEqual([]);
      expect(dotenvResult.unusedDependencies).toEqual(['lodash']);
      expect(dotenvResult.unusedDevDependencies).toEqual([]);
      expect(dotenvResult.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared postcss-cli or dotenv-cli', async () => {
      const postcssResult = await analyzeProject(fixturePath('postcss-undeclared'));
      const dotenvResult = await analyzeProject(fixturePath('dotenv-undeclared'));

      expect(postcssResult.unusedDependencies).toEqual([]);
      expect(postcssResult.unusedDevDependencies).toEqual([]);
      expect(postcssResult.missingDependencies).toEqual([]);
      expect(dotenvResult.unusedDependencies).toEqual([]);
      expect(dotenvResult.unusedDevDependencies).toEqual([]);
      expect(dotenvResult.missingDependencies).toEqual([]);
    });

    it('does not auto-suppress both providers when a same-name library is declared too', async () => {
      const postcssResult = await analyzeProject(fixturePath('postcss-collision'));
      const dotenvResult = await analyzeProject(fixturePath('dotenv-collision'));

      // Exact-name precedence: the same-name library keeps the evidence and the CLI provider stays
      // unused, so one executable never marks two competing providers as used.
      expect(postcssResult.unusedDevDependencies).toEqual(['postcss-cli']);
      expect(postcssResult.missingDependencies).toEqual([]);
      expect(dotenvResult.unusedDevDependencies).toEqual(['dotenv-cli']);
      expect(dotenvResult.missingDependencies).toEqual([]);
    });

    it('does not parse the executable that dotenv runs after `--`', async () => {
      const result = await analyzeProject(fixturePath('dotenv-runner-args'));

      // `dotenv -e .env -- tsc --noEmit` uses dotenv-cli; the `tsc` after `--` is not inspected, so
      // the declared `typescript` package stays unused and no runner parsing is inferred.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual(['typescript']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not treat echo or adjacent-command arguments as CLI usage evidence', async () => {
      const echoPostcss = await analyzeProject(fixturePath('echo-postcss'));
      const echoDotenv = await analyzeProject(fixturePath('echo-dotenv'));
      const lintPostcss = await analyzeProject(fixturePath('eslint-postcss'));
      const probeDotenv = await analyzeProject(fixturePath('node-e-dotenv'));

      expect(echoPostcss.unusedDevDependencies).toEqual(['postcss-cli']);
      expect(echoDotenv.unusedDevDependencies).toEqual(['dotenv-cli']);
      expect(lintPostcss.unusedDevDependencies).toEqual(['postcss-cli']);
      expect(probeDotenv.unusedDevDependencies).toEqual(['dotenv-cli']);
    });
  });

  describe('Step 31: `changeset`/`commitlint` in command position mark the declared CLI package as used', () => {
    it('does not report @changesets/cli as unused when a script runs changeset', async () => {
      const result = await analyzeProject(fixturePath('changeset-command'));

      // `changeset version` is a command plus arguments, so the command token maps to @changesets/cli.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not report @commitlint/cli as unused when a script runs commitlint', async () => {
      const result = await analyzeProject(fixturePath('commitlint-command'));

      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('leaves unrelated declared dependencies unused when changeset or commitlint runs', async () => {
      const changesetResult = await analyzeProject(fixturePath('changeset-with-unrelated'));
      const commitlintResult = await analyzeProject(fixturePath('commitlint-with-unrelated'));

      expect(changesetResult.unusedDependencies).toEqual(['lodash']);
      expect(changesetResult.unusedDevDependencies).toEqual([]);
      expect(changesetResult.missingDependencies).toEqual([]);
      expect(commitlintResult.unusedDependencies).toEqual(['lodash']);
      expect(commitlintResult.unusedDevDependencies).toEqual([]);
      expect(commitlintResult.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared changesets or commitlint CLI', async () => {
      const changesetResult = await analyzeProject(fixturePath('changeset-undeclared'));
      const commitlintResult = await analyzeProject(fixturePath('commitlint-undeclared'));

      expect(changesetResult.unusedDependencies).toEqual([]);
      expect(changesetResult.unusedDevDependencies).toEqual([]);
      expect(changesetResult.missingDependencies).toEqual([]);
      expect(commitlintResult.unusedDependencies).toEqual([]);
      expect(commitlintResult.unusedDevDependencies).toEqual([]);
      expect(commitlintResult.missingDependencies).toEqual([]);
    });

    it('does not treat echo mentions as CLI usage evidence', async () => {
      const changesetResult = await analyzeProject(fixturePath('echo-changeset'));
      const commitlintResult = await analyzeProject(fixturePath('echo-commitlint'));

      expect(changesetResult.unusedDevDependencies).toEqual(['@changesets/cli']);
      expect(commitlintResult.unusedDevDependencies).toEqual(['@commitlint/cli']);
    });

    it('does not accept the unverified plural changesets spelling', async () => {
      const result = await analyzeProject(fixturePath('changesets-plural'));

      // The published bin is `changeset` (singular); the plural spelling must leave the CLI unused.
      expect(result.unusedDevDependencies).toEqual(['@changesets/cli']);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('Step 32: verified code-generator aliases map to one declared package', () => {
    it('does not report @graphql-codegen/cli as unused for each verified alias', async () => {
      for (const fixture of ['codegen-command', 'gql-gen-command', 'codegen-generator-command']) {
        const result = await analyzeProject(fixturePath(fixture));

        expect(result.unusedDependencies).toEqual([]);
        expect(result.unusedDevDependencies).toEqual([]);
        expect(result.missingDependencies).toEqual([]);
      }
    });

    it('does not report @openapitools/openapi-generator-cli as unused when it runs', async () => {
      const result = await analyzeProject(fixturePath('openapi-generator-command'));

      // The verified CLI is used; the unrelated lodash dependency keeps its own unused finding.
      expect(result.unusedDependencies).toEqual(['lodash']);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('classifies two aliases of the same package as a single used dependency', async () => {
      const result = await analyzeProject(fixturePath('codegen-two-aliases'));

      // Two scripts using two different aliases produce one classification for the single declared
      // package; the reported arrays stay duplicate-free.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('never reports a missing finding for undeclared generators', async () => {
      const result = await analyzeProject(fixturePath('codegen-undeclared'));

      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not treat echo or node -e mentions as generator usage evidence', async () => {
      const echoResult = await analyzeProject(fixturePath('echo-codegen'));
      const probeResult = await analyzeProject(fixturePath('node-e-gqlgen'));

      expect(echoResult.unusedDevDependencies).toEqual(['@graphql-codegen/cli']);
      expect(probeResult.unusedDevDependencies).toEqual(['@graphql-codegen/cli']);
      expect(echoResult.missingDependencies).toEqual([]);
      expect(probeResult.missingDependencies).toEqual([]);
    });
  });

  describe('Step 33: npm-script runner aliases and ncu', () => {
    it('does not report npm-run-all as unused when run-p or run-s runs', async () => {
      const parallel = await analyzeProject(fixturePath('run-p-command'));
      const serial = await analyzeProject(fixturePath('run-s-command'));

      expect(parallel.unusedDependencies).toEqual([]);
      expect(parallel.unusedDevDependencies).toEqual([]);
      expect(parallel.missingDependencies).toEqual([]);
      expect(serial.unusedDependencies).toEqual([]);
      expect(serial.unusedDevDependencies).toEqual([]);
      expect(serial.missingDependencies).toEqual([]);
    });

    it('does not report concurrently as unused when conc runs', async () => {
      const result = await analyzeProject(fixturePath('conc-command'));

      // `conc "vite" "tsc"` is evidence for concurrently only; the quoted arguments are not analyzed.
      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not report npm-check-updates as unused when ncu runs', async () => {
      const result = await analyzeProject(fixturePath('ncu-command'));

      // The declared CLI is used; the unrelated lodash dependency keeps its own unused finding.
      expect(result.unusedDependencies).toEqual(['lodash']);
      expect(result.unusedDevDependencies).toEqual([]);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not infer a runner script-name argument as used', async () => {
      const result = await analyzeProject(fixturePath('run-p-arg-vite'));

      // `run-p vite` marks npm-run-all used; `vite` here is only a runner argument, so it stays
      // unused and no recursive script analysis happens.
      expect(result.unusedDevDependencies).toEqual(['vite']);
      expect(result.missingDependencies).toEqual([]);
    });

    it('does not treat echo or adjacent-command arguments as runner usage evidence', async () => {
      const echoRunAll = await analyzeProject(fixturePath('echo-runp'));
      const echoNcu = await analyzeProject(fixturePath('echo-ncu'));
      const lintConc = await analyzeProject(fixturePath('eslint-conc'));

      expect(echoRunAll.unusedDevDependencies).toEqual(['npm-run-all']);
      expect(echoNcu.unusedDevDependencies).toEqual(['npm-check-updates']);
      expect(lintConc.unusedDevDependencies).toEqual(['concurrently']);
    });
  });

  describe('Step 34: collision-aware Gulp, Grunt and Sequelize CLI mappings', () => {
    it('does not report a declared CLI package as unused when its executable runs', async () => {
      const gulp = await analyzeProject(fixturePath('gulp-cli-only'));
      const grunt = await analyzeProject(fixturePath('grunt-cli-only'));
      const sequelize = await analyzeProject(fixturePath('sequelize-cli-only'));

      // The declared CLIs are used; the unrelated lodash dependency keeps its own unused finding.
      expect(gulp.unusedDependencies).toEqual(['lodash']);
      expect(gulp.unusedDevDependencies).toEqual([]);
      expect(grunt.unusedDependencies).toEqual(['lodash']);
      expect(grunt.unusedDevDependencies).toEqual([]);
      expect(sequelize.unusedDependencies).toEqual(['lodash']);
      expect(sequelize.unusedDevDependencies).toEqual([]);
    });

    it('never marks a CLI and its same-name package used from one command', async () => {
      const gulp = await analyzeProject(fixturePath('both-gulp'));
      const grunt = await analyzeProject(fixturePath('both-grunt'));
      const sequelize = await analyzeProject(fixturePath('both-sequelize'));

      // Exact-name precedence is preserved, so the CLI package keeps its own unused finding instead
      // of being marked used together with the same-name package.
      expect(gulp.unusedDevDependencies).toEqual(['gulp-cli']);
      expect(grunt.unusedDevDependencies).toEqual(['grunt-cli']);
      expect(sequelize.unusedDevDependencies).toEqual(['sequelize-cli']);
    });

    it('does not treat an echo mention as task-runner usage evidence', async () => {
      const result = await analyzeProject(fixturePath('echo-grunt'));

      expect(result.unusedDevDependencies).toEqual(['grunt-cli']);
      expect(result.missingDependencies).toEqual([]);
    });
  });

  describe('Step 35: vue-cli-service and babel-node aliases', () => {
    it('does not report the declared CLI package as unused when its executable runs', async () => {
      const vue = await analyzeProject(fixturePath('vue-cli-service-command'));
      const babel = await analyzeProject(fixturePath('babel-node-command'));

      // The declared CLIs are used; the unrelated lodash dependency keeps its own unused finding.
      expect(vue.unusedDependencies).toEqual(['lodash']);
      expect(vue.unusedDevDependencies).toEqual([]);
      expect(babel.unusedDependencies).toEqual(['lodash']);
      expect(babel.unusedDevDependencies).toEqual([]);
      expect(vue.missingDependencies).toEqual([]);
      expect(babel.missingDependencies).toEqual([]);
    });

    it('keeps exact-name precedence when the same-name package is also declared', async () => {
      const vue = await analyzeProject(fixturePath('vue-cli-service-both'));
      const babel = await analyzeProject(fixturePath('babel-node-both'));

      expect(vue.unusedDevDependencies).toEqual(['@vue/cli-service']);
      expect(babel.unusedDevDependencies).toEqual(['@babel/node']);
    });

    it('never infers the matching runtime library from the CLI command', async () => {
      const vue = await analyzeProject(fixturePath('vue-not-inferred'));
      const babel = await analyzeProject(fixturePath('babel-core-not-inferred'));

      // `vue` and `@babel/core` receive no evidence from `vue-cli-service` / `babel-node`.
      expect(vue.unusedDependencies).toEqual(['vue']);
      expect(vue.unusedDevDependencies).toEqual([]);
      expect(babel.unusedDependencies).toEqual(['@babel/core']);
      expect(babel.unusedDevDependencies).toEqual([]);
    });

    it('does not treat echo mentions as CLI usage evidence', async () => {
      const vue = await analyzeProject(fixturePath('echo-vue-cli-service'));
      const babel = await analyzeProject(fixturePath('echo-babel-node'));

      expect(vue.unusedDevDependencies).toEqual(['@vue/cli-service']);
      expect(babel.unusedDevDependencies).toEqual(['@babel/node']);
      expect(vue.missingDependencies).toEqual([]);
      expect(babel.missingDependencies).toEqual([]);
    });
  });

  describe('Step 36: ambiguous binary providers stay unclassified', () => {
    it('credits only the exactly declared same-name package', async () => {
      const tailwind = await analyzeProject(fixturePath('tailwind-both-providers'));
      const playwright = await analyzeProject(fixturePath('playwright-both-providers'));
      const webpack = await analyzeProject(fixturePath('webpack-both-providers'));

      // The sibling provider keeps its own unused finding instead of being marked used speculatively.
      expect(tailwind.unusedDevDependencies).toEqual(['@tailwindcss/cli']);
      expect(playwright.unusedDevDependencies).toEqual(['@playwright/test']);
      expect(webpack.unusedDevDependencies).toEqual(['webpack-cli']);
    });

    it('abstains when only the unmapped provider package is declared', async () => {
      const playwright = await analyzeProject(fixturePath('playwright-test-only'));
      const tailwind = await analyzeProject(fixturePath('tailwind-cli-only'));

      // `playwright test` / `tailwindcss ...` cannot be attributed to a single provider, so the
      // declared package stays reported unused rather than receiving invented evidence.
      expect(playwright.unusedDevDependencies).toEqual(['@playwright/test']);
      expect(tailwind.unusedDevDependencies).toEqual(['@tailwindcss/cli']);
      expect(playwright.missingDependencies).toEqual([]);
      expect(tailwind.missingDependencies).toEqual([]);
    });

    it('infers nothing from the node and pnpm binaries', async () => {
      const result = await analyzeProject(fixturePath('node-binary'));

      expect(result.unusedDependencies).toEqual([]);
      expect(result.unusedDevDependencies).toEqual(['webpack-cli']);
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

  describe('Step 26: collision-sensitive fixtures before any alias mapping is activated', () => {
    // These fixtures declare both an exact-name package and its prospective CLI provider, then run
    // the exact-name command. No Category B mapping is enabled yet, so the exact-name package keeps
    // its usage evidence and the CLI package stays unused. This only records the current baseline;
    // each future mapping step must retest the collision with its mapping enabled.
    const collisionCases = [
      { fixture: 'gulp-collision', used: 'gulp', unused: 'gulp-cli' },
      { fixture: 'grunt-collision', used: 'grunt', unused: 'grunt-cli' },
      { fixture: 'postcss-collision', used: 'postcss', unused: 'postcss-cli' },
      { fixture: 'dotenv-collision', used: 'dotenv', unused: 'dotenv-cli' },
    ] as const;

    for (const { fixture, unused } of collisionCases) {
      it(`${fixture}: exact-name package is used, CLI provider stays unused, no missing`, async () => {
        const result = await analyzeProject(fixturePath(fixture));

        // Only the exact-name package receives usage evidence; the CLI package has no independent
        // evidence and remains unused. Script evidence never produces a missing finding.
        expect(result.unusedDependencies).toEqual([]);
        expect(result.unusedDevDependencies).toEqual([unused]);
        expect(result.missingDependencies).toEqual([]);
      });
    }

    it('does not map an unknown executable to a guessed package', async () => {
      const result = await analyzeProject(fixturePath('script-only-undeclared'));

      // `left-pad` is an undeclared executable in command position: no usage evidence and no missing.
      expect(result.unusedDependencies).toEqual(['left-pad']);
      expect(result.missingDependencies).toEqual([]);
    });
  });
});
