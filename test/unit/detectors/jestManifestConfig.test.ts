/**
 * Focused coverage for the bounded `package.json#jest` detection (Step 59).
 *
 * The step adds one narrow static configuration reader whose only output is a set of declared package
 * names handed to the Step 56 analyzer seam. As in the ESLint steps, two properties are asserted
 * everywhere:
 *
 * - config-only evidence genuinely suppresses an `unused` finding (each positive case is paired with
 *   the same fixture scanned without hints, which must report the package as unused);
 * - it never creates a `missing` finding, and nothing outside the two supported fields (shorthands,
 *   unrelated fields, local paths, arbitrary strings, malformed shapes, a root `jest.config.*` file)
 *   produces evidence at all.
 *
 * Nothing is executed: Jest is never run, its configuration loader is never imported, and fixtures are
 * only read as JSON text. The tests are offline.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import { analyzeProject } from '../../../src/core/analyzeProject.js';
import {
  findJestConfigUsage,
  findJestManifestUsage,
} from '../../../src/detectors/jestManifestConfig.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));
const FAMILY = 'jest-manifest-config';

/** Absolute path to a committed project inside the `jest-manifest-config` fixture family. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, FAMILY, name));
}

/** Absolute path to a committed project directly under the shared analysis fixture root. */
function analysisFixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, name));
}

/** The package names the allowlist may ever return. */
const SUPPORTING = new Set(['ts-jest', 'jest-environment-jsdom']);

/**
 * Run `run` inside a throwaway project directory containing `files`, outside the DepVitals
 * repository, and remove only that freshly created directory afterwards.
 */
async function withScratchProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-jest-manifest-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content, 'utf8');
    }

    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MANIFEST_WITH_TS_JEST_PRESET = JSON.stringify({
  name: 'scratch-jest-preset',
  version: '0.0.0',
  devDependencies: { 'ts-jest': '29.2.0' },
  jest: { preset: 'ts-jest' },
});

describe('findJestConfigUsage (pure allowlist matcher)', () => {
  it('recognizes the explicit ts-jest preset', () => {
    expect(findJestConfigUsage({ preset: 'ts-jest' }, SUPPORTING)).toEqual(new Set(['ts-jest']));
  });

  it('recognizes the exact jest-environment-jsdom testEnvironment', () => {
    expect(findJestConfigUsage({ testEnvironment: 'jest-environment-jsdom' }, SUPPORTING)).toEqual(
      new Set(['jest-environment-jsdom']),
    );
  });

  it('recognizes both fields at once and returns them in a deterministic order', () => {
    const jestConfig = { preset: 'ts-jest', testEnvironment: 'jest-environment-jsdom' };

    expect([...findJestConfigUsage(jestConfig, SUPPORTING)]).toEqual([
      'jest-environment-jsdom',
      'ts-jest',
    ]);
  });

  it('accepts a literal subpath of an allowlisted package, collapsed to its package root', () => {
    expect(findJestConfigUsage({ preset: 'ts-jest/presets/default-esm' }, SUPPORTING)).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('does not expand the historical "jsdom" shorthand', () => {
    // Where Jest accepts `jsdom` it resolves it to the separately installed
    // jest-environment-jsdom, but whether the shorthand is available at all depends on the Jest
    // major version, which DepVitals does not read. This release supports explicit package names
    // only, so the shorthand stays unsupported by design rather than by assumption.
    expect(findJestConfigUsage({ testEnvironment: 'jsdom' }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
  });

  it('ignores fields outside the two supported ones, even when they name a supported package', () => {
    expect(findJestConfigUsage({ displayName: 'ts-jest' }, SUPPORTING)).toEqual(new Set<string>());
    expect(
      findJestConfigUsage(
        { runner: 'jest-environment-jsdom', coverageReportName: 'ts-jest' },
        SUPPORTING,
      ),
    ).toEqual(new Set<string>());
    // A nested `preset` is not the top-level field.
    expect(findJestConfigUsage({ projects: [{ preset: 'ts-jest' }] }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
  });

  it('rejects local, absolute, rootDir-relative and URL-shaped resolver strings', () => {
    for (const preset of [
      './local.js',
      '../shared-preset.js',
      '/srv/presets/ts-jest.js',
      '<rootDir>/presets/ts-jest.js',
      'file:./ts-jest.js',
      'ts-jest-extras',
      'TS-Jest',
      '',
      'ts jest',
    ]) {
      expect(findJestConfigUsage({ preset }, SUPPORTING)).toEqual(new Set<string>());
    }
  });

  it('produces nothing for non-string field values', () => {
    expect(
      findJestConfigUsage(
        { preset: ['ts-jest'], testEnvironment: { name: 'jest-environment-jsdom' } },
        SUPPORTING,
      ),
    ).toEqual(new Set<string>());
    expect(findJestConfigUsage({ preset: 42, testEnvironment: null }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
    expect(findJestConfigUsage({ preset: true, testEnvironment: undefined }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a value that is only declared under a different name', () => {
    // `ts-jest` is the recognized name; the same string in a project that declares something else
    // can never credit that other package.
    expect(findJestConfigUsage({ preset: 'ts-jest' }, new Set(['some-other-preset']))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for anything that is not a Jest configuration object', () => {
    for (const jestConfig of ['ts-jest', ['ts-jest'], null, undefined, 0, true]) {
      expect(findJestConfigUsage(jestConfig, SUPPORTING)).toEqual(new Set<string>());
    }
  });

  it('does not mutate the configuration value it is given', () => {
    const jestConfig = { preset: 'ts-jest', testEnvironment: 'jest-environment-jsdom' };
    const before = structuredClone(jestConfig);

    findJestConfigUsage(jestConfig, SUPPORTING);

    expect(structuredClone(jestConfig)).toEqual(before);
  });
});

describe('findJestManifestUsage (package.json#jest reader)', () => {
  it('recognizes the explicit preset in a real manifest', async () => {
    expect(await findJestManifestUsage(fixturePath('preset-ts-jest'))).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('recognizes the exact testEnvironment in a real manifest', async () => {
    expect(await findJestManifestUsage(fixturePath('test-environment-jsdom'))).toEqual(
      new Set(['jest-environment-jsdom']),
    );
  });

  it('collapses a literal preset subpath to the declared package root', async () => {
    expect(await findJestManifestUsage(fixturePath('preset-subpath'))).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('does not expand the "jsdom" shorthand declared for the real package', async () => {
    expect(await findJestManifestUsage(fixturePath('jsdom-shorthand-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing when a supported name appears only as unrelated config text', async () => {
    expect(await findJestManifestUsage(fixturePath('display-name-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a local preset path', async () => {
    expect(await findJestManifestUsage(fixturePath('local-preset-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for arbitrary fields and script arguments that mention supported names', async () => {
    // The fixture also passes `--config ts-jest` and echoes `jest-environment-jsdom` in a script,
    // neither of which is configuration evidence.
    expect(await findJestManifestUsage(fixturePath('unrelated-text-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('tolerates malformed jest shapes without throwing', async () => {
    await expect(findJestManifestUsage(fixturePath('malformed-shapes'))).resolves.toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a non-object jest value', async () => {
    expect(await findJestManifestUsage(fixturePath('jest-scalar-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for undeclared matches, which are never missing findings', async () => {
    expect(await findJestManifestUsage(fixturePath('undeclared-no-missing'))).toEqual(
      new Set<string>(),
    );
  });

  it('skips manifest hints when a root jest.config.js exists', async () => {
    expect(await findJestManifestUsage(fixturePath('root-jest-config-precedence'))).toEqual(
      new Set<string>(),
    );
  });

  it('skips manifest hints for every supported root jest.config entry name', async () => {
    const entryNames = [
      'jest.config.js',
      'jest.config.mjs',
      'jest.config.cjs',
      'jest.config.ts',
      'jest.config.json',
    ];

    for (const entryName of entryNames) {
      await withScratchProject(
        {
          'package.json': MANIFEST_WITH_TS_JEST_PRESET,
          [entryName]: 'module.exports = {};\n',
        },
        async (root) => {
          expect(await findJestManifestUsage(root)).toEqual(new Set<string>());
        },
      );
    }
  });

  it('matches the root jest.config entry name case-insensitively, which only drops hints', async () => {
    // Case-insensitive filesystems (Windows, and macOS by default) resolve `Jest.Config.JS` to the
    // same file as `jest.config.js`, so DepVitals must not credit hints it cannot prove. On a
    // case-sensitive filesystem the comparison is deliberately conservative: it can only skip hints,
    // never invent them.
    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_TS_JEST_PRESET,
        'Jest.Config.JS': 'module.exports = {};\n',
      },
      async (root) => {
        expect(await findJestManifestUsage(root)).toEqual(new Set<string>());
      },
    );
  });

  it('documented limitation: jest.config.mts is not part of the fixed precedence list', async () => {
    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_TS_JEST_PRESET,
        'jest.config.mts': 'export default {};\n',
      },
      async (root) => {
        // The guard list is fixed to the extensions named by the contract, so this name does not
        // suppress the (still explicit) `package.json#jest` hint.
        expect(await findJestManifestUsage(root)).toEqual(new Set(['ts-jest']));
      },
    );
  });

  it('keeps manifest hints once no root jest.config file exists in the same project', async () => {
    await withScratchProject({ 'package.json': MANIFEST_WITH_TS_JEST_PRESET }, async (root) => {
      expect(await findJestManifestUsage(root)).toEqual(new Set(['ts-jest']));
    });
  });

  it('a jest.config.json that is present but unreadable still disables the hints', async () => {
    // The guard is presence-based only: the file is never opened, so its content - even invalid
    // JSON - cannot add evidence.
    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_TS_JEST_PRESET,
        'jest.config.json': '{ not json',
      },
      async (root) => {
        expect(await findJestManifestUsage(root)).toEqual(new Set<string>());
      },
    );
  });

  it('returns nothing for a project without any manifest', async () => {
    await withScratchProject({}, async (root) => {
      await expect(findJestManifestUsage(root)).resolves.toEqual(new Set<string>());
      // The manifest loader stays the component that reports a missing manifest.
      await expect(analyzeProject(root)).rejects.toThrow(/No package\.json found/);
    });
  });

  it('ignores a truly invalid manifest instead of replacing its diagnosis', async () => {
    const invalid = '{ "name": "broken", "jest": { "preset": "ts-jest" }';

    await withScratchProject({ 'package.json': invalid }, async (root) => {
      await expect(findJestManifestUsage(root)).resolves.toEqual(new Set<string>());
      await expect(analyzeProject(root)).rejects.toThrow(/is not valid JSON/);
    });
  });

  it('reads a scratch project outside the DepVitals repository without touching it', async () => {
    await withScratchProject({ 'package.json': MANIFEST_WITH_TS_JEST_PRESET }, async (root) => {
      const manifestPath = join(root, 'package.json');
      const before = await readFile(manifestPath, 'utf8');

      const first = await findJestManifestUsage(root);
      const second = await findJestManifestUsage(root);

      expect(first).toEqual(new Set(['ts-jest']));
      expect(second).toEqual(first);
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
    });
  });
});

describe('package.json#jest names through the Step 56 analyzer handoff', () => {
  it('suppresses an unused devDependency that no source or script references (preset)', async () => {
    const root = fixturePath('preset-ts-jest');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    // The suppression is genuine config-only usage: without the config there is no evidence at all.
    expect(baseline).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: ['ts-jest'],
      missingDependencies: [],
    });

    expect(hinted).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('suppresses an unused devDependency named only by testEnvironment', async () => {
    const root = fixturePath('test-environment-jsdom');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(baseline.unusedDevDependencies).toEqual(['jest-environment-jsdom']);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('suppresses for a literal preset subpath', async () => {
    const root = fixturePath('preset-subpath');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('keeps source and missing behavior unchanged next to a suppressed preset', async () => {
    const root = fixturePath('preset-with-source');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(baseline).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: ['ts-jest'],
      missingDependencies: ['zod'],
    });

    // Only the config-referenced devDependency disappears; the source-derived missing finding stays.
    expect(hinted).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: ['zod'],
    });
  });

  it('leaves the package unused when the shorthand is not expanded', async () => {
    const root = fixturePath('jsdom-shorthand-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['jest-environment-jsdom']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves a declared package unused when it is named only as unrelated config text', async () => {
    const root = fixturePath('display-name-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
  });

  it('leaves every unrelated package unused for arbitrary fields and script arguments', async () => {
    const root = fixturePath('unrelated-text-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['jest-environment-jsdom', 'ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves the package unused for a local preset path', async () => {
    const root = fixturePath('local-preset-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('never reports a missing finding for a config string that is not declared', async () => {
    const root = fixturePath('undeclared-no-missing');
    const configUsedNames = await findJestManifestUsage(root);

    expect(configUsedNames).toEqual(new Set<string>());
    expect(await analyzeProject(root, { configUsedNames })).toEqual({
      projectRoot: root,
      unusedDependencies: ['left-pad'],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('keeps the package unused when a root jest.config file makes manifest hints uncertain', async () => {
    const root = fixturePath('root-jest-config-precedence');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('does not change any result for a manifest without a jest block', async () => {
    const root = analysisFixturePath('config-seam');

    expect(await findJestManifestUsage(root)).toEqual(new Set<string>());
    expect(await analyzeProject(root, { configUsedNames: new Set<string>() })).toEqual(
      await analyzeProject(root),
    );
  });
});

describe('CLI scan wiring for package.json#jest hints', () => {
  const OPTIONS = { version: '0.0.0-test', cwd: tmpdir() };

  it('reports a config-only used devDependency as clean', async () => {
    const result = await runCli([fixturePath('preset-ts-jest')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('reports a config-only used testEnvironment as clean', async () => {
    const result = await runCli([fixturePath('test-environment-jsdom')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('still reports the package when a root jest.config file shadows the manifest block', async () => {
    const result = await runCli([fixturePath('root-jest-config-precedence')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('ts-jest');
    expect(result.stderr).toBe('');
  });

  it('still reports the package for the unsupported shorthand', async () => {
    const result = await runCli([fixturePath('jsdom-shorthand-negative')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('jest-environment-jsdom');
  });

  it('keeps exit status and findings unchanged for an unrelated project', async () => {
    const result = await runCli([fixturePath('unrelated-text-negative')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (2)');
    expect(result.stdout).toContain('ts-jest');
    expect(result.stdout).toContain('jest-environment-jsdom');
  });
});
