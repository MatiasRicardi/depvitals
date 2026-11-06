/**
 * `package.json#jest` usage detection.
 *
 * This module answers exactly one narrow question: which declared dependencies are named by the three
 * explicit Jest fields this release understands inside the `jest` block of `package.json` — the
 * top-level `preset` and `testEnvironment` strings and the values of the top-level `transform` map?
 * The result is a set of configuration-only package names handed to the Step 56 analyzer seam, so a
 * recognized name can only suppress an `unused` finding and can never create a `missing` one.
 *
 * It deliberately does not:
 * - execute Jest, `import()`/`require()` its configuration loader, or evaluate any target code;
 * - implement the Jest configuration schema. Only `preset`, `testEnvironment` and `transform` are
 *   read, and only through the fixed allowlists below;
 * - use `transform` map keys as package evidence. Keys are retained only in JSON pointers; they
 *   select the transformer field and never name a package, even when a key literally reads
 *   `"ts-jest"`. No regular expression is evaluated here;
 * - expand Jest shorthands. In particular `testEnvironment: "jsdom"` is *not* credited to
 *   `jest-environment-jsdom`: whether that shorthand is a package reference at all depends on the
 *   Jest major version in use, which DepVitals does not read, so it stays outside the supported
 *   subset of explicit package names;
 * - interpret `<rootDir>/...`, `./...`, absolute paths, URLs or any other resolver-looking string as a
 *   package reference;
 * - read `jest.config.js`/`.cjs`/`.mjs`/`.ts`/`.json` contents. Those files are only checked for
 *   presence, never opened here (source detection already handles their imports on its own);
 * - guess a package from arbitrary configuration text, substring-match a value, or invent a name;
 * - report anything about a package the manifest does not declare;
 * - mutate the analyzed project.
 *
 * A conservative precedence guard applies before anything is read: when a root `jest.config.*` file
 * exists, it is not provable which configuration Jest actually loads, so no `package.json#jest`
 * hints are produced. Presence is checked by directory entry name only.
 *
 * The manifest model intentionally does not carry `jest`, so `package.json` is read a second time here
 * as plain text (same trade-off as the legacy ESLint readers): the loader stays the validity gate and
 * the single reporter of a broken manifest, while this detector silently ignores every shape it cannot
 * use. Ignoring is deliberate — an unusable `jest` block is not an error, and diagnosing one here would
 * duplicate the manifest loader.
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  compareEvidence,
  compareStrings,
  jsonPointer,
  type ConfigEvidence,
} from '../core/evidence.js';

import {
  loadProjectManifest,
  ProjectManifestError,
  readManifestText,
} from '../scanner/projectManifest.js';
import { assertReadableRoot, SourceFilesError } from '../scanner/sourceFiles.js';
import { classifyPackageSpecifier } from '../scanner/packageSpecifier.js';

/**
 * The only `preset` packages recognized by this release.
 *
 * A fixed allowlist, not a resolution algorithm: `ts-jest` is supported because it is the published
 * package name of the preset itself, so the string is already a complete package reference and needs
 * no Jest-version knowledge to interpret. Any other preset name is unsupported and contributes no
 * evidence, since guessing what an unknown preset string resolves to would create false confidence.
 *
 * A literal subpath of an allowlisted package (`"ts-jest/presets/default-esm"`) is accepted too,
 * through the existing package-root normalization in {@link classifyPackageSpecifier}: the first path
 * segment of such a specifier is the package that provides the preset.
 */
const PRESET_PACKAGE_NAMES: ReadonlySet<string> = new Set(['ts-jest']);

/**
 * The only `testEnvironment` packages recognized by this release.
 *
 * Again the complete package name only; the `"jsdom"` shorthand is deliberately absent from this
 * release. Where Jest accepts `"jsdom"`, it does resolve it to the separately installed
 * `jest-environment-jsdom` package - but whether that shorthand is available at all depends on the
 * Jest major version (up to v27 the jsdom environment shipped inside Jest itself, so such a project
 * declares no package to credit), and DepVitals neither reads nor resolves the Jest version of an
 * analyzed project. The supported subset is therefore fixed to the exact package name; shorthand
 * resolution is a separate change that must first define which Jest versions it applies to.
 */
const TEST_ENVIRONMENT_PACKAGE_NAMES: ReadonlySet<string> = new Set(['jest-environment-jsdom']);

/**
 * The only `transform` packages recognized by this release.
 *
 * A separate fixed allowlist rather than a reuse of the `preset` one: `ts-jest` is the only
 * transformer credited, and it is supported for the same reason as the preset — the string is already
 * the complete published package name, so nothing has to be resolved or versioned to interpret it.
 * `jest-environment-jsdom` is deliberately absent, because a test environment is not a transformer;
 * no other transform module is resolved, guessed, searched for in `node_modules` or matched by
 * prefix, and transform maps are never flattened or searched recursively.
 */
const TRANSFORM_PACKAGE_NAMES: ReadonlySet<string> = new Set(['ts-jest']);

/**
 * Root Jest configuration file names that disable `package.json#jest` hints.
 *
 * The list is fixed to the extensions named by the supported contract; `jest.config.mts` and other
 * spellings are not part of it, which only makes the guard narrower (it can drop hints, never add
 * them). Presence of any listed name at the project root is enough; the file itself is never read or
 * executed.
 *
 * Compared case-insensitively (see {@link hasRootJestConfigEntry}) because a case-insensitive
 * filesystem treats `Jest.Config.JS` as the same file, and DepVitals must not disagree with itself
 * about one project depending on the platform it runs on.
 */
const JEST_CONFIG_ENTRY_NAMES: ReadonlySet<string> = new Set([
  'jest.config.js',
  'jest.config.mjs',
  'jest.config.cjs',
  'jest.config.ts',
  'jest.config.json',
]);

/**
 * Match the allowlisted subset of one `jest` configuration against the declared packages.
 *
 * Pure and side-effect free: it takes the raw `package.json#jest` JSON value (any shape, including
 * something that is not an object) and the declared dependency names, and returns the declared
 * packages named by `preset`, `testEnvironment` or the values of `transform`, in alphabetical order.
 * Neither argument is mutated, and a candidate that is not declared is dropped, so this function can
 * never describe an undeclared package as used.
 *
 * @param jestConfig - The raw `package.json#jest` value, validated here and never trusted.
 * @param declaredPackageNames - Declared dependency names, the only names this may return.
 */
export function findJestConfigUsage(
  jestConfig: unknown,
  declaredPackageNames: ReadonlySet<string>,
): ReadonlySet<string> {
  return new Set(
    collectJestConfigUsage(jestConfig, declaredPackageNames).map(({ packageName }) => packageName),
  );
}

/** Internal package owner plus one exact recognized Jest configuration value. */
export type JestConfigOccurrence = {
  readonly packageName: string;
  readonly evidence: ConfigEvidence;
};

/** Pure collector for standalone readers and the later shared validated-context handoff. */
export function collectJestConfigUsage(
  jestConfig: unknown,
  declaredPackageNames: ReadonlySet<string>,
): readonly JestConfigOccurrence[] {
  if (!isPlainRecord(jestConfig)) return [];
  const occurrences: JestConfigOccurrence[] = [];
  const add = (
    value: unknown,
    allowedPackages: ReadonlySet<string>,
    pointerTokens: readonly string[],
  ): void => {
    if (typeof value !== 'string') return;
    for (const packageName of matchAllowedPackage(value, allowedPackages)) {
      if (declaredPackageNames.has(packageName)) {
        occurrences.push({
          packageName,
          evidence: {
            kind: 'config',
            file: 'package.json',
            pointer: jsonPointer('jest', ...pointerTokens),
            value,
            detector: 'jest',
          },
        });
      }
    }
  };
  add(jestConfig['preset'], PRESET_PACKAGE_NAMES, ['preset']);
  add(jestConfig['testEnvironment'], TEST_ENVIRONMENT_PACKAGE_NAMES, ['testEnvironment']);
  const transform = jestConfig['transform'];
  if (isPlainRecord(transform)) {
    for (const [key, value] of Object.entries(transform)) {
      // Keys identify fields only. A tuple must have exactly two items and object-shaped options;
      // those options remain opaque, and only its first item can supply a recognized value.
      if (Array.isArray(value)) {
        if (value.length === 2 && isPlainRecord(value[1])) {
          add(value[0], TRANSFORM_PACKAGE_NAMES, ['transform', key, '0']);
        }
      } else {
        add(value, TRANSFORM_PACKAGE_NAMES, ['transform', key]);
      }
    }
  }
  // Different fields and transform keys remain distinct, even when their package/value repeats.
  return occurrences.sort(
    (a, b) =>
      compareStrings(a.packageName, b.packageName) || compareEvidence(a.evidence, b.evidence),
  );
}

/**
 * Collect the `package.json#jest` hints for the project rooted at `projectRoot`.
 *
 * The returned set is shaped for the analyzer's `configUsedNames` option (the Step 56 handoff), which
 * is the only way configuration evidence reaches the analyzer. Nothing is decided here: the analyzer
 * stays the sole owner of the unused/missing categories.
 *
 * No configuration problem is reported as an error. A missing manifest, an unreadable or invalid
 * `package.json`, an unusable `jest` shape or an unreadable root all yield the empty set; the analyzer
 * loads the manifest itself and remains the component that reports manifest failures, so this detector
 * never replaces or duplicates that diagnosis.
 *
 * @param projectRoot - Project directory to inspect; resolved to an absolute path.
 */
export async function findJestManifestUsage(projectRoot: string): Promise<ReadonlySet<string>> {
  return new Set(
    (await collectJestManifestUsage(projectRoot)).map(({ packageName }) => packageName),
  );
}

/** Retain manifest facts through the existing barrier, validation and text-read path. */
export async function collectJestManifestUsage(
  projectRoot: string,
): Promise<readonly JestConfigOccurrence[]> {
  const root = resolve(projectRoot);

  if (await hasRootJestConfigEntry(root)) {
    return [];
  }

  let packageJsonPath: string;
  let declaredPackageNames: ReadonlySet<string>;

  try {
    const manifest = await loadProjectManifest(root);
    packageJsonPath = manifest.packageJsonPath;
    declaredPackageNames = manifest.declaredDependencyNames;
  } catch (error) {
    if (error instanceof ProjectManifestError || error instanceof SourceFilesError) {
      return [];
    }

    throw error;
  }

  return collectJestConfigUsage(await readJestConfigValue(packageJsonPath), declaredPackageNames);
}

/**
 * Whether a root Jest configuration file name exists in the project root.
 *
 * The root directory is listed by name only (`readdir`), so no entry is opened, stat-followed, read or
 * executed. An unreadable or missing root simply means no root Jest config is known to be present.
 * Names are compared case-insensitively so a case-insensitive filesystem (typical on Windows and
 * macOS) cannot hide a root Jest config from this guard.
 */
export async function hasRootJestConfigEntry(root: string): Promise<boolean> {
  let entries: string[];

  try {
    await assertReadableRoot(root);
    entries = await readdir(root);
  } catch {
    return false;
  }

  return hasRootJestConfigEntries(entries);
}

/** Pure barrier decision for a shared per-scan root listing. */
export function hasRootJestConfigEntries(entries: readonly string[]): boolean {
  return entries.some((entry) => JEST_CONFIG_ENTRY_NAMES.has(entry.toLowerCase()));
}

/**
 * Read the raw `package.json#jest` value, ignoring everything that cannot be used.
 *
 * The manifest is read as text and parsed with `JSON.parse`, so no target-project code runs. An
 * unreadable file, invalid JSON, a non-object document or an absent `jest` key all yield `undefined`;
 * the loader-facing diagnosis of a broken manifest stays in {@link loadProjectManifest}.
 */
async function readJestConfigValue(packageJsonPath: string): Promise<unknown> {
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

  return isPlainRecord(parsed) ? parsed['jest'] : undefined;
}

/**
 * The single allowlisted package named by one static string value, if any.
 *
 * Only strings are considered: a number, `null`, an array or an object contributes nothing, so a
 * malformed field never becomes evidence. The string is classified with the shared package-specifier
 * rules, which reject relative and absolute paths (`"./local.js"`, `"/opt/preset.js"`) and URI forms
 * such as `"file:./preset.js"` as internal or unsupported. Whatever package root survives must then
 * be an exact member of `allowedPackages`, and that exact-name rule is what rejects the remaining
 * resolver-shaped values, including `<rootDir>/presets/x.js` (its first segment `<rootDir>` is not a
 * package name DepVitals will ever allow) and `"ts-jest-extras"`. There is no prefix, suffix,
 * substring or case-insensitive matching, so `"jsdom"`, `"TS-Jest"` and
 * `"jest-environment-node"` never match an entry.
 */
function matchAllowedPackage(
  value: unknown,
  allowedPackages: ReadonlySet<string>,
): readonly string[] {
  if (typeof value !== 'string') {
    return [];
  }

  const specifier = classifyPackageSpecifier(value);

  if (specifier.kind !== 'external') {
    return [];
  }

  return allowedPackages.has(specifier.packageName) ? [specifier.packageName] : [];
}

/**
 * A JSON object (not an array, not `null`) whose keys are strings.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
