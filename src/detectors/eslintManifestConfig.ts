/**
 * Legacy `package.json#eslintConfig` usage detection.
 *
 * This module answers exactly one narrow question: which declared dependencies are referenced by a
 * small, explicitly enumerated subset of the legacy ESLint configuration block stored inside
 * `package.json`? The result is a set of configuration-only package names that is handed to the
 * Step 56 analyzer seam, so a recognized name can only suppress an `unused` finding and can never
 * create a `missing` one.
 *
 * It deliberately does not:
 * - evaluate, `import()`, `require()` or otherwise run ESLint, a config loader or any target code;
 * - implement the ESLint configuration schema. Only `extends` and `plugins` are read, and only
 *   through the fixed allowlists below;
 * - resolve `overrides`, scoped plugin shorthands, `plugin:<name>/<config>` forms other than the one
 *   allowlisted string, shareable-config subpaths, or external `.eslintrc.*` files, which are read
 *   by the sibling `findEslintRcJsonUsage` reader instead of duplicating these tables;
 * - guess a package from arbitrary configuration text, substring-match a value, or invent a name;
 * - report anything about a package the manifest does not declare;
 * - mutate the analyzed project.
 *
 * The manifest model intentionally does not carry `eslintConfig`, so `package.json` is read a second
 * time here as plain text: the loader is reused as the validity gate, and one extra small read beats
 * widening the manifest model for one detector. Every unusable shape is ignored rather than
 * diagnosed: manifest validity stays with the manifest loader and the analyzer, which report a
 * genuinely invalid `package.json` as they always have.
 *
 * A conservative precedence guard applies before anything is read: when a hard barrier (a modern
 * flat-config entrypoint, or a legacy `.eslintrc.js`/`.cjs`/`.yaml`/`.yml`) exists at the project
 * root, the legacy block is not provably the active configuration, so no legacy hints are produced
 * from either source. Presence is checked by directory entry name only; no entry is read,
 * interpreted or executed. The precedence is computed once by {@link readLegacyEslintPrecedence},
 * shared by both legacy readers, so the two sources obey exactly one set of rules.
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  loadProjectManifest,
  ProjectManifestError,
  readManifestText,
} from '../scanner/projectManifest.js';
import { assertReadableRoot, SourceFilesError } from '../scanner/sourceFiles.js';

/**
 * The legacy `extends` values recognized by this release and the package each one refers to.
 *
 * The table is a fixed allowlist, not a resolution algorithm. It contains the three documented
 * shorthand aliases (`prettier`, `airbnb` and the single `plugin:react/recommended` form) plus the
 * already complete package name of each shareable config they point at, because a complete
 * `eslint-config-*` name is a valid `extends` value in its own right.
 *
 * There is deliberately no plugin package name in this table. Legacy ESLint resolves `extends` as a
 * shareable config name, so `extends: "eslint-plugin-react"` refers to a package named
 * `eslint-config-eslint-plugin-react`, not to `eslint-plugin-react`; the only valid `extends` form
 * for a plugin is `plugin:<name>/<config>`. A plugin is therefore credited through
 * {@link PLUGIN_PACKAGE_NAMES} (or through an allowlisted `plugin:` form), never through a bare
 * plugin name in `extends`, which would suppress a real `unused` finding based on a value ESLint
 * cannot load.
 *
 * Anything else is unsupported on purpose: `eslint:recommended`, `eslint:all`,
 * `plugin:other/recommended`, `prettier/react`, a scoped config, an unknown alias or any other
 * string contributes no evidence, because a guessed alias would create false confidence.
 */
const EXTENDS_PACKAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['prettier', 'eslint-config-prettier'],
  ['airbnb', 'eslint-config-airbnb'],
  ['plugin:react/recommended', 'eslint-plugin-react'],
  ['eslint-config-prettier', 'eslint-config-prettier'],
  ['eslint-config-airbnb', 'eslint-config-airbnb'],
]);

/**
 * The legacy `plugins` entries recognized by this release and the package each one refers to.
 *
 * Same rule as {@link EXTENDS_PACKAGE_NAMES}: only the documented `react` shorthand and the already
 * complete package name are supported. Invented plugin names, scoped shorthands such as
 * `@acme/eslint-plugin` and any other plugin string produce no evidence.
 *
 * `plugins` is where the complete `eslint-plugin-react` name is valid, unlike in `extends` (see
 * {@link EXTENDS_PACKAGE_NAMES}).
 */
const PLUGIN_PACKAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['react', 'eslint-plugin-react'],
  ['eslint-plugin-react', 'eslint-plugin-react'],
]);

/**
 * Modern flat-config entrypoint names that form a hard barrier: their presence disables every legacy
 * ESLint hint, from both `package.json#eslintConfig` and `.eslintrc.json`.
 *
 * Compared case-insensitively (see {@link readLegacyEslintPrecedence}) because case-insensitive
 * filesystems treat `ESLint.Config.js` as the same file, so DepVitals must not disagree with itself
 * about one project on different platforms. Added in Step 68.1: `mts`/`cts` join the original four.
 */
const FLAT_CONFIG_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
]);

/**
 * Legacy `.eslintrc.*` names that form a hard barrier for every legacy hint, same rule as the flat
 * configs: `.eslintrc.js`, `.eslintrc.cjs`, `.eslintrc.yaml` and `.eslintrc.yml`.
 *
 * Legacy ESLint ignores `package.json#eslintConfig` once any `.eslintrc.*` file exists by name, so
 * these names disable the manifest block too. Compared case-insensitively, like the flat configs.
 */
const LEGACY_BARRIER_ENTRY_NAMES: ReadonlySet<string> = new Set([
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yaml',
  '.eslintrc.yml',
]);

/**
 * Legacy `.eslintrc` names whose presence displaces the manifest block but does not by itself disable
 * the `.eslintrc.json` reader: the extensionless `.eslintrc` and `.eslintrc.json` itself.
 *
 * Legacy ESLint ignores the manifest block once any `.eslintrc.*` file exists by name, so the
 * extensionless `.eslintrc` displaces only the manifest block. `.eslintrc.json` is the file the JSON
 * reader actually reads, so it is listed here as a pure name check for the manifest block. Compared
 * case-insensitively, like the other legacy tables.
 */
const LEGACY_RC_BY_NAME_ENTRY_NAMES: ReadonlySet<string> = new Set(['.eslintrc.json', '.eslintrc']);

/**
 * The legacy ESLint precedence state for one project root, computed once by both readers so the two
 * legacy sources obey exactly one set of rules.
 *
 * - `hardBarrier`: a flat config or `.eslintrc.js`/`.cjs`/`.yaml`/`.yml` exists, which disables every
 *   legacy hint from both sources;
 * - `legacyRcByName`: a legacy `.eslintrc.json` or extensionless `.eslintrc` exists by name, which
 *   displaces the manifest block but does not by itself stop the `.eslintrc.json` reader.
 *
 * Presence is checked by directory entry name only; no entry is opened, stat-followed, read or
 * executed, and an unreadable root simply means no barrier is known to exist.
 */
export type LegacyEslintPrecedence = {
  readonly hardBarrier: boolean;
  readonly legacyRcByName: boolean;
  readonly legacyRcJsonEntryName: string | undefined;
};

/**
 * Compute the legacy ESLint precedence state for the project rooted at `projectRoot`.
 *
 * The two legacy readers ({@link findEslintManifestUsage} and {@link findEslintRcJsonUsage}) share
 * this so a hard barrier disables both, `.eslintrc.json` wins over the manifest block, and an
 * extensionless `.eslintrc` displaces only the manifest block. Neither reader unions the displaced
 * source, so two contradictory legacy configurations are never combined.
 *
 * The legacy `.eslintrc.json` name is resolved case-insensitively, so the matched directory entry
 * name is returned as `legacyRcJsonEntryName` for the JSON reader to reuse.
 *
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 */
export async function readLegacyEslintPrecedence(
  projectRoot: string,
): Promise<LegacyEslintPrecedence> {
  const root = resolve(projectRoot);

  let entries: string[];
  try {
    await assertReadableRoot(root);
    entries = await readdir(root);
  } catch {
    return {
      hardBarrier: false,
      legacyRcByName: false,
      legacyRcJsonEntryName: undefined,
    };
  }

  const has = (names: ReadonlySet<string>): boolean =>
    entries.some((entry) => names.has(entry.toLowerCase()));
  // The legacy `.eslintrc.json` name is matched case-insensitively (Windows/macOS resolve the
  // same file under a different casing), so remember the actual entry that was found. The JSON
  // reader reuses this exact entry name instead of assuming the canonical lowercase spelling.
  // Prefer the canonical lowercase entry when both it and an uppercase copy exist in a
  // case-sensitive root, so directory order cannot make the reader open the wrong file.
  const legacyRcJsonEntryName = entries.includes('.eslintrc.json')
    ? '.eslintrc.json'
    : entries.find((entry) => entry.toLowerCase() === '.eslintrc.json');

  return {
    hardBarrier: has(FLAT_CONFIG_ENTRY_NAMES) || has(LEGACY_BARRIER_ENTRY_NAMES),
    legacyRcByName: has(LEGACY_RC_BY_NAME_ENTRY_NAMES),
    legacyRcJsonEntryName,
  };
}

/**
 * Match the allowlisted subset of one legacy `eslintConfig` value against the declared packages.
 *
 * Pure and side-effect free: it takes the raw `eslintConfig` JSON value (any shape, including
 * something that is not an object) and the declared dependency names, and returns the declared
 * packages that have configuration-only evidence, in alphabetical order. Neither argument is
 * mutated, and a candidate that is not declared is dropped, so this function can never describe an
 * undeclared package as used.
 *
 * @param eslintConfig - The raw `package.json#eslintConfig` value, validated here and never trusted.
 * @param declaredPackageNames - Declared dependency names, the only names this may return.
 */
export function findEslintConfigUsage(
  eslintConfig: unknown,
  declaredPackageNames: ReadonlySet<string>,
): ReadonlySet<string> {
  if (!isPlainRecord(eslintConfig)) {
    return new Set<string>();
  }

  const candidates: string[] = [
    ...matchTable(extendsValues(eslintConfig['extends']), EXTENDS_PACKAGE_NAMES),
    ...matchTable(pluginsValues(eslintConfig['plugins']), PLUGIN_PACKAGE_NAMES),
  ];

  const used = new Set<string>();

  for (const candidate of candidates) {
    if (declaredPackageNames.has(candidate)) {
      used.add(candidate);
    }
  }

  // Rebuilt from sorted names so iteration is deterministic for every input.
  return new Set<string>([...used].sort(compareNames));
}

/**
 * Collect the legacy `package.json#eslintConfig` hints for the project rooted at `projectRoot`.
 *
 * The returned set is shaped for the analyzer's `configUsedNames` option (the Step 56 handoff),
 * which is the only way configuration evidence reaches the analyzer. Nothing is decided here: the
 * analyzer stays the sole owner of the unused/missing categories.
 *
 * No configuration problem is reported as an error. A missing manifest, an unreadable or invalid
 * `package.json`, an unusable `eslintConfig` shape or an unreadable root all yield the empty set;
 * the analyzer loads the manifest itself and remains the component that reports manifest failures,
 * so this detector never replaces or duplicates that diagnosis.
 *
 * Legacy precedence (Step 68.1) is delegated to {@link readLegacyEslintPrecedence}, which both
 * legacy readers share: a hard barrier disables this block outright, and any legacy `.eslintrc.*`
 * by name displaces it in favour of the lower-priority `.eslintrc.json` reader. This reader never
 * unions the displaced source, so the two legacy configurations are never combined.
 *
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 */
export async function findEslintManifestUsage(projectRoot: string): Promise<ReadonlySet<string>> {
  const root = resolve(projectRoot);

  const precedence = await readLegacyEslintPrecedence(root);
  if (precedence.hardBarrier || precedence.legacyRcByName) {
    return new Set<string>();
  }

  let packageJsonPath: string;
  let declaredPackageNames: ReadonlySet<string>;

  try {
    const manifest = await loadProjectManifest(root);
    packageJsonPath = manifest.packageJsonPath;
    declaredPackageNames = manifest.declaredDependencyNames;
  } catch (error) {
    if (error instanceof ProjectManifestError || error instanceof SourceFilesError) {
      return new Set<string>();
    }

    throw error;
  }

  return findEslintConfigUsage(await readEslintConfigValue(packageJsonPath), declaredPackageNames);
}

/**
 * Whether the on-disk directory entries contain a modern flat-config entrypoint (see
 * {@link FLAT_CONFIG_ENTRY_NAMES}).
 *
 * A legacy `.eslintrc.*` file is not a flat-config entrypoint, so this predicate checks only the
 * flat-config names.
 */
function hasFlatConfigEntryEntries(entries: readonly string[]): boolean {
  return entries.some((entry) => FLAT_CONFIG_ENTRY_NAMES.has(entry.toLowerCase()));
}

/**
 * Whether the project rooted at `projectRoot` contains a modern flat-config entrypoint (see
 * {@link FLAT_CONFIG_ENTRY_NAMES}).
 *
 * A flat config is a hard barrier: its presence disables every legacy hint, including the
 * `package.json#eslintConfig` block, so it is checked before any legacy reader contributes a hint.
 * This is a thin convenience for callers that only need the flat-config question. Only flat-config
 * entrypoints count: a legacy `.eslintrc.*` file reports `false`, even though it still participates
 * in the hard-barrier check inside the legacy readers.
 *
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 */
export async function hasFlatConfigEntry(projectRoot: string): Promise<boolean> {
  let entries: string[];
  try {
    await assertReadableRoot(resolve(projectRoot));
    entries = await readdir(resolve(projectRoot));
  } catch {
    return false;
  }

  return hasFlatConfigEntryEntries(entries);
}

/**
 * Read the raw `package.json#eslintConfig` value, ignoring everything that cannot be used.
 *
 * The manifest is read as text and parsed with `JSON.parse`, so no target-project code runs. An
 * unreadable file, invalid JSON, a non-object document or an absent `eslintConfig` all yield
 * `undefined`; the loader-facing diagnosis of a broken manifest stays in {@link loadProjectManifest}.
 */
async function readEslintConfigValue(packageJsonPath: string): Promise<unknown> {
  let text: string;

  try {
    text = await readManifestText(packageJsonPath);
  } catch {
    return undefined;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  return isPlainRecord(parsed) ? parsed['eslintConfig'] : undefined;
}

/**
 * The string values of `extends`, which ESLint accepts as one string or as an array.
 *
 * Non-string array entries contribute nothing on their own, so a malformed array still yields no
 * evidence for the malformed entries. Any other shape (number, object, `null`, ...) contributes
 * nothing at all.
 */
function extendsValues(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }

  return stringItems(value);
}

/**
 * The string values of `plugins`, which ESLint accepts only as an array.
 *
 * A bare string such as `"react"` is not a valid `plugins` value and is deliberately not accepted,
 * so a typo-shaped value never becomes evidence.
 */
function pluginsValues(value: unknown): readonly string[] {
  return stringItems(value);
}

/**
 * The string entries of an array value; a non-array value contributes nothing.
 */
function stringItems(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Look every value up in one fixed allowlist table.
 *
 * Lookup is exact-string only: no prefix, suffix, substring or case-insensitive matching, so
 * `prettier/react`, `eslint-config-unknown` and `React` never match an entry.
 */
function matchTable(
  values: readonly string[],
  table: ReadonlyMap<string, string>,
): readonly string[] {
  const matched: string[] = [];

  for (const value of values) {
    const mapped = table.get(value);

    if (mapped !== undefined) {
      matched.push(mapped);
    }
  }

  return matched;
}

/**
 * A JSON object (not an array, not `null`) whose keys are strings.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locale-independent lexicographic ordering, so the same configuration always yields the same order.
 */
function compareNames(a: string, b: string): number {
  if (a < b) {
    return -1;
  }

  if (a > b) {
    return 1;
  }

  return 0;
}
