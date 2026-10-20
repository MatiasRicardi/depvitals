/**
 * Step 54: integrated regressions across the whole activated catalog.
 *
 * `mappingMatrix.test.ts` proves each alias in isolation and `mappingCatalog.test.ts` proves the catalog
 * counts. This file proves the two compose: a project that declares packages in every supported manifest
 * group, combines recognized commands with genuinely unused declarations and repeated aliases of one
 * package, and a project whose tricky text (arguments, quoted strings, shell wrappers, unsupported
 * interpolation, ambiguous providers, literal import strings) must stay inert.
 *
 * Scan results stay identical across repeated runs, and the analyzed project is left byte-for-byte
 * unchanged. No analyzed script is ever executed and nothing is read from `node_modules`.
 */

import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject, type AnalysisResult } from '../../../src/core/analyzeProject.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, 'mapping-matrix', name));
}

/** Recursively snapshot every file path and content under a project root. */
function snapshotProject(root: string): readonly { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      files.push({
        path: relative(root, absolute).split(/[\\/]/).join('/'),
        content: readFileSync(absolute, 'utf8'),
      });
    }
  };

  walk(root);
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/** Serialize a result so ordering, not only membership, is compared. */
function asText(result: AnalysisResult): string {
  return JSON.stringify(result);
}

describe('Step 54: every manifest group composes with the catalog', () => {
  it('suppresses only the packages that have valid evidence', async () => {
    // `tsc` credits typescript and `ts-node-cwd`/`ts-node-esm` both credit the single declared ts-node.
    // `react` is used by the source import, `lodash` has no evidence at all, and `eslint` is only named
    // as an argument. `vue` and `fsevents` are peer/optional declarations and are never reported unused,
    // while the undeclared `zod` import stays a missing finding.
    const result = await analyzeProject(fixturePath('integration-groups'));

    expect(result.unusedDependencies).toEqual(['lodash']);
    expect(result.unusedDevDependencies).toEqual(['eslint']);
    expect(result.missingDependencies).toEqual(['zod']);
  });

  it('reports each package at most once when several aliases of it run', async () => {
    const result = await analyzeProject(fixturePath('integration-groups'));

    // Two different ts-node commands and one mapped tsc must not duplicate or reorder any section.
    expect(result.unusedDependencies).toEqual([...new Set(result.unusedDependencies)]);
    expect(result.unusedDevDependencies).toEqual([...new Set(result.unusedDevDependencies)]);
    expect(result.unusedDevDependencies).not.toContain('ts-node');
  });

  it('is deterministic across repeated scans of the same project', async () => {
    const root = fixturePath('integration-groups');
    const first = asText(await analyzeProject(root));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(asText(await analyzeProject(root))).toBe(first);
    }
  });

  it('leaves the analyzed project untouched', async () => {
    const root = fixturePath('integration-groups');
    const before = snapshotProject(root);

    expect(before.length).toBeGreaterThan(1);

    await analyzeProject(root);

    expect(snapshotProject(root)).toEqual(before);
  });
});

describe('Step 54: tricky script text never becomes usage evidence', () => {
  it('keeps every declared package unused when names only appear as text', async () => {
    // The scripts hold `echo biome`, `printf '%s' sls`, quoted `cz`/`manypkg`/`dotenvx` text, a
    // `sh -c "tsc"`/`bash -c 'docsify serve'` wrapper that is never unwrapped, an `${npm_package_json}`
    // interpolation, and `--tool=serverless` style arguments. None of them is a command position.
    const result = await analyzeProject(fixturePath('integration-tricky-negatives'));

    expect(result.unusedDependencies).toEqual(['lodash', 'react']);
    expect(result.unusedDevDependencies).toEqual([
      '@biomejs/biome',
      '@manypkg/cli',
      '@playwright/test',
      '@tailwindcss/cli',
      'commitizen',
      'docsify-cli',
      'serverless',
      'typescript',
      'webpack-cli',
    ]);
    expect(result.missingDependencies).toEqual([]);
  });

  it('does not pick a provider for ambiguous commands that only have alternative providers declared', async () => {
    // `tailwindcss`, `playwright` and `webpack` run in command position, but each is published by several
    // packages, so DepVitals credits only an exactly declared same-name package. The declared alternative
    // providers stay unused instead of receiving invented usage.
    const result = await analyzeProject(fixturePath('integration-tricky-negatives'));

    expect(result.unusedDevDependencies).toContain('@tailwindcss/cli');
    expect(result.unusedDevDependencies).toContain('@playwright/test');
    expect(result.unusedDevDependencies).toContain('webpack-cli');
    expect(result.missingDependencies).toEqual([]);
  });

  it('ignores import-like strings in source files', async () => {
    // The source file only contains string literals that look like an import, a require, a dynamic import
    // and a template literal, so react and lodash stay unused and express/zod never become missing.
    const result = await analyzeProject(fixturePath('integration-tricky-negatives'));

    expect(result.unusedDependencies).toEqual(['lodash', 'react']);
    expect(result.missingDependencies).toEqual([]);
  });

  it('stays deterministic and read-only', async () => {
    const root = fixturePath('integration-tricky-negatives');
    const before = snapshotProject(root);
    const first = asText(await analyzeProject(root));

    expect(asText(await analyzeProject(root))).toBe(first);
    expect(snapshotProject(root)).toEqual(before);
  });
});
