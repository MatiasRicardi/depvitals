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

  // Hashbang: only at offset 0. Ignore until the first line break.
  if (source.startsWith('#!')) {
    i = 2;
    while (i < n && source[i] !== '\n' && source[i] !== '\r') {
      i++;
    }
  }

  // The previous significant token drives the regex-vs-division decision for `/`.
  let prevKind: PrevKind = 'start';
  // The value of the previous punctuation token, when the previous token was punctuation.
  let prevPunct: string | undefined;

  // Template literal state. `exprDepth` counts the open `${...}` expressions on the current stack;
  // `inText` is true while scanning template text that must not be lexed as JavaScript. A backtick
  // toggles `inText`, so nested templates are handled by the toggle. JavaScript inside `${...}` is
  // lexed like ordinary source.
  let exprDepth = 0;
  let inText = false;
  // Offset of the opening backtick of the current template, for unterminated-template errors.
  let templateStart = 0;

  // Regex-after-`)` heuristic. `afterControlHead` is true when the most recent `)` closed the head
  // of a control statement (if/while/for/with), so a following `/` may start a regex literal.
  let afterControlHead = false;
  // The control keyword pending a `(` (if/while/for/with), so the matching `)` can be recognised.
  let pendingControlKeyword: string | undefined;
  // Whether the most recent `(` opened a control-statement head.
  let openControlParen = false;

  // Reset the expression-start state at the beginning of a fresh `${...}` expression.
  const resetExpressionState = (): void => {
    prevKind = 'start';
    prevPunct = undefined;
    prevIsExpressionKeyword = false;
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
        // Start of a `${...}` expression: lex the JavaScript inside like ordinary source.
        exprDepth++;
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

    // Line comment.
    if (ch === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') {
        i++;
      }

      continue;
    }

    // Block comment.
    if (ch === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
      afterControlHead = false;
      pendingControlKeyword = undefined;
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

    // Closing brace of a `${...}` expression returns to template text.
    if (ch === '}') {
      if (exprDepth > 0) {
        exprDepth--;
        i++;
        inText = true;
        resetExpressionState();
        continue;
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
      // Remember a control-statement keyword until its `(` is seen.
      pendingControlKeyword = CONTROL_HEAD_KEYWORDS.has(value) ? value : undefined;
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
    if (ch === '(') {
      // A `(` immediately after a control keyword opens a control head; the matching `)` may then
      // start a regex with a following `/`.
      openControlParen = pendingControlKeyword !== undefined;
      pendingControlKeyword = undefined;
    } else if (ch === ')') {
      afterControlHead = openControlParen;
      openControlParen = false;
    }

    tokens.push({ kind: 'punct', value: ch, offset: i });
    prevKind = 'punct';
    prevPunct = ch;
    i++;
  }

  // Reaching the end of the source while inside a template text or an open `${...}` expression means
  // the template literal was never closed.
  if (inText || exprDepth > 0) {
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
 * - `import('pkg')` is `dynamic-import` when the argument is a static string.
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

  // `import('pkg')` / `import ('pkg')`
  if (next?.kind === 'punct' && next.value === '(') {
    const arg = tokens[i + 2];

    if (arg?.kind === 'string') {
      occurrences.push({ specifier: arg.value, kind: 'dynamic-import' });
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
 * `kind`. Stops early at a nested `import`/`export`/`require` so a following construct is handled
 * on its own.
 */
function scanImportSource(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
  kind: ModuleSpecifierKind,
): number {
  const n = tokens.length;
  let j = i + 1;

  while (j < n) {
    const token = tokens[j];

    if (token?.kind === 'identifier') {
      if (token.value === 'import' || token.value === 'export' || token.value === 'require') {
        break;
      }

      if (token.value === 'from') {
        const sourceToken = tokens[j + 1];

        if (sourceToken?.kind === 'string') {
          occurrences.push({ specifier: sourceToken.value, kind });
          return j + 2;
        }
      }
    }

    j++;
  }

  // No source found; keep scanning from the next token.
  return i + 1;
}

/**
 * Handle a `require` identifier. `obj.require(...)` is ignored (preceded by `.`).
 * `require('pkg')` is `require`.
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

  if (next?.kind === 'punct' && next.value === '(') {
    const arg = tokens[i + 2];

    if (arg?.kind === 'string') {
      occurrences.push({ specifier: arg.value, kind: 'require' });
      return i + 3;
    }
  }

  return i + 1;
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

    // A raw line terminator inside a quoted string is invalid JavaScript; reject it instead of
    // continuing to scan (which would otherwise swallow later code as part of the string).
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
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

  // Octal backreferences (`\1`-`\9`, and `\0` followed by a decimal digit) are not valid string
  // escapes and must be rejected.
  if (e >= '1' && e <= '9') {
    throw new ModuleSpecifierError(`Invalid escape sequence '\\${e}`, 'invalid-source', backslash);
  }

  if (e === '0' && isNumberStart(source[i + 1] ?? '')) {
    throw new ModuleSpecifierError(`Invalid escape sequence '\\${e}`, 'invalid-source', backslash);
  }

  const simple: Record<string, string> = {
    '\\': '\\',
    n: '\n',
    r: '\r',
    t: '\t',
    b: '\b',
    f: '\f',
    v: '\v',
    0: '\0',
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

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
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
