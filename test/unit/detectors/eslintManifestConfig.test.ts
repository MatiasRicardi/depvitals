/**
 * Focused coverage for the bounded legacy `package.json#eslintConfig` detection (Step 57).
 *
 * The step adds one narrow static configuration reader whose only output is a set of declared
 * package names handed to the Step 56 analyzer seam. Two properties are asserted everywhere:
 *
 * - config-only evidence genuinely suppresses an `unused` finding (each positive case is paired
 *   with the same fixture scanned without hints, which must report the package as unused);
 * - it never creates a `missing` finding, and nothing outside the fixed allowlist (unrelated
 *   config text, unknown aliases, invented plugin names, malformed shapes, a modern root
 *   flat-config entrypoint) produces evidence at all.
 *
 * Nothing is executed: fixtures are only read as JSON text, and the tests are offline.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCli } from '../../../src/cli/runCli.js';
import { analyzeProject } from '../../../src/core/analyzeProject.js';
import {
  findEslintConfigUsage,
  findEslintManifestUsage,
} from '../../../src/detectors/eslintManifestConfig.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));
const FAMILY = 'eslint-manifest-config';

/** Absolute path to a committed project inside the `eslint-manifest-config` fixture family. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, FAMILY, name));
}

/** Absolute path to a committed project directly under the shared analysis fixture root. */
function analysisFixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, name));
}

/** The package names the allowlist tables may ever return. */
const SUPPORTING = new Set([
  'eslint-config-prettier',
  'eslint-config-airbnb',
  'eslint-plugin-react',
]);

/**
 * Run `run` inside a throwaway project directory containing `files`, outside the DepVitals
 * repository, and remove only that freshly created directory afterwards.
 */
async function withScratchProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-eslint-manifest-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content, 'utf8');
    }

    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MANIFEST_WITH_PRETTIER_ALIAS = JSON.stringify({
  name: 'scratch-eslint-alias',
  version: '0.0.0',
  devDependencies: { 'eslint-config-prettier': '9.1.0' },
  eslintConfig: { extends: 'prettier' },
});

describe('findEslintConfigUsage (pure allowlist matcher)', () => {
  it('maps the documented extends aliases to their packages', () => {
    expect(findEslintConfigUsage({ extends: 'prettier' }, SUPPORTING)).toEqual(
      new Set(['eslint-config-prettier']),
    );
    expect(findEslintConfigUsage({ extends: 'airbnb' }, SUPPORTING)).toEqual(
      new Set(['eslint-config-airbnb']),
    );
    expect(findEslintConfigUsage({ extends: 'plugin:react/recommended' }, SUPPORTING)).toEqual(
      new Set(['eslint-plugin-react']),
    );
  });

  it('maps the documented plugin shorthand and keeps builtins out', () => {
    expect(findEslintConfigUsage({ plugins: ['react'] }, SUPPORTING)).toEqual(
      new Set(['eslint-plugin-react']),
    );

    // `eslint:recommended` / `eslint:all` are builtin config names, not packages.
    expect(
      findEslintConfigUsage({ extends: ['eslint:recommended', 'eslint:all'] }, SUPPORTING),
    ).toEqual(new Set<string>());
  });

  it('accepts the already complete package names of the supported aliases', () => {
    const eslintConfig = {
      extends: ['eslint:recommended', 'eslint-config-prettier', 'plugin:react/recommended'],
      plugins: ['eslint-plugin-react'],
    };

    expect(findEslintConfigUsage(eslintConfig, SUPPORTING)).toEqual(
      new Set(['eslint-config-prettier', 'eslint-plugin-react']),
    );
  });

  it('credits a complete plugin name only in plugins, never in extends', () => {
    // `extends: "eslint-plugin-react"` resolves to `eslint-config-eslint-plugin-react` in legacy
    // ESLint, so it is not evidence of usage of the declared plugin.
    expect(findEslintConfigUsage({ extends: 'eslint-plugin-react' }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
    expect(findEslintConfigUsage({ plugins: ['eslint-plugin-react'] }, SUPPORTING)).toEqual(
      new Set(['eslint-plugin-react']),
    );
  });

  it('never generalizes an unknown alias, plugin name or casing', () => {
    const unsupported = {
      extends: [
        'some-unknown-config',
        'prettier/react',
        'airbnb-base',
        'airbnb/hooks',
        'plugin:jsx-plus/recommended',
        'plugin:react/all',
        'plugin:prettier',
        'standard-with-typescript',
        '@acme/eslint-config',
        'ESLint-Config-Prettier',
        'Prettier',
        'Airbnb',
        ' prettier',
        'prettier ',
        'eslint-config-prettier/react',
        // A plugin is only extendable as `plugin:<name>/<config>`; legacy ESLint prefixes a bare
        // name with `eslint-config-`, so this value cannot refer to `eslint-plugin-react`.
        'eslint-plugin-react',
      ],
      plugins: ['invented', 'jsx-plus', 'React', 'eslint', '@acme', 'eslint-plugin-Vue'],
    };

    expect(findEslintConfigUsage(unsupported, SUPPORTING)).toEqual(new Set<string>());
  });

  it('reads only extends and plugins, never any other configuration value', () => {
    const eslintConfig = {
      settings: { label: 'react', react: { version: 'detect' } },
      rules: { 'react/jsx-uses-react': 'error' },
      parser: 'react',
      parserOptions: { plugins: ['react'] },
      env: { extends: 'prettier' },
      globals: { prettier: 'readonly' },
      ignorePatterns: ['prettier'],
      overrides: [{ files: ['*.ts'], extends: 'prettier', plugins: ['react'] }],
      plugins: { react: [] },
    };

    expect(findEslintConfigUsage(eslintConfig, SUPPORTING)).toEqual(new Set<string>());
  });

  it('ignores an eslintConfig value that is not a plain object', () => {
    for (const value of ['prettier', ['prettier'], 42, true, null, undefined]) {
      expect(findEslintConfigUsage(value, SUPPORTING)).toEqual(new Set<string>());
    }
  });

  it('requires an array for plugins and ignores non-string array entries', () => {
    // A bare string is not a valid `plugins` value, so it contributes nothing.
    expect(findEslintConfigUsage({ plugins: 'react' }, SUPPORTING)).toEqual(new Set<string>());

    // A malformed `extends` array keeps its usable string entries and ignores the rest.
    expect(findEslintConfigUsage({ extends: [42, null, true, 'prettier'] }, SUPPORTING)).toEqual(
      new Set(['eslint-config-prettier']),
    );
    expect(findEslintConfigUsage({ extends: [{ extends: 'prettier' }] }, SUPPORTING)).toEqual(
      new Set<string>(),
    );
  });

  it('returns only declared packages and nothing for an undeclared match', () => {
    const eslintConfig = { extends: 'prettier', plugins: ['react'] };

    expect(findEslintConfigUsage(eslintConfig, new Set(['unrelated']))).toEqual(new Set<string>());
    expect(findEslintConfigUsage(eslintConfig, new Set(['eslint-plugin-react']))).toEqual(
      new Set(['eslint-plugin-react']),
    );
  });

  it('is deterministic and independent of declaration order', () => {
    const eslintConfig = {
      extends: ['plugin:react/recommended', 'airbnb', 'prettier'],
      plugins: ['react'],
    };

    expect([...findEslintConfigUsage(eslintConfig, SUPPORTING)]).toEqual([
      'eslint-config-airbnb',
      'eslint-config-prettier',
      'eslint-plugin-react',
    ]);
  });

  it('does not mutate the configuration value it is given', () => {
    const eslintConfig = { extends: ['prettier'], plugins: ['react'] };
    const before = structuredClone(eslintConfig);

    findEslintConfigUsage(eslintConfig, SUPPORTING);

    expect(structuredClone(eslintConfig)).toEqual(before);
  });
});

describe('findEslintManifestUsage (package.json#eslintConfig reader)', () => {
  it('recognizes the alias in a real manifest', async () => {
    expect(await findEslintManifestUsage(fixturePath('extends-prettier'))).toEqual(
      new Set(['eslint-config-prettier']),
    );
  });

  it('skips builtin entries of a mixed extends array', async () => {
    // `eslint:recommended` contributes nothing, and the declared `eslint` control keeps no evidence.
    expect(await findEslintManifestUsage(fixturePath('extends-array-builtins'))).toEqual(
      new Set(['eslint-config-airbnb']),
    );
  });

  it('recognizes a documented plugin entry', async () => {
    expect(await findEslintManifestUsage(fixturePath('plugins-react'))).toEqual(
      new Set(['eslint-plugin-react']),
    );
  });

  it('recognizes already complete package names', async () => {
    expect(await findEslintManifestUsage(fixturePath('explicit-package-names'))).toEqual(
      new Set(['eslint-config-prettier', 'eslint-plugin-react']),
    );
  });

  it('produces nothing for unrelated configuration text', async () => {
    expect(await findEslintManifestUsage(fixturePath('settings-text-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for unknown aliases and invented plugin names', async () => {
    expect(await findEslintManifestUsage(fixturePath('unknown-alias-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a plugin package name used as an extends value', async () => {
    expect(await findEslintManifestUsage(fixturePath('extends-plugin-name-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for a non-object eslintConfig value', async () => {
    expect(await findEslintManifestUsage(fixturePath('eslintconfig-scalar-negative'))).toEqual(
      new Set<string>(),
    );
  });

  it('does not read overrides, which are out of the supported subset', async () => {
    expect(await findEslintManifestUsage(fixturePath('overrides-not-read'))).toEqual(
      new Set<string>(),
    );
  });

  it('produces nothing for undeclared matches, which are never missing findings', async () => {
    expect(await findEslintManifestUsage(fixturePath('undeclared-no-missing'))).toEqual(
      new Set<string>(),
    );
  });

  it('tolerates malformed optional eslintConfig shapes without throwing', async () => {
    await expect(findEslintManifestUsage(fixturePath('malformed-shapes'))).resolves.toEqual(
      new Set<string>(),
    );
  });

  it('skips legacy hints when a modern flat-config entrypoint sits at the project root', async () => {
    expect(await findEslintManifestUsage(fixturePath('flat-config-precedence'))).toEqual(
      new Set<string>(),
    );
  });

  it('skips legacy hints for every supported flat-config entry name', async () => {
    const entryNames = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs'];

    for (const entryName of entryNames) {
      await withScratchProject(
        {
          'package.json': MANIFEST_WITH_PRETTIER_ALIAS,
          [entryName]: 'export default [];\n',
        },
        async (root) => {
          expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
        },
      );
    }

    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_PRETTIER_ALIAS,
        'eslint.config.ts': 'export default [];\n',
      },
      async (root) => {
        expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
      },
    );
  });

  it('matches the flat-config entry name case-insensitively, which only drops hints', async () => {
    // Case-insensitive filesystems (Windows, and macOS by default) resolve `ESLint.Config.JS` to the
    // same file as `eslint.config.js`, so DepVitals must not credit legacy hints it cannot prove.
    // On a case-sensitive filesystem the comparison is deliberately conservative: it can only skip
    // hints, never invent them.
    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_PRETTIER_ALIAS,
        'ESLint.Config.JS': 'export default [];\n',
      },
      async (root) => {
        expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
      },
    );
  });

  it('keeps legacy hints once no flat-config entry exists in the same project', async () => {
    await withScratchProject({ 'package.json': MANIFEST_WITH_PRETTIER_ALIAS }, async (root) => {
      expect(await findEslintManifestUsage(root)).toEqual(new Set(['eslint-config-prettier']));
    });
  });

  it('treats eslint.config.mts as a hard barrier in the fixed precedence list', async () => {
    await withScratchProject(
      {
        'package.json': MANIFEST_WITH_PRETTIER_ALIAS,
        'eslint.config.mts': 'export default [];\n',
      },
      async (root) => {
        // Step 68.1 added `eslint.config.mts` / `eslint.config.cts` to the fixed list, so this name
        // now suppresses legacy hints like the original four extensions.
        expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
      },
    );
  });

  it('returns nothing for a project without any manifest', async () => {
    await withScratchProject({}, async (root) => {
      await expect(findEslintManifestUsage(root)).resolves.toEqual(new Set<string>());
      // The manifest loader stays the component that reports a missing manifest.
      await expect(analyzeProject(root)).rejects.toThrow(/No package\.json found/);
    });
  });

  it('ignores a truly invalid manifest instead of replacing its diagnosis', async () => {
    const invalid = '{ "name": "broken", "eslintConfig": { "extends": "prettier" }';

    await withScratchProject({ 'package.json': invalid }, async (root) => {
      await expect(findEslintManifestUsage(root)).resolves.toEqual(new Set<string>());
      await expect(analyzeProject(root)).rejects.toThrow(/is not valid JSON/);
    });
  });

  it('reads a scratch project outside the DepVitals repository without touching it', async () => {
    await withScratchProject({ 'package.json': MANIFEST_WITH_PRETTIER_ALIAS }, async (root) => {
      const manifestPath = join(root, 'package.json');
      const before = await readFile(manifestPath, 'utf8');

      const first = await findEslintManifestUsage(root);
      const second = await findEslintManifestUsage(root);

      expect(first).toEqual(new Set(['eslint-config-prettier']));
      expect(second).toEqual(first);
      expect(await readFile(manifestPath, 'utf8')).toBe(before);
    });
  });
});

describe('eslintConfig names through the Step 56 analyzer handoff', () => {
  it('suppresses an unused dependency that no source or script references', async () => {
    const root = fixturePath('extends-prettier');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    // The suppression is genuine config-only usage: without the config there is no evidence at all.
    expect(baseline).toEqual({
      projectRoot: root,
      unusedDependencies: ['eslint-config-prettier'],
      unusedDevDependencies: [],
      missingDependencies: [],
    });

    expect(hinted).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('suppresses an unused devDependency declared for a mixed extends array', async () => {
    const root = fixturePath('extends-array-builtins');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(baseline.unusedDevDependencies).toEqual([]);
    expect(baseline.unusedDependencies).toEqual(['eslint', 'eslint-config-airbnb']);

    // Only the aliased config disappears: the builtin name never credits the declared `eslint`.
    expect(hinted.unusedDependencies).toEqual(['eslint']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('suppresses an unused devDependency named only by a plugin entry', async () => {
    const root = fixturePath('plugins-react');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(baseline.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('suppresses for already complete package names', async () => {
    const root = fixturePath('explicit-package-names');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(baseline.unusedDevDependencies).toEqual([
      'eslint-config-prettier',
      'eslint-plugin-react',
    ]);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves a declared plugin unused when it is named only as an extends value', async () => {
    const root = fixturePath('extends-plugin-name-negative');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    // The value is not a loadable `extends` reference for legacy ESLint, so nothing is credited.
    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves a declared plugin unused when the name appears only as unrelated text', async () => {
    const root = fixturePath('settings-text-negative');
    const configUsedNames = await findEslintManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves every unrelated package unused for unknown aliases and invented plugins', async () => {
    const root = fixturePath('unknown-alias-negative');
    const configUsedNames = await findEslintManifestUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual([
      'eslint-config-standardish',
      'eslint-plugin-invented',
      'react',
    ]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('never reports a missing finding for a config string that is not declared', async () => {
    const root = fixturePath('undeclared-no-missing');

    // Nothing is declared under the ESLint names, so the reader produces nothing and the analyzer
    // has nothing to report: an `extends`/`plugins` string is not source evidence.
    expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
    expect(
      await analyzeProject(root, { configUsedNames: await findEslintManifestUsage(root) }),
    ).toEqual({
      projectRoot: root,
      unusedDependencies: ['left-pad'],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('keeps the package unused when a root flat config makes legacy hints uncertain', async () => {
    const root = fixturePath('flat-config-precedence');
    const configUsedNames = await findEslintManifestUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-config-prettier']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('does not change any result for a manifest without an eslintConfig block', async () => {
    const root = analysisFixturePath('config-seam');

    expect(await findEslintManifestUsage(root)).toEqual(new Set<string>());
    expect(await analyzeProject(root, { configUsedNames: new Set<string>() })).toEqual(
      await analyzeProject(root),
    );
  });
});

describe('CLI scan wiring for eslintConfig hints', () => {
  const OPTIONS = { version: '0.0.0-test', cwd: tmpdir() };

  it('reports a config-only used dependency as clean', async () => {
    const result = await runCli([fixturePath('extends-prettier')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('still reports the package when the legacy block is shadowed by a root flat config', async () => {
    const result = await runCli([fixturePath('flat-config-precedence')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('eslint-config-prettier');
    expect(result.stderr).toBe('');
  });

  it('keeps exit status and findings unchanged for an unrelated project', async () => {
    const result = await runCli([fixturePath('settings-text-negative')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('eslint-plugin-react');
  });
});
