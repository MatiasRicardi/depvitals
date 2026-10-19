/**
 * End-to-end matrix for the v0.2.0 executable-to-package catalog at the analyzer boundary.
 *
 * Every activated mapping is asserted in both directions through `analyzeProject`:
 * - `all-used` runs each executable in command position and proves the mapped package is never
 *   reported unused, while an unrelated declared package stays unused and an undeclared source
 *   import stays missing;
 * - `all-used-clean` proves the same catalog can produce a fully clean project;
 * - `all-negatives` mentions each executable only as an argument and proves none of the declared
 *   packages is credited, so mappings suppress `unused` only;
 * - `alias-dedup` resolves several aliases to one package and overlaps script evidence with a source
 *   import, proving findings stay sorted and deduplicated.
 *
 * The alias table below is the catalog under test. If production dropped a mapping its positive case
 * fails; if production ever credited an argument position, a negative case fails.
 */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject, type AnalysisResult } from '../../../src/core/analyzeProject.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

/** Absolute path to a mapping-matrix fixture. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, 'mapping-matrix', name));
}

/** Activated executable/package pairs, keyed by executable. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['tsc', 'typescript'],
  ['docsify', 'docsify-cli'],
  ['ng', '@angular/cli'],
  ['nest', '@nestjs/cli'],
  ['babel', '@babel/cli'],
  ['swc', '@swc/cli'],
  ['postcss', 'postcss-cli'],
  ['dotenv', 'dotenv-cli'],
  ['changeset', '@changesets/cli'],
  ['commitlint', '@commitlint/cli'],
  ['graphql-codegen', '@graphql-codegen/cli'],
  ['gql-gen', '@graphql-codegen/cli'],
  ['graphql-code-generator', '@graphql-codegen/cli'],
  ['openapi-generator-cli', '@openapitools/openapi-generator-cli'],
  ['run-p', 'npm-run-all'],
  ['run-s', 'npm-run-all'],
  ['conc', 'concurrently'],
  ['ncu', 'npm-check-updates'],
  ['gulp', 'gulp-cli'],
  ['grunt', 'grunt-cli'],
  ['sequelize', 'sequelize-cli'],
  ['vue-cli-service', '@vue/cli-service'],
  ['babel-node', '@babel/node'],
];

/** Every mapped package exactly once, sorted. */
const MAPPED_PACKAGES = [...new Set(PAIRS.map(([, packageName]) => packageName))].sort();

// Each fixture is scanned once and shared by the table-driven assertions.
const allUsed: AnalysisResult = await analyzeProject(fixturePath('all-used'));
const allUsedClean: AnalysisResult = await analyzeProject(fixturePath('all-used-clean'));
const allNegatives: AnalysisResult = await analyzeProject(fixturePath('all-negatives'));
const aliasDedup: AnalysisResult = await analyzeProject(fixturePath('alias-dedup'));

/** The mapped packages a result credits as used (declared but not reported unused). */
function usedMappedPackages(result: AnalysisResult): Set<string> {
  const unused = new Set([...result.unusedDependencies, ...result.unusedDevDependencies]);
  return new Set(MAPPED_PACKAGES.filter((name) => !unused.has(name)));
}

describe('activated mappings are credited at the analyzer boundary', () => {
  it.each(PAIRS)('%s marks %s as used', (_bin, packageName) => {
    expect(usedMappedPackages(allUsed)).toContain(packageName);
  });

  it('keeps the unrelated declared package unused and the undeclared source import missing', () => {
    expect(allUsed.unusedDependencies).toEqual(['lodash']);
    expect(allUsed.unusedDevDependencies).toEqual([]);
    expect(allUsed.missingDependencies).toEqual(['zod']);
  });

  it('reports a clean project when only mapped CLI tools are declared and used', () => {
    expect(allUsedClean.unusedDependencies).toEqual([]);
    expect(allUsedClean.unusedDevDependencies).toEqual([]);
    expect(allUsedClean.missingDependencies).toEqual([]);
  });
});

describe('mappings never credit argument positions', () => {
  it.each(PAIRS)('echo %s does not mark %s as used', (_bin, packageName) => {
    expect(allNegatives.unusedDevDependencies).toContain(packageName);
  });

  it('reports every mapped package as unused when nothing runs in command position', () => {
    expect(allNegatives.unusedDependencies).toEqual([]);
    expect(allNegatives.unusedDevDependencies).toEqual(MAPPED_PACKAGES);
    // Script evidence never produces a missing finding, even though scripts name every executable.
    expect(allNegatives.missingDependencies).toEqual([]);
  });
});

describe('several aliases resolve to one declared package', () => {
  it('classifies each package once, regardless of aliases or overlapping source usage', () => {
    // `graphql-codegen`, `gql-gen` and `graphql-code-generator` all resolve to @graphql-codegen/cli,
    // `tsc` is also imported by the source file, and `babel`/`babel-node` map to different packages.
    expect(aliasDedup.unusedDependencies).toEqual([]);
    expect(aliasDedup.unusedDevDependencies).toEqual([]);
    expect(aliasDedup.missingDependencies).toEqual([]);
  });
});
