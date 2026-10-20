/**
 * Read-only derivation of the production executable-to-package catalog, shared by the Step 54 tests.
 *
 * The catalog in `src/scanner/scriptUsage.ts` intentionally exposes only `findPackageScriptUsage`, so
 * the tests need the mapping as data (counts, grouping per mapped package, fixture coverage) without
 * widening that module surface. The source file is therefore read as inert text: nothing is imported
 * here from it, nothing is executed, and nothing is written back. The parsers are pure string
 * transformations so they can be exercised directly, independently of the real source file.
 *
 * A parse failure throws instead of returning an empty catalog, so a restructured mapping block fails
 * loudly rather than silently shrinking the asserted coverage.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const SOURCE_FILE = fileURLToPath(new URL('../../src/scanner/scriptUsage.ts', import.meta.url));

const MAPPING_MARKER = 'const BINARY_TO_PACKAGE: ReadonlyMap<string, string> = new Map([';
const COLLISION_MARKER = 'const COLLISION_SENSITIVE_BINARIES: ReadonlySet<string> = new Set([';
const BLOCK_END = '\n]);';

/** One catalog entry: an executable name and the package it is translated to. */
export type ExecutableMapping = readonly [executable: string, packageName: string];

/** All executables that resolve to one mapped package. */
export type PackageAliasGroup = {
  readonly packageName: string;
  readonly executables: readonly string[];
};

/** The two counts the catalog must report separately. */
export type CatalogCounts = {
  readonly executableKeys: number;
  readonly packageNames: number;
};

/**
 * Extract the entries of a `new Map([...])` / `new Set([...])` literal between two fixed markers.
 *
 * @param source - production source text.
 * @param marker - the declaration line that opens the literal.
 * @throws when the marker is absent or the literal is not closed.
 */
function literalBody(source: string, marker: string): string {
  const start = source.indexOf(marker);

  if (start === -1) {
    throw new Error(`mapping catalog marker not found: ${marker}`);
  }

  const bodyStart = start + marker.length;
  const end = source.indexOf(BLOCK_END, bodyStart);

  if (end === -1) {
    throw new Error(`mapping catalog literal is not closed after: ${marker}`);
  }

  return source.slice(bodyStart, end);
}

/**
 * Parse the `BINARY_TO_PACKAGE` literal body into `[executable, packageName]` pairs.
 *
 * The returned array keeps source order and may contain duplicates, which is what lets the caller
 * detect a duplicated executable key.
 */
export function parseExecutableMappings(body: string): ExecutableMapping[] {
  const mappings: ExecutableMapping[] = [];

  for (const line of body.split('\n')) {
    const entry = /^\s*\['([^']*)',\s*'([^']*)'\],$/.exec(line);

    if (entry?.[1] !== undefined && entry[2] !== undefined) {
      mappings.push([entry[1], entry[2]]);
    }
  }

  if (mappings.length === 0) {
    throw new Error('mapping catalog literal contains no entries');
  }

  return mappings;
}

/**
 * Parse the `COLLISION_SENSITIVE_BINARIES` literal body into executable names in source order.
 */
export function parseCollisionSensitiveBinaries(body: string): string[] {
  const names: string[] = [];

  for (const line of body.split('\n')) {
    const entry = /^\s*'([^']+)',$/.exec(line);

    if (entry?.[1] !== undefined) {
      names.push(entry[1]);
    }
  }

  if (names.length === 0) {
    throw new Error('collision-sensitive literal contains no entries');
  }

  return names;
}

/** The activated catalog as it currently exists in `src/scanner/scriptUsage.ts`. */
export function readMappingCatalog(): ExecutableMapping[] {
  const source = readFileSync(SOURCE_FILE, 'utf8');

  return parseExecutableMappings(literalBody(source, MAPPING_MARKER));
}

/** The collision-sensitive subset as it currently exists in `src/scanner/scriptUsage.ts`. */
export function readCollisionSensitiveBinaries(): string[] {
  const source = readFileSync(SOURCE_FILE, 'utf8');

  return parseCollisionSensitiveBinaries(literalBody(source, COLLISION_MARKER));
}

/**
 * Group the catalog by mapped package name.
 *
 * Packages and executables are both sorted ascending, so the derived table is deterministic and can be
 * compared with `toEqual` regardless of the order the mappings were added in.
 */
export function groupMappingsByPackage(
  mappings: readonly ExecutableMapping[],
): PackageAliasGroup[] {
  const groups = new Map<string, string[]>();

  for (const [executable, packageName] of mappings) {
    const executables = groups.get(packageName);

    if (executables === undefined) {
      groups.set(packageName, [executable]);
      continue;
    }

    executables.push(executable);
  }

  return [...groups.entries()]
    .map(([packageName, executables]) => ({
      packageName,
      executables: executables.toSorted((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => left.packageName.localeCompare(right.packageName));
}

/**
 * Count unique executable keys and distinct mapped packages separately.
 *
 * A package reachable through several aliases is counted once, while every executable key is counted,
 * which is exactly the distinction the coverage report must keep.
 */
export function countCatalog(mappings: readonly ExecutableMapping[]): CatalogCounts {
  return {
    executableKeys: new Set(mappings.map(([executable]) => executable)).size,
    packageNames: new Set(mappings.map(([, packageName]) => packageName)).size,
  };
}
