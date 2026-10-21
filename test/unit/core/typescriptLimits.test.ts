/**
 * Observed-behavior coverage for the TypeScript implicit-type and `@types/*` limits (Step 61).
 *
 * Step 61 is a bounded technical decision step, not a detection step: it records which ambient-type
 * cases DepVitals can settle deterministically today and which ones must stay deferred. The decision
 * record lives in `instructions/phase3/reference/typescript-decision.md` (an internal planning
 * document, so it is not part of the published package). No shipped rule changes: the scanner keeps
 * reporting an ambient type package as unused when nothing in a scanned file references it by name,
 * and no broad `@types/*` suppression and no TypeScript resolution logic is introduced.
 *
 * The cases below are the behavior matrix of the step, asserted against the real analyzer:
 *
 * - `@types/node` declared with only ambient Node globals in source -> still `unused` (no blanket
 *   assumption that a Node type package is used);
 * - `@types/jest` declared with only ambient Jest globals in a spec file -> still `unused`;
 * - an explicit `tsconfig.json` `compilerOptions.types` list -> never read, so it changes nothing;
 * - `typeRoots` / `extends` -> never read, and a `types` entry can name a local folder rather than a
 *   package, which is exactly why the name cannot be guessed from the entry alone;
 * - a type-only `import type { Request } from 'express'` with only `@types/express` declared -> the
 *   scanner keeps reporting `express` as missing and `@types/express` as unused. TypeScript erases
 *   `import type`, so this source reference is no proof that `express` is needed at runtime; crediting
 *   the stub from the `express` specifier would silently silence only the unused side;
 * - type-level imports (`import type`, `import('pkg')`) inside a `.d.ts` file already count as usage,
 *   while `declare module 'pkg'` and `/// <reference types="pkg" />` produce no evidence.
 *
 * Everything is static and offline: fixtures are read as text, nothing is installed, resolved or
 * executed, and no `node_modules` content is inspected.
 */

import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../../../src/core/analyzeProject.js';
import { classifyPackageSpecifier } from '../../../src/scanner/packageSpecifier.js';
import { discoverSourceFiles } from '../../../src/scanner/sourceFiles.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../fixtures/analysis/', import.meta.url));
const FAMILY = 'typescript-limits';

/** Absolute path to a committed project inside the `typescript-limits` fixture family. */
function fixturePath(name: string): string {
  return resolve(join(FIXTURE_DIR, FAMILY, name));
}

describe('ambient @types packages are never assumed used (Step 61)', () => {
  it('reports @types/node as unused when only ambient Node globals are used', async () => {
    expect(await analyzeProject(fixturePath('types-node-no-import'))).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['@types/node'],
      missingDependencies: [],
    });
  });

  it('reports @types/jest as unused when only ambient Jest globals are used', async () => {
    expect(await analyzeProject(fixturePath('types-jest-ambient-globals'))).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['@types/jest'],
      missingDependencies: [],
    });
  });

  it('does not turn a Node builtin import into @types/node evidence', () => {
    // Node builtins are classified as builtins, never as the `@types/node` package, so a builtin
    // import can only ever be used to credit a declared package of the same name (there is none).
    expect(classifyPackageSpecifier('node:fs')).toEqual({ kind: 'builtin' });
    expect(classifyPackageSpecifier('@types/node')).toEqual({
      kind: 'external',
      packageName: '@types/node',
    });
  });
});

describe('tsconfig.json is not read, so compiler options change nothing (Step 61)', () => {
  it('leaves an explicit compilerOptions.types list without effect', async () => {
    const root = fixturePath('tsconfig-types-explicit');

    // `tsconfig.json` is not a supported source extension, so no configuration reader exists for it.
    expect(await discoverSourceFiles(root)).toEqual([join(root, 'src', 'index.ts')]);
    expect(await analyzeProject(root)).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['@types/node'],
      missingDependencies: [],
    });
  });

  it('ignores typeRoots and inherited configuration instead of guessing from file names', async () => {
    const root = fixturePath('typeroots-extends');

    // The inherited `types` list lives in `tsconfig.base.json`; the effective local type root is the
    // `typings/` directory. Both files stay unread, and the scanned local declaration contributes no
    // evidence for the declared `@types/jest` package the entry could otherwise be confused with.
    const discovered = await discoverSourceFiles(root);
    expect(discovered).toContain(join(root, 'typings', 'jest', 'index.d.ts'));
    expect(discovered.some((file) => file.endsWith('tsconfig.json'))).toBe(false);
    expect(discovered.some((file) => file.endsWith('tsconfig.base.json'))).toBe(false);

    expect(await analyzeProject(root)).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['@types/jest', '@types/node'],
      missingDependencies: [],
    });
  });

  it('shows that a "types" entry is not a package name', () => {
    // These are the strings a `compilerOptions.types` list may contain. TypeScript resolves them
    // against type roots, so they are not `@types/*` package names: a hint reader built on them would
    // credit nothing for `node` (the declared package is `@types/node`) or the wrong package for
    // `jest` whenever a runtime package of that same name happens to be declared.
    expect(classifyPackageSpecifier('node')).toEqual({ kind: 'external', packageName: 'node' });
    expect(classifyPackageSpecifier('jest')).toEqual({ kind: 'external', packageName: 'jest' });
    expect(classifyPackageSpecifier('./typings/jest')).toEqual({ kind: 'internal' });
  });
});

describe('a type-only import of an undeclared package keeps both findings (Step 61)', () => {
  it('keeps express missing while @types/express stays unused', async () => {
    const result = await analyzeProject(fixturePath('types-ambient-with-source-import'));

    // The reference is in type position, which TypeScript erases, so nothing here proves a runtime
    // dependency on `express`; the scanner does not distinguish type position from value position, and
    // it never equates the `express` specifier with the declared `@types/express` stub. Both findings
    // therefore stay as reported, which is what a future rule must preserve explicitly.

    expect(result).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['@types/express'],
      missingDependencies: ['express'],
    });
  });
});

describe('type-level imports already count, ambient declaration constructs do not (Step 61)', () => {
  it('credits packages named by type-only imports and defers the rest', async () => {
    const result = await analyzeProject(fixturePath('declaration-file-evidence'));

    // `zod` (import type) and `other-pkg` (type-position `import('other-pkg')`) are credited inside a
    // `.d.ts` file, while `untyped-lib` (`declare module 'untyped-lib'`) and `referenced-pkg`
    // (`/// <reference types="referenced-pkg" />`) produce no evidence at all.
    expect(result).toMatchObject({
      unusedDependencies: [],
      unusedDevDependencies: ['referenced-pkg', 'untyped-lib'],
      missingDependencies: [],
    });
  });
});
