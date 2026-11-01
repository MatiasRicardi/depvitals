/**
 * Dependency analysis.
 *
 * This module combines the outputs of the manifest loader, source discovery, module-specifier
 * extraction, package-specifier classification and script-usage detection into the first real
 * dependency-analysis engine.
 *
 * It answers exactly three questions about a single Node.js project:
 * - which `dependencies` are never referenced (neither by source files nor by `package.json`
 *   scripts)?
 * - which `devDependencies` are never referenced?
 * - which external packages are referenced by source files but are not declared anywhere?
 *
 * It deliberately does not:
 * - decide whether a dependency is misplaced, a misconfigured peer/optional, or a scoped
 *   dependency (that belongs to later releases);
 * - resolve specifiers against `node_modules`, `tsconfig` `paths`, `package.json#imports` or
 *   bundler aliases (Step 10 only classifies a raw specifier);
 * - render terminal output, JSON, evidence or confidence (that belongs to later steps);
 * - execute or import any analyzed source, run package scripts, or mutate the analyzed project;
 * - consult the network or the npm registry.
 *
 * The pipeline is intentionally sequential and single-pass: each discovered source file is read
 * once and parsed once. No concurrency pool, cache or index is introduced before a measured need
 * appears.
 *
 * Usage/missing formulas (`usedNames` is the union of source-external package roots, script-used
 * package names and validated configuration-only package names; `declaredDependencyNames` is the
 * union of every declared dependency section):
 *
 * ```text
 * sourceUsedNames = external package roots extracted from source files
 * scriptUsedNames = findPackageScriptUsage(scripts, dependencies ∪ devDependencies)
 * configUsedNames = validated configuration-only names handed to the analyzer (empty for now)
 * usedNames       = sourceUsedNames ∪ scriptUsedNames ∪ configUsedNames
 * unusedDependencies    = dependencies    − usedNames
 * unusedDevDependencies = devDependencies − usedNames
 * missingDependencies   = sourceUsedNames − declaredDependencyNames
 * ```
 *
 * The evidence sources are deliberately asymmetric:
 * - source imports and requires may contribute to `missingDependencies`;
 * - package scripts and validated static tool configuration may only suppress an unused finding and
 *   can never create a missing finding, because a command or configuration string is not evidence
 *   that source code references the package.
 *
 * Peer/optional declarations suppress false missing results through `declaredDependencyNames`.
 */

import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import {
  loadPackageScope,
  loadProjectManifest,
  type PackageScopeMetadata,
} from '../scanner/projectManifest.js';
import { discoverSourceFiles } from '../scanner/sourceFiles.js';
import { extractModuleSpecifiers } from '../scanner/moduleSpecifiers.js';
import { classifyPackageSpecifier, isPackageSelfReference } from '../scanner/packageSpecifier.js';
import { findPackageScriptUsage } from '../scanner/scriptUsage.js';

/**
 * The structured outcome of a dependency analysis.
 *
 * Every package-name list is sorted alphabetically and contains no duplicates. The result carries
 * only the facts needed by the `v0.1.0` report: the project root and the three unused/missing
 * categories. Confidence, explanations, evidence, severity and JSON schema version are deliberately
 * absent: they are future roadmap concepts.
 */
export type AnalysisResult = {
  /** Absolute, normalized project root (from the manifest). */
  projectRoot: string;
  /** Unused `dependencies`, sorted alphabetically. */
  unusedDependencies: readonly string[];
  /** Unused `devDependencies`, sorted alphabetically. */
  unusedDevDependencies: readonly string[];
  /** External packages referenced by source but not declared anywhere, sorted alphabetically. */
  missingDependencies: readonly string[];
};

/**
 * Internal handoff for package names recognized by a validated static configuration reader.
 *
 * This is deliberately not the future public `why` evidence model: it carries no location, kind, or
 * explanation, and it is never rendered or exposed. A configuration reader hands the package names it
 * recognized to the analyzer through this set; only {@link analyzeProject} turns them into final
 * unused/missing categories, so no configuration reader may edit report arrays directly.
 *
 * The analyzer validates every entry with {@link classifyPackageSpecifier} before using it, so
 * arbitrary configuration text can never be treated as a package name. Accepted entries are collapsed
 * to their package root and deduplicated case-sensitively, matching package-specifier classification
 * (names are compared case-sensitively throughout DepVitals).
 *
 * The set may only suppress unused findings; it is never merged into the source-derived names that
 * produce missing findings.
 */
export type ConfigUsageHints = ReadonlySet<string>;

/**
 * Optional inputs for {@link analyzeProject}.
 */
export type AnalysisOptions = {
  /**
   * Validated configuration-only package names, see {@link ConfigUsageHints}.
   *
   * Omitted or empty is the default, which is the state of the released product: no configuration
   * rule is active yet, so the default keeps every report byte-for-byte identical.
   */
  readonly configUsedNames?: ConfigUsageHints | undefined;
  /** Validated, normalized literal paths excluded from source discovery only; omitted is empty. */
  readonly ignorePaths?: readonly string[] | undefined;
};

/**
 * Why the analysis could not complete.
 *
 * - `unreadable-source`: a discovered source file could not be read from disk.
 * - `invalid-source`: a discovered source file reached a lexical state from which the specifier
 *   extractor cannot safely continue (an unterminated string/comment/template/regex, or a malformed
 *   string escape).
 */
export type AnalysisErrorCode = 'unreadable-source' | 'invalid-source';

/**
 * Operational error for the dependency-analysis engine.
 *
 * The `code` lets callers (the CLI in a later step) render a clean message without matching on error
 * strings, and the preserved `cause` keeps the original filesystem or parsing failure. The affected
 * source-file path is always included in the message so an unreadable or invalid file is never
 * silently skipped.
 */
export class AnalysisError extends Error {
  readonly code: AnalysisErrorCode;

  constructor(message: string, code: AnalysisErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AnalysisError';
    this.code = code;
  }
}

/**
 * Analyze the single project rooted at `projectRoot` and return the structured unused/missing result.
 *
 * The supplied root is resolved to an absolute path; `process.cwd()` is never changed and the target
 * project is never written to.
 *
 * @param projectRoot - Directory to analyze.
 * @param options - Optional static tool hints and validated source exclusions; omitted inputs change nothing.
 * @throws {AnalysisError} when a discovered source file cannot be read or cannot be safely analyzed.
 * @throws {ProjectManifestError} when the manifest is missing, unreadable, invalid or malformed.
 * @throws {SourceFilesError} when the root is missing, is not a directory, or cannot be read.
 */
export async function analyzeProject(
  projectRoot: string,
  options: AnalysisOptions = {},
): Promise<AnalysisResult> {
  const manifest = await loadProjectManifest(projectRoot);

  const sourceFiles = await discoverSourceFiles(manifest.root, {
    ignorePaths: options.ignorePaths,
  });

  // External package roots referenced by source files, collapsed to their package root.
  const sourceUsedNames = new Set<string>();
  // Seed the selected root so scope lookup never consults a parent outside the scan.
  const scopeByDirectory = new Map<string, PackageScopeMetadata>([
    [manifest.root, { packageType: manifest.packageType, selfReference: manifest.selfReference }],
  ]);

  for (const file of sourceFiles) {
    const scope = await packageScopeForDirectory(dirname(file), scopeByDirectory);
    const specifiers = await readAndExtract(file, scope.packageType);

    for (const specifier of specifiers) {
      if (isPackageSelfReference(specifier, scope.selfReference)) continue;
      const classified = classifyPackageSpecifier(specifier);

      if (classified.kind === 'external') {
        sourceUsedNames.add(classified.packageName);
      }
    }
  }

  // Script usage is only meaningful for the packages that may be reported as unused: dependencies
  // and devDependencies. Peer/optional declarations are excluded from this input by design.
  const declaredCandidates = unionNames([
    Object.keys(manifest.dependencies),
    Object.keys(manifest.devDependencies),
  ]);

  const scriptUsedNames = findPackageScriptUsage(manifest.scripts, declaredCandidates);

  // Configuration evidence never reaches `sourceUsedNames`, which is the only input able to produce
  // a missing finding; it can only make `usedNames` bigger and therefore suppress unused findings.
  const configUsedNames = normalizeConfigHints(options.configUsedNames);

  const usedNames = unionNames([[...sourceUsedNames], [...scriptUsedNames], [...configUsedNames]]);

  const unusedDependencies = declaredMinus(Object.keys(manifest.dependencies), usedNames);

  const unusedDevDependencies = declaredMinus(Object.keys(manifest.devDependencies), usedNames);

  // An external root is missing only when it is absent from every declared dependency section.
  // Peer/optional declarations therefore suppress false missing results.
  const missingDependencies = declaredMinus([...sourceUsedNames], manifest.declaredDependencyNames);

  return {
    projectRoot: manifest.root,
    unusedDependencies,
    unusedDevDependencies,
    missingDependencies,
  };
}

/**
 * Resolve the nearest package scope for one discovered source file.
 *
 * An existing nested `package.json` starts a new scope even when it omits `type`; directories
 * without one inherit their parent. Ownership and module mode share this walk and cache. The
 * selected root is always seeded before lookup, so traversal stops there.
 */
async function packageScopeForDirectory(
  directory: string,
  cache: Map<string, PackageScopeMetadata>,
): Promise<PackageScopeMetadata> {
  const cached = cache.get(directory);
  if (cached !== undefined) return cached;

  const ownScope = await loadPackageScope(directory);
  const scope = ownScope ?? (await packageScopeForDirectory(dirname(directory), cache));
  cache.set(directory, scope);
  return scope;
}

/**
 * Read a discovered source file and extract its statically known specifiers.
 *
 * A filesystem read failure becomes {@link AnalysisError} with code `unreadable-source`; a lexical
 * failure from the specifier extractor becomes {@link AnalysisError} with code `invalid-source`. Both
 * preserve the original error as `cause` and include the affected path, so a broken file never
 * yields a partial result or a misleading "clean" analysis.
 */
async function readAndExtract(
  file: string,
  packageType: string | undefined,
): Promise<readonly string[]> {
  let source: string;

  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    throw new AnalysisError(
      `Could not read source file ${file}: ${messageOf(error)}`,
      'unreadable-source',
      error,
    );
  }

  /**
   * Determine the narrow Node source mode needed for top-level `await`.
   *
   * Explicit module extensions win over the package type. CommonJS extensions remain scripts even
   * under a module package. Ambiguous `.js` scopes use bounded syntax detection; JSX/TypeScript
   * extensions retain the existing nearest-scope `type: "module"` policy.
   */
  function sourceModuleMode(file: string, packageType: string | undefined): boolean | 'detect' {
    const lower = file.toLowerCase();

    if (lower.endsWith('.mjs') || lower.endsWith('.mts')) {
      return true;
    }

    if (lower.endsWith('.cjs') || lower.endsWith('.cts')) {
      return false;
    }

    if (lower.endsWith('.js') && packageType !== 'module' && packageType !== 'commonjs') {
      return 'detect';
    }

    return (
      (lower.endsWith('.js') ||
        lower.endsWith('.jsx') ||
        lower.endsWith('.ts') ||
        lower.endsWith('.tsx')) &&
      packageType === 'module'
    );
  }

  try {
    const occurrences = extractModuleSpecifiers(source, {
      jsx: usesJsxSyntax(file, source),
      module: sourceModuleMode(file, packageType),
    });
    return occurrences.map((occurrence) => occurrence.specifier);
  } catch (error) {
    if (error instanceof Error && error.name === 'ModuleSpecifierError') {
      throw new AnalysisError(
        `Source file ${file} could not be analyzed: ${messageOf(error)}`,
        'invalid-source',
        error,
      );
    }

    throw error;
  }
}

/**
 * Whether a discovered source file may contain JSX syntax.
 *
 * `.jsx` and `.tsx` always enable the extractor's bounded JSX mode. Plain JavaScript extensions
 * (`.js`, `.mjs` and `.cjs`) enable it only when the source contains a JSX-like closing or
 * self-closing tag. TypeScript extensions other than `.tsx` stay in plain mode, so a `.ts` type
 * assertion (`<Foo>value`) is never mistaken for markup. Extension checks are case-insensitive.
 */
function usesJsxSyntax(file: string, source: string): boolean {
  const lower = file.toLowerCase();

  if (lower.endsWith('.jsx') || lower.endsWith('.tsx')) {
    return true;
  }

  return /\.(?:js|mjs|cjs)$/.test(lower) && /<\/[A-Za-z]|\/>/.test(source);
}

/**
 * Turn the internal configuration handoff into validated package roots.
 *
 * The entries come from configuration reading code, not from the trusted analyzer, so each one is
 * re-validated with the same utility that classifies source specifiers. Builtins, relative or
 * absolute paths, malformed scoped names, URIs, whitespace and version suffixes are dropped instead
 * of being trusted as package names. Accepted entries collapse to their package root and are
 * deduplicated case-sensitively; an omitted set behaves exactly like an empty one.
 */
function normalizeConfigHints(hints: ConfigUsageHints | undefined): ReadonlySet<string> {
  const names = new Set<string>();

  if (hints === undefined) {
    return names;
  }

  for (const hint of hints) {
    const classified = classifyPackageSpecifier(hint);

    if (classified.kind === 'external') {
      names.add(classified.packageName);
    }
  }

  // Rebuilt from sorted names so iteration order never depends on the caller's set insertion order.
  return new Set<string>([...names].sort(compareNames));
}

/**
 * Union of the names of every supplied list, sorted alphabetically.
 */
function unionNames(lists: readonly (readonly string[])[]): ReadonlySet<string> {
  const names = new Set<string>();

  for (const list of lists) {
    for (const name of list) {
      names.add(name);
    }
  }

  return new Set([...names].sort(compareNames));
}

/**
 * The sorted names of `declared` that are not contained in `used`.
 */
function declaredMinus(declared: readonly string[], used: ReadonlySet<string>): readonly string[] {
  const unused = declared.filter((name) => !used.has(name));
  return [...new Set(unused)].sort(compareNames);
}

/**
 * A short, human-readable reason extracted from an unknown thrown value, for error messages only.
 */
function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Locale-independent lexicographic ordering, so the same project always yields the same order.
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
