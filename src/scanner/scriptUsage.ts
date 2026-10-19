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
 * - map arbitrary shell binaries to packages; only the small, explicit `BINARY_TO_PACKAGE` list
 *   (currently `tsc` -> `typescript`) is ever translated, and only against declared packages;
 * - report missing dependencies (undeclared command tokens are ignored);
 * - inspect installed `bin` metadata, config, workspaces or framework detectors.
 *
 * The strings are treated as inert text. This module performs no I/O and has no side effects.
 *
 * Recognition is intentionally conservative:
 * - a shell segment's first effective command token counts only when that token is exactly a package
 *   name, so paths and package subpaths (`scripts/build.js`, `eslint/bin/cli`) are never usage
 *   evidence for the package they point into;
 * - the small explicit `BINARY_TO_PACKAGE` list translates a recognized direct executable (currently
 *   `tsc` -> `typescript`) to its declared package; every other command keeps exact-name matching.
 * - the five documented package-runner forms count (`npx`, `npm exec`, `pnpm exec`, `pnpm dlx`,
 *   `yarn dlx`) with the package in its immediate position;
 * - leading POSIX environment assignments (`NODE_ENV=test`, `FOO=1 BAR=2`) are skipped;
 * - quoted tokens keep their content, so separators and text inside quotes are not misread.
 *
 * Shell syntax this scanner does not understand invalidates the segment that contains it: single `&`
 * (background execution), redirection (`<`, `>`), command and parameter expansion (`$(...)`,
 * `${...}`), legacy backtick substitution and backslash escapes outside single quotes, plus a quote
 * that is still open at the end of the script. Each such region is consumed as an opaque block, so a
 * separator inside it never delimits the surrounding script. An invalidated segment yields no
 * evidence at all, while the neighbouring segments delimited by real supported separators are still
 * analyzed normally.
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
 *
 * `unsupported` is segment-local: once a segment contains shell syntax the scanner does not
 * understand, the whole segment stops producing evidence. It is reset by every real separator, so an
 * ambiguous construct never discards an independent neighbouring segment.
 */
type Segment = {
  readonly tokens: readonly Token[];
  readonly unsupported: boolean;
};

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
 * Explicit static executable -> declared-package mappings for supported direct command positions.
 *
 * A shell command position carries binaries and file paths, not package names, so this list is
 * strictly opt-in: each executable here is known to provide exactly the mapped package.
 * - `tsc` is the compiler front-end of the `typescript` package; the deprecated standalone `tsc`
 *   npm package is intentionally NOT treated as providing the TypeScript compiler.
 * - `docsify` is the executable provided by the `docsify-cli` package.
 * Only lowercase `tsc` and `docsify` map; runner forms such as `npx tsc` or `npx docsify` keep their
 * own (unmapped) semantics for now.
 *
 * The mapping is applied after safe command extraction and can only match a package that is actually
 * declared, so it can never create a missing-dependency finding. When both a bare package name and
 * its mapped package are declared (for example `docsify` and `docsify-cli`), only the declared
 * mapped package (`docsify-cli`) receives this evidence; the bare `docsify` package is unaffected
 * unless independent source or script evidence supports it.
 */
const BINARY_TO_PACKAGE: ReadonlyMap<string, string> = new Map([
  ['tsc', 'typescript'],
  ['docsify', 'docsify-cli'],
]);

/**
 * Recognize the declared dependencies that `package.json` scripts clearly reference.
 *
 * For every script command the module collects the package names that have clear static usage
 * evidence (a command token, a recognized executable mapped through `BINARY_TO_PACKAGE`, or a
 * supported runner package position) and keeps only those that are present in
 * {@link declaredPackageNames}. Undeclared command tokens and undeclared mapped packages are ignored:
 * this module never creates missing-dependency findings.
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
 * form, or the segment's first effective command token when that token is exactly a package name.
 * Segments containing unsupported shell syntax contribute nothing.
 */
function collectScriptCandidates(command: string): readonly string[] {
  const candidates: string[] = [];

  for (const segment of splitSegments(command)) {
    // An unsupported segment is never partially trusted, not even its leading command.
    if (segment.unsupported) {
      continue;
    }

    const significant = skipLeadingAssignments(segment.tokens);

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

    // Only the first effective command token is inspected, and it must be exactly the package root.
    // Shell command position carries binaries and file paths, so a package subpath such as
    // `eslint/bin/cli` or a script path such as `scripts/build.js` is never usage evidence.
    const classification = classifyPackageSpecifier(commandName);
    if (classification.kind === 'external' && commandName === classification.packageName) {
      // An explicit executable mapping takes precedence over same-name matching: `tsc` resolves to
      // the declared `typescript` package only, never to a hypothetical `tsc` package, so a single
      // executable yields at most one piece of usage evidence.
      const mapped = BINARY_TO_PACKAGE.get(commandName);
      candidates.push(mapped ?? commandName);
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
 * Split a script string into segments on the supported separators (`&&`, `||`, `;`, `|`, newline
 * outside quotes).
 *
 * The scanner only needs enough shell awareness to preserve quoted tokens, to keep separators and
 * text inside quotes from being misread, and to detect the syntax it refuses to interpret. It never
 * executes, expands or substitutes anything.
 *
 * Unsupported constructs (single `&`, redirection, `$(...)`, `${...}`, quotes left open at the end of
 * the script) mark the current segment as unsupported instead of guessing tokens from inside it. The
 * marker is reset by the next real separator, so invalidation stays local to the affected segment.
 */
function splitSegments(script: string): readonly Segment[] {
  const segments: Segment[] = [];
  let tokens: readonly Token[] = [];
  let unsupported = false;
  let i = 0;
  const length = script.length;

  // A real separator ends the current segment and clears its unsupported marker.
  const flush = (): void => {
    segments.push({ tokens, unsupported });
    tokens = [];
    unsupported = false;
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

    // Supported separators. `&&`/`||` are two-character; `;`, `|` and newline are single-character.
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

    // A single `&` is background execution, which is unsupported in v0.1.0. It deliberately does not
    // behave like `&&`: it never splits the segment, it only invalidates it, so `eslint & prettier`
    // yields no evidence instead of two independently trusted commands.
    if (ch === '&') {
      if (script[i + 1] === '&') {
        i += 2;
        flush();
      } else {
        i += 1;
        unsupported = true;
      }
      continue;
    }

    // Every other character starts an unquoted token. The token scan consumes exactly the characters
    // of one token, so it always advances at least one position here.
    const scanned = scanToken(script, i);
    if (scanned.unsupported) {
      unsupported = true;
    }
    if (scanned.text.length > 0) {
      tokens = [...tokens, { value: scanned.text }];
    }
    i = scanned.next;
  }

  segments.push({ tokens, unsupported });
  return segments;
}

/**
 * One unquoted token: its text, the index to continue from, and whether it holds unsupported syntax.
 */
type ScannedToken = {
  readonly text: string;
  readonly next: number;
  readonly unsupported: boolean;
};

/**
 * Scan a single unquoted token starting at `start`.
 *
 * Quoted runs inside the token are consumed with their content kept verbatim, so `"eslint"`,
 * `FOO="a;b"` and `echo "a && b"` tokenize safely. Redirection and shell expansion are reported as
 * unsupported rather than interpreted, and a quote left open at the end of the script drops the
 * partially accumulated token entirely.
 */
function scanToken(script: string, start: number): ScannedToken {
  let value = '';
  let unsupported = false;
  let i = start;

  while (i < script.length) {
    const ch = script[i];
    if (ch === undefined) {
      break;
    }

    if (isWhitespace(ch) || ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      break;
    }

    // Redirection is not parsed in v0.1.0; its presence alone invalidates the segment.
    if (ch === '<' || ch === '>') {
      unsupported = true;
      i += 1;
      continue;
    }

    // `$(...)`, `${...}` and backticks are never parsed or expanded here. The whole region is
    // consumed as an opaque block so that separators (`;`, `|`, `&&`, newline) found inside it can
    // never reach the outer segment logic and flush the current segment.
    if (isUnsupportedRegionStart(script, i)) {
      unsupported = true;
      i = skipUnsupportedRegion(script, i);
      continue;
    }

    // Outside single quotes a backslash escapes the following character, so that character can never
    // act as a separator. The pair is consumed together; its exact meaning is irrelevant here.
    if (ch === '\\') {
      unsupported = true;
      value += ch + (script[i + 1] ?? '');
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const run = scanQuoted(script, i + 1, ch);
      if (run.open) {
        // EOF before the quote closes: the segment is invalid and the partial token is dropped.
        return { text: '', next: run.next, unsupported: true };
      }
      if (run.expands) {
        unsupported = true;
      }
      value += run.text;
      i = run.next;
      continue;
    }

    value += ch;
    i += 1;
  }

  return { text: value, next: i, unsupported };
}

/**
 * A quoted run that starts right after the opening quote.
 *
 * `open` reports a quote that was never closed before the end of the script. `expands` reports shell
 * expansion that is still active inside double quotes; single quotes are fully literal.
 */
type QuotedRun = {
  readonly text: string;
  readonly next: number;
  readonly open: boolean;
  readonly expands: boolean;
};

/**
 * Consume a quoted run, keeping its content verbatim.
 *
 * Separators and redirection characters inside quotes stay literal text. Single quotes are fully
 * literal. Inside double quotes `$(...)`, `${...}`, backticks and a backslash count as expansion or
 * escape and invalidate the segment; each such region is still consumed as an opaque block. Newlines
 * are literal in both quote forms, so a quoted string may span several lines; only an unclosed quote
 * at the end of the script is malformed.
 */
function scanQuoted(script: string, start: number, quote: string): QuotedRun {
  const doubleQuoted = quote === '"';
  let text = '';
  let expands = false;
  let i = start;

  while (i < script.length) {
    const ch = script[i];
    if (ch === undefined) {
      break;
    }

    if (ch === quote) {
      return { text, next: i + 1, open: false, expands };
    }

    if (doubleQuoted && isUnsupportedRegionStart(script, i)) {
      // Inside double quotes, `$(...)`, `${...}` and backticks are real expansion. The region is
      // consumed as an opaque block so its inner separators never reach the outer segment, while the
      // expansion itself still invalidates the segment.
      expands = true;
      i = skipUnsupportedRegion(script, i);
      continue;
    }

    // Inside double quotes a backslash escapes the following character, so that character can never
    // close the quoted run. The pair is consumed together and invalidates the segment.
    if (doubleQuoted && ch === '\\') {
      expands = true;
      text += ch + (script[i + 1] ?? '');
      i += 2;
      continue;
    }

    text += ch;
    i += 1;
  }

  return { text, next: i, open: true, expands };
}

/**
 * Whether the character right after `$` opens a shell expansion (`$(` or `${`).
 */
function opensExpansion(next: string | undefined): boolean {
  return next === '(' || next === '{';
}

/**
 * Whether an unsupported opaque region starts at `index`: `$(`, `${` or a legacy backtick.
 */
function isUnsupportedRegionStart(script: string, index: number): boolean {
  const ch = script[index];
  if (ch === '`') {
    return true;
  }

  return ch === '$' && opensExpansion(script[index + 1]);
}

/**
 * The delimiter that closes an open region: `)` for `$(`, `}` for `${`, a backtick for a legacy
 * command substitution, and the two quote characters for a quoted run.
 */
type RegionDelimiter = ')' | '}' | '`' | '"' | "'";

/**
 * Skip one unsupported shell region starting at `start`, which must point at `$(`, `${` or a
 * backtick, and return the index just past its matching closing delimiter.
 *
 * The region is consumed opaquely: its contents are never interpreted, so separators found inside it
 * can never flush the outer segment. Every open region is pushed onto a stack, which keeps mixed
 * nesting balanced (`${A:-$(...)}`, `$(echo ${X})`, ``${X:-`cmd`}``) no matter which delimiter type
 * opened it. Quoted runs are stack entries too, so a closing delimiter inside a quote never ends a
 * region early, and a backslash consumes the character after it so an escaped `\)`, `\}` or backtick
 * cannot close a region either. A single quote is literal text inside a double-quoted run, which is
 * the one quote form that does not nest.
 *
 * If EOF is reached first the region is unterminated and `script.length` is returned, leaving the
 * current outer segment unsupported. This never interprets shell semantics; it only locates opaque
 * region boundaries safely.
 */
function skipUnsupportedRegion(script: string, start: number): number {
  const length = script.length;
  const stack: RegionDelimiter[] = [];

  const first = script[start];
  const second = script[start + 1];
  let i: number;
  if (first === '`') {
    stack.push('`');
    i = start + 1;
  } else if (first === '$' && (second === '(' || second === '{')) {
    stack.push(second === '(' ? ')' : '}');
    i = start + 2;
  } else {
    // Not a region opener; advance by one so a caller can never loop forever.
    return start + 1;
  }

  while (i < length && stack.length > 0) {
    const ch = script[i];
    if (ch === undefined) {
      break;
    }

    const top = stack.at(-1);

    // Inside single quotes everything is literal, so only the closing single quote is special.
    if (top === "'") {
      if (ch === "'") {
        stack.pop();
      }
      i += 1;
      continue;
    }

    // A backslash consumes the next character in `$()`, `${}`, backticks and double quotes.
    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      // A single quote is literal text inside a double-quoted run, so it must never open a region of
      // its own. Doing so would keep the outer double quote open until EOF and hide the separators
      // that follow it.
      if (ch === "'" && top === '"') {
        i += 1;
        continue;
      }
      // A double quote closes only the quoted run it opened; any other quote opens a literal run.
      if (ch === '"' && top === '"') {
        stack.pop();
      } else {
        stack.push(ch);
      }
      i += 1;
      continue;
    }

    const next = script[i + 1];
    if (ch === '$' && opensExpansion(next)) {
      stack.push(next === '(' ? ')' : '}');
      i += 2;
      continue;
    }

    if (ch === '`') {
      if (top === '`') {
        stack.pop();
      } else {
        stack.push('`');
      }
      i += 1;
      continue;
    }

    // `)` and `}` close only a matching region; otherwise they are inert region content.
    if ((ch === ')' || ch === '}') && ch === top) {
      stack.pop();
    }
    i += 1;
  }

  // An empty stack means the outermost region closed just before `i`; otherwise EOF arrived first.
  return stack.length === 0 ? i : length;
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
