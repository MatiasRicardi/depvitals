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
 *   allowlisted string, shareable-config subpaths, or external `.eslintrc.*` files (Step 58);
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
 * A conservative precedence guard applies before anything is read: when a modern flat-config
 * entrypoint exists at the project root, the legacy block is not provably the active configuration,
 * so no legacy hints are produced. Presence is checked by directory entry name only; the flat config
 * itself is never read, interpreted or executed.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadProjectManifest, ProjectManifestError } from '../scanner/projectManifest.js';

/**
 * The legacy `extends` values recognized by this release and the package each one refers to.
 *
 * The table is a fixed allowlist, not a resolution algorithm. It contains the three documented
 * shorthand aliases (`prettier`, `airbnb` and the single `plugin:react/recommended` form) plus the
 * already complete package name of the package each alias points at, which is also a valid
 * `extends` value in ESLint. Anything else is unsupported on purpose: `eslint:recommended`,
 * `eslint:all`, `plugin:other/recommended`, `prettier/react`, a scoped config, an unknown alias or
 * any other string contributes no evidence, because a guessed alias would create false confidence.
 */
const EXTENDS_PACKAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['prettier', 'eslint-config-prettier'],
  ['airbnb', 'eslint-config-airbnb'],
  ['plugin:react/recommended', 'eslint-plugin-react'],
  ['eslint-config-prettier', 'eslint-config-prettier'],
  ['eslint-config-airbnb', 'eslint-config-airbnb'],
  ['eslint-plugin-react', 'eslint-plugin-react'],
]);

/**
 * The legacy `plugins` entries recognized by this release and the package each one refers to.
 *
 * Same rule as {@link EXTENDS_PACKAGE_NAMES}: only the documented `react` shorthand and the already
 * complete package name are supported. Invented plugin names, scoped shorthands such as
 * `@acme/eslint-plugin` and any other plugin string produce no evidence.
 */
const PLUGIN_PACKAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['react', 'eslint-plugin-react'],
  ['eslint-plugin-react', 'eslint-plugin-react'],
]);

/**
 * Modern flat-config entrypoint names that disable legacy `eslintConfig` hints.
 *
 * The list is fixed: `eslint.config.mts` / `eslint.config.cts` are not part of it, which only makes
 * the guard narrower (it can drop hints, never add them). Presence of any of these names at the
 * project root is enough; the entry itself is never read or executed.
 *
 * Compared case-insensitively (see {@link hasFlatConfigEntry}) because case-insensitive filesystems
 * treat `ESLint.Config.js` as the same file, and DepVitals must not disagree with itself about one
 * project depending on the platform it runs on.
 */
const FLAT_CONFIG_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
]);

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
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 */
export async function findEslintManifestUsage(projectRoot: string): Promise<ReadonlySet<string>> {
  const root = resolve(projectRoot);

  if (await hasFlatConfigEntry(root)) {
    return new Set<string>();
  }

  let packageJsonPath: string;
  let declaredPackageNames: ReadonlySet<string>;

  try {
    const manifest = await loadProjectManifest(root);
    packageJsonPath = manifest.packageJsonPath;
    declaredPackageNames = manifest.declaredDependencyNames;
  } catch (error) {
    if (error instanceof ProjectManifestError) {
      return new Set<string>();
    }

    throw error;
  }

  return findEslintConfigUsage(await readEslintConfigValue(packageJsonPath), declaredPackageNames);
}

/**
 * Whether a modern flat-config entrypoint name exists in the project root.
 *
 * The root directory is listed by name only (`readdir`), so no entry is opened, stat-followed, read
 * or executed. An unreadable or missing root simply means no flat config is known to be present.
 * Names are compared case-insensitively so a case-insensitive filesystem (typical on Windows and
 * macOS) cannot hide a flat config from this guard.
 */
async function hasFlatConfigEntry(root: string): Promise<boolean> {
  let entries: string[];

  try {
    entries = await readdir(root);
  } catch {
    return false;
  }

  return entries.some((entry) => FLAT_CONFIG_ENTRY_NAMES.has(entry.toLowerCase()));
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
    text = await readFile(packageJsonPath, 'utf8');
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
