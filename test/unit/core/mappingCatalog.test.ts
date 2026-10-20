/**
 * Step 54: the activated executable-to-package catalog as a read-only derived coverage table.
 *
 * The catalog is derived from `src/scanner/scriptUsage.ts` (see `test/helpers/mappingCatalog.ts`), so
 * these assertions describe what actually shipped rather than a hand-maintained list, and they never
 * execute or mutate anything. Three things are pinned:
 *
 * - catalog hygiene: no duplicated executable key, no empty name, every collision-sensitive name is a
 *   mapped executable key;
 * - the two counts kept strictly apart: unique executable keys versus distinct mapped npm packages, so a
 *   package reachable through several aliases is never counted as several mappings;
 * - fixture lockstep: every derived alias has exactly one positive command script and one argument-only
 *   negative script, and every matrix fixture declares exactly the mapped packages.
 *
 * Aliases are only added by their own scheduled step with a published-`bin` proof in
 * `mapping-verification-ledger.md`; this file intentionally adds none.
 */

import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  countCatalog,
  groupMappingsByPackage,
  parseCollisionSensitiveBinaries,
  parseExecutableMappings,
  readCollisionSensitiveBinaries,
  readMappingCatalog,
} from '../../helpers/mappingCatalog.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));

const CATALOG = readMappingCatalog();
const COLLISION_SENSITIVE = readCollisionSensitiveBinaries();
const EXECUTABLES = CATALOG.map(([executable]) => executable);
const MAPPED_PACKAGES = [...new Set(CATALOG.map(([, packageName]) => packageName))];

/** Sorted copy of a name list, using the same comparison the fixtures are written with. */
function sorted(names: Iterable<string>): string[] {
  return [...names].sort((left, right) => left.localeCompare(right));
}

/** The `scripts` keys of a mapping-matrix fixture, in file order. */
function scriptKeys(fixtureName: string): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(join(FIXTURE_DIR, 'mapping-matrix', fixtureName, 'package.json')), 'utf8'),
  ) as { scripts?: Record<string, string> };

  return Object.keys(manifest.scripts ?? {});
}

/** The `devDependencies` names of a mapping-matrix fixture. */
function declaredPackages(fixtureName: string): string[] {
  const manifest = JSON.parse(
    readFileSync(resolve(join(FIXTURE_DIR, 'mapping-matrix', fixtureName, 'package.json')), 'utf8'),
  ) as { devDependencies?: Record<string, string> };

  return Object.keys(manifest.devDependencies ?? {});
}

describe('Step 54: catalog hygiene', () => {
  it('declares every executable key exactly once', () => {
    expect(new Set(EXECUTABLES).size).toBe(CATALOG.length);
  });

  it('uses non-empty names without surrounding whitespace', () => {
    for (const [executable, packageName] of CATALOG) {
      expect(executable.length).toBeGreaterThan(0);
      expect(packageName.length).toBeGreaterThan(0);
      expect(executable).toBe(executable.trim());
      expect(packageName).toBe(packageName.trim());
    }
  });

  it('keeps the collision-sensitive names a subset of the mapped executables', () => {
    expect(new Set(COLLISION_SENSITIVE).size).toBe(COLLISION_SENSITIVE.length);

    for (const executable of COLLISION_SENSITIVE) {
      expect(EXECUTABLES).toContain(executable);
    }
  });
});

describe('Step 54: activated coverage counts', () => {
  it('counts executable keys and distinct mapped packages separately', () => {
    // 60 executable keys resolve to 46 distinct npm packages; several aliases always collapse to one
    // package, so the two numbers must never be reported as one "mappings" figure.
    expect(countCatalog(CATALOG)).toEqual({ executableKeys: 60, packageNames: 46 });
    expect(CATALOG.length).toBe(60);
    expect(MAPPED_PACKAGES.length).toBe(46);
  });

  it('lists every package that is reachable through more than one alias', () => {
    const multiAlias = groupMappingsByPackage(CATALOG).filter(
      ({ executables }) => executables.length > 1,
    );

    expect(multiAlias).toEqual([
      { packageName: '@angular/compiler-cli', executables: ['ng-xi18n', 'ngc'] },
      { packageName: '@capacitor/cli', executables: ['cap', 'capacitor'] },
      {
        packageName: '@graphql-codegen/cli',
        executables: ['gql-gen', 'graphql-code-generator', 'graphql-codegen'],
      },
      { packageName: 'coffeescript', executables: ['cake', 'coffee'] },
      {
        packageName: 'dependency-cruiser',
        executables: ['depcruise', 'depcruise-baseline', 'depcruise-fmt'],
      },
      { packageName: 'esprima', executables: ['esparse', 'esvalidate'] },
      { packageName: 'js-beautify', executables: ['css-beautify', 'html-beautify'] },
      { packageName: 'npm-run-all', executables: ['run-p', 'run-s'] },
      {
        packageName: 'ts-node',
        executables: ['ts-node-cwd', 'ts-node-esm', 'ts-node-script', 'ts-node-transpile-only'],
      },
      { packageName: 'typescript', executables: ['tsc', 'tsserver'] },
    ]);

    // 10 packages carry 24 aliases; the remaining 36 packages are reached by exactly one executable.
    expect(multiAlias.reduce((total, { executables }) => total + executables.length, 0)).toBe(24);
    expect(CATALOG.length - 24).toBe(46 - multiAlias.length);
  });

  it('derives the same table on every read', () => {
    expect(readMappingCatalog()).toEqual(readMappingCatalog());
    expect(readCollisionSensitiveBinaries()).toEqual(readCollisionSensitiveBinaries());
    expect(groupMappingsByPackage(CATALOG)).toEqual(groupMappingsByPackage(CATALOG));
  });
});

describe('Step 54: the matrix fixtures stay in lockstep with the catalog', () => {
  it('runs every activated alias in command position exactly once', () => {
    expect(scriptKeys('all-used')).toEqual(CATALOG.map(([executable]) => `run-${executable}`));
  });

  it('mentions every activated alias as an argument exactly once', () => {
    expect(scriptKeys('all-negatives')).toEqual(
      CATALOG.map(([executable]) => `echo-${executable}`),
    );
  });

  it('declares exactly the mapped packages in each matrix fixture', () => {
    for (const fixtureName of ['all-used', 'all-used-clean', 'all-negatives']) {
      expect(sorted(declaredPackages(fixtureName))).toEqual(sorted(MAPPED_PACKAGES));
    }
  });

  it('names every alias as a command in the clean fixture', () => {
    expect(scriptKeys('all-used-clean').sort((left, right) => left.localeCompare(right))).toEqual(
      sorted(EXECUTABLES),
    );
  });
});

describe('Step 54: the catalog parsers fail loudly instead of reporting an empty catalog', () => {
  it('parses a mapping literal and a collision literal', () => {
    expect(parseExecutableMappings("\n  ['a', 'pkg-a'],\n  ['b', 'pkg-b'],\n")).toEqual([
      ['a', 'pkg-a'],
      ['b', 'pkg-b'],
    ]);
    expect(parseCollisionSensitiveBinaries("\n  'a',\n  'b',\n")).toEqual(['a', 'b']);
  });

  it('rejects an empty literal instead of returning no coverage', () => {
    expect(() => parseExecutableMappings('\n')).toThrow(/no entries/);
    expect(() => parseCollisionSensitiveBinaries('\n')).toThrow(/no entries/);
  });

  it('rejects an entry it cannot read instead of skipping it', () => {
    // A double-quoted or reflowed entry must not disappear from the derived matrix while the pinned totals
    // keep passing.
    expect(() => parseExecutableMappings("\n  ['a', 'pkg-a'],\n  ['b', 'pkg-b']\n")).toThrow(
      /Unsupported BINARY_TO_PACKAGE entry/,
    );
    expect(() => parseExecutableMappings("\n  ['a', 'pkg-a'],\n  [\"b\", 'pkg-b'],\n")).toThrow(
      /Unsupported BINARY_TO_PACKAGE entry/,
    );
    expect(() => parseCollisionSensitiveBinaries('\n  \'a\',\n  "b",\n')).toThrow(
      /Unsupported COLLISION_SENSITIVE_BINARIES entry/,
    );
  });
});
