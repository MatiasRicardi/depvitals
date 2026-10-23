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
 * Options for {@link extractModuleSpecifiers}.
 */
export type ExtractModuleSpecifiersOptions = {
  // Enable a bounded JSX lexical overlay. JSX text, tags and attributes are skipped, while the JS
  // inside `{...}` expression containers is still lexed, so real specifiers are found and JSX can
  // not be mistaken for regex/division. Only meaningful for `.jsx`/`.tsx` source.
  jsx?: boolean;
  /** Treat top-level `await` as a keyword. Omitted and false retain script/CommonJS behavior. */
  module?: boolean;
};

/**
 * Extract the statically knowable module specifiers from `source`.
 *
 * The returned occurrences preserve source order and are not deduplicated.
 *
 * @throws {ModuleSpecifierError} when the source reaches an unterminated or malformed lexical state
 *   from which the scanner cannot safely continue.
 */
export function extractModuleSpecifiers(
  source: string,
  options: ExtractModuleSpecifiersOptions = {},
): readonly ModuleSpecifierOccurrence[] {
  return interpret(tokenize(source, options.jsx ?? false, options.module ?? false));
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

// Async/generator context of a function. `await`/`yield` follow the nearest context, whether its body
// is a brace block or an arrow expression. `isExpression` marks a function expression used as a
// value (its closing `}` ends an expression, so a following `/` is division) versus a declaration
// in statement position (its closing `}` starts a block, so a following `/` may be a regex).
type FuncContext = {
  readonly async: boolean;
  readonly generator: boolean;
  readonly isExpression: boolean;
};

type ExpressionFuncContext = FuncContext & {
  readonly parenDepth: number;
  readonly bracketDepth: number;
  readonly braceDepth: number;
  readonly functionDepth: number;
};

// Lexical frames opened by a template interpolation or by the JSX overlay. The tokenizer keeps them
// on a single stack, so the innermost frame always decides how the next character is read:
//
// - `template-expr`: JavaScript inside `${...}`; `depth` counts the braces opened within it.
// - `jsx-expr`: JavaScript inside a JSX `{...}` container; `depth` counts the braces within it.
// - `jsx-tag`: inside `<name ...` up to the `>` or `/>` that ends the open tag.
// - `jsx-text`: inert JSX children up to the matching close tag (`name` is `null` for a fragment).
//
// `offset` is where the frame was opened, so an unterminated frame can report a useful position.
type Frame =
  | { readonly kind: 'template-expr'; depth: number; readonly offset: number }
  | { readonly kind: 'jsx-expr'; depth: number; readonly offset: number }
  | { readonly kind: 'jsx-tag'; readonly name: string; readonly offset: number }
  | { readonly kind: 'jsx-text'; readonly name: string | null; readonly offset: number };

/**
 * Turn source into a stream of significant tokens, skipping whitespace, line/block comments, regex
 * literals and template literals.
 */
function tokenize(source: string, jsx = false, module = false): readonly Token[] {
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
  // The value of the previous identifier token, when the previous token was an identifier. Which
  // identifier it was matters for one decision: `return {` opens an object literal, `else {` not.
  let prevIdentifier: string | undefined;
  // Where the previous identifier token ended, so `async function` can be rejected when a line
  // terminator separates the two words (automatic semicolon insertion ends the `async` statement).
  let prevIdentifierEnd = 0;
  // A line terminator in trivia may end an expression-bodied arrow through ASI. It is consumed
  // only when the next significant token cannot continue the preceding expression.
  let lineTerminatorSinceLastToken = false;

  // Template literal state. `inText` is true while scanning template text that must not be lexed as
  // JavaScript; a backtick toggles it, so nested templates are handled by the toggle. Every open
  // `${...}` expression pushes a `template-expr` frame carrying its own brace depth, which is what
  // distinguishes the `}` that closes the interpolation from a `}` belonging to an object literal, a
  // block or a function body inside it. JavaScript inside `${...}` is lexed like ordinary source.
  //
  // The same stack carries the JSX overlay frames (`jsx-tag`, `jsx-text` and the `jsx-expr` of a
  // `{...}` container), so markup, expression containers, templates and nested elements interleave
  // in a single pass without any state leaking between them.
  const frames: Frame[] = [];
  let inText = false;
  // Offset of the opening backtick of the current template, for unterminated-template errors.
  let templateStart = 0;

  // Brace context. Each `{` pushes whether it opened an expression (an object literal or a
  // destructuring pattern) or a statement block / function body, and its matching `}` pops that
  // entry. A `}` only ends an expression when it closed an object literal, which is what separates
  // `{}` in `{} / require('pkg') / 2`, where both slashes divide, from the `}` of
  // `if (ok) { ... }`, after which a `/` may legitimately start a regex. Anything unrecognized is
  // treated as a block.
  const braceContexts: boolean[] = [];
  // Parallel to `braceContexts`: whether each open brace belongs to a function body. Pushed in
  // lockstep with `braceContexts` so the matching `}` can restore the nearest function context.
  const functionBodyBraces: boolean[] = [];
  // Parallel to `braceContexts`: whether each brace opened a class body. Object and class bodies
  // are the two containers in which keyword-named ordinary methods are unambiguous.
  const classBodyBraces: boolean[] = [];
  // Function context of every open function body, tracked independently of expression frame resets
  // so `${}` boundaries cannot change the nearest await/yield grammar.
  const functionContextStack: FuncContext[] = [];
  // The nearest function body owns the await/yield grammar. An ordinary nested function therefore
  // suspends an async/generator context from an outer function instead of inheriting it.
  // A pending function signature (`function`/`async`/`*`) that has not yet reached its body `{`.
  let pendingFunctionContext: FuncContext | undefined;
  const expressionFunctionContexts: ExpressionFuncContext[] = [];
  let bracketDepth = 0;
  // Whether the most recent `}` closed an object literal. It is only consulted while that `}` is
  // the previous token, exactly like `prevPunct`.
  let closedObjectBrace = false;

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
    prevIdentifier = undefined;
    prevIsExpressionKeyword = false;
    afterControlHead = false;
    pendingControlKeyword = undefined;
    closedObjectBrace = false;
    lineTerminatorSinceLastToken = false;
    // A function signature is not part of a `${...}` expression; drop a half-written one so it can
    // not leak across the boundary.
    pendingFunctionContext = undefined;
  };

  // A finished JSX element leaves an expression value behind: a following `/` divides, and the
  // markup itself never opens a statement context.
  const endJsxElement = (): void => {
    prevKind = 'template';
    prevPunct = undefined;
    prevIdentifier = undefined;
    prevIsExpressionKeyword = false;
    afterControlHead = false;
    pendingControlKeyword = undefined;
    closedObjectBrace = false;
  };

  // JSX markup and sibling expression containers are separate expressions. Emitting an explicit
  // boundary keeps the token stream from gluing two of them into an import/require sequence that
  // does not exist in source (for example `<p>{import}{('pkg')}</p>`).
  const pushBoundary = (offset: number): void => {
    tokens.push({ kind: 'punct', value: ';', offset });
  };

  while (i < n) {
    const ch = source[i];

    if (ch === undefined) {
      i++;
      continue;
    }

    let expressionFunctionContext =
      expressionFunctionContexts[expressionFunctionContexts.length - 1];

    while (
      expressionFunctionContext !== undefined &&
      !closingParenBelongsToArrowParameters(source, i, n) &&
      expressionFunctionBodyEnded(
        ch,
        parenDepth,
        bracketDepth,
        braceContexts.length,
        functionContextStack.length,
        expressionFunctionContext,
      )
    ) {
      expressionFunctionContexts.pop();
      expressionFunctionContext = expressionFunctionContexts[expressionFunctionContexts.length - 1];
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
        frames.push({ kind: 'template-expr', depth: 0, offset: i });
        inText = false;
        resetExpressionState();
        i += 2;
        continue;
      }

      i++;
      continue;
    }

    // The innermost frame decides how the next character is read.
    const frame = frames[frames.length - 1];

    // JSX children: inert text up to the matching close tag. Quotes, backticks and comment-looking
    // sequences are text here, so only `<` (markup) and `{` (an expression container) leave it.
    if (frame?.kind === 'jsx-text') {
      if (ch === '{') {
        frames.push({ kind: 'jsx-expr', depth: 0, offset: i });
        pushBoundary(i);
        resetExpressionState();
        i++;
        continue;
      }

      if (ch === '<') {
        const after = source[i + 1];

        // Close tag `</name>` or fragment close `</>`: this element ends here.
        if (after === '/') {
          let k = i + 2;

          while (k < n && source[k] !== '>') {
            k++;
          }

          if (k >= n) {
            throw new ModuleSpecifierError(
              'Unterminated JSX element',
              'invalid-source',
              frame.offset,
            );
          }

          frames.pop();
          pushBoundary(i);
          endJsxElement();
          i = k + 1;
          continue;
        }

        // Nested fragment `<>`.
        if (after === '>') {
          frames.push({ kind: 'jsx-text', name: null, offset: i });
          i += 2;
          continue;
        }

        // Nested element `<name ...`.
        if (after !== undefined && isIdentifierStart(after)) {
          const tag = readJsxTagName(source, i + 1, n);
          frames.push({ kind: 'jsx-tag', name: tag.name, offset: i });
          i = tag.end;
          continue;
        }

        // A `<` that is not markup (`a < b` written inside JSX text) is ordinary text.
        i++;
        continue;
      }

      i++;
      continue;
    }

    // JSX open tag: attribute names, `=` and namespaces are inert; quoted values are inert text and
    // `{...}` returns to real JavaScript.
    if (frame?.kind === 'jsx-tag') {
      if (ch === '{') {
        frames.push({ kind: 'jsx-expr', depth: 0, offset: i });
        pushBoundary(i);
        resetExpressionState();
        i++;
        continue;
      }

      if (ch === '"' || ch === "'") {
        i = skipJsxAttributeValue(source, i, n);
        continue;
      }

      // Self-closing tag `<name ... />`: the element ends without children.
      if (ch === '/' && source[i + 1] === '>') {
        frames.pop();
        pushBoundary(i);
        endJsxElement();
        i += 2;
        continue;
      }

      // End of the open tag: its children follow until the matching close tag.
      if (ch === '>') {
        frames.pop();
        frames.push({ kind: 'jsx-text', name: frame.name, offset: frame.offset });
        i++;
        continue;
      }

      i++;
      continue;
    }

    if (isWhitespace(ch)) {
      if (isLineTerminator(ch)) {
        lineTerminatorSinceLastToken = true;
      }

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
      const commentStart = i;
      i = skipBlockComment(source, i);
      lineTerminatorSinceLastToken ||= hasLineTerminator(source, commentStart, i);
      continue;
    }

    if (lineTerminatorSinceLastToken) {
      let context = expressionFunctionContexts[expressionFunctionContexts.length - 1];

      while (
        context !== undefined &&
        lineTerminatorEndsExpressionFunctionBody(
          ch,
          prevKind,
          prevPunct,
          parenDepth,
          bracketDepth,
          braceContexts.length,
          functionContextStack.length,
          context,
        )
      ) {
        expressionFunctionContexts.pop();
        context = expressionFunctionContexts[expressionFunctionContexts.length - 1];
      }

      lineTerminatorSinceLastToken = false;
    }

    // A backtick in code mode opens a (possibly nested) template literal.
    if (ch === '`') {
      templateStart = i;
      inText = true;
      prevKind = 'template';
      i++;
      continue;
    }

    // JSX overlay (opt-in via the `jsx` option). A `<` in expression position that is followed by a
    // tag name (or `>` for a fragment) opens JSX markup: its text, tags and attributes are inert,
    // while the JavaScript inside `{...}` containers is lexed normally. Expression position is the
    // same test that decides a regex literal, so a comparison (`a < b`, `f() < x`) is never JSX, and
    // a TypeScript type-argument list (`<T,>`, `<T extends U>`) is excluded explicitly.
    if (
      jsx &&
      ch === '<' &&
      i + 1 < n &&
      isRegexStart(
        prevKind,
        prevPunct,
        prevIsExpressionKeyword,
        afterControlHead,
        closedObjectBrace,
      )
    ) {
      const after = source[i + 1];

      if (after === '>') {
        frames.push({ kind: 'jsx-text', name: null, offset: i });
        pushBoundary(i);
        i += 2;
        continue;
      }

      if (after !== undefined && isIdentifierStart(after) && !jsxTagIsGeneric(source, i + 1, n)) {
        const tag = readJsxTagName(source, i + 1, n);
        frames.push({ kind: 'jsx-tag', name: tag.name, offset: i });
        pushBoundary(i);
        i = tag.end;
        continue;
      }
    }

    // A `}` in code mode closes the innermost open `${...}` or JSX `{...}` expression only when that
    // expression has no open braces of its own; otherwise it is an ordinary brace inside it.
    if (ch === '}') {
      if (frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr') {
        if (frame.depth === 0) {
          frames.pop();
          pushBoundary(i);
          i++;

          if (frame.kind === 'template-expr') {
            inText = true;
            resetExpressionState();
          } else {
            // Back to the enclosing JSX tag or text frame, which reads the next character itself.
            endJsxElement();
          }

          continue;
        }

        frame.depth -= 1;
      }

      // Otherwise `}` is an ordinary brace: it ends an expression only when it closed an object
      // literal. An unmatched `}` (an empty context) keeps the statement-block behaviour.
      const wasFunctionBody = functionBodyBraces.pop() ?? false;
      closedObjectBrace = braceContexts.pop() === true;
      // Restore the async/generator context of a function body whose `{` was tracked alongside
      // `braceContexts`. The matching `}` is always the current one because braces nest properly.
      if (wasFunctionBody) {
        functionContextStack.pop();
      }
      classBodyBraces.pop();
    }

    // `/` is a regex when it can start an expression, otherwise it is division.
    if (ch === '/') {
      if (
        isRegexStart(
          prevKind,
          prevPunct,
          prevIsExpressionKeyword,
          afterControlHead,
          closedObjectBrace,
        )
      ) {
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
      const previousIdentifier = prevIdentifier;
      prevIdentifier = value;
      const isMemberName = prevKind === 'punct' && prevPunct === '.';
      // A keyword after `.` is a property name (e.g. `x.return`), not an expression start.
      let isExpressionKeyword = REGEX_PRECEDING_KEYWORDS.has(value) && !isMemberName;
      // `await`/`yield` are keywords only inside an async / generator function body. A member name
      // (`obj.await`) is always a property access, never a keyword, so a following `/` divides.
      if (!isMemberName) {
        const expressionContext = expressionFunctionContexts[expressionFunctionContexts.length - 1];
        const bodyContext = functionContextStack[functionContextStack.length - 1];
        const functionContext =
          expressionContext !== undefined &&
          functionContextStack.length <= expressionContext.functionDepth
            ? expressionContext
            : bodyContext;

        if (
          value === 'await' &&
          (functionContext?.async === true || (functionContext === undefined && module))
        ) {
          isExpressionKeyword = true;
        } else if (value === 'yield' && functionContext?.generator === true) {
          isExpressionKeyword = true;
        }
      }
      prevIsExpressionKeyword = isExpressionKeyword;
      // Remember a control-statement keyword until its `(` is seen so only that head's `)` may be
      // followed by a regex literal.
      pendingControlKeyword = pendingControlKeywordAfter(
        value,
        isMemberName ||
          braceContexts[braceContexts.length - 1] === true ||
          classBodyBraces[classBodyBraces.length - 1] === true,
        pendingControlKeyword,
      );
      // A `function` keyword (not a property name) starts a function signature. Track whether it is
      // an expression (`const f = function(){}`) or a declaration (`function f(){}`), and whether it
      // is async (`async function`, i.e. preceded by `async`) or a generator (`function*`, resolved
      // when a following `*` is seen). The context is consumed at the body `{`.
      if (value === 'function' && !isMemberName) {
        // `async function` is only async without a line terminator between the two words: a line
        // break ends the `async` statement, so the declaration that follows is an ordinary one.
        const isAsync =
          previousIdentifier === 'async' &&
          prevKind === 'identifier' &&
          !hasLineTerminator(source, prevIdentifierEnd, start);

        pendingFunctionContext = {
          async: isAsync,
          generator: false,
          isExpression: functionIsExpressionPosition(prevKind, prevPunct, previousIdentifier),
        };
      }
      tokens.push({ kind: 'identifier', value, offset: start });
      prevKind = 'identifier';
      prevIdentifierEnd = i;
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
      // Record what this brace opens, so its `}` knows whether an expression or a statement ended.
      // The enclosing entry is inspected before pushing, so a `:` knows if it separates a property.
      let isObject = opensObjectLiteral(
        prevKind,
        prevPunct,
        prevIdentifier,
        prevIsExpressionKeyword,
        frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr',
        braceContexts[braceContexts.length - 1] === true,
      );
      const isClassBody =
        !isObject && pendingFunctionContext === undefined && opensClassBody(tokens);

      // A statement-block brace that consumes a pending function signature is a function body. A
      // function expression used as a value ends an expression (so a following `/` divides), while a
      // declaration in statement position starts a block (so a following `/` may be a regex).
      //
      // Arrows and methods carry no `function` keyword, so their context is inferred from the tokens
      // before the brace. Ordinary methods are accepted only inside a known object/class container;
      // elsewhere the same `name() {` shape may be a control head such as `if (cond) {`.
      if (pendingFunctionContext === undefined && !isObject && !isClassBody) {
        pendingFunctionContext = inferFunctionBodyContext(
          tokens,
          braceContexts[braceContexts.length - 1] === true ||
            classBodyBraces[classBodyBraces.length - 1] === true,
        );
      }

      let wasFunctionBody = false;
      if (!isObject && pendingFunctionContext !== undefined) {
        wasFunctionBody = true;
        const context = pendingFunctionContext;
        pendingFunctionContext = undefined;
        isObject = context.isExpression;
        functionContextStack.push(context);
      }
      functionBodyBraces.push(wasFunctionBody);
      braceContexts.push(isObject);
      classBodyBraces.push(isClassBody);

      // Count the brace inside the innermost open `${...}` or JSX `{...}` expression so its closing
      // `}` is found.
      if (frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr') {
        frame.depth += 1;
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
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ')') {
      afterControlHead = controlParenDepth !== undefined && parenDepth === controlParenDepth;

      if (afterControlHead) {
        controlParenDepth = undefined;
      }

      if (parenDepth > 0) {
        parenDepth--;
      }
    } else if (ch === ']') {
      if (bracketDepth > 0) {
        bracketDepth--;
      }
    }

    // An arrow's expression body has no brace where its function context can be consumed. Record
    // its bounded context after `=>`; a following delimiter removes it again.
    if (ch === '>' && prevPunct === '=') {
      const context = inferArrowContext(source, tokens);
      const next = skipTrivia(source, i + 1, n);

      if (context !== undefined && source[next] !== '{') {
        expressionFunctionContexts.push({
          ...context,
          isExpression: true,
          parenDepth,
          bracketDepth,
          braceDepth: braceContexts.length,
          functionDepth: functionContextStack.length,
        });
      }
    }

    // A `*` right after `function` (whitespace/comments aside) marks a generator: `function*` and
    // `function *`. It is recorded on the pending signature, consumed at the body `{`.
    if (ch === '*' && prevIdentifier === 'function' && pendingFunctionContext !== undefined) {
      pendingFunctionContext = { ...pendingFunctionContext, generator: true };
    }

    // A `;` ends a statement, so any half-written function signature cannot continue.
    if (ch === ';') {
      pendingFunctionContext = undefined;
    }

    tokens.push({ kind: 'punct', value: ch, offset: i });
    prevKind = 'punct';
    prevPunct = ch;
    i++;
  }

  // Reaching the end of the source with an open frame means the template literal, the JSX element or
  // the JSX expression container was never closed. The innermost open frame is the one that failed.
  const openFrame = frames[frames.length - 1];

  if (inText || openFrame?.kind === 'template-expr') {
    throw new ModuleSpecifierError(
      'Unterminated template literal',
      'invalid-source',
      inText ? templateStart : (openFrame?.offset ?? templateStart),
    );
  }

  if (openFrame?.kind === 'jsx-expr') {
    throw new ModuleSpecifierError(
      'Unterminated JSX expression',
      'invalid-source',
      openFrame.offset,
    );
  }

  if (openFrame !== undefined) {
    throw new ModuleSpecifierError('Unterminated JSX element', 'invalid-source', openFrame.offset);
  }

  return tokens;
}

// A `<` followed by an identifier that begins a generic type-argument list (e.g. `<T,>`, `<T = X>`,
// `<T extends U>`, `<const T,>`) or a generic function signature (`<T>(x: T) => T`) is not a JSX
// element. `<T>` alone in expression position remains ambiguous and is treated as JSX.
function jsxTagIsGeneric(source: string, i: number, n: number): boolean {
  if (!isIdentifierStart(source[i])) {
    return false;
  }

  let k = i;

  while (k < n && isIdentifierPart(source[k])) {
    k++;
  }

  const next = source[k];

  if (next === ',' || next === '=') {
    return true;
  }

  if (next === '>') {
    let j = k + 1;

    while (j < n && isWhitespace(source[j])) {
      j++;
    }

    if (source[j] === '(') {
      return arrowFollowsParameters(source, j, n);
    }
  }

  if (isWhitespace(next)) {
    const name = source.slice(i, k);

    while (k < n && isWhitespace(source[k])) {
      k++;
    }

    if (source.slice(k, k + 7) === 'extends' || source.slice(k, k + 10) === 'implements') {
      return true;
    }

    // `const T, ...`: a TypeScript const type parameter, whose real name follows the modifier.
    if (name === 'const' && k < n && isIdentifierStart(source[k])) {
      return jsxTagIsGeneric(source, k, n);
    }
  }

  return false;
}

function arrowFollowsParameters(source: string, open: number, n: number): boolean {
  let depth = 0;

  for (let k = open; k < n; k++) {
    const ch = source[k];

    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;

      if (depth === 0) {
        let j = k + 1;

        while (j < n && isWhitespace(source[j])) {
          j++;
        }

        return source[j] === '=' && source[j + 1] === '>';
      }
    }
  }

  return false;
}

/**
 * Whether the source between two offsets contains a line terminator.
 */
function hasLineTerminator(source: string, from: number, to: number): boolean {
  for (let k = from; k < to; k++) {
    if (isLineTerminator(source[k])) {
      return true;
    }
  }

  return false;
}

/** Skip whitespace and comments without interpreting any target-project code. */
function skipTrivia(source: string, start: number, n: number): number {
  let i = start;

  while (i < n) {
    if (isWhitespace(source[i])) {
      i++;
      continue;
    }

    if (source[i] === '/' && source[i + 1] === '/') {
      i += 2;
      while (i < n && !isLineTerminator(source[i])) {
        i++;
      }
      continue;
    }

    if (source[i] === '/' && source[i + 1] === '*') {
      i = skipBlockComment(source, i);
      continue;
    }

    break;
  }

  return i;
}

/**
 * The async/generator context of a function body whose signature carries no `function` keyword,
 * inferred from the tokens emitted just before its `{`.
 *
 * The recognised shapes all bind their own `await`/`yield`:
 *
 * - an async arrow: `async () => {`, `async x => {`;
 * - an async or generator method: `async run() {`, `*run() {`, `async *run() {`;
 * - an ordinary identifier, keyword-named or computed method inside a known object/class body.
 *
 * Everything else returns `undefined`; outside a method container, a plain `name() {` may instead
 * be a control head and is never inferred as a function boundary.
 */
function inferFunctionBodyContext(
  tokens: readonly Token[],
  insideMethodContainer: boolean,
): FuncContext | undefined {
  const last = tokens[tokens.length - 1];

  if (last?.kind !== 'punct') {
    return undefined;
  }

  // `... => {`: the token before the parameter list decides whether the arrow is async.
  if (last.value === '>') {
    const arrow = tokens[tokens.length - 2];

    if (arrow?.kind !== 'punct' || arrow.value !== '=') {
      return undefined;
    }

    const beforeArrow = tokens.length - 3;
    const parameters = tokens[beforeArrow];
    let marker: number;

    if (parameters?.kind === 'punct' && parameters.value === ')') {
      marker = matchingOpenParen(tokens, beforeArrow) - 1;
    } else if (parameters?.kind === 'identifier') {
      marker = beforeArrow - 1;
    } else {
      return undefined;
    }

    return {
      async: isIdentifier(tokens[marker], 'async'),
      generator: false,
      isExpression: false,
    };
  }

  // `... ) {`: an async or generator method, recognised only through its `async` / `*` marker.
  if (last.value === ')') {
    const open = matchingOpenParen(tokens, tokens.length - 1);

    if (open < 0) {
      return undefined;
    }

    const methodName = tokens[open - 1];
    const marker = tokens[open - 2];

    if (methodName?.kind === 'identifier' && isIdentifier(marker, 'async')) {
      return { async: true, generator: false, isExpression: false };
    }

    if (methodName?.kind === 'identifier' && marker?.kind === 'punct' && marker.value === '*') {
      return {
        async: isIdentifier(tokens[open - 3], 'async'),
        generator: true,
        isExpression: false,
      };
    }

    if (!insideMethodContainer) {
      return undefined;
    }

    if (methodName?.kind === 'identifier') {
      // `for await (...) {}` is a loop head, not a method named `await`.
      if (methodName.value === 'await' && isIdentifier(marker, 'for')) {
        return undefined;
      }

      return { async: false, generator: false, isExpression: false };
    }

    if (methodName?.kind === 'punct' && methodName.value === ']') {
      return { async: false, generator: false, isExpression: false };
    }
  }

  return undefined;
}

/**
 * Infer the async marker immediately before an arrow's `=>`, using the same parameter shapes as
 * {@link inferFunctionBodyContext}. The caller has not emitted the `>` token yet.
 */
function inferArrowContext(source: string, tokens: readonly Token[]): FuncContext | undefined {
  const arrow = tokens[tokens.length - 1];

  if (arrow?.kind !== 'punct' || arrow.value !== '=') {
    return undefined;
  }

  const beforeArrow = tokens.length - 2;
  const parameters = tokens[beforeArrow];
  let marker: number;

  if (parameters?.kind === 'punct' && parameters.value === ')') {
    marker = matchingOpenParen(tokens, beforeArrow) - 1;
  } else if (parameters?.kind === 'identifier') {
    marker = beforeArrow - 1;
  } else {
    return undefined;
  }

  // A line terminator between `async` and the parameters means the arrow is not async: `async`
  // ends the previous expression and the arrow body starts on the next line. Treating it as async
  // would make `await` a keyword and read division as a regex, hiding a real dependency.
  const markerToken = tokens[marker];
  const async =
    markerToken?.kind === 'identifier' &&
    markerToken.value === 'async' &&
    !hasLineTerminatorBetween(source, markerToken.offset, parameters.offset);

  return {
    async,
    generator: false,
    isExpression: false,
  };
}

/** Whether any line terminator appears strictly between two source offsets. */
function hasLineTerminatorBetween(source: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (isLineTerminator(source[i])) {
      return true;
    }
  }

  return false;
}

function expressionFunctionBodyEnded(
  ch: string,
  parenDepth: number,
  bracketDepth: number,
  braceDepth: number,
  functionDepth: number,
  context: ExpressionFuncContext,
): boolean {
  if (functionDepth > context.functionDepth || braceDepth > context.braceDepth) {
    return false;
  }

  if (ch === ';' || ch === ',') {
    return (
      parenDepth === context.parenDepth &&
      bracketDepth === context.bracketDepth &&
      braceDepth === context.braceDepth
    );
  }

  if (ch === ')' || ch === ']' || ch === '}') {
    return (
      parenDepth === context.parenDepth &&
      bracketDepth === context.bracketDepth &&
      braceDepth === context.braceDepth
    );
  }

  return false;
}

/** A `)` followed by `=>` belongs to a nested arrow signature, not the outer arrow's boundary. */
function closingParenBelongsToArrowParameters(source: string, close: number, n: number): boolean {
  if (source[close] !== ')') {
    return false;
  }

  const next = skipTrivia(source, close + 1, n);

  return source[next] === '=' && source[next + 1] === '>';
}

function lineTerminatorEndsExpressionFunctionBody(
  next: string,
  prevKind: PrevKind,
  prevPunct: string | undefined,
  parenDepth: number,
  bracketDepth: number,
  braceDepth: number,
  functionDepth: number,
  context: ExpressionFuncContext,
): boolean {
  if (
    functionDepth > context.functionDepth ||
    parenDepth !== context.parenDepth ||
    bracketDepth !== context.bracketDepth ||
    braceDepth !== context.braceDepth
  ) {
    return false;
  }

  const previousEndsExpression =
    EXPRESSION_ENDING.has(prevKind) ||
    (prevKind === 'punct' && [')', ']', '}'].includes(prevPunct ?? ''));

  return previousEndsExpression && !EXPRESSION_CONTINUATION_CHARACTERS.has(next);
}

/** Whether a token is the given identifier. */
function isIdentifier(token: Token | undefined, value: string): boolean {
  return token?.kind === 'identifier' && token.value === value;
}

/**
 * The index of the `(` matching the `)` at `closeIndex`, or `-1` when the source has no match.
 */
function matchingOpenParen(tokens: readonly Token[], closeIndex: number): number {
  let depth = 0;

  for (let k = closeIndex; k >= 0; k--) {
    const token = tokens[k];

    if (token?.kind !== 'punct') {
      continue;
    }

    if (token.value === ')') {
      depth++;
    } else if (token.value === '(') {
      depth--;

      if (depth === 0) {
        return k;
      }
    }
  }

  return -1;
}

/** Whether the next `{` opens the class whose `class` keyword is in the current token segment. */
function opensClassBody(tokens: readonly Token[]): boolean {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];

    if (isIdentifier(token, 'class')) {
      const afterClass = tokens[index + 1];

      return afterClass?.kind !== 'punct' || afterClass.value !== '(';
    }

    if (
      token?.kind === 'punct' &&
      (token.value === ';' || token.value === '{' || token.value === '}')
    ) {
      return false;
    }
  }

  return false;
}

/**
 * Read a JSX tag name starting at `i` (the first character after `<`). Member expressions
 * (`<UI.Panel>`), namespaced names (`<svg:rect>`) and dashed names (`<my-tag>`) are part of the name.
 */
function readJsxTagName(source: string, i: number, n: number): { name: string; end: number } {
  const start = i;

  while (i < n) {
    const ch = source[i];

    if (ch === undefined || !(isIdentifierPart(ch) || ch === '.' || ch === '-' || ch === ':')) {
      break;
    }

    i++;
  }

  return { name: source.slice(start, i), end: i };
}

/**
 * Skip a quoted JSX attribute value starting at its opening quote. The value is inert text: it ends
 * at the matching quote and backslashes are not escapes, so it can never contribute a specifier.
 */
function skipJsxAttributeValue(source: string, i: number, n: number): number {
  const quote = source[i];
  let k = i + 1;

  while (k < n && source[k] !== quote) {
    k++;
  }

  if (k >= n) {
    throw new ModuleSpecifierError('Unterminated JSX attribute value', 'invalid-source', i);
  }

  return k + 1;
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

// A token beginning with one of these characters may continue an expression across a line
// terminator, so ASI must not retire an expression-bodied arrow before it.
const EXPRESSION_CONTINUATION_CHARACTERS: ReadonlySet<string> = new Set([
  '.',
  '(',
  '[',
  '?',
  ':',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
  '!',
  '&',
  '|',
  '^',
  '`',
]);

/**
 * Expression-starting keywords. After one of these, a `/` begins a regex literal even though the
 * keyword itself is tokenized as an identifier. `of`, `yield` and `await` are intentionally
 * excluded: they are valid identifiers in some contexts, so `/` after them may be division.
 * `default` covers `export default /re/.test(value)`, where the regex literal is the exported
 * value, and, together with the brace stack, `export default {} / require('pkg') / 2`, where the
 * object literal is.
 */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
  'return',
  'default',
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
 * The control keyword still pending a `(` after reading the identifier `value`, given what was
 * pending before it.
 *
 * - `if`/`while`/`for`/`with` start a control head.
 * - `await` keeps a pending `for` alive, because `for await (...)` puts it between the keyword and
 *   its `(`. `await` is not a control keyword on its own.
 * - Anything else (including a keyword used as a property name after `.`) clears the pending state.
 */
function pendingControlKeywordAfter(
  value: string,
  isMemberName: boolean,
  pending: string | undefined,
): string | undefined {
  if (isMemberName) {
    return undefined;
  }

  if (CONTROL_HEAD_KEYWORDS.has(value)) {
    return value;
  }

  return value === 'await' && pending === 'for' ? pending : undefined;
}

/**
 * Punctuation after which a `{` opens an expression, because the token before it needs an
 * expression on its right: assignment (`= {`), an argument or element list (`f({`, `[{`) and the
 * separators and binary/logical operators. `>` is absent because it usually ends an arrow function
 * (`() => {}`), whose `{` opens a function body, and `)`/`}` are absent because they close
 * statement heads and blocks. `:` is decided separately, in {@link opensObjectLiteral}, because it
 * is a property separator inside an object literal but a label or `case`/`default` separator
 * otherwise.
 */
const EXPRESSION_BEFORE_BRACE: ReadonlySet<string> = new Set([
  '=',
  '(',
  '[',
  ',',
  '?',
  '&',
  '|',
  '^',
  '+',
  '-',
  '*',
  '%',
  '!',
  '~',
]);

// Keywords that start an expression but are still followed by a statement block.
const BLOCK_AFTER_KEYWORD: ReadonlySet<string> = new Set(['else', 'do']);

// Whether a `function` keyword sits in expression position (a function expression used as a value,
// so a slash after its body `{}` divides) rather than statement position (a declaration, so a slash
// after its body may start a regex). The previous significant token must expect an expression on
// its right: an expression-starting punctuation, an expression keyword, or a regex.
function functionIsExpressionPosition(
  prevKind: PrevKind,
  prevPunct: string | undefined,
  previousIdentifier: string | undefined,
): boolean {
  if (prevKind === 'punct') {
    return EXPRESSION_BEFORE_BRACE.has(prevPunct ?? '');
  }
  if (prevKind === 'identifier') {
    return REGEX_PRECEDING_KEYWORDS.has(previousIdentifier ?? '');
  }
  return prevKind === 'regex';
}

/**
 * Whether a `{` opens an expression (an object literal or a destructuring pattern) instead of a
 * statement block or function body. `enclosingIsObjectLiteral` reports what the enclosing `{`, if
 * any, opened. Statement position is the default, so an unknown context keeps the existing
 * behaviour of allowing a regex literal after the matching `}`.
 */
function opensObjectLiteral(
  prevKind: PrevKind,
  prevPunct: string | undefined,
  prevIdentifier: string | undefined,
  prevIsExpressionKeyword: boolean,
  inTemplateExpression: boolean,
  enclosingIsObjectLiteral: boolean,
): boolean {
  if (prevKind === 'punct') {
    // Inside an object literal a `:` separates a property from its value (`{ scale: {} }`, where a
    // following `/` divides), while at statement level the same `:` follows a label
    // (`label: {}`) or a `case`/`default` clause, whose `{` opens a block.
    if (prevPunct === ':') {
      return enclosingIsObjectLiteral;
    }

    return EXPRESSION_BEFORE_BRACE.has(prevPunct ?? '');
  }

  if (prevKind === 'identifier') {
    // `return {` is an expression, `else {`/`do {` are blocks and every other identifier
    // (`function f`, `class C`) sits in statement position.
    return prevIsExpressionKeyword && !BLOCK_AFTER_KEYWORD.has(prevIdentifier ?? '');
  }

  // Right after `${` an expression is expected, so a `{` opens an object literal.
  return inTemplateExpression && prevKind === 'start';
}

/**
 * Whether a `/` (not already a comment) may begin a regex literal, given the previous significant
 * token. `)` and `]` punctuation also end an expression (division), so any other punctuation (or
 * the start of the file) may start a regex. The one exception is a `/` after the `)` that closes a
 * control-statement head (if/while/for/with), which may start a regex literal. A `}` depends on
 * what it closed: an object literal ends an expression, so the `/` divides, while a statement block
 * leaves the expression-start position, where a regex literal may begin.
 */
function isRegexStart(
  prevKind: PrevKind,
  prevPunct: string | undefined,
  prevIsExpressionKeyword: boolean,
  afterControlHead: boolean,
  closedObjectBrace: boolean,
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

    if (prevPunct === '}') {
      return !closedObjectBrace;
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
/**
 * Whether the identifier at `i` is a property name (`obj.require`), which is never the global
 * `require`/`import`. A `.` that belongs to a spread (`...require('pkg')`) is not member access.
 */
function isMemberName(tokens: readonly Token[], i: number): boolean {
  const prev = tokens[i - 1];

  if (prev?.kind !== 'punct' || prev.value !== '.') {
    return false;
  }

  const second = tokens[i - 2];
  const third = tokens[i - 3];
  const isSpread =
    second?.kind === 'punct' &&
    second.value === '.' &&
    third?.kind === 'punct' &&
    third.value === '.';

  return !isSpread;
}

function handleImport(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
): number {
  const next = tokens[i + 1];

  // `obj.import(...)`: a member call, not the import keyword.
  if (isMemberName(tokens, i)) {
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
  // `obj.require(...)`: not the global CommonJS require.
  if (isMemberName(tokens, i)) {
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

// The Unicode `Zs` (`Space_Separator`) category, so every one of those characters separates tokens
// instead of being read as punctuation.
const SPACE_SEPARATOR = /\p{Zs}/u;

/**
 * The characters that separate tokens, that is the ECMAScript `WhiteSpace` production: the Unicode
 * `Space_Separator` (`Zs`) characters (plain space, NBSP, EM SPACE, IDEOGRAPHIC SPACE, ...), tab,
 * vertical tab, form feed, ZWNBSP/BOM, plus every `LineTerminator`. Only used for the gap between
 * tokens; string contents are handled by `readString`, so a raw U+2028/U+2029 inside a quoted string
 * stays valid source while a raw LF/CR there stays an error.
 */
function isWhitespace(ch: string | undefined): boolean {
  return (
    ch === '\t' ||
    ch === '\v' ||
    ch === '\f' ||
    ch === '\uFEFF' ||
    isLineTerminator(ch) ||
    (ch !== undefined && SPACE_SEPARATOR.test(ch))
  );
}

/**
 * The ECMAScript `LineTerminator` characters. Line comments and the hashbang end at any of them,
 * not only at `\n`. `undefined` (end of the source indexed past its end) is not a terminator.
 */
function isLineTerminator(ch: string | undefined): boolean {
  return ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029';
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function isNumberStart(ch: string): boolean {
  return /[0-9]/.test(ch);
}
