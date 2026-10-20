/**
 * Focused coverage for the Step 56 internal config-evidence handoff.
 *
 * The handoff is a single optional argument on `analyzeProject`: an already-validated set of
 * configuration-only package names. The analyzer stays the only owner of the final unused/missing
 * categories, and the evidence asymmetry is the whole point of the seam:
 *
 * - source imports may create missing findings;
 * - configuration names may only suppress an unused finding and can never create one.
 *
 * Every case below is asserted through the public analyzer boundary, offline, and no fixture code is
 * executed. The final group is a backward-compatibility guard: with no configuration evidence (the
 * state of the released product) the structured result and the rendered report must be identical to
 * the pre-seam behavior for every committed fixture.
 */

import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  analyzeProject,
  type AnalysisOptions,
  type AnalysisResult,
} from '../../../src/core/analyzeProject.js';
import { formatTerminalReport } from '../../../src/reporters/terminalReporter.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

/** Absolute path to a committed analysis fixture. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURES, name));
}

/**
 * Every committed fixture project root (a directory containing a `package.json`).
 *
 * Two fixture families group several projects one level deeper, so those children are collected too.
 */
function allFixtureRoots(): readonly string[] {
  const roots: string[] = [];

  for (const entry of readdirSync(FIXTURES, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const directory = join(FIXTURES, entry.name);

    if (readdirSync(directory).includes('package.json')) {
      roots.push(directory);
      continue;
    }

    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (
        child.isDirectory() &&
        readdirSync(join(directory, child.name)).includes('package.json')
      ) {
        roots.push(join(directory, child.name));
      }
    }
  }

  return roots.sort(comparePaths);
}

function comparePaths(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}

/**
 * A scan outcome. Some fixtures intentionally fail (an invalid source file), so a thrown operational
 * error is compared as data instead of aborting the backward-compatibility matrix.
 */
type ScanOutcome = { ok: true; result: AnalysisResult } | { ok: false; error: string };

async function scan(root: string, options?: AnalysisOptions): Promise<ScanOutcome> {
  try {
    return { ok: true, result: await analyzeProject(root, options) };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return { ok: false, error: message };
  }
}

/** The `config-seam` fixture without any configuration evidence. */
const BASELINE: AnalysisResult = await analyzeProject(fixturePath('config-seam'));

/**
 * The `config-seam` fixture with configuration-only hints for both a declared dependency and a
 * declared devDependency, plus an undeclared name and a name already used by source and script.
 */
const HINTED: AnalysisResult = await analyzeProject(fixturePath('config-seam'), {
  configUsedNames: new Set(['config-only', 'config-only-dev', 'undeclared-pkg', 'all-sources']),
});

describe('internal config-evidence handoff', () => {
  it('records the pre-seam baseline of the config-seam fixture', () => {
    // Without configuration evidence the config-only packages have no evidence at all and the
    // undeclared source import is missing. This pins what the seam must change and must not.
    expect(BASELINE).toEqual({
      projectRoot: fixturePath('config-seam'),
      unusedDependencies: ['config-only', 'unused-pkg'],
      unusedDevDependencies: ['config-only-dev'],
      missingDependencies: ['undeclared-pkg'],
    });
  });

  it('suppresses unused dependencies and devDependencies for hinted declared packages', async () => {
    const hinted = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(['config-only', 'config-only-dev']),
    });

    expect(hinted.unusedDependencies).toEqual(['unused-pkg']);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual(['undeclared-pkg']);
  });

  it('never turns an undeclared hinted package into a missing finding', async () => {
    const undeclaredOnly = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(['totally-undeclared-config-pkg']),
    });

    // A configuration string is not source evidence, so nothing is reported about it.
    expect(undeclaredOnly).toEqual(BASELINE);
  });

  it('keeps a source import of an undeclared package missing even when it is hinted', () => {
    // `undeclared-pkg` is imported by source and hinted by configuration. The hint must not launder
    // the missing finding, and it must not add a second entry either.
    expect(HINTED.missingDependencies).toEqual(['undeclared-pkg']);
    expect(HINTED.missingDependencies).toHaveLength(1);
  });

  it('reports one consistent result when script, source and configuration name the same package', () => {
    // `all-sources` is declared, imported by source, used as a script executable and hinted by
    // configuration. It appears in none of the finding arrays, exactly once in each other case.
    expect(HINTED.unusedDependencies).toEqual(['unused-pkg']);
    expect(HINTED.unusedDevDependencies).toEqual([]);
    expect(HINTED.missingDependencies).toEqual(['undeclared-pkg']);
  });

  it('collapses a hinted subpath to the declared package root', async () => {
    const normalized = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(['config-only/lib/entry']),
    });

    expect(normalized.unusedDependencies).toEqual(['unused-pkg']);
    expect(normalized.unusedDevDependencies).toEqual(['config-only-dev']);
  });

  it('deduplicates repeated hinted names case-sensitively without matching other casings', async () => {
    const suppressed = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(['unused-pkg', 'unused-pkg', 'unused-pkg/']),
    });

    expect(suppressed.unusedDependencies).toEqual(['config-only']);

    // Package names are compared case-sensitively, so an upper-case hint suppresses nothing.
    const otherCase = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(['Unused-Pkg', 'UNUSED-PKG']),
    });

    expect(otherCase).toEqual(BASELINE);
  });

  it('ignores arbitrary configuration text that is not a package name', async () => {
    const noise = [
      './all-sources',
      '../relative',
      '/absolute/path',
      'node:path',
      'data:text/plain',
      '@scope',
      '@/pkg',
      'all-sources@1.0.0',
      ' all-sources ',
      'all-sources?',
      '',
      'plugin:@scope/legacy',
    ];

    const noisy = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set(noise),
    });

    // None of the noise suppresses an unused finding or creates a missing one.
    expect(noisy).toEqual(BASELINE);
  });

  it('treats an omitted options argument as an empty hint set', async () => {
    const explicitEmpty = await analyzeProject(fixturePath('config-seam'), {
      configUsedNames: new Set<string>(),
    });

    expect(explicitEmpty).toEqual(BASELINE);
  });
});

describe('backward compatibility without configuration evidence', () => {
  const roots = allFixtureRoots();

  it('covers every committed fixture project', () => {
    // Guards the guard: a fixture family without a manifest would otherwise be skipped silently.
    expect(roots.length).toBeGreaterThanOrEqual(157);
  });

  const cases: readonly (readonly [string, string])[] = roots.map((root) => [
    root.slice(FIXTURES.length + 1),
    root,
  ]);

  it.each(cases)(
    '%s matches the pre-seam result and report for empty config hints',
    async (_name, root) => {
      const withoutOptions = await scan(root);
      const withEmptyHints = await scan(root, { configUsedNames: new Set<string>() });

      expect(withEmptyHints).toEqual(withoutOptions);

      if (withoutOptions.ok && withEmptyHints.ok) {
        expect(formatTerminalReport(withEmptyHints.result)).toBe(
          formatTerminalReport(withoutOptions.result),
        );
      } else {
        // A fixture that fails must keep failing in exactly the same way: the seam adds no new error
        // and hides no operational failure.
        expect(withoutOptions.ok).toBe(false);
      }
    },
  );

  it('keeps the released v0.1.0 golden results when no config hints are supplied', async () => {
    const esm = await analyzeProject(fixturePath('esm'), { configUsedNames: new Set() });
    const commonjs = await analyzeProject(fixturePath('commonjs'), {
      configUsedNames: new Set(),
    });
    const typescript = await analyzeProject(fixturePath('typescript'), {
      configUsedNames: new Set(),
    });

    // These are the published v0.1.0 golden results, unchanged by the seam.
    expect(esm).toEqual({
      projectRoot: fixturePath('esm'),
      unusedDependencies: ['unused-esm-dep'],
      unusedDevDependencies: [],
      missingDependencies: ['dynamic-pkg', 'reexport-pkg', 'side-effect-pkg'],
    });

    expect(commonjs).toEqual({
      projectRoot: fixturePath('commonjs'),
      unusedDependencies: ['unused-cjs-dep'],
      unusedDevDependencies: [],
      missingDependencies: ['missing-cjs'],
    });

    expect(typescript.unusedDependencies).toEqual(['unused-ts-dep']);
    expect(typescript.unusedDevDependencies).toEqual([]);
    expect(typescript.missingDependencies).toEqual([]);
  });
});
