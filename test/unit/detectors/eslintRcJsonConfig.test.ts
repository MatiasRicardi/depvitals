/**
 * Focused coverage for the external `.eslintrc.json` data source (Step 58).
 *
 * The step adds one static file reader on top of the ESLint rules proven in Step 57, so every
 * assertion here targets the file boundary: which single file is read, how it is read, what a bad
 * file does, and which source wins when several legacy configurations coexist. The allowlist itself
 * is covered by `eslintManifestConfig.test.ts` and is only exercised through one reuse check.
 *
 * Two product invariants are asserted everywhere:
 *
 * - config-only evidence genuinely suppresses an `unused` finding (each positive case is paired with
 *   the same project scanned without hints, which must report the package as unused);
 * - it never creates a `missing` finding, and nothing outside the read subset (unknown aliases,
 *   unrelated fields, `overrides`, a symlink, a shadowed file, a non-object document) produces any
 *   evidence at all.
 *
 * Nothing is executed: `.eslintrc.json` is only read as JSON text, the temporary projects live
 * outside the DepVitals repository, and the tests are offline.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import {
  EslintRcJsonError,
  findEslintRcJsonUsage,
} from '../../../src/detectors/eslintRcJsonConfig.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));
const FAMILY = 'eslint-rc-json-config';

/** Absolute path to a committed project inside the `eslint-rc-json-config` fixture family. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, FAMILY, name));
}

/**
 * Run `run` inside a throwaway project directory containing `files`, outside the DepVitals
 * repository, and remove only that freshly created directory afterwards.
 */
async function withScratchProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-eslintrc-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content, 'utf8');
    }

    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const MANIFEST_DECLARING_REACT = JSON.stringify({
  name: 'scratch-eslintrc',
  version: '0.0.0',
  devDependencies: { 'eslint-plugin-react': '7.37.0' },
});

const ESLINTRC_DECLARING_REACT = '{"plugins":["react"]}\n';

describe('findEslintRcJsonUsage (external .eslintrc.json reader)', () => {
  it('suppresses an unused devDependency named by a plugins entry', async () => {
    const root = fixturePath('plugins-react');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set(['eslint-plugin-react']));
    expect(baseline.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('suppresses an unused devDependency named by an extends alias', async () => {
    const root = fixturePath('extends-prettier');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set(['eslint-config-prettier']));
    expect(baseline.unusedDevDependencies).toEqual(['eslint-config-prettier']);
    expect(hinted.unusedDevDependencies).toEqual([]);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('reuses the Step 57 matcher instead of duplicating its tables', async () => {
    const root = fixturePath('plugins-react');
    const declared = new Set(['eslint-plugin-react']);

    // The same document, in both shapes, must resolve to the same package set.
    expect(await findEslintRcJsonUsage(root)).toEqual(
      findEslintConfigUsage({ plugins: ['react'] }, declared),
    );
  });

  it('never guesses a package for an unknown plugin or unsupported extends value', async () => {
    const root = fixturePath('unknown-plugin-negative');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted).toEqual(baseline);
    expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-jsx-plus', 'eslint-plugin-vue']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('reads nothing but extends/plugins, ignoring overrides and every unrelated field', async () => {
    const root = fixturePath('unknown-fields-negative');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    // `react`/`prettier`/`airbnb` appear only in `settings`, `globals`, `rules` and `overrides`,
    // none of which the bounded subset reads, so both declared packages stay unused.
    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-config-airbnb', 'eslint-plugin-react']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('changes nothing when the project has no .eslintrc.json', async () => {
    const root = fixturePath('no-eslintrc');

    expect(await findEslintRcJsonUsage(root)).toEqual(new Set<string>());
    expect(await analyzeProject(root, { configUsedNames: new Set<string>() })).toEqual(
      await analyzeProject(root),
    );
  });

  it('treats valid JSON that is not a configuration object as no evidence, not as an error', async () => {
    const root = fixturePath('not-object-json');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
  });

  it('fails with an operational error for malformed JSON instead of assuming no usage', async () => {
    const root = fixturePath('malformed-json');

    // Swallowing an unreadable configuration would let the declared package be reported as unused
    // based on a file DepVitals could not read, so the failure is surfaced instead.
    await expect(findEslintRcJsonUsage(root)).rejects.toMatchObject({
      name: 'EslintRcJsonError',
      code: 'invalid-json',
    });

    const error = await findEslintRcJsonUsage(root).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(EslintRcJsonError);
    expect((error as EslintRcJsonError).code).toBe('invalid-json');
    expect((error as Error).message).toContain('.eslintrc.json');
    expect((error as Error).message).toContain('is not valid JSON');
    expect((error as Error).message).toContain(root);
  });

  it('reads a .eslintrc.json saved with a leading UTF-8 byte order mark', async () => {
    // A byte order mark is an encoding artifact of the same JSON document (common from Windows
    // editors), so it must not turn a readable configuration into a failed scan.
    await withScratchProject(
      {
        'package.json': MANIFEST_DECLARING_REACT,
        '.eslintrc.json': `\uFEFF${ESLINTRC_DECLARING_REACT}`,
      },
      async (root) => {
        expect(await findEslintRcJsonUsage(root)).toEqual(new Set(['eslint-plugin-react']));
      },
    );
  });

  it('fails on a commented .eslintrc.json instead of parsing a second JSON dialect', async () => {
    const root = fixturePath('commented-json-negative');

    // Documented limitation: ESLint's legacy loader strips comments, but DepVitals reads one strict
    // JSON document in this release. The file fails loudly rather than inventing evidence through a
    // hand-written comment stripper or letting `eslint-plugin-react` look unused.
    await expect(findEslintRcJsonUsage(root)).rejects.toThrow(EslintRcJsonError);

    const error = await findEslintRcJsonUsage(root).catch((thrown: unknown) => thrown);

    expect((error as EslintRcJsonError).code).toBe('invalid-json');
    expect((error as Error).message).toContain('is not valid JSON');
    expect((error as Error).message).toContain('JavaScript-style comments');
  });

  it('defers to package.json#eslintConfig instead of unioning the two legacy sources', async () => {
    const root = fixturePath('manifest-precedence');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    // The external `plugins: ["react"]` entry is shadowed by the manifest block, so the external
    // reader contributes nothing at all - not even a hint for the package the manifest credits.
    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-config-airbnb', 'eslint-plugin-react']);
    expect(hinted.missingDependencies).toEqual([]);

    // Across both legacy readers exactly one source is active, so the merged hint set the CLI hands
    // to the analyzer never combines contradictory configuration.
    expect(
      new Set<string>([
        ...(await findEslintManifestUsage(root)),
        ...(await findEslintRcJsonUsage(root)),
      ]),
    ).toEqual(new Set(['eslint-config-airbnb']));
  });

  it('lets any eslintConfig key shadow the external file, including an explicit null', async () => {
    const root = fixturePath('eslintconfig-null-negative');

    // A manifest that mentions `eslintConfig` owns the legacy configuration, whatever its value.
    // Treating `null` as absent would credit `eslint-plugin-react` from a file ESLint may ignore.
    expect(await findEslintRcJsonUsage(root)).toEqual(new Set<string>());
  });

  it('skips the external file when a modern root flat config exists', async () => {
    const root = fixturePath('flat-config-precedence');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const hinted = await analyzeProject(root, { configUsedNames });

    expect(configUsedNames).toEqual(new Set<string>());
    expect(hinted.unusedDevDependencies).toEqual(['eslint-config-prettier']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('leaves root eslint.config.js imports to ordinary source detection', async () => {
    const root = fixturePath('flat-config-source-import');
    const configUsedNames = await findEslintRcJsonUsage(root);

    const baseline = await analyzeProject(root);
    const hinted = await analyzeProject(root, { configUsedNames });

    // The flat config contributes no config hint; its static import of `@eslint/js` is already
    // source evidence in v0.1.0, while the legacy-only `eslint-plugin-react` stays unused.
    expect(configUsedNames).toEqual(new Set<string>());
    expect(baseline.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
    expect(hinted.missingDependencies).toEqual([]);
  });

  it('never reports a missing finding for a configuration name that is not declared', async () => {
    const root = fixturePath('undeclared-no-missing');

    // Nothing is declared under the ESLint names, so the reader produces nothing and the analyzer
    // has nothing to report: an `extends`/`plugins` string is not source evidence.
    expect(await findEslintRcJsonUsage(root)).toEqual(new Set<string>());
    expect(await analyzeProject(root)).toEqual({
      projectRoot: root,
      unusedDependencies: ['left-pad'],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
  });

  it('reads a target project that lives outside the DepVitals repository', async () => {
    await withScratchProject(
      {
        'package.json': MANIFEST_DECLARING_REACT,
        '.eslintrc.json': ESLINTRC_DECLARING_REACT,
      },
      async (root) => {
        expect(root).not.toContain(join('Projects', 'depvitals'));

        const configUsedNames = await findEslintRcJsonUsage(root);
        const baseline = await analyzeProject(root);
        const hinted = await analyzeProject(root, { configUsedNames });

        expect(configUsedNames).toEqual(new Set(['eslint-plugin-react']));
        expect(baseline.unusedDevDependencies).toEqual(['eslint-plugin-react']);
        expect(hinted.unusedDevDependencies).toEqual([]);
        expect(hinted.missingDependencies).toEqual([]);
      },
    );
  });

  it('dismisses every other legacy ESLint format instead of reading it', async () => {
    // Only the JSON file is a data source in this release. A JavaScript, YAML or extensionless
    // legacy config is never opened, so it can contribute no evidence at all.
    await withScratchProject(
      {
        'package.json': MANIFEST_DECLARING_REACT,
        '.eslintrc.js': 'module.exports = { plugins: ["react"] };\n',
        '.eslintrc.yml': 'plugins:\n  - react\n',
        '.eslintrc': '{ "plugins": ["react"] }\n',
      },
      async (root) => {
        const configUsedNames = await findEslintRcJsonUsage(root);
        const hinted = await analyzeProject(root, { configUsedNames });

        expect(configUsedNames).toEqual(new Set<string>());
        expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
        expect(hinted.missingDependencies).toEqual([]);
      },
    );
  });

  it('does not follow a symlinked .eslintrc.json that points outside the project root', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'depvitals-eslintrc-symlink-'));

    try {
      const root = join(sandbox, 'project');
      const outside = join(sandbox, 'outside-config.json');

      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'package.json'), MANIFEST_DECLARING_REACT, 'utf8');
      await writeFile(outside, ESLINTRC_DECLARING_REACT, 'utf8');

      // Creating a symlink can fail on a permission-restricted filesystem (e.g. Windows without
      // privileges); there is nothing to assert in that case, so the check is skipped.
      let linksCreated = true;

      try {
        await symlink(outside, join(root, '.eslintrc.json'), 'file');
      } catch {
        linksCreated = false;
      }

      const configUsedNames = await findEslintRcJsonUsage(root);
      const hinted = await analyzeProject(root, { configUsedNames });

      // A link is not a regular file, so it is skipped instead of read: no evidence, and no error.
      expect(configUsedNames).toEqual(new Set<string>());
      expect(hinted.unusedDevDependencies).toEqual(['eslint-plugin-react']);
      expect(hinted.missingDependencies).toEqual([]);

      if (linksCreated) {
        // Prove the check above was meaningful: the link is in place and does resolve to a
        // `plugins: ["react"]` document, which DepVitals declined to read.
        expect(await readFile(join(root, '.eslintrc.json'), 'utf8')).toContain('"react"');
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  it('leaves the analyzed project untouched', async () => {
    const eslintRcJson = '{"extends":["prettier"]}\n';

    await withScratchProject(
      {
        'package.json': MANIFEST_DECLARING_REACT,
        '.eslintrc.json': eslintRcJson,
      },
      async (root) => {
        await findEslintRcJsonUsage(root);

        expect(await readFile(join(root, '.eslintrc.json'), 'utf8')).toBe(eslintRcJson);
        expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(MANIFEST_DECLARING_REACT);
      },
    );
  });
});

describe('CLI scan wiring for external .eslintrc.json hints', () => {
  const OPTIONS = { version: '0.0.0-test', cwd: tmpdir() };

  it('reports a config-only used dependency as clean', async () => {
    const result = await runCli([fixturePath('extends-prettier')], OPTIONS);

    expect(result).toEqual({
      exitCode: 0,
      stdout: 'DepVitals\n\nNo dependency issues found.\n',
      stderr: '',
    });
  });

  it('keeps reporting the package that only the shadowed external file names', async () => {
    const result = await runCli([fixturePath('manifest-precedence')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('eslint-plugin-react');
    expect(result.stdout).not.toContain('eslint-config-airbnb');
    expect(result.stderr).toBe('');
  });

  it('still reports the package when a root flat config disables legacy hints', async () => {
    const result = await runCli([fixturePath('flat-config-precedence')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('eslint-config-prettier');
    expect(result.stderr).toBe('');
  });

  it('fails with exit 1 and an empty stdout for a malformed .eslintrc.json', async () => {
    const result = await runCli([fixturePath('malformed-json')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('.eslintrc.json');
    expect(result.stderr).toContain('is not valid JSON');
  });

  it('fails with exit 1 and an empty stdout for a commented .eslintrc.json', async () => {
    const result = await runCli([fixturePath('commented-json-negative')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('is not valid JSON');
    expect(result.stderr).toContain('JavaScript-style comments');
  });

  it('changes nothing for a project without an .eslintrc.json', async () => {
    const result = await runCli([fixturePath('no-eslintrc')], OPTIONS);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Unused devDependencies (1)');
    expect(result.stdout).toContain('eslint-plugin-react');
    expect(result.stderr).toBe('');
  });
});
