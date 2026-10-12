/**
 * Package specifier classification.
 *
 * This module classifies a single raw module specifier into a small set of categories without
 * executing code, reading the filesystem or consulting `node_modules`. It is a pure transformation
 * that sits between specifier extraction (Step 9) and dependency analysis (Step 12).
 *
 * It deliberately does not:
 * - decide whether a specifier is used, unused or missing (that belongs to the analyzer);
 * - resolve files on disk, `node_modules`, package `exports`, TS `paths` or bundler aliases;
 * - validate a name against npm registry publication rules (names are compared case-sensitively);
 * - read `package.json#imports`, so `#` import aliases cannot be resolved here.
 *
 * The classification is conservative: anything that cannot be confidently recognized is reported as
 * `unsupported` (or `internal`) rather than as an external package, so these specifiers can never
 * become a false "missing dependency".
 */

import { isBuiltin } from 'node:module';

/**
 * The classification of a raw module specifier.
 *
 * - `external`: an npm package, normalized to its package root (subpaths collapse to the root).
 * - `builtin`: a Node.js builtin module, recognized from the running runtime.
 * - `internal`: a relative or absolute filesystem reference.
 * - `unsupported`: a specifier that cannot be recognized (URI schemes, `#` import aliases, malformed
 *   scoped names, empty input, ...).
 */
export type PackageSpecifier =
  | { kind: 'external'; packageName: string }
  | { kind: 'builtin' }
  | { kind: 'internal' }
  | { kind: 'unsupported' };

/**
 * A URI-like scheme prefix such as `file:`, `http:`, `data:` or `npm:`.
 *
 * `node:` is matched here too, but builtin recognition runs first so real Node builtins are never
 * swallowed by this check.
 */
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/**
 * Classify a raw module specifier as an external package, a Node builtin, an internal reference or
 * an unsupported specifier.
 *
 * The function is pure and side-effect free: it performs no I/O, caches nothing and never mutates
 * its argument.
 */
export function classifyPackageSpecifier(specifier: string): PackageSpecifier {
  // Empty and whitespace-only input, and any specifier containing a character that can never appear
  // in a package reference, are unsupported. Trimming is intentionally avoided so accidental
  // whitespace does not silently change a specifier.
  if (specifier.length === 0 || isMalformed(specifier)) {
    return { kind: 'unsupported' };
  }

  // Node builtins are recognized from the running runtime before any generic scheme handling so
  // that real builtins (including the `node:` form) are never treated as external packages.
  if (isBuiltin(specifier)) {
    return { kind: 'builtin' };
  }

  // Relative and absolute filesystem references.
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    return { kind: 'internal' };
  }

  // Any other URI-like scheme (file:, data:, http:, https:, npm:, bun:, drive letters like C:).
  if (SCHEME_PATTERN.test(specifier)) {
    return { kind: 'unsupported' };
  }

  // Scoped packages collapse to `@scope/package`; malformed scoped forms are rejected below.
  if (specifier.startsWith('@')) {
    return classifyScoped(specifier);
  }

  // Unscoped packages: the first path segment is the package root. A stray `@` (for example a
  // version specifier such as `pkg@1.2.3`) is not a valid package name.
  const root = specifier.split('/')[0] ?? '';

  if (root.length === 0 || root.includes('@')) {
    return { kind: 'unsupported' };
  }

  return { kind: 'external', packageName: root };
}

/**
 * Classify a scoped specifier (`@scope/package`), collapsing subpaths to the package root.
 *
 * Malformed scoped forms (`@scope`, `@scope/`, `@/pkg`) are rejected as unsupported rather than
 * inventing a package name.
 */
function classifyScoped(specifier: string): PackageSpecifier {
  const slashIndex = specifier.indexOf('/');

  if (slashIndex === -1) {
    // A bare `@` with no package part.
    return { kind: 'unsupported' };
  }

  const scope = specifier.slice(1, slashIndex);
  const rest = specifier.slice(slashIndex + 1);
  const packageRoot = rest.split('/')[0] ?? '';

  if (scope.length === 0 || packageRoot.length === 0 || packageRoot.includes('@')) {
    return { kind: 'unsupported' };
  }

  return { kind: 'external', packageName: `@${scope}/${packageRoot}` };
}

/**
 * Whether a specifier contains a character that can never appear in a package reference.
 *
 * These are checked before structural parsing so a stray `?`, `#`, `%`, backslash or whitespace
 * anywhere in the specifier is rejected consistently, for both scoped and unscoped forms.
 */
function isMalformed(specifier: string): boolean {
  return (
    /\s/.test(specifier) ||
    specifier.includes('\\') ||
    specifier.includes('#') ||
    specifier.includes('?') ||
    specifier.includes('%')
  );
}
