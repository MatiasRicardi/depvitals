/**
 * Basic package.json script usage detection.
 *
 * This module answers exactly one narrow question: which declared dependencies are referenced by
 * the static strings found in a project's `package.json` `scripts`? It turns those strings into a
 * conservative set of package names that have clear static usage evidence, so later steps can avoid
 * reporting them as unused.
 *
 * It deliberately does not:
 * - execute, expand, substitute, resolve, spawn, source or evaluate anything;
 * - shell-out, read the filesystem or consult `node_modules`;
 * - map shell binaries to packages (`tsc` is never treated as `typescript`);
 * - report missing dependencies (undeclared command tokens are ignored);
 * - inspect installed `bin` metadata, config, workspaces or framework detectors.
 *
 * The strings are treated as inert text. This module performs no I/O and has no side effects.
 *
 * Recognition is intentionally conservative for `v0.1.0`:
 * - a shell segment's first effective command token may count, when it is a declared package name
 *   (or a declared package subpath, normalized by the specifier classifier);
 * - the five documented package-runner forms count (`npx`, `npm exec`, `pnpm exec`, `pnpm dlx`,
 *   `yarn dlx`) with the package in its immediate position;
 * - leading POSIX environment assignments (`NODE_ENV=test`, `FOO=1 BAR=2`) are skipped;
 * - quoted tokens keep their content, so separators and text inside quotes are not misread.
 *
 * Anything ambiguous (unterminated quotes, `$(...)`, `${...}`, single `&`, redirection, ...) fails
 * conservatively: the affected segment simply yields no evidence instead of a guessed token.
 */

import { classifyPackageSpecifier } from './packageSpecifier.js';

/**
 * A single lexical token produced by the script scanner.
 *
 * `value` is the token content with surrounding quotes removed. A quoted token such as `'prettier'`
 * yields the value `prettier`; an assignment token such as `FOO="a;b"` yields `FOO=a;b`.
 */
type Token = { readonly value: string };

/**
 * One command segment delimited by a supported separator (`&&`, `||`, `;`, `|`, newline).
 */
type Segment = readonly Token[];

/**
 * Package-manager command words that are never evidence that the manager itself is a used dependency.
 *
 * Invoked without a supported runner form (for example `npm run build`, `pnpm test`, `yarn lint`),
 * they do not prove usage of a declared dependency. The package they actually run (if any) is what
 * may count, and only through the supported runner forms above.
 */
const PACKAGE_MANAGER_COMMANDS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn', 'npx']);

/**
 * Leading POSIX-style environment assignment prefix, e.g. `NODE_ENV=`, `FOO=`.
 *
 * Only the name part is matched; the value (quoted or not) is consumed by the tokenizer.
 */
const ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Recognize the declared dependencies that `package.json` scripts clearly reference.
 *
 * For every script command the module collects the package names that have clear static usage
 * evidence (a command token or a supported runner package position) and keeps only those that are
 * present in {@link declaredPackageNames}. Undeclared command tokens are ignored: this module never
 * creates missing-dependency findings.
 *
 * The result is built in alphabetical package-name order so iteration is deterministic. Neither
 * {@link scripts} nor {@link declaredPackageNames} is mutated.
 *
 * @param scripts - `package.json` `scripts` entries as static strings (never executed).
 * @param declaredPackageNames - the declared dependency names that may be suppressed as used.
 */
export function findPackageScriptUsage(
  scripts: Readonly<Record<string, string>>,
  declaredPackageNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const used = new Set<string>();

  for (const command of Object.values(scripts)) {
    for (const candidate of collectScriptCandidates(command)) {
      if (declaredPackageNames.has(candidate)) {
        used.add(candidate);
      }
    }
  }

  return new Set([...used].sort(compareNames));
}

/**
 * Collect the package-name candidates referenced by a single script command.
 *
 * Each shell segment contributes at most one candidate: the package supplied to a supported runner
 * form, or the normalized package root of the segment's first effective command token.
 */
function collectScriptCandidates(command: string): readonly string[] {
  const candidates: string[] = [];

  for (const segment of splitSegments(command)) {
    const significant = skipLeadingAssignments(segment);

    if (significant.length === 0) {
      continue;
    }

    const runnerPackage = matchRunnerPackage(significant);
    if (runnerPackage !== undefined) {
      candidates.push(runnerPackage);
      continue;
    }

    // A package manager invoked without a supported runner form is never evidence that the manager
    // itself is a used dependency.
    const commandName = significant[0]?.value;
    if (commandName === undefined) {
      continue;
    }

    if (PACKAGE_MANAGER_COMMANDS.has(commandName)) {
      continue;
    }

    // Only the first effective command token is inspected. It is normalized to its package root so
    // that `some-package/subpath` counts as `some-package`, while filesystem paths never do.
    const classification = classifyPackageSpecifier(commandName);
    if (classification.kind === 'external') {
      candidates.push(classification.packageName);
    }
  }

  return candidates;
}

/**
 * Drop leading `VAR=value` assignments so the first real command token can be inspected.
 */
function skipLeadingAssignments(segment: readonly Token[]): readonly Token[] {
  let index = 0;

  while (index < segment.length) {
    const token = segment[index];
    if (token === undefined || !ASSIGNMENT_PATTERN.test(token.value)) {
      break;
    }
    index += 1;
  }

  return segment.slice(index);
}

/**
 * Recognize the package position of the five supported runner forms.
 *
 * Returns the package token only when it appears in the expected immediate position. Forms that add
 * flags, `--package` options or version/tags (for example `npx --no-install eslint`) return
 * `undefined` and fall back to command-token handling.
 */
function matchRunnerPackage(significant: readonly Token[]): string | undefined {
  const command = significant[0]?.value;

  if (command === 'npx') {
    return significant[1]?.value;
  }

  if (command === 'npm') {
    return significant[1]?.value === 'exec' ? significant[2]?.value : undefined;
  }

  if (command === 'pnpm') {
    const subcommand = significant[1]?.value;
    return subcommand === 'exec' || subcommand === 'dlx' ? significant[2]?.value : undefined;
  }

  if (command === 'yarn') {
    return significant[1]?.value === 'dlx' ? significant[2]?.value : undefined;
  }

  return undefined;
}

/**
 * Split a script string into segments on the supported separators (`&&`, `||`, `;`, `|`, newline).
 *
 * The scanner only needs enough shell awareness to preserve quoted tokens and to keep separators and
 * text inside quotes from being misread. It never executes, expands or substitutes anything.
 *
 * Ambiguous constructs (unterminated quotes, `$(...)`, `${...}`, single `&`, redirection, ...) fail
 * conservatively: the affected segment is dropped and no token is guessed from inside it.
 */
function splitSegments(script: string): readonly Segment[] {
  const segments: Segment[] = [];
  let segment: readonly Token[] = [];
  let i = 0;
  const length = script.length;

  const flush = (): void => {
    segments.push(segment);
    segment = [];
  };

  while (i < length) {
    const ch = script[i];
    if (ch === undefined) {
      break;
    }

    // Whitespace separates tokens within a segment.
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    // Segment separators. `&&`/`||` are two-character; `;`, `|` and newline are single-character.
    // Single `&` (background execution, `2>&1`) is intentionally not a separator in v0.1.0.
    if (ch === ';' || ch === '\n') {
      i += 1;
      flush();
      continue;
    }

    if (ch === '|') {
      i += script[i + 1] === '|' ? 2 : 1;
      flush();
      continue;
    }

    if (ch === '&') {
      i += script[i + 1] === '&' ? 2 : 1;
      flush();
      continue;
    }

    // Accumulate one unquoted token. Quoted runs inside the token are consumed and their content
    // kept verbatim, so `"eslint"`, `FOO="a;b"` and `echo "a && b"` tokenize safely.
    let value = '';
    while (i < length) {
      const c = script[i];
      if (c === undefined) {
        break;
      }

      if (isWhitespace(c) || c === ';' || c === '\n' || c === '|' || c === '&') {
        break;
      }

      if (c === '"' || c === "'") {
        const quote = c;
        i += 1; // skip the opening quote
        while (i < length) {
          const inner = script[i];
          if (inner === undefined) {
            break; // unterminated quote at EOF
          }
          if (inner === quote) {
            i += 1; // consume the closing quote
            break;
          }
          // An unterminated quote terminated by a newline is malformed: drop this segment.
          if (inner === '\n') {
            segment = [];
            i += 1;
            break;
          }
          value += inner;
          i += 1;
        }
        continue;
      }

      value += c;
      i += 1;
    }

    if (value.length > 0) {
      segment = [...segment, { value }];
    }
  }

  segments.push(segment);
  return segments;
}

/**
 * Whether a character is whitespace (spaces, tabs, CR, FF, VT).
 */
function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v';
}

/**
 * Locale-independent lexicographic ordering, so the same scripts always yield the same order.
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
