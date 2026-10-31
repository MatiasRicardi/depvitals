/**
 * Step 62: cross-detector integration gate for the analysis path.
 *
 * This file integrates the two evidence families built before it and proves they compose without
 * changing any contract:
 *
 * - binary evidence (Steps 23-55), produced by `findPackageScriptUsage` inside the analyzer;
 * - configuration evidence (Steps 56-61), produced by the three legacy config readers and handed to
 *   `analyzeProject` through the `configUsedNames` seam.
 *
 * The configuration readers are wired into the product only by `collectConfigUsedNames` in
 * `src/cli/runCli.ts`, so this file composes them the same way (see {@link collectConfigHints}) and
 * `test/cliGate.test.ts` proves the CLI produces exactly the same result. That keeps the gate at the
 * analyzer boundary while still exercising every detector at once.
 *
 * Asserted properties:
 * - one project combining a source import, a `tsc` script, a `docsify` script, `package.json#eslintConfig`
 *   and `package.json#jest` (plus a sibling fixture that swaps in the external `.eslintrc.json`)
 *   credits exactly the packages that have real evidence, once each and in alphabetical order;
 * - `dependencies`/`devDependencies` keep the v0.1.0 unused classification and `peerDependencies`/
 *   `optionalDependencies` keep suppressing missing without ever being reported as unused;
 * - an undeclared source import stays missing however many script or configuration names the same
 *   project contains, and script/configuration names alone never create a missing finding;
 * - a workspace child manifest and lockfile/package-manager metadata are outside the scanned
 *   project boundary and contribute no evidence in either direction;
 * - the analysis path can reach neither the network nor a process/eval primitive, and the source
 *   surface stays closed to unrequested modules; notifier helpers and the disconnected Step 87
 *   JSON shape reader are explicitly allowlisted without changing the CLI or result surface;
 * - the analysis result gained no new finding category and `src/index.ts` gained no public entry point.
 *
 * Everything is static and offline: fixtures are read as text, no analyzed project code, script,
 * configuration module or lifecycle hook is executed, nothing is installed or resolved, and no
 * network access happens.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as bootstrap from '../../../src/index.js';
import { analyzeProject, type AnalysisResult } from '../../../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../../../src/detectors/eslintManifestConfig.js';
import { findEslintRcJsonUsage } from '../../../src/detectors/eslintRcJsonConfig.js';
import { findJestManifestUsage } from '../../../src/detectors/jestManifestConfig.js';
import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';

const FIXTURES = fileURLToPath(
  new URL('../../fixtures/analysis/integration-gate/', import.meta.url),
);

/**
 * The source tree, anchored to this file instead of the invocation directory, so the source-surface
 * probes work no matter where Vitest was started from.
 */
const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Absolute path to a committed Step 62 gate fixture. */
function gateFixture(name: string): string {
  return resolve(join(FIXTURES, name));
}

/**
 * The configuration hints of one project, merged exactly like `src/cli/runCli.ts` does.
 *
 * The three readers carry their own precedence guards (`package.json#eslintConfig` versus
 * `.eslintrc.json` versus a root flat config, and `package.json#jest` versus a root `jest.config.*`),
 * so their union is the full configuration evidence of the project.
 */
async function collectConfigHints(root: string): Promise<ReadonlySet<string>> {
  return new Set<string>([
    ...(await findEslintManifestUsage(root)),
    ...(await findEslintRcJsonUsage(root)),
    ...(await findJestManifestUsage(root)),
  ]);
}

/** Snapshot of every file path and content under a project root, for non-mutation assertions. */
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

/** The raw declared groups of a fixture manifest, read as text so the test owns no model. */
function declaredGroups(root: string): Record<'peer' | 'optional', readonly string[]> {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };

  return {
    peer: Object.keys(manifest.peerDependencies ?? {}).sort(),
    optional: Object.keys(manifest.optionalDependencies ?? {}).sort(),
  };
}

/** Serialize a result so ordering, and not only membership, is compared. */
function asText(result: AnalysisResult): string {
  return JSON.stringify(result);
}

function isSorted(values: readonly string[]): boolean {
  return values.toSorted().every((value, index) => values[index] === value);
}

const ALL_SOURCES = 'composed-all-sources';
const NEGATIVES = 'composed-negatives';
const RC_AND_JEST = 'composed-rc-and-jest';
const ALIASES = 'composed-aliases-and-collisions';
const BOUNDARY = 'project-boundary';

const ALL_SOURCES_HINTS = await collectConfigHints(gateFixture(ALL_SOURCES));
const NEGATIVES_HINTS = await collectConfigHints(gateFixture(NEGATIVES));
const RC_AND_JEST_HINTS = await collectConfigHints(gateFixture(RC_AND_JEST));
const ALIASES_HINTS = await collectConfigHints(gateFixture(ALIASES));
const BOUNDARY_HINTS = await collectConfigHints(gateFixture(BOUNDARY));

const ALL_SOURCES_RESULT = await analyzeProject(gateFixture(ALL_SOURCES), {
  configUsedNames: ALL_SOURCES_HINTS,
});
const NEGATIVES_RESULT = await analyzeProject(gateFixture(NEGATIVES), {
  configUsedNames: NEGATIVES_HINTS,
});
const RC_AND_JEST_RESULT = await analyzeProject(gateFixture(RC_AND_JEST), {
  configUsedNames: RC_AND_JEST_HINTS,
});
const ALIASES_RESULT = await analyzeProject(gateFixture(ALIASES), {
  configUsedNames: ALIASES_HINTS,
});
const BOUNDARY_RESULT = await analyzeProject(gateFixture(BOUNDARY), {
  configUsedNames: BOUNDARY_HINTS,
});

/** Every gate fixture with its configuration hints, for the shared structural assertions. */
const FIXTURE_CASES: readonly (readonly [string, string, AnalysisResult])[] = [
  [ALL_SOURCES, gateFixture(ALL_SOURCES), ALL_SOURCES_RESULT],
  [NEGATIVES, gateFixture(NEGATIVES), NEGATIVES_RESULT],
  [RC_AND_JEST, gateFixture(RC_AND_JEST), RC_AND_JEST_RESULT],
  [ALIASES, gateFixture(ALIASES), ALIASES_RESULT],
  [BOUNDARY, gateFixture(BOUNDARY), BOUNDARY_RESULT],
];

describe('Step 62: one project combining every evidence channel', () => {
  it('keeps every composition field live in one project', () => {
    // Six fields must be exercised together, not pairwise: `scripts`, `dependencies`,
    // `devDependencies` (the declared set the config readers are filtered against),
    // `package.json#eslintConfig`, `package.json#jest` and the external `.eslintrc.json`.
    const allSources = JSON.parse(
      readFileSync(join(gateFixture('composed-all-sources'), 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    const rcAndJest = JSON.parse(
      readFileSync(join(gateFixture('composed-rc-and-jest'), 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(allSources).sort()).toEqual([
      'dependencies',
      'devDependencies',
      'eslintConfig',
      'jest',
      'name',
      'optionalDependencies',
      'peerDependencies',
      'scripts',
      'version',
    ]);

    // The sibling fixture has no legacy block in its manifest, so its hints can only come from the
    // `.eslintrc.json` channel plus `package.json#jest`.
    expect(rcAndJest).not.toHaveProperty('eslintConfig');
    expect(rcAndJest).toHaveProperty('jest');
    expect(existsSync(join(gateFixture('composed-rc-and-jest'), '.eslintrc.json'))).toBe(true);
  });

  it('credits source, mapped binaries, both legacy ESLint sources and package.json#jest together', () => {
    expect([...ALL_SOURCES_HINTS]).toEqual([
      'eslint-config-prettier',
      'eslint-plugin-react',
      'jest-environment-jsdom',
      'ts-jest',
    ]);

    expect(ALL_SOURCES_RESULT.unusedDependencies).toEqual(['lodash']);
    expect(ALL_SOURCES_RESULT.unusedDevDependencies).toEqual(['echo-only']);
    expect(ALL_SOURCES_RESULT.missingDependencies).toEqual(['undeclared-pkg']);
  });

  it('classifies one package once when source and two configuration fields name it', () => {
    // `ts-jest` is a side-effect import, the Jest `preset` string and a `transform` value. It appears
    // in no finding array, and no array mentions it twice.
    expect(ALL_SOURCES_RESULT.unusedDependencies).not.toContain('ts-jest');
    expect(ALL_SOURCES_RESULT.unusedDevDependencies).not.toContain('ts-jest');
    expect(ALL_SOURCES_RESULT.missingDependencies).not.toContain('ts-jest');
    expect([...ALL_SOURCES_HINTS].filter((name) => name === 'ts-jest')).toHaveLength(1);

    for (const values of [
      ALL_SOURCES_RESULT.unusedDependencies,
      ALL_SOURCES_RESULT.unusedDevDependencies,
      ALL_SOURCES_RESULT.missingDependencies,
    ]) {
      expect(values).toEqual([...new Set(values)]);
    }
  });

  it('keeps a script-only named tool unused when it appears only as an argument', () => {
    // `echo-only` is declared but never runs in a command position; the `jest --preset ts-jest ...`
    // and `echo tsc docsify ...` scripts name it as an argument only.
    expect(ALL_SOURCES_RESULT.unusedDevDependencies).toEqual(['echo-only']);
  });

  it('never turns an undeclared configuration name into a missing finding', () => {
    // `extends: ["airbnb"]` is outside the small explicit ESLint alias set, so the detector never
    // proposes `eslint-config-airbnb` at all: no hint, therefore no finding of any kind.
    expect(ALL_SOURCES_HINTS).not.toContain('eslint-config-airbnb');
    expect(ALL_SOURCES_RESULT.missingDependencies).toEqual(['undeclared-pkg']);
    expect(ALL_SOURCES_RESULT.unusedDependencies).not.toContain('eslint-config-airbnb');
  });

  it('reports the undeclared source import as missing next to every other evidence channel', () => {
    // Same project: `undeclared-pkg` is imported by source only, so it is the single missing entry
    // even though scripts and configuration name several other packages.
    expect(ALL_SOURCES_RESULT.missingDependencies).toHaveLength(1);
    expect(ALL_SOURCES_RESULT.missingDependencies[0]).toBe('undeclared-pkg');
  });
});

describe('Step 62: near-miss text in every channel stays inert', () => {
  it('produces no configuration hint at all', () => {
    // `extends: ["ts-jest"]`, `plugins: ["ts-jest"]`, `settings.jest`, `displayName`, the transform
    // *key*, the `jsdom` shorthand, `setupFiles`, `plugin:other/recommended` and a scoped plugin are
    // all outside the supported subsets.
    expect([...NEGATIVES_HINTS]).toEqual([]);
  });

  it('reports every declared package as unused when names appear only as arguments, strings or unsupported config text', () => {
    expect(NEGATIVES_RESULT.unusedDependencies).toEqual([
      'eslint-config-prettier',
      'eslint-plugin-react',
      'jest-environment-jsdom',
      'react',
      'ts-jest',
      'zod',
    ]);
    expect(NEGATIVES_RESULT.unusedDevDependencies).toEqual([
      'docsify-cli',
      'eslint',
      'jest',
      'typescript',
    ]);
  });

  it('creates no missing finding from script or configuration names and import-like string literals', () => {
    // Scripts run `echo`/`printf`/`env`/`node -e`/`node ./run-jest.js` and name tools only as
    // arguments; the source file holds import-like text inside string literals only.
    expect(NEGATIVES_RESULT.missingDependencies).toEqual([]);
  });
});

describe('Step 62: the external .eslintrc.json channel composes with package.json#jest', () => {
  it('credits both legacy ESLint fields and the Jest preset in one scan', () => {
    expect([...RC_AND_JEST_HINTS]).toEqual([
      'eslint-config-airbnb',
      'eslint-plugin-react',
      'ts-jest',
    ]);

    expect(RC_AND_JEST_RESULT.unusedDependencies).toEqual(['unused-pkg']);
    expect(RC_AND_JEST_RESULT.unusedDevDependencies).toEqual([]);
    expect(RC_AND_JEST_RESULT.missingDependencies).toEqual(['undeclared-pkg']);
  });

  it('is not silenced by a jest.config.js that is only named as a script argument', () => {
    // The precedence guard looks for a root `jest.config.*` directory entry; `--config jest.config.js`
    // is an argument and creates no file, so the manifest hints survive.
    expect(readFileSync(join(gateFixture(RC_AND_JEST), 'package.json'), 'utf8')).toContain(
      '--config jest.config.js',
    );
    expect(RC_AND_JEST_HINTS).toContain('ts-jest');
  });

  it('keeps an undeclared script tool out of the missing list', () => {
    // `jest` and `echo eslint` run or name tools this project does not declare at all.
    expect(RC_AND_JEST_RESULT.missingDependencies).not.toContain('jest');
    expect(RC_AND_JEST_RESULT.missingDependencies).not.toContain('eslint');
  });
});

describe('Step 62: activated aliases and collisions compose with the source-missing invariant', () => {
  it('credits every activated alias of a multi-alias package once', () => {
    // `graphql-codegen` and `graphql-codegen-esm` are two verified aliases of one declared package.
    expect(ALIASES_RESULT.unusedDependencies).toEqual([]);
    expect(ALIASES_RESULT.missingDependencies).not.toContain('graphql-codegen');
    expect(ALIASES_RESULT.missingDependencies).not.toContain('graphql-codegen-esm');
  });

  it('credits declared packages from their own script commands without inferring arguments', () => {
    // `ng build`, `babel src -d dist`, `run-p lint test`, `dotenv -e .env -- node app.js`: the
    // executables are credited, the argument words (`lint`, `test`, `app.js`) are not packages.
    expect(ALIASES_RESULT.unusedDependencies).toEqual([]);
    expect(ALIASES_RESULT.missingDependencies).toEqual(['zod']);
  });

  it('keeps exact-name collision behavior and never suppresses both providers', () => {
    // `gulp build` credits `gulp`; the declared `gulp-cli` stays a finding.
    expect(ALIASES_RESULT.unusedDevDependencies).toContain('gulp-cli');
    expect(ALIASES_RESULT.unusedDevDependencies).not.toContain('gulp');
  });

  it('still reports an unrelated declared package and reports an undeclared source import as missing', () => {
    // `echo ng`, `node -e "ng babel"`, `printf 'webpack\n'` and `totally-unknown-tool --json` credit
    // nothing, so `unused-tool` remains reported and only the source import is missing. This is the
    // complete unused set: `webpack`/`tailwindcss` are credited only by the pre-existing exact-name
    // command rule, never by a speculative alias, and nothing else was invented for them.
    expect(ALIASES_RESULT.unusedDevDependencies).toEqual(['gulp-cli', 'unused-tool']);
    expect(ALIASES_RESULT.missingDependencies).toEqual(['zod']);
  });

  it('credits a package named by both source and a script exactly once', () => {
    // `playwright` is imported by source and run by the `e2e` script.
    expect(ALIASES_RESULT.unusedDevDependencies).not.toContain('playwright');
    expect(ALIASES_RESULT.missingDependencies).not.toContain('playwright');
    expect(ALIASES_RESULT.unusedDevDependencies).toEqual([
      ...new Set(ALIASES_RESULT.unusedDevDependencies),
    ]);
  });
});

describe('Step 62: v0.1.0 declaration groups hold across every gate fixture', () => {
  it.each(FIXTURE_CASES)(
    '%s reports only dependencies and devDependencies as unused',
    (_n, root, result) => {
      const groups = declaredGroups(root);

      for (const name of [...groups.peer, ...groups.optional]) {
        expect(result.unusedDependencies).not.toContain(name);
        expect(result.unusedDevDependencies).not.toContain(name);
      }
    },
  );

  it('suppresses missing for a peer declaration that source imports and ignores an untouched optional declaration', () => {
    // Fixture A imports `react-dom` (declared only as a peer) and never touches `fsevents`.
    expect(ALL_SOURCES_RESULT.missingDependencies).not.toContain('react-dom');
    expect(ALL_SOURCES_RESULT.unusedDependencies).not.toContain('react-dom');
    expect(ALL_SOURCES_RESULT.unusedDependencies).not.toContain('fsevents');
    expect(ALL_SOURCES_RESULT.missingDependencies).not.toContain('fsevents');
  });

  it.each(FIXTURE_CASES)(
    '%s reports every finding sorted and deduplicated',
    (_n, _root, result) => {
      const sections = [
        result.unusedDependencies,
        result.unusedDevDependencies,
        result.missingDependencies,
      ];

      for (const values of sections) {
        expect(isSorted(values)).toBe(true);
        expect(values).toEqual([...new Set(values)]);
      }
    },
  );

  it.each(FIXTURE_CASES)('%s is deterministic across repeated scans', async (_n, root) => {
    const hints = await collectConfigHints(root);
    const first = asText(await analyzeProject(root, { configUsedNames: hints }));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(asText(await analyzeProject(root, { configUsedNames: hints }))).toBe(first);
    }
  });

  it.each(FIXTURE_CASES)('%s is left byte-for-byte unchanged by the scan', async (_n, root) => {
    const before = snapshotProject(root);
    const hints = await collectConfigHints(root);

    expect(before.length).toBeGreaterThan(1);

    await analyzeProject(root, { configUsedNames: hints });

    expect(snapshotProject(root)).toEqual(before);
  });
});

describe('Step 62: workspace children and lockfiles stay outside the project boundary', () => {
  it('scans only the manifest of the project that was asked for', () => {
    // The root declares `workspaces` and `packageManager`, and three lockfiles exist, but the
    // analysis is a single project: `react` is unused and nothing from the child manifest appears.
    expect(BOUNDARY_RESULT.unusedDependencies).toEqual(['react']);
    expect(BOUNDARY_RESULT.unusedDevDependencies).toEqual([]);
    expect(BOUNDARY_RESULT.missingDependencies).toEqual([]);
  });

  it('never credits or invents a package from lockfile text', () => {
    // The synthetic lockfiles name `react` (declared and unused at the root) and `phantom-pkg`
    // (declared nowhere). Lockfile metadata is neither usage evidence nor missing evidence.
    expect(BOUNDARY_RESULT.unusedDependencies).toContain('react');
    expect(BOUNDARY_RESULT.missingDependencies).not.toContain('phantom-pkg');
  });

  it('reports the child as its own project when the child directory is scanned directly', async () => {
    const child = await analyzeProject(join(gateFixture(BOUNDARY), 'packages/child'));

    // Same directory, different project root: the child sees its own manifest and only its own.
    expect(child.unusedDependencies).toEqual(['child-only-dep']);
    expect(child.unusedDevDependencies).toEqual(['child-unused-dep']);
    expect(child.missingDependencies).toEqual([]);
    expect(BOUNDARY_RESULT.unusedDependencies).not.toContain('child-only-dep');
  });
});

describe('Step 62: the analysis path has no network or execution capability', () => {
  const ANALYSIS_DIRECTORIES = ['config', 'core', 'scanner', 'detectors', 'reporters'];

  /** Every module specifier of the analysis path, read with the production lexer. */
  const specifiers: readonly (readonly [string, string])[] = ANALYSIS_DIRECTORIES.flatMap(
    (directory) =>
      readdirSync(join(SRC, directory), { recursive: true }).map((entry) => {
        const absolute = join(SRC, directory, String(entry));
        const file = relative(SRC, absolute).split(/[\\/]/).join('/');
        return [file, readFileSync(absolute, 'utf8')] as const;
      }),
  ).flatMap(([file, content]) =>
    extractModuleSpecifiers(content).map((occurrence) => [file, occurrence.specifier] as const),
  );

  /** Builtins the analysis path may use: reading files, joining paths and the builtin-package test. */
  const ALLOWED_BUILTINS = new Set(['node:fs/promises', 'node:path', 'node:module']);

  it('imports no builtin other than the filesystem, path and module helpers', () => {
    const nonRelative = specifiers
      .filter(([, specifier]) => !specifier.startsWith('.'))
      .map(([, specifier]) => specifier);

    expect(nonRelative.length).toBeGreaterThan(0);
    for (const specifier of nonRelative) {
      expect(ALLOWED_BUILTINS.has(specifier)).toBe(true);
    }
  });

  it('mentions no network, process or eval primitive in the analysis path', () => {
    const forbidden = [
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:child_process',
      'node:worker_threads',
      'XMLHttpRequest',
      'WebSocket',
      'fetch(',
      'eval(',
      'new Function(',
    ];

    const offenders: string[] = [];

    for (const [file, content] of specifiers) {
      for (const token of forbidden) {
        if (content.includes(token)) {
          offenders.push(`${file}: ${token}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('pins the source surface, so no unrequested module exists yet', () => {
    // Separator-normalized so the pinned list is one POSIX-style list on Linux, macOS and Windows
    // (`readdirSync` reports `scanner\moduleSpecifiers.ts` on Windows).
    const modules = readdirSync(SRC, { recursive: true })
      .map((entry) => String(entry).split(/[\\/]/).join('/'))
      .filter((entry) => entry.endsWith('.ts'))
      .sort();

    // Steps 63-68 deliberately extend this list; anything else appearing here is feature creep.
    // Step 63 adds only the pure, I/O-free notifier comparison helper, Step 64 only the pure,
    // import-free notifier eligibility predicate, Step 65 only the private best-effort
    // update-version cache, Step 66 only the private bounded registry lookup, and Step 67 only the
    // notification orchestrator plus the stream-injecting entry layer that calls it after the report
    // (both - unlike the analysis path below - confined to src/cli/).
    // Step 87 adds only the disconnected internal JSON shape reader; its I/O imports are guarded too.
    expect(modules).toEqual([
      'cli/entry.ts',
      'cli/index.ts',
      'cli/notifier/eligibility.ts',
      'cli/notifier/registryLookup.ts',
      'cli/notifier/updateCache.ts',
      'cli/notifier/updateCheck.ts',
      'cli/notifier/versionCompare.ts',
      'cli/parseCliArgs.ts',
      'cli/runCli.ts',
      'config/readProjectConfig.ts',
      'core/analyzeProject.ts',
      'detectors/eslintManifestConfig.ts',
      'detectors/eslintRcJsonConfig.ts',
      'detectors/jestManifestConfig.ts',
      'index.ts',
      'reporters/terminalReporter.ts',
      'scanner/moduleSpecifiers.ts',
      'scanner/packageSpecifier.ts',
      'scanner/projectManifest.ts',
      'scanner/scriptUsage.ts',
      'scanner/sourceFiles.ts',
    ]);
  });
});

describe('Step 62: the frozen product surface gained no category and no entry point', () => {
  it.each(FIXTURE_CASES)(
    '%s exposes exactly the three v0.1.0 finding arrays plus the project root',
    (_n, _root, result) => {
      // No new finding category, no evidence payload, no confidence field, no review bucket.
      expect(Object.keys(result).sort()).toEqual([
        'missingDependencies',
        'projectRoot',
        'unusedDependencies',
        'unusedDevDependencies',
      ]);
    },
  );

  it('still exposes no programmatic entry point', () => {
    // `src/index.ts` remains an internal bootstrap module: none of the detection work is exported
    // as a public API, and no notifier surface exists yet.
    expect(Object.keys(bootstrap).sort()).toEqual(['packageName']);
  });

  it('added no runtime dependency for the detection work', () => {
    // The scanner stays dependency-free: 60 mapped executables and three config readers are all
    // static analysis over files, and Steps 63-68 must not smuggle a registry client in here.
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).toBeUndefined();
  });
});
