/**
 * Static module specifier extraction.
 *
 * This module reads JavaScript/TypeScript source text and returns the statically knowable module
 * specifiers it contains, without executing the code and without a heavyweight parser dependency.
 *
 * It deliberately does not:
 * - decide whether a specifier is an external package, a Node builtin, relative, missing or used
 *   (that belongs to later steps);
 * - normalize specifiers, sort or deduplicate them;
 * - resolve anything on disk or through path aliases / bundler aliases.
 *
 * The occurrences are returned in source encounter order and are not deduplicated: deduplication
 * belongs to the analysis step, not to extraction.
 *
 * Instead of a few global regexes over raw source, this module runs a small lexical scanner with
 * just enough JavaScript awareness to identify the required forms while ignoring comments, strings,
 * template literal text and regex literals so they never produce false findings. JavaScript inside
 * template interpolations (`${...}`) is still lexed, so specifiers there are found.
 */

/**
 * The kind of module construct a specifier came from.
 */
export type ModuleSpecifierKind = 'import' | 'export-from' | 'dynamic-import' | 'require';

/**
 * A single statically extracted specifier together with the construct that produced it.
 */
export type ModuleSpecifierOccurrence = {
  readonly specifier: string;
  readonly kind: ModuleSpecifierKind;
};

/**
 * Error code for the module specifier scanner.
 *
 * - `invalid-source`: the source reached a lexical state from which the scanner cannot safely
 *   determine where the current lexical construct ends (an unterminated string/comment/template/
 *   regex, or a malformed string escape).
 */
export type ModuleSpecifierErrorCode = 'invalid-source';

/**
 * Operational error for module specifier extraction.
 *
 * It is thrown only when the source cannot be scanned safely, so callers (later steps) can treat a
 * file as un-analysable rather than trusting a partial result.
 */
export class ModuleSpecifierError extends Error {
  readonly code: ModuleSpecifierErrorCode;
  readonly offset: number;

  constructor(message: string, code: ModuleSpecifierErrorCode, offset: number) {
    super(message);
    this.name = 'ModuleSpecifierError';
    this.code = code;
    this.offset = offset;
  }
}

/**
 * Extract the statically knowable module specifiers from `source`.
 *
 * The returned occurrences preserve source order and are not deduplicated.
 *
 * @throws {ModuleSpecifierError} when the source reaches an unterminated or malformed lexical state
 *   from which the scanner cannot safely continue.
 */
export function extractModuleSpecifiers(source: string): readonly ModuleSpecifierOccurrence[] {
  return interpret(tokenize(source));
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                  */
/* -------------------------------------------------------------------------- */

type Token =
  | { readonly kind: 'identifier'; readonly value: string; readonly offset: number }
  | { readonly kind: 'string'; readonly value: string; readonly offset: number }
  | { readonly kind: 'number'; readonly offset: number }
  | { readonly kind: 'punct'; readonly value: string; readonly offset: number }
  | { readonly kind: 'regex' }
  | { readonly kind: 'template' };

type PrevKind = 'start' | 'identifier' | 'number' | 'string' | 'punct' | 'regex' | 'template';

/**
 * Turn source into a stream of significant tokens, skipping whitespace, line/block comments, regex
 * literals and template literals.
 */
function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  // Whether the previous identifier token is an expression-starting keyword (return, typeof, ...).
  // Such keywords start an expression, so a following `/` begins a regex rather than division.
  let prevIsExpressionKeyword = false;

  // Hashbang: only at offset 0. Ignore until the first line terminator.
  if (source.startsWith('#!')) {
    i = 2;
    while (i < n && !isLineTerminator(source[i])) {
      i++;
    }
  }

  // The previous significant token drives the regex-vs-division decision for `/`.
  let prevKind: PrevKind = 'start';
  // The value of the previous punctuation token, when the previous token was punctuation.
  let prevPunct: string | undefined;

  // Template literal state. `inText` is true while scanning template text that must not be lexed as
  // JavaScript; a backtick toggles it, so nested templates are handled by the toggle. Every open
  // `${...}` expression pushes its own brace depth onto `braceDepths`, which is what distinguishes
  // the `}` that closes the interpolation from a `}` belonging to an object literal, a block or a
  // function body inside it. JavaScript inside `${...}` is lexed like ordinary source.
  const braceDepths: number[] = [];
  let inText = false;
  // Offset of the opening backtick of the current template, for unterminated-template errors.
  let templateStart = 0;

  // Regex-after-`)` heuristic. `afterControlHead` is true when the most recent `)` closed the head
  // of a control statement (if/while/for/with), so a following `/` may start a regex literal.
  let afterControlHead = false;
  // The control keyword pending a `(` (if/while/for/with), so the matching `)` can be recognised.
  // Only whitespace and comments may appear between the keyword and the `(`.
  let pendingControlKeyword: string | undefined;
  // How many `(` are currently open, and the depth at which the open control-statement head sits,
  // so only the `)` that closes the head itself (not a nested one) enables the heuristic.
  let parenDepth = 0;
  let controlParenDepth: number | undefined;

  // Reset the expression-start state at the beginning of a fresh `${...}` expression.
  const resetExpressionState = (): void => {
    prevKind = 'start';
    prevPunct = undefined;
    prevIsExpressionKeyword = false;
    afterControlHead = false;
    pendingControlKeyword = undefined;
  };

  while (i < n) {
    const ch = source[i];

    if (ch === undefined) {
      i++;
      continue;
    }

    // Template literal text: skip everything until `${`, a nested `` ` ``, or the closing `` ` ``.
    // A backtick toggles out of text mode; the matching toggle happens below in code mode.
    if (inText) {
      if (ch === '\\') {
        i += 2;
        continue;
      }

      if (ch === '`') {
        // Closing backtick of the current (or nested) template literal.
        inText = false;
        prevKind = 'template';
        i++;
        continue;
      }

      if (ch === '$' && source[i + 1] === '{') {
        // Start of a `${...}` expression: lex the JavaScript inside like ordinary source. The frame
        // starts at brace depth 0, so the next unmatched `}` closes the interpolation.
        braceDepths.push(0);
        inText = false;
        resetExpressionState();
        i += 2;
        continue;
      }

      i++;
      continue;
    }

    if (isWhitespace(ch)) {
      i++;
      continue;
    }

    // Line comment: it ends at any ECMAScript line terminator (LF, CR, LS or PS), not only `\n`.
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && !isLineTerminator(source[i])) {
        i++;
      }

      continue;
    }

    // Block comment. Comments are transparent to the regex/division heuristic, so a comment between
    // a control keyword and its `(` behaves exactly like whitespace.
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
      continue;
    }

    // A backtick in code mode opens a (possibly nested) template literal.
    if (ch === '`') {
      templateStart = i;
      inText = true;
      prevKind = 'template';
      i++;
      continue;
    }

    // A `}` in code mode closes the innermost open `${...}` expression only when that expression has
    // no open braces of its own; otherwise it is an ordinary brace inside the expression.
    if (ch === '}') {
      const depth = braceDepths[braceDepths.length - 1];

      if (depth !== undefined) {
        if (depth === 0) {
          braceDepths.pop();
          i++;
          inText = true;
          resetExpressionState();
          continue;
        }

        braceDepths[braceDepths.length - 1] = depth - 1;
      }
      // Otherwise `}` is an ordinary object-literal punctuation token.
    }

    // `/` is a regex when it can start an expression, otherwise it is division.
    if (ch === '/') {
      if (isRegexStart(prevKind, prevPunct, prevIsExpressionKeyword, afterControlHead)) {
        i = skipRegex(source, i);
        prevKind = 'regex';
        afterControlHead = false;
        pendingControlKeyword = undefined;
        continue;
      }

      tokens.push({ kind: 'punct', value: '/', offset: i });
      prevKind = 'punct';
      prevPunct = '/';
      afterControlHead = false;
      pendingControlKeyword = undefined;
      i++;
      continue;
    }

    // String literals (single or double quoted).
    if (ch === "'" || ch === '"') {
      const { value, next } = readString(source, i);
      tokens.push({ kind: 'string', value, offset: i });
      prevKind = 'string';
      afterControlHead = false;
      pendingControlKeyword = undefined;
      i = next;
      continue;
    }

    // Identifiers.
    if (isIdentifierStart(ch)) {
      const start = i;
      i++;
      while (i < n) {
        const part = source[i];

        if (part === undefined || !isIdentifierPart(part)) {
          break;
        }

        i++;
      }

      const value = source.slice(start, i);
      // A keyword after `.` is a property name (e.g. `x.return`), not an expression start.
      prevIsExpressionKeyword =
        REGEX_PRECEDING_KEYWORDS.has(value) && !(prevKind === 'punct' && prevPunct === '.');
      // Remember a control-statement keyword until its `(` is seen. After `.` the identifier is a
      // property name (e.g. `obj.if(...)`), so it must not be tracked as a control head: doing so
      // would let the member call's `)` claim the regex-after-control-head state.
      pendingControlKeyword =
        CONTROL_HEAD_KEYWORDS.has(value) && !(prevKind === 'punct' && prevPunct === '.')
          ? value
          : undefined;
      tokens.push({ kind: 'identifier', value, offset: start });
      prevKind = 'identifier';
      afterControlHead = false;
      continue;
    }

    // Numbers end an expression, so they affect the regex/division decision.
    if (isNumberStart(ch)) {
      const start = i;
      i++;
      while (i < n) {
        const part = source[i];

        if (part === undefined || !(isIdentifierPart(part) || part === '.')) {
          break;
        }

        i++;
      }

      tokens.push({ kind: 'number', offset: start });
      prevKind = 'number';
      afterControlHead = false;
      pendingControlKeyword = undefined;
      continue;
    }

    // Any other single character is punctuation.
    if (ch === '{') {
      // Count the brace inside the innermost open `${...}` expression so its closing `}` is found.
      const depth = braceDepths[braceDepths.length - 1];

      if (depth !== undefined) {
        braceDepths[braceDepths.length - 1] = depth + 1;
      }
    } else if (ch === '(') {
      // A `(` after a control keyword opens a control head; only its matching `)` may then be
      // followed by a regex literal, so the nesting depth of every `(` has to be tracked.
      parenDepth++;

      if (pendingControlKeyword !== undefined) {
        controlParenDepth = parenDepth;
        pendingControlKeyword = undefined;
      }

      afterControlHead = false;
    } else if (ch === ')') {
      afterControlHead = controlParenDepth !== undefined && parenDepth === controlParenDepth;

      if (afterControlHead) {
        controlParenDepth = undefined;
      }

      if (parenDepth > 0) {
        parenDepth--;
      }
    }

    tokens.push({ kind: 'punct', value: ch, offset: i });
    prevKind = 'punct';
    prevPunct = ch;
    i++;
  }

  // Reaching the end of the source while inside a template text or an open `${...}` expression means
  // the template literal was never closed.
  if (inText || braceDepths.length > 0) {
    throw new ModuleSpecifierError(
      'Unterminated template literal',
      'invalid-source',
      templateStart,
    );
  }

  return tokens;
}

/**
 * Significant token kinds that clearly terminate an expression. After one of these, `/` is
 * division; otherwise it may start a regex literal.
 */
const EXPRESSION_ENDING: ReadonlySet<PrevKind> = new Set([
  'identifier',
  'number',
  'string',
  'template',
  'regex',
]);

/**
 * Expression-starting keywords. After one of these, a `/` begins a regex literal even though the
 * keyword itself is tokenized as an identifier. `of`, `yield` and `await` are intentionally
 * excluded: they are valid identifiers in some contexts, so `/` after them may be division.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
]);

// Control-statement heads whose closing `)` may be followed by a regex literal.
const CONTROL_HEAD_KEYWORDS: ReadonlySet<string> = new Set(['if', 'while', 'for', 'with']);

/**
 * Whether a `/` (not already a comment) may begin a regex literal, given the previous significant
 * token. `)` and `]` punctuation also end an expression (division), so any other punctuation (or
 * the start of the file) may start a regex. The one exception is a `/` after the `)` that closes a
 * control-statement head (if/while/for/with), which may start a regex literal.
 */
function isRegexStart(
  prevKind: PrevKind,
  prevPunct: string | undefined,
  prevIsExpressionKeyword: boolean,
  afterControlHead: boolean,
): boolean {
  if (prevKind === 'identifier' && prevIsExpressionKeyword) {
    return true;
  }

  if (EXPRESSION_ENDING.has(prevKind)) {
    return false;
  }

  if (prevKind === 'punct') {
    if (afterControlHead && prevPunct === ')') {
      return true;
    }

    return prevPunct !== ')' && prevPunct !== ']';
  }

  return true;
}

/* -------------------------------------------------------------------------- */
/* Interpretation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Walk the significant tokens and record specifiers for the required import/export/require forms.
 */
function interpret(tokens: readonly Token[]): ModuleSpecifierOccurrence[] {
  const occurrences: ModuleSpecifierOccurrence[] = [];
  const n = tokens.length;
  let i = 0;

  while (i < n) {
    const token = tokens[i];

    if (token?.kind !== 'identifier') {
      i++;
      continue;
    }

    if (token.value === 'import') {
      i = handleImport(tokens, i, occurrences);
      continue;
    }

    if (token.value === 'export') {
      i = handleExport(tokens, i, occurrences);
      continue;
    }

    if (token.value === 'require') {
      i = handleRequire(tokens, i, occurrences);
      continue;
    }

    i++;
  }

  return occurrences;
}

/**
 * Handle an `import` identifier. Returns the next index to scan from.
 *
 * - `obj.import(...)` is ignored (a member call, preceded by `.`).
 * - `import.meta` is ignored (treated as `import` followed by `.`).
 * - `import 'pkg'` and `import ... from 'pkg'` are `import`.
 * - `import('pkg')` is `dynamic-import` only when the sole argument is a static string.
 */
function handleImport(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
): number {
  const prev = tokens[i - 1];
  const next = tokens[i + 1];

  // `obj.import(...)`: a member call, not the import keyword.
  if (prev?.kind === 'punct' && prev.value === '.') {
    return i + 1;
  }

  // `import.meta` / `import .foo`: not a module import.
  if (next?.kind === 'punct' && next.value === '.') {
    return i + 1;
  }

  // `import 'pkg'`
  if (next?.kind === 'string') {
    occurrences.push({ specifier: next.value, kind: 'import' });
    return i + 2;
  }

  // `import('pkg')` / `import ('pkg')`: only a sole string argument closed by `)` is static.
  if (next?.kind === 'punct' && next.value === '(') {
    const specifier = soleStringSpecifier(tokens, i + 2);

    if (specifier !== undefined) {
      occurrences.push({ specifier, kind: 'dynamic-import' });
      return i + 3;
    }

    return i + 1;
  }

  // Static `import ... from 'pkg'`: scan forward for `from` followed by a string.
  return scanImportSource(tokens, i, occurrences, 'import');
}

/**
 * Handle an `export` identifier. `export ... from 'pkg'` is `export-from`.
 */
function handleExport(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
): number {
  return scanImportSource(tokens, i, occurrences, 'export-from');
}

/**
 * Scan forward from `i` looking for the `from` keyword followed by a string, recording it with
 * `kind`. Stops early at a nested `import`/`export`/`require` so a following construct is handled on
 * its own, except for `import`/`export` used as binding names inside the `{ ... }` clause of the
 * current statement (e.g. `import { export as v } from 'pkg'`).
 */
function scanImportSource(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
  kind: ModuleSpecifierKind,
): number {
  const n = tokens.length;
  let j = i + 1;
  // How many `{ ... }` named clauses of the current statement are open. `import`/`export` are legal
  // binding names inside such a clause (e.g. `import { export as v } from 'pkg'`), so they may only
  // start a new construct at depth 0, otherwise the search stops before the real `from` source.
  let braceDepth = 0;

  while (j < n) {
    const token = tokens[j];

    if (token?.kind === 'punct') {
      if (token.value === '{') {
        braceDepth++;
      } else if (token.value === '}') {
        // Clamped so an unmatched `}` cannot leave a negative depth that hides later boundaries.
        braceDepth = braceDepth > 0 ? braceDepth - 1 : 0;
      }
    }

    if (token?.kind === 'identifier') {
      const next = tokens[j + 1];

      // `import`/`export` only start a new construct outside the named clause. A `require`
      // identifier only starts one when it begins a direct call: a binding named `require` (e.g.
      // `import { require } from 'pkg'`) must not stop the search for the source that follows
      // `from`.
      if (
        (braceDepth === 0 && (token.value === 'import' || token.value === 'export')) ||
        (token.value === 'require' && next?.kind === 'punct' && next.value === '(')
      ) {
        break;
      }

      if (token.value === 'from' && next?.kind === 'string') {
        occurrences.push({ specifier: next.value, kind });
        return j + 2;
      }
    }

    j++;
  }

  // No source found; keep scanning from the next token.
  return i + 1;
}

/**
 * Handle a `require` identifier. `obj.require(...)` is ignored (preceded by `.`).
 * `require('pkg')` is `require` only when the sole argument is a static string.
 */
function handleRequire(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
): number {
  const prev = tokens[i - 1];

  // `obj.require(...)`: not the global CommonJS require.
  if (prev?.kind === 'punct' && prev.value === '.') {
    return i + 1;
  }

  const next = tokens[i + 1];

  // `require('pkg')`: only a sole string argument closed by `)` is static.
  if (next?.kind === 'punct' && next.value === '(') {
    const specifier = soleStringSpecifier(tokens, i + 2);

    if (specifier !== undefined) {
      occurrences.push({ specifier, kind: 'require' });
      return i + 3;
    }
  }

  return i + 1;
}

/**
 * The decoded string at `argIndex` when it is the only argument of the surrounding call, that is
 * when it is a string and the very next token closes the call with `)`. Returns undefined otherwise,
 * so a dynamic argument (e.g. `'pkg-' + name`) or a call with extra arguments (e.g.
 * `require('pkg', ctx)`) never yields a static specifier.
 */
function soleStringSpecifier(tokens: readonly Token[], argIndex: number): string | undefined {
  const arg = tokens[argIndex];
  const closing = tokens[argIndex + 1];

  if (arg?.kind !== 'string') {
    return undefined;
  }

  if (closing?.kind !== 'punct' || closing.value !== ')') {
    return undefined;
  }

  return arg.value;
}

/* -------------------------------------------------------------------------- */
/* Lexical constructs                                                         */
/* -------------------------------------------------------------------------- */

function skipBlockComment(source: string, start: number): number {
  const n = source.length;
  let i = start + 2;

  while (i < n) {
    if (source[i] === '*' && source[i + 1] === '/') {
      return i + 2;
    }

    i++;
  }

  throw new ModuleSpecifierError('Unterminated block comment', 'invalid-source', start);
}

function skipRegex(source: string, start: number): number {
  const n = source.length;
  let i = start + 1;
  let inClass = false;

  while (i < n) {
    const ch = source[i];

    // A regex literal cannot contain a raw line terminator. Rejecting it here stops a wrong regex
    // start from swallowing the following lines.
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
      throw new ModuleSpecifierError('Unterminated regex literal', 'invalid-source', start);
    }

    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (inClass) {
      if (ch === ']') {
        inClass = false;
      }

      i++;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      i++;
      continue;
    }

    if (ch === '/') {
      return skipRegexFlags(source, i + 1);
    }

    i++;
  }

  throw new ModuleSpecifierError('Unterminated regex literal', 'invalid-source', start);
}

function skipRegexFlags(source: string, i: number): number {
  const n = source.length;

  while (i < n) {
    const ch = source[i];

    if (ch === undefined || !/[a-z]/.test(ch)) {
      break;
    }

    i++;
  }

  return i;
}

/**
 * Read a single- or double-quoted string literal starting at `start`, decoding ordinary JS string
 * escapes to the specifier's semantic value. Returns the decoded value and the index just past the
 * closing quote.
 *
 * @throws {ModuleSpecifierError} on an unterminated string or a malformed escape sequence.
 */
function readString(source: string, start: number): { value: string; next: number } {
  const quote = source[start];
  const n = source.length;
  let i = start + 1;
  let out = '';

  while (i < n) {
    const ch = source[i];

    if (ch === '\\') {
      const decoded = decodeEscape(source, i);
      i = decoded.next;
      out += decoded.value;
      continue;
    }

    if (ch === quote) {
      return { value: out, next: i + 1 };
    }

    // A raw LF/CR inside a quoted string is invalid JavaScript; reject it instead of continuing to
    // scan (which would otherwise swallow later code as part of the string). Raw U+2028 and U+2029
    // are valid inside strings since ES2019, so they are kept as part of the value.
    if (ch === '\n' || ch === '\r') {
      throw new ModuleSpecifierError('Unterminated string literal', 'invalid-source', start);
    }

    if (ch !== undefined) {
      out += ch;
    }

    i++;
  }

  throw new ModuleSpecifierError('Unterminated string literal', 'invalid-source', start);
}

/**
 * Decode one escape sequence starting with a backslash at `start`.
 *
 * Returns the decoded character(s) and the index just past the escape. Line continuations are
 * dropped. A malformed escape throws.
 */
function decodeEscape(source: string, start: number): { value: string; next: number } {
  const n = source.length;
  const backslash = start;
  const i = start + 1; // past the backslash

  if (i >= n) {
    throw new ModuleSpecifierError('Unterminated string literal', 'invalid-source', backslash);
  }

  const e = source[i] ?? '';

  // Line continuation: a backslash before a line break (including the Unicode line separators
  // U+2028 and U+2029) is dropped from the decoded value.
  if (e === '\n' || e === '\u2028' || e === '\u2029') {
    return { value: '', next: i + 1 };
  }

  if (e === '\r') {
    return { value: '', next: source[i + 1] === '\n' ? i + 2 : i + 1 };
  }

  // Legacy octal escapes (`\0`-`\7` plus the following octal digits) are accepted and decoded: they
  // are valid in sloppy-mode CommonJS, and rejecting them would make a whole source un-analysable
  // even though the string has nothing to do with dependency detection. `\8` and `\9` fall through
  // to the identity rule below, which is exactly what Annex-B specifies for them.
  if (e >= '0' && e <= '7') {
    return decodeLegacyOctal(source, i);
  }

  const simple: Record<string, string> = {
    '\\': '\\',
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    v: '\v',
  };

  if (e === "'" || e === '"' || e === '`') {
    return { value: e, next: i + 1 };
  }

  const single = simple[e];

  if (single !== undefined) {
    return { value: single, next: i + 1 };
  }

  if (e === 'x') {
    return decodeHex(source, i + 1, 2);
  }

  if (e === 'u') {
    if (source[i + 1] === '{') {
      return decodeUnicodeBraced(source, i + 2);
    }

    return decodeHex(source, i + 1, 4);
  }

  // Any other character after a backslash evaluates to itself (e.g. `\q` is `q`, `\/` is `/`).
  return { value: e, next: i + 1 };
}

/**
 * Decode a legacy octal escape whose first digit (`0`-`7`) sits at `start`.
 *
 * The first digit bounds how many octal digits the escape may consume: `0`-`3` allow up to three
 * digits, `4`-`7` up to two. A lone `\0` decodes to NUL.
 */
function decodeLegacyOctal(source: string, start: number): { value: string; next: number } {
  const first = source[start] ?? '';
  const maxDigits = first >= '4' ? 2 : 3;
  let i = start;
  let digits = '';

  while (digits.length < maxDigits) {
    const digit = source[i];

    if (digit === undefined || digit < '0' || digit > '7') {
      break;
    }

    digits += digit;
    i++;
  }

  return { value: String.fromCharCode(parseInt(digits, 8)), next: i };
}

function decodeHex(source: string, start: number, length: number): { value: string; next: number } {
  const digits = source.slice(start, start + length);

  if (digits.length !== length || !/^[0-9a-fA-F]+$/.test(digits)) {
    throw new ModuleSpecifierError('Invalid hex escape', 'invalid-source', start);
  }

  return { value: String.fromCharCode(parseInt(digits, 16)), next: start + length };
}

function decodeUnicodeBraced(source: string, start: number): { value: string; next: number } {
  let i = start;
  let code = 0;

  while (i < source.length) {
    const hex = source[i];

    if (hex === undefined || !/[0-9a-fA-F]/.test(hex)) {
      break;
    }

    code = code * 16 + parseInt(hex, 16);

    // Stop accumulating once the value exceeds the maximum code point to avoid unbounded growth.
    if (code > 0x10ffff) {
      break;
    }

    i++;
  }

  // Reject empty braced escapes (`\u{}`) and code points above the maximum Unicode value.
  if (source[i] !== '}' || i === start || code > 0x10ffff) {
    throw new ModuleSpecifierError('Invalid \\u{...} escape', 'invalid-source', start);
  }

  return { value: String.fromCodePoint(code), next: i + 1 };
}

/* -------------------------------------------------------------------------- */
/* Character helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The characters that separate tokens: the ECMAScript `WhiteSpace` characters the scanner has to
 * accept between tokens (including NBSP and ZWNBSP/BOM) plus every `LineTerminator`. Only used for
 * the gap between tokens; string contents are handled by `readString`, so a raw U+2028/U+2029 inside
 * a quoted string stays valid source while a raw LF/CR there stays an error.
 */
function isWhitespace(ch: string): boolean {
  return (
    ch === ' ' ||
    ch === '\t' ||
    ch === '\v' ||
    ch === '\f' ||
    ch === '\u00A0' ||
    ch === '\uFEFF' ||
    isLineTerminator(ch)
  );
}

/**
 * The ECMAScript `LineTerminator` characters. Line comments and the hashbang end at any of them,
 * not only at `\n`. `undefined` (end of the source indexed past its end) is not a terminator.
 */
function isLineTerminator(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isNumberStart(ch: string): boolean {
  return /[0-9]/.test(ch);
}
