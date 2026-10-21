/**
 * Focused coverage for the bounded `package.json#jest.transform` detection (Step 60).
 *
 * The step widens the Step 59 `package.json#jest` reader by exactly one field: the *values* of the
 * top-level `transform` map. Every other rule is inherited unchanged - fixed allowlists, the shared
 * package-specifier classifier applied before any comparison, the root `jest.config.*` precedence
 * guard, and the Step 56 handoff, so a recognized name can only suppress an `unused` finding and can
 * never create a `missing` one.
 *
 * The properties asserted everywhere are therefore the same two as in Step 59:
 *
 * - config-only evidence genuinely suppresses an `unused` finding (each positive case is paired with
 *   the same fixture scanned without hints, which must report the package as unused);
 * - nothing outside the supported shapes produces evidence - not a transform *key* (a regular
 *   expression), not an option object, not a label, not a local path, not a malformed shape.
 *
 * Nothing is executed: Jest is never run, its configuration loader is never imported, no regular
 * expression key is evaluated, and fixtures are only read as JSON text. The tests are offline.
 */

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
const FAMILY = 'jest-transform-config';

/** Absolute path to a committed project inside the `jest-transform-config` fixture family. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, FAMILY, name));
}

/** Absolute path to a committed project directly under the shared analysis fixture root. */
function analysisFixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, name));
}

/** The package names the Jest allowlists may ever return. */
const SUPPORTING = new Set(['ts-jest', 'jest-environment-jsdom']);

/** A realistic transform key: in `package.json` text the pattern is JSON-escaped. */
const TS_PATTERN = '^.+\\.tsx?$';

describe('findJestConfigUsage (transform values)', () => {
  it('recognizes a literal "ts-jest" transform value', () => {
    expect(findJestConfigUsage({ transform: { [TS_PATTERN]: 'ts-jest' } }, SUPPORTING)).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('recognizes the [transformer, options] tuple form', () => {
    expect(
      findJestConfigUsage(
        { transform: { [TS_PATTERN]: ['ts-jest', { isolatedModules: true }] } },
        SUPPORTING,
      ),
    ).toEqual(new Set(['ts-jest']));
  });

  it('recognizes a tuple with an empty options object', () => {
    expect(
      findJestConfigUsage({ transform: { [TS_PATTERN]: ['ts-jest', {}] } }, SUPPORTING),
    ).toEqual(new Set(['ts-jest']));
  });

  it('collapses a literal transform subpath to the declared package root', () => {
    // `"ts-jest/preprocessor.js"` is the historical ts-jest transformer path. As for `preset`, the
    // shared package-root normalization credits the package that provides the module, so the same
    // normalization rule applies to the whole supported `jest` block.
    expect(
      findJestConfigUsage({ transform: { '^.+\\.ts$': 'ts-jest/preprocessor.js' } }, SUPPORTING),
    ).toEqual(new Set(['ts-jest']));
  });

  it('returns each recognized package once and in a deterministic order', () => {
    const jestConfig = {
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
        '^.+\\.js$': ['ts-jest', {}],
        '^.+\\.mjs$': 'some-other-transformer',
      },
      preset: 'ts-jest',
      testEnvironment: 'jest-environment-jsdom',
    };

    expect([...findJestConfigUsage(jestConfig, SUPPORTING)]).toEqual([
      'jest-environment-jsdom',
      'ts-jest',
    ]);
  });

  it('never reads a transform key as a package name', () => {
    // Keys of a Jest transform map are regular expressions. A key that literally reads `ts-jest` is
    // still only a pattern, and the value here is a local transformer, so nothing is credited.
    expect(findJestConfigUsage({ transform: { 'ts-jest': './transform.js' } }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
    expect(
      findJestConfigUsage({ transform: { 'ts-jest': 'some-other-transformer' } }, SUPPORTING),
    ).toEqual(new Set<string>());
  });

  it('never reads a transform option object as a package reference', () => {
    // The supported package name appears only as a display label inside the options object of a
    // tuple whose transformer is a local file.
    expect(
      findJestConfigUsage(
        {
          transform: {
            '^.+$': ['./local-transform.js', { label: 'ts-jest', displayName: 'ts-jest' }],
          },
        },
        SUPPORTING,
      ),
    ).toEqual(new Set<string>());
    // An object used in place of the whole value is not a tuple and not a transformer string.
    expect(findJestConfigUsage({ transform: { '^.+$': { name: 'ts-jest' } } }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
  });

  it('supports only the two documented tuple shapes', () => {
    for (const value of [
      ['ts-jest'],
      ['ts-jest', { isolatedModules: true }, 'extra'],
      ['ts-jest', 'isolatedModules'],
      ['ts-jest', null],
      ['ts-jest', ['ts-jest']],
      ['ts-jest'],
      [['ts-jest', {}]],
      [],
      undefined,
      null,
      42,
      true,
    ]) {
      expect(findJestConfigUsage({ transform: { [TS_PATTERN]: value } }, SUPPORTING)).toEqual(
        new Set<string>(),
      );
    }
  });

  it('rejects local, absolute, rootDir-relative, URL-shaped and near-miss transformers', () => {
    for (const value of [
      './local-transform.js',
      '../shared/transform.js',
      '/srv/transforms/ts-jest.js',
      '<rootDir>/jest/transform.js',
      'file:./ts-jest.js',
      // Windows-shaped and UNC paths must be as inert as POSIX ones.
      'C:\\tools\\transform.js',
      '\\\\server\\share\\transform.js',
      'ts-jest-extras',
      'TS-Jest',
      'ts jest',
      '',
      ' ',
    ]) {
      expect(findJestConfigUsage({ transform: { [TS_PATTERN]: value } }, SUPPORTING)).toEqual(
        new Set<string>(),
      );
      expect(findJestConfigUsage({ transform: { [TS_PATTERN]: [value, {}] } }, SUPPORTING)).toEqual(
        new Set<string>(),
      );
    }
  });

  it('produces nothing when transform is not a map', () => {
    for (const transform of ['ts-jest', ['ts-jest', {}], null, undefined, 42, true, 0]) {
      expect(findJestConfigUsage({ transform }, SUPPORTING)).toEqual(new Set<string>());
    }
  });

  it('does not credit a test environment package as a transformer', () => {
    // The `transform` allowlist is its own fixed list; `jest-environment-jsdom` is a supported
    // `testEnvironment`, never a transformer.
    expect(
      findJestConfigUsage({ transform: { [TS_PATTERN]: 'jest-environment-jsdom' } }, SUPPORTING),
    ).toEqual(new Set<string>());
  });

  it('ignores nested jest blocks and fields that merely look like transforms', () => {
    // A nested `transform` is not the top-level field, and `globals` never names a package.
    expect(
      findJestConfigUsage({ projects: [{ transform: { [TS_PATTERN]: 'ts-jest' } }] }, SUPPORTING),
    ).toEqual(new Set<string>());
    expect(
      findJestConfigUsage({ globals: { 'ts-jest': { isolatedModules: true } } }, SUPPORTING),
    ).toEqual(new Set<string>());
  });

  it('produces nothing for a recognized name that is not declared', () => {
    expect(
      findJestConfigUsage({ transform: { [TS_PATTERN]: 'ts-jest' } }, new Set(['some-other-pkg'])),
    ).toEqual(new Set<string>());
  });

  it('keeps recognizing preset and testEnvironment next to a transform', () => {
    const jestConfig = {
      preset: 'ts-jest',
      testEnvironment: 'jest-environment-jsdom',
      transform: { [TS_PATTERN]: ['ts-jest', { isolatedModules: true }] },
    };

    expect(findJestConfigUsage(jestConfig, SUPPORTING)).toEqual(
      new Set(['jest-environment-jsdom', 'ts-jest']),
    );
  });

  it('does not mutate the configuration value it is given', () => {
    const jestConfig = {
      transform: { [TS_PATTERN]: ['ts-jest', { isolatedModules: true }] },
    };
    const before = structuredClone(jestConfig);

    findJestConfigUsage(jestConfig, SUPPORTING);

    expect(structuredClone(jestConfig)).toEqual(before);
  });
});

describe('findJestManifestUsage (transform values in real manifests)', () => {
  it('recognizes the string transform value', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-string'))).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('recognizes the tuple transform value', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-tuple'))).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('collapses a literal transform subpath', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-subpath'))).toEqual(
      new Set(['ts-jest']),
    );
  });

  it('produces nothing when the supported name is only a transform key', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-key-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a local transformer whose options merely label ts-jest', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-tuple-local-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('tolerates unsupported transform shapes without fabricating evidence', async () => {
    await expect(findJestManifestUsage(fixturePath('transform-malformed-shapes'))).resolves.toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a transform value that is not a map', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-scalar-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('does not credit a test environment package as a transformer', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-environment-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for undeclared matches, which are never missing findings', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-undeclared-no-missing'))).toEqual(
      new Set<string>(),
    );
  });

  it('skips transform hints when a root jest.config.js exists', async () => {
    expect(await findJestManifestUsage(fixturePath('transform-root-config-precedence'))).toEqual(
      new Set<string>(),
    );
  });

  it('leaves an unrelated project untouched', async () => {
    expect(await findJestManifestUsage(analysisFixturePath('config-seam'))).toEqual(
      new Set<string>(),
    );
  });
});

describe('analyzer handoff for transform hints', () => {
  it('suppresses an unused devDependency named only by a transform string', async () => {
    const root = fixturePath('transform-string');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    // Genuine config-only usage: without the hint there is no evidence for the package at all.
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

  it('suppresses an unused devDependency named only by a transform tuple', async () => {
    const root = fixturePath('transform-tuple');
    const configUsedNames = await findJestManifestUsage(root);

    expect((await analyzeProject(root)).unusedDevDependencies).toEqual(['ts-jest']);
    expect((await analyzeProject(root, { configUsedNames })).unusedDevDependencies).toEqual([]);
  });

  it('keeps source-derived missing findings while suppressing the transform dependency', async () => {
    const root = fixturePath('transform-with-source');
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

  it('never reports a missing finding for a transform value that is not declared', async () => {
    const root = fixturePath('transform-undeclared-no-missing');
    const configUsedNames = await findJestManifestUsage(root);

    expect(configUsedNames).toEqual(new Set<string>());
    expect(await analyzeProject(root, { configUsedNames })).toEqual({
      projectRoot: root,
      unusedDependencies: ['left-pad'],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('leaves the package unused when the supported name is only a transform key', async () => {
    const root = fixturePath('transform-key-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
  });

  it('leaves the package unused for a local transformer with a ts-jest label', async () => {
    const root = fixturePath('transform-tuple-local-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves every declared package unused for unsupported transform shapes', async () => {
    const root = fixturePath('transform-malformed-shapes');
    const configUsedNames = await findJestManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
  });

  it('leaves both packages unused when only a test environment appears as transformer', async () => {
    const root = fixturePath('transform-environment-negative');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['jest-environment-jsdom', 'ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('keeps the package unused when a root jest.config file makes manifest hints uncertain', async () => {
    const root = fixturePath('transform-root-config-precedence');
    const configUsedNames = await findJestManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['ts-jest']);
    expect(hinted.missingDependencies).toEqual([]);
  });
});

describe('CLI scan wiring for transform hints', () => {
  const OPTIONS = { version: '0.0.0-test', cwd: tmpdir() };

  it('reports a config-only used transform as clean', async () => {
    const result = await runCli([fixturePath('transform-string')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('reports a config-only used transform tuple as clean', async () => {
    const result = await runCli([fixturePath('transform-tuple')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('still reports the package when the supported name is only a transform key', async () => {
    const result = await runCli([fixturePath('transform-key-negative')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('ts-jest');
    expect(result.stderr).toBe('');
  });

  it('still reports the package when a root jest.config file shadows the manifest block', async () => {
    const result = await runCli([fixturePath('transform-root-config-precedence')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('ts-jest');
    expect(result.stderr).toBe('');
  });

  it('keeps findings and exit status unchanged for an unsupported transform shape', async () => {
    const result = await runCli([fixturePath('transform-malformed-shapes')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('ts-jest');
    expect(result.stderr).toBe('');
  });
});
