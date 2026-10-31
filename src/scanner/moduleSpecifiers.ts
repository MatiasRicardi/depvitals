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
  /** Explicit module/script grammar, or bounded syntax detection for ambiguous `.js` input. */
  module?: boolean | 'detect';
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
  const jsx = options.jsx ?? false;
  // Ambiguous input gets one non-interpreting lexical probe and one definitive extraction. No
  // source reread, parser retry after an exception, or repeated per-statement suffix scans.
  const module =
    options.module === 'detect'
      ? tokenize(source, jsx, false, true).some((token) => token.moduleSignal === true)
      : (options.module ?? false);
  return interpret(tokenize(source, jsx, module));
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                  */
/* -------------------------------------------------------------------------- */

type RequireScope = {
  readonly parent: RequireScope | undefined;
  readonly bindings: { start: number; end: number }[];
  inParameters: boolean;
};

type Token = {
  readonly signatureContext?: FuncContext;
  readonly requireScope?: RequireScope;
  readonly parameterFrame?: number;
  readonly parameterType?: boolean;
  readonly moduleSignal?: boolean;
  readonly lineBreakBefore?: boolean;
  readonly assertionEnd?: boolean;
} & (
  | {
      readonly kind: 'identifier';
      readonly value: string;
      readonly propertyName?: boolean;
      readonly offset: number;
      readonly endOffset: number;
    }
  | {
      readonly kind: 'string';
      readonly value: string;
      readonly offset: number;
      readonly endOffset: number;
    }
  | { readonly kind: 'number'; readonly offset: number; readonly endOffset: number }
  | {
      readonly kind: 'punct';
      readonly value: string;
      readonly offset: number;
      readonly endOffset: number;
      readonly memberSeparator?: boolean;
      readonly expressionEnd?: boolean;
      readonly syntheticBoundary?: boolean;
      readonly operator?: 'assignment' | 'arrow' | 'other';
      readonly operatorEndOffset?: number;
      readonly matchingOpen?: number;
    }
  | { readonly kind: 'regex'; readonly offset: number; readonly endOffset: number }
  | { readonly kind: 'template'; readonly offset: number; readonly endOffset: number }
);

type PrevKind = 'start' | 'identifier' | 'number' | 'string' | 'punct' | 'regex' | 'template';

// Async/generator context of a function. `await`/`yield` follow the nearest context, whether its body
// is a brace block or an arrow expression. `isExpression` marks a function expression used as a
// value (its closing `}` ends an expression, so a following `/` is division) versus a declaration
// in statement position (its closing `}` starts a block, so a following `/` may be a regex).
type FuncContext = {
  readonly requireScope?: RequireScope;
  readonly async: boolean;
  readonly generator: boolean;
  readonly isExpression: boolean;
  readonly isClassMember?: boolean;
};

type LexicalDepth = {
  readonly parenDepth: number;
  readonly bracketDepth: number;
  readonly braceDepth: number;
  readonly frameDepth: number;
};

type PendingFuncContext = FuncContext &
  LexicalDepth & {
    parameterDepth: number | undefined;
    phase: 'awaiting-parameters' | 'parameters' | 'awaiting-body';
  };

type ExpressionFuncContext = FuncContext & {
  readonly parenDepth: number;
  readonly bracketDepth: number;
  readonly braceDepth: number;
  readonly frameDepth: number;
  readonly functionDepth: number;
  readonly conditionalDepth: number;
  readonly parameterOwner?: ParameterContext;
  readonly classMemberOwner?: ClassMember;
};

// The signature a `:` starts a return annotation for. `isFunctionKeyword` marks the ones that already
// pushed their pending context, `isArrowSignature` the shapes whose body may be an arrow expression
// (`=> ...`) instead of a block.
type TypedReturnSignature = {
  readonly context: FuncContext;
  readonly isFunctionKeyword: boolean;
  readonly isArrowSignature: boolean;
};

type OwnedSignature = TypedReturnSignature & { readonly owner: LexicalDepth };

type ParameterContext = {
  readonly openIndex: number;
  bindingStart: number;
  bindingEnd: number | undefined;
  bindingCommas: {
    index: number;
    bindingStart: number;
    bindingEnd: number | undefined;
    phase: 'binding' | 'type' | 'initializer';
    bindingCount: number;
  }[];
  readonly signature: OwnedSignature | undefined;
  readonly control: boolean;
  readonly controlKeyword: string | undefined;
  readonly functionDepth: number;
  readonly depth: LexicalDepth;
  phase: 'binding' | 'type' | 'initializer';
  forPhase?: 'binding' | 'iteration' | 'regular';
};

// A type in progress uses separate delimiter depths so its braces and arrows never become
// runtime delimiters. `typeOperandExpected` records whether the next token has to begin a type: a `{`
// where an operand is expected opens an object type (`{ ok: boolean }`), while a `{` read after a
// complete type begins the runtime body.
type TypeDepth = {
  parenDepth: number;
  bracketDepth: number;
  braceDepth: number;
  angleDepth: number;
  typeOperandExpected: boolean;
};

type TypeAnnotation = TypeDepth &
  (
    | { readonly role: 'return'; readonly signature: OwnedSignature }
    | { readonly role: 'field'; readonly owner: ClassContext; readonly member: ClassMember }
    | { readonly role: 'parameter'; readonly owner: ParameterContext }
    | { readonly role: 'class-header'; readonly owner: PendingClassContext }
    | {
        readonly role: 'assertion';
        readonly owner: LexicalDepth;
        conditionalDepth: number;
        conditionalOperand: boolean;
        importCallPending: boolean;
      }
  );

type ClassMember = {
  readonly start: number;
  readonly functionDepth: number;
  phase: 'head' | 'decorator' | 'field' | 'type' | 'initializer' | 'parameters';
};

type ClassContext = LexicalDepth & {
  member: ClassMember | undefined;
};

type PendingClassContext = LexicalDepth & {
  readonly isExpression: boolean;
};

// A brace owns its closing action. In particular an initializer's object/function cannot close
// the enclosing class member, and only a function body restores the nearest function grammar.
type BraceContext =
  | { readonly role: 'object'; readonly depth: LexicalDepth }
  | { readonly role: 'block' }
  | { readonly role: 'class'; readonly state: ClassContext; readonly isExpression: boolean }
  | { readonly role: 'static-block'; readonly owner: ClassContext }
  | { readonly role: 'function'; readonly context: FuncContext; readonly owner?: ClassContext };

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
  | {
      readonly kind: 'template-expr';
      depth: number;
      readonly offset: number;
      readonly typeOwner?: { readonly annotation: TypeAnnotation; readonly depth: TypeDepth };
    }
  | { readonly kind: 'jsx-expr'; depth: number; readonly offset: number }
  | {
      readonly kind: 'jsx-tag';
      readonly name: string;
      readonly offset: number;
      readonly nameEnd: number;
    }
  | { readonly kind: 'jsx-text'; readonly name: string | null; readonly offset: number };

/**
 * Turn source into a stream of significant tokens, skipping whitespace, line/block comments, regex
 * literals and template literals.
 */
function tokenize(
  source: string,
  jsx = false,
  module = false,
  detectModule = false,
): readonly Token[] {
  const tokens: Token[] = [];
  const typeArgumentBounds = new Map<number, number | null>();
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
  // Preserve the position before an `async` modifier for a following `function` keyword.
  let asyncFunctionIsExpression = false;
  // A line terminator in trivia may end an expression-bodied arrow through ASI. It is consumed
  // only when the next significant token cannot continue the preceding expression.
  let lineTerminatorSinceLastToken = false;
  let tokenLineBreakBefore = false;
  let htmlCloseCommentAllowed = true;
  const emit = (token: Token): void => {
    const significant = tokenLineBreakBefore ? { ...token, lineBreakBefore: true } : token;
    if (memberAtToken !== undefined) {
      advanceMember(memberAtToken, significant, tokens[tokens.length - 1]);
    }
    const scope = requireScopes[requireScopes.length - 1];
    tokens.push(
      scope?.inParameters === true
        ? {
            ...significant,
            parameterFrame: frames.length,
            ...(typeAnnotation === undefined ? {} : { parameterType: true }),
          }
        : significant,
    );
    if (token.kind !== 'punct' || token.syntheticBoundary !== true) {
      htmlCloseCommentAllowed = false;
    }
    tokenLineBreakBefore = false;
    lineTerminatorSinceLastToken = false;
  };

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
  const templateStarts: number[] = [];

  const braceContexts: BraceContext[] = [];
  let memberAtToken: ClassMember | undefined;
  // Function context of every open function body, tracked independently of expression frame resets
  // so `${}` boundaries cannot change the nearest await/yield grammar.
  const functionContextStack: FuncContext[] = [];
  const requireScopes: RequireScope[] = [];
  const closeRequireScope = (scope: RequireScope | undefined): void => {
    if (scope !== undefined && requireScopes[requireScopes.length - 1] === scope) {
      requireScopes.pop();
    }
  };
  const recordRequireBinding = (parameters: ParameterContext, end: number): void => {
    const scope = parameters.signature?.context.requireScope;
    const bindingEnd = parameters.bindingEnd ?? end;
    if (scope !== undefined && parameters.bindingStart < bindingEnd) {
      scope.bindings.push({ start: parameters.bindingStart, end: bindingEnd });
    }
  };
  // The nearest function body owns the await/yield grammar. An ordinary nested function therefore
  // suspends an async/generator context from an outer function instead of inheriting it.
  // A default callback may open and finish while an outer signature is still reading parameters.
  // Only a signature with closed parameters at its original depth can own the next body brace.
  const pendingFunctionContexts: PendingFuncContext[] = [];
  const pendingClassContexts: PendingClassContext[] = [];
  const conditionalContexts: LexicalDepth[] = [];
  let colonIsExpression = false;
  const expressionFunctionContexts: ExpressionFuncContext[] = [];
  let typeAnnotation: TypeAnnotation | undefined;
  const parameterContexts: ParameterContext[] = [];
  let closedParameterSignature: OwnedSignature | undefined;
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
  // Parameter/control parentheses carry the signature they opened, rather than recovering one
  // from an arbitrary `)` when a colon or body brace appears later.
  let parenDepth = 0;

  const atLexicalDepth = (context: LexicalDepth): boolean =>
    parenDepth === context.parenDepth &&
    bracketDepth === context.bracketDepth &&
    braceContexts.length === context.braceDepth &&
    frames.length === context.frameDepth;

  const insideObjectLiteral = (): boolean =>
    braceContexts[braceContexts.length - 1]?.role === 'object';
  const insideClassBody = (): boolean => braceContexts[braceContexts.length - 1]?.role === 'class';
  const atMethodContainer = (): boolean => {
    const brace = braceContexts[braceContexts.length - 1];
    return brace?.role === 'object'
      ? atLexicalDepth(brace.depth)
      : brace?.role === 'class' && atLexicalDepth(brace.state);
  };
  const currentClass = (): ClassContext | undefined => {
    const brace = braceContexts[braceContexts.length - 1];
    return brace?.role === 'class' ? brace.state : undefined;
  };

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
    // Pending signatures retain their own depth across template/JSX expressions in parameters.
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

  // Template interpolations, JSX markup and sibling containers are separate expressions. An
  // explicit boundary keeps the token stream from gluing them into an import/require sequence that
  // does not exist in source (for example `<p>{import}{('pkg')}</p>`).
  const pushBoundary = (offset: number): void => {
    emit({
      kind: 'punct',
      value: ';',
      offset,
      endOffset: offset + 1,
      syntheticBoundary: true,
    });
  };

  while (i < n) {
    memberAtToken = undefined;
    const ch = source[i];
    let typedArrowContext: FuncContext | undefined;
    let inType = typeAnnotation !== undefined;
    let closedClassMemberBoundary = false;
    let closedExpressionBrace = false;
    let opensClassMemberBoundary = false;
    let matchingOpen: number | undefined;

    if (ch === undefined) {
      i++;
      continue;
    }

    let conditional = conditionalContexts[conditionalContexts.length - 1];

    while (
      conditional !== undefined &&
      (conditional.parenDepth > parenDepth ||
        conditional.bracketDepth > bracketDepth ||
        conditional.braceDepth > braceContexts.length ||
        conditional.frameDepth > frames.length)
    ) {
      conditionalContexts.pop();
      conditional = conditionalContexts[conditionalContexts.length - 1];
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
        const start = templateStarts.pop() ?? templateStart;
        emit({ kind: 'template', offset: start, endOffset: i + 1 });
        templateStart = templateStarts[templateStarts.length - 1] ?? start;
        prevKind = 'template';
        i++;
        continue;
      }

      if (ch === '$' && source[i + 1] === '{') {
        // Start of a `${...}` expression: lex the JavaScript inside like ordinary source. The frame
        // starts at brace depth 0, so the next unmatched `}` closes the interpolation.
        frames.push({
          kind: 'template-expr',
          depth: 0,
          offset: i,
          ...(typeAnnotation !== undefined
            ? { typeOwner: { annotation: typeAnnotation, depth: { ...typeAnnotation } } }
            : {}),
        });
        // The preceding tag is not the callee of tokens inside this interpolation.
        pushBoundary(i);
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
        if (isIdentifierStartAt(source, i + 1)) {
          const tag = readJsxTagName(source, i + 1, n);
          frames.push({ kind: 'jsx-tag', name: tag.name, offset: i, nameEnd: tag.end });
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
      if (ch === '<' && skipTrivia(source, frame.nameEnd, n) === i) {
        pushBoundary(i);
        i = readJsxTypeArguments(source, i, n, tokens);
        pushBoundary(i);
        continue;
      }

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

    if (
      !module &&
      (source.startsWith('<!--', i) || (source.startsWith('-->', i) && htmlCloseCommentAllowed))
    ) {
      while (i < n && !isLineTerminator(source[i])) {
        i++;
      }
      continue;
    }

    if (isWhitespace(ch) || (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*'))) {
      const trivia = readTrivia(source, i, n);
      i = trivia.end;
      lineTerminatorSinceLastToken ||= trivia.lineBreak;
      htmlCloseCommentAllowed ||= trivia.lineBreak;
      continue;
    }

    tokenLineBreakBefore = lineTerminatorSinceLastToken;
    const previousSignature = closedParameterSignature;
    closedParameterSignature = undefined;
    memberAtToken = undefined;
    const classState = currentClass();
    const identifier =
      isIdentifierStartAt(source, i) || isUnicodeEscapeStart(source, i)
        ? readIdentifier(source, i)
        : undefined;
    if (
      typeAnnotation?.role === 'assertion' &&
      atLexicalDepth(typeAnnotation.owner) &&
      atTypeRoot(typeAnnotation) &&
      !(ch === '>' && isArrowHead(tokens[tokens.length - 1], i)) &&
      !assertionTypeContinues(
        typeAnnotation,
        ch,
        identifier?.value,
        tokenLineBreakBefore,
        source[i + 1],
      )
    ) {
      // Complete the expression before class-field ASI and slash classification consume it.
      // The token keeps its type delimiter identity; no runtime brace is invented or popped.
      const previous = tokens[tokens.length - 1];
      if (previous !== undefined) {
        tokens[tokens.length - 1] = { ...previous, assertionEnd: true };
      }
      prevIsExpressionKeyword = false;
      afterControlHead = false;
      typeAnnotation = undefined;
      inType = false;
    }
    const expressionOwner = expressionFunctionContexts[expressionFunctionContexts.length - 1];
    if (
      typeAnnotation === undefined &&
      ch === '<' &&
      prevKind === 'identifier' &&
      expressionOwner !== undefined &&
      atLexicalDepth(expressionOwner)
    ) {
      const end = expressionTypeArgumentEnd(source, i, n, typeArgumentBounds);
      if (end !== undefined) {
        // Use the ordinary type overlay: it preserves template imports and lexical scopes.
        typeAnnotation = {
          role: 'assertion',
          conditionalDepth: 0,
          conditionalOperand: false,
          importCallPending: false,
          owner: {
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length,
            frameDepth: frames.length,
          },
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
        inType = true;
      }
    }

    // An assertion must release its type context before the same runtime delimiter can retire
    // an enclosing arrow. Consume the delimiter only after restoring the nearest function grammar.
    let expressionFunctionContext =
      expressionFunctionContexts[expressionFunctionContexts.length - 1];

    while (
      expressionFunctionContext !== undefined &&
      typeAnnotation === undefined &&
      frames[frames.length - 1]?.kind !== 'jsx-text' &&
      frames[frames.length - 1]?.kind !== 'jsx-tag' &&
      expressionFunctionBodyEnded(
        ch,
        parenDepth,
        bracketDepth,
        braceContexts.length,
        frames.length,
        functionContextStack.length,
        conditionalContexts.length,
        expressionFunctionContext,
      )
    ) {
      closeRequireScope(expressionFunctionContexts.pop()?.requireScope);
      expressionFunctionContext = expressionFunctionContexts[expressionFunctionContexts.length - 1];
    }

    if (
      typeAnnotation?.role === 'return' &&
      tokenLineBreakBefore &&
      atLexicalDepth(typeAnnotation.signature.owner) &&
      atTypeRoot(typeAnnotation) &&
      !typeAnnotation.typeOperandExpected &&
      ((identifier !== undefined &&
        (!TYPE_OPERAND_KEYWORDS.has(identifier.value) || identifier.value === 'const')) ||
        (ch === '[' &&
          typeAnnotation.signature.context.isClassMember === true &&
          computedMethodFollows(source, i, n)))
    ) {
      const signature = typeAnnotation.signature;
      if (
        pendingFunctionContexts[pendingFunctionContexts.length - 1]?.requireScope ===
        signature.context.requireScope
      ) {
        closeRequireScope(pendingFunctionContexts.pop()?.requireScope);
      }
      if (classState !== undefined && signature.context.isClassMember === true) {
        classState.member = undefined;
      }
      typeAnnotation = undefined;
      inType = false;
    }
    const pendingBodylessSignature = pendingFunctionContexts[pendingFunctionContexts.length - 1];
    if (
      pendingBodylessSignature?.phase === 'awaiting-body' &&
      atLexicalDepth(pendingBodylessSignature) &&
      ((typeAnnotation === undefined && tokenLineBreakBefore && ch !== '{' && ch !== ':') ||
        (ch === '}' &&
          (typeAnnotation === undefined ||
            (typeAnnotation.role === 'return' && atTypeRoot(typeAnnotation)))))
    ) {
      closeRequireScope(pendingFunctionContexts.pop()?.requireScope);
      typeAnnotation = undefined;
      inType = false;
      resetExpressionState();
    }
    if (
      classState !== undefined &&
      atLexicalDepth(classState) &&
      (typeAnnotation === undefined ||
        (typeAnnotation.role === 'field' && atTypeRoot(typeAnnotation)) ||
        (typeAnnotation.role === 'return' &&
          atTypeRoot(typeAnnotation) &&
          (ch === ';' || ch === '}')))
    ) {
      if (
        tokenLineBreakBefore &&
        classState.member !== undefined &&
        typeAnnotation?.typeOperandExpected !== true &&
        classFieldCanEnd(classState.member, tokens[tokens.length - 1], ch, identifier?.value)
      ) {
        classState.member = undefined;
        typeAnnotation = undefined;
        inType = false;
      }
      if (ch === ';' || ch === '}') {
        classState.member = undefined;
        if (typeAnnotation?.role === 'field') {
          typeAnnotation = undefined;
          inType = false;
        }
      } else {
        classState.member ??= {
          start: tokens.length,
          functionDepth: functionContextStack.length,
          phase: 'head',
        };
        memberAtToken = classState.member;
      }
    }
    if (lineTerminatorSinceLastToken && typeAnnotation === undefined) {
      let context = expressionFunctionContexts[expressionFunctionContexts.length - 1];

      while (
        context !== undefined &&
        frames[frames.length - 1]?.kind !== 'jsx-text' &&
        frames[frames.length - 1]?.kind !== 'jsx-tag' &&
        lineTerminatorEndsExpressionFunctionBody(
          ch,
          prevKind,
          prevPunct,
          tokens[tokens.length - 1],
          identifier?.value,
          (ch === '+' || ch === '-') && source[i + 1] === ch,
          parenDepth,
          bracketDepth,
          braceContexts.length,
          frames.length,
          functionContextStack.length,
          context,
        )
      ) {
        closeRequireScope(expressionFunctionContexts.pop()?.requireScope);
        context = expressionFunctionContexts[expressionFunctionContexts.length - 1];
      }

      lineTerminatorSinceLastToken = false;
    }
    const equalsOperator =
      ch === '='
        ? classifyEquals(source, i, typeAnnotation !== undefined && atTypeRoot(typeAnnotation))
        : undefined;

    if (ch === '<' && typeAnnotation === undefined) {
      const classHeader = pendingClassContexts[pendingClassContexts.length - 1];
      if (
        classHeader !== undefined &&
        atLexicalDepth(classHeader) &&
        (tokens[tokens.length - 1]?.kind === 'identifier' ||
          isPunct(tokens[tokens.length - 1], ')') ||
          isPunct(tokens[tokens.length - 1], ']') ||
          isPunct(tokens[tokens.length - 1], '>'))
      ) {
        typeAnnotation = {
          role: 'class-header',
          owner: classHeader,
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
        inType = true;
      }
    }

    // A backtick in code mode opens a (possibly nested) template literal. Inside an annotation
    // that is a template-literal type: its text stays inert and the annotation keeps running until the
    // type itself ends.
    if (ch === '`') {
      templateStart = i;
      templateStarts.push(i);
      inText = true;
      prevKind = 'template';

      if (typeAnnotation !== undefined) {
        typeAnnotation.typeOperandExpected = false;
      }

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
      typeAnnotation === undefined &&
      ch === '<' &&
      i + 1 < n &&
      isRegexStart(
        prevKind,
        prevPunct,
        prevIsExpressionKeyword,
        afterControlHead,
        closedObjectBrace,
        tokens[tokens.length - 1],
      )
    ) {
      const after = source[i + 1];

      if (after === '>') {
        frames.push({ kind: 'jsx-text', name: null, offset: i });
        pushBoundary(i);
        i += 2;
        continue;
      }

      if (isIdentifierStartAt(source, i + 1) && !jsxTagIsGeneric(source, i + 1, n)) {
        const tag = readJsxTagName(source, i + 1, n);
        frames.push({ kind: 'jsx-tag', name: tag.name, offset: i, nameEnd: tag.end });
        pushBoundary(i);
        i = tag.end;
        continue;
      }
    }

    // Type delimiters belong to the field, parameter or return signature, never to runtime code.
    // Only that owner's boundary or initializer/body can end the annotation.
    if (typeAnnotation !== undefined) {
      const annotation = typeAnnotation;
      const typeFrame =
        frame?.kind === 'template-expr' && frame.typeOwner?.annotation === annotation
          ? frame.typeOwner
          : undefined;
      const atRoot = typeFrame === undefined && atTypeRoot(annotation);
      const isTypeArrow = ch === '>' && isArrowHead(tokens[tokens.length - 1], i);

      if (annotation.role === 'assertion' && atRoot) {
        if (ch === '?' && annotation.conditionalOperand) {
          annotation.conditionalDepth++;
          annotation.conditionalOperand = false;
        } else if (ch === ':' && annotation.conditionalDepth > 0) {
          annotation.conditionalDepth--;
        }
        if (ch === '(') {
          annotation.importCallPending = false;
        }
      }

      // Interpolations own depths relative to the surrounding type, which may itself be an object.
      if (
        ch === '}' &&
        (typeFrame !== undefined
          ? sameTypeDepth(annotation, typeFrame.depth)
          : annotation.braceDepth === 0) &&
        (frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr') &&
        frame.depth === 0
      ) {
        frames.pop();
        pushBoundary(i);
        i++;

        if (frame.kind === 'template-expr') {
          annotation.typeOperandExpected = false;
          inText = true;
          resetExpressionState();
        } else {
          // Back to the enclosing JSX tag or text frame, which reads the next character itself.
          endJsxElement();
        }

        continue;
      }

      if (
        (annotation.role === 'field' || annotation.role === 'parameter') &&
        atRoot &&
        ch === '=' &&
        equalsOperator?.operator === 'assignment'
      ) {
        if (annotation.role === 'field') {
          annotation.member.phase = 'initializer';
        } else {
          annotation.owner.phase = 'initializer';
        }
        typeAnnotation = undefined;
        inType = false;
      } else if (
        annotation.role === 'return' &&
        ch === '{' &&
        atRoot &&
        !annotation.typeOperandExpected
      ) {
        // A complete type was read, so this brace opens the runtime body.
        typeAnnotation = undefined;
        inType = false;
        lineTerminatorSinceLastToken = false;

        if (
          !annotation.signature.isFunctionKeyword &&
          pendingFunctionContexts[pendingFunctionContexts.length - 1]?.requireScope !==
            annotation.signature.context.requireScope
        ) {
          pendingFunctionContexts.push({
            ...annotation.signature.context,
            ...annotation.signature.owner,
            parameterDepth: undefined,
            phase: 'awaiting-body',
          });
        }
      } else if (
        isTypeArrow &&
        atRoot &&
        annotation.role === 'return' &&
        annotation.signature.isArrowSignature &&
        !functionTypeArrowContinues(
          source,
          i,
          n,
          conditional !== undefined && atLexicalDepth(conditional),
        )
      ) {
        // The signature's own `=>`: everything after it is the body, not the return type.
        typedArrowContext = annotation.signature.context;
        typeAnnotation = undefined;
        inType = false;
        lineTerminatorSinceLastToken = false;
      } else if (atRoot && (ch === ';' || ch === ',' || ch === ')' || ch === ']' || ch === '}')) {
        // A signature with no body of its own. Neither the annotation nor a pending signature may
        // outlive it, otherwise later code (a JSX text `<`, another method body, an async arrow) is
        // misread.
        typeAnnotation = undefined;
        inType = false;
      } else {
        if (ch === '{') {
          annotation.braceDepth++;
          annotation.typeOperandExpected = true;
        } else if (ch === '}') {
          annotation.braceDepth = Math.max(0, annotation.braceDepth - 1);
          annotation.typeOperandExpected = false;
        } else if (ch === '(') {
          annotation.parenDepth++;
          annotation.typeOperandExpected = true;
        } else if (ch === ')') {
          annotation.parenDepth = Math.max(0, annotation.parenDepth - 1);
          annotation.typeOperandExpected = false;
        } else if (ch === '[') {
          annotation.bracketDepth++;
          annotation.typeOperandExpected = true;
        } else if (ch === ']') {
          annotation.bracketDepth = Math.max(0, annotation.bracketDepth - 1);
          annotation.typeOperandExpected = false;
        } else if (ch === '<') {
          annotation.angleDepth++;
          annotation.typeOperandExpected = true;
        } else if (isTypeArrow) {
          // A function type's own arrow (`(x: A) => B`) still expects a type on its right.
          annotation.typeOperandExpected = true;
        } else if (ch === '>' && annotation.angleDepth > 0) {
          annotation.angleDepth--;
          annotation.typeOperandExpected = false;
        } else if (ch === ':' || ch === '?' || ch === '.' || ch === '|' || ch === '&') {
          annotation.typeOperandExpected = true;
        }
        if (
          annotation.role === 'class-header' &&
          ch === '>' &&
          !isTypeArrow &&
          atTypeRoot(annotation)
        ) {
          typeAnnotation = undefined;
        }
      }
    }

    // A `}` in code mode closes the innermost open `${...}` or JSX `{...}` expression only when that
    // expression has no open braces of its own; otherwise it is an ordinary brace inside it.
    if (ch === '}' && typeAnnotation === undefined) {
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

      // Operand completion for class-field ASI is separate from the regex/division decision.
      // A function/class body can finish an initializer without closing an object literal.
      const closed = braceContexts.pop();
      const closedMethod = closed?.role === 'function' && closed.context.isClassMember === true;
      closedClassMemberBoundary = closedMethod || closed?.role === 'static-block';
      closedObjectBrace =
        closed?.role === 'object' ||
        (closed?.role === 'function' && closed.context.isExpression) ||
        (closed?.role === 'class' && closed.isExpression);
      closedExpressionBrace =
        closedObjectBrace ||
        closedMethod ||
        closed?.role === 'function' ||
        closed?.role === 'class';
      if (closed?.role === 'function') {
        closeRequireScope(closed.context.requireScope);
        functionContextStack.pop();
      }
      if (
        (closed?.role === 'function' || closed?.role === 'static-block') &&
        closed.owner !== undefined
      ) {
        closed.owner.member = undefined;
      }
    }

    // `/` is a regex when it can start an expression, otherwise it is division.
    if (ch === '/') {
      if (
        isRegexStart(
          prevKind,
          prevPunct,
          prevIsExpressionKeyword ||
            (tokenLineBreakBefore &&
              (isIdentifier(tokens[tokens.length - 1], 'break') ||
                isIdentifier(tokens[tokens.length - 1], 'continue'))),
          afterControlHead,
          closedObjectBrace,
          tokens[tokens.length - 1],
        )
      ) {
        const start = i;
        i = skipRegex(source, i);
        emit({ kind: 'regex', offset: start, endOffset: i });
        prevKind = 'regex';
        afterControlHead = false;
        pendingControlKeyword = undefined;
        continue;
      }

      emit({ kind: 'punct', value: '/', offset: i, endOffset: i + 1 });
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
      emit({ kind: 'string', value, offset: i, endOffset: next });

      if (typeAnnotation !== undefined) {
        typeAnnotation.typeOperandExpected = false;
      }
      prevKind = 'string';
      afterControlHead = false;
      pendingControlKeyword = undefined;
      i = next;
      continue;
    }

    // Identifiers.
    if (identifier !== undefined) {
      const start = i;
      i = identifier.end;
      const value = identifier.value;

      if (typeAnnotation !== undefined) {
        if (typeAnnotation.role === 'assertion') {
          if (
            atLexicalDepth(typeAnnotation.owner) &&
            atTypeRoot(typeAnnotation) &&
            value === 'extends' &&
            !typeAnnotation.typeOperandExpected
          ) {
            typeAnnotation.conditionalOperand = true;
          }
          typeAnnotation.importCallPending = value === 'import';
        }
        // `as const` completes an assertion, while prefix keywords still expect an operand.
        typeAnnotation.typeOperandExpected =
          TYPE_OPERAND_KEYWORDS.has(value) &&
          !(typeAnnotation.role === 'assertion' && value === 'const');
      }
      const previousIdentifier = prevIdentifier;
      const startsAssertion =
        (value === 'as' || value === 'satisfies') &&
        !inType &&
        // TypeScript permits trivia after these operators, but a preceding newline ends them.
        !tokenLineBreakBefore &&
        !(prevKind === 'punct' && prevPunct === '.') &&
        !(
          prevKind === 'punct' &&
          prevPunct === '}' &&
          !closedObjectBrace &&
          tokens[tokens.length - 1]?.assertionEnd !== true
        ) &&
        !afterControlHead &&
        !prevIsExpressionKeyword &&
        canStartTypeAssertion(tokens[tokens.length - 1]);
      // Capture the enclosing operand grammar before this identifier replaces it. Contextual
      // await/yield, an arrow head and a fresh embedded expression all expect an expression.
      const expressionPosition = functionIsExpressionPosition(
        prevKind,
        prevPunct,
        colonIsExpression,
        (prevKind === 'identifier' &&
          prevIsExpressionKeyword &&
          !BLOCK_AFTER_KEYWORD.has(previousIdentifier ?? '') &&
          !(
            (previousIdentifier === 'return' || previousIdentifier === 'yield') &&
            tokenLineBreakBefore
          )) ||
          (isPunct(tokens[tokens.length - 1], '>') && isArrowHead(tokens[tokens.length - 2])) ||
          (prevKind === 'start' && (frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr')),
      );
      if (value === 'async') {
        asyncFunctionIsExpression = expressionPosition;
        if (
          isIdentifier(tokens[tokens.length - 1], 'default') &&
          isIdentifier(tokens[tokens.length - 2], 'export')
        ) {
          asyncFunctionIsExpression = false;
        }
      }
      prevIdentifier = value;
      const isMemberName = prevKind === 'punct' && prevPunct === '.';
      const atRoot =
        braceContexts.length === 0 && parenDepth === 0 && bracketDepth === 0 && frames.length === 0;
      let moduleSignal =
        detectModule &&
        !isMemberName &&
        ((value === 'import' && importSignalsModule(source, i, atRoot)) ||
          (value === 'export' && atRoot && exportSignalsModule(source, i)));
      const classMemberName =
        value === 'class' &&
        atMethodContainer() &&
        memberDeclarationHead(
          tokens,
          tokens.length,
          insideClassBody(),
          currentClass()?.member?.start,
        ) !== undefined;
      const nextSignificant = skipTrivia(source, i, n);
      const classPropertyName =
        value === 'class' &&
        (insideObjectLiteral() || insideClassBody()) &&
        [':', '=', '(', ',', '}'].includes(source[nextSignificant] ?? '');
      if (
        value === 'class' &&
        !isMemberName &&
        !classMemberName &&
        !classPropertyName &&
        typeAnnotation === undefined
      ) {
        const isExportDefault =
          isIdentifier(tokens[tokens.length - 1], 'default') &&
          isIdentifier(tokens[tokens.length - 2], 'export');
        pendingClassContexts.push({
          parenDepth,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
          isExpression:
            !isExportDefault && (previousIdentifier === 'extends' || expressionPosition),
        });
      }
      // A keyword after `.` is a property name (e.g. `x.return`), not an expression start.
      const forIterationSeparator =
        (value === 'of' || value === 'in') &&
        !isMemberName &&
        consumeForIterationSeparator(tokens, parameterContexts, {
          parenDepth,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
        });
      let isExpressionKeyword =
        (REGEX_PRECEDING_KEYWORDS.has(value) || forIterationSeparator) && !isMemberName;
      // `await`/`yield` are keywords only inside an async / generator function body. A member name
      // (`obj.await`) is always a property access, never a keyword, so a following `/` divides.
      if (!isMemberName) {
        const expressionContext = expressionFunctionContexts[expressionFunctionContexts.length - 1];
        const bodyContext = functionContextStack[functionContextStack.length - 1];
        const parameterOwner = nearestFunctionParameter(parameterContexts);
        const classMemberOwner = nearestClassField(braceContexts);
        const parameterGrammarSuspended =
          parameterOwner !== undefined &&
          functionContextStack.length <= parameterOwner.functionDepth &&
          expressionContext?.parameterOwner !== parameterOwner;
        const fieldGrammarSuspended =
          classMemberOwner !== undefined &&
          functionContextStack.length <= classMemberOwner.functionDepth &&
          expressionContext?.classMemberOwner !== classMemberOwner;
        const expressionContextIsCurrent =
          expressionContext !== undefined &&
          functionContextStack.length <= expressionContext.functionDepth
            ? expressionContext
            : undefined;
        const functionContext =
          parameterGrammarSuspended || fieldGrammarSuspended
            ? undefined
            : (expressionContextIsCurrent ?? bodyContext);
        const probe =
          detectModule &&
          value === 'await' &&
          !(
            prevKind === 'identifier' &&
            ['class', 'function', 'var', 'let', 'const', 'extends'].includes(
              previousIdentifier ?? '',
            )
          ) &&
          functionContext === undefined &&
          !parameterGrammarSuspended &&
          !fieldGrammarSuspended
            ? probeAwaitOperand(
                source,
                i,
                parameterContexts[parameterContexts.length - 1]?.forPhase !== undefined,
              )
            : undefined;
        moduleSignal ||= probe?.module === true;
        if (
          value === 'await' &&
          (functionContext?.async === true ||
            probe?.keyword === true ||
            (functionContext === undefined &&
              module &&
              !parameterGrammarSuspended &&
              !fieldGrammarSuspended))
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
        isMemberName || insideObjectLiteral() || insideClassBody(),
        pendingControlKeyword,
      );
      // A `function` keyword (not a property name) starts a function signature. Track whether it is
      // an expression (`const f = function(){}`) or a declaration (`function f(){}`), and whether it
      // is async (`async function`, i.e. preceded by `async`) or a generator (`function*`, resolved
      // when a following `*` is seen). The context is consumed at the body `{`.
      const methodName =
        value === 'function' &&
        atMethodContainer() &&
        memberDeclarationHead(
          tokens,
          tokens.length,
          insideClassBody(),
          currentClass()?.member?.start,
        ) !== undefined;
      if (value === 'function' && !isMemberName && !methodName && typeAnnotation === undefined) {
        // `async function` is only async without a line terminator between the two words: a line
        // break ends the `async` statement, so the declaration that follows is an ordinary one.
        const isAsync =
          previousIdentifier === 'async' && prevKind === 'identifier' && !tokenLineBreakBefore;

        pendingFunctionContexts.push({
          requireScope: {
            parent: requireScopes[requireScopes.length - 1],
            bindings: [],
            inParameters: true,
          },
          async: isAsync,
          generator: false,
          isExpression: isAsync
            ? asyncFunctionIsExpression
            : !(
                isIdentifier(tokens[tokens.length - 1], 'default') &&
                isIdentifier(tokens[tokens.length - 2], 'export')
              ) && expressionPosition,
          parenDepth,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
          parameterDepth: undefined,
          phase: 'awaiting-parameters',
        });
      }
      // A bare arrow parameter has no opening parenthesis to own its binding range.
      const next = !inType && !isMemberName ? skipTrivia(source, i, n) : n;
      const singleArrowContext: FuncContext | undefined =
        source[next] === '=' && source[next + 1] === '>'
          ? {
              async:
                prevKind === 'identifier' &&
                previousIdentifier === 'async' &&
                !tokenLineBreakBefore,
              generator: false,
              isExpression: false,
              requireScope: {
                parent: requireScopes[requireScopes.length - 1],
                bindings: [{ start: tokens.length, end: tokens.length + 1 }],
                inParameters: false,
              },
            }
          : undefined;
      if (singleArrowContext?.requireScope !== undefined) {
        requireScopes.push(singleArrowContext.requireScope);
      }
      emit({
        kind: 'identifier',
        value,
        offset: start,
        ...(singleArrowContext === undefined ? {} : { signatureContext: singleArrowContext }),
        endOffset: i,
        ...(value === 'require' && requireScopes.length > 0
          ? { requireScope: requireScopes[requireScopes.length - 1] }
          : {}),
        ...(isMemberName ? { propertyName: true } : {}),
        ...(moduleSignal ? { moduleSignal: true } : {}),
      });
      // Once the mode is known, only the definitive module pass should validate the remainder.
      // Continuing this probe with script grammar could reject valid newline await operands.
      if (detectModule && moduleSignal) {
        return tokens;
      }
      if (startsAssertion) {
        typeAnnotation = {
          role: 'assertion',
          conditionalDepth: 0,
          conditionalOperand: false,
          importCallPending: false,
          owner: {
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length,
            frameDepth: frames.length,
          },
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
      }
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

        if (part === undefined || !(isIdentifierPartAt(source, i) || part === '.')) {
          break;
        }

        i++;
      }

      emit({ kind: 'number', offset: start, endOffset: i });

      if (typeAnnotation !== undefined) {
        typeAnnotation.typeOperandExpected = false;
      }

      prevKind = 'number';
      afterControlHead = false;
      pendingControlKeyword = undefined;
      continue;
    }

    if (ch === ':' && typeAnnotation === undefined) {
      const parameter = parameterContexts[parameterContexts.length - 1];
      if (previousSignature !== undefined && atLexicalDepth(previousSignature.owner)) {
        typeAnnotation = {
          role: 'return',
          signature: previousSignature,
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
        inType = true;
      } else if (
        classState !== undefined &&
        memberAtToken !== undefined &&
        (memberAtToken.phase === 'field' || memberAtToken.phase === 'head')
      ) {
        typeAnnotation = {
          role: 'field',
          owner: classState,
          member: memberAtToken,
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
        memberAtToken.phase = 'type';
        inType = true;
      } else if (
        parameter?.signature !== undefined &&
        parameter.phase === 'binding' &&
        atLexicalDepth(parameter.depth)
      ) {
        typeAnnotation = {
          role: 'parameter',
          owner: parameter,
          parenDepth: 0,
          bracketDepth: 0,
          braceDepth: 0,
          angleDepth: 0,
          typeOperandExpected: true,
        };
        parameter.bindingEnd ??= tokens.length;
        parameter.phase = 'type';
        inType = true;
      }
    }

    // Any other single character is punctuation. This (and the `:`/`;`/`}` handlers below) is the
    // only place that pushes a conditionalContext, and it is reached solely while scanning real
    // JavaScript: template text, JSX markup and `${...}`/`{...}` expression bodies are consumed by
    // the text-mode gates above, so inert punctuation inside them never contributes a conditional.
    // A `?` in template text is a plain character, not a ternary, so it must not leak here.
    if (
      !inType &&
      ch === '?' &&
      (memberAtToken === undefined || memberAtToken.phase === 'initializer') &&
      source[i + 1] !== '?' &&
      source[i - 1] !== '?' &&
      source[i + 1] !== '.'
    ) {
      conditionalContexts.push({
        parenDepth,
        bracketDepth,
        braceDepth: braceContexts.length,
        frameDepth: frames.length,
      });
    } else if (!inType && ch === ':') {
      const isConditional = conditional !== undefined && atLexicalDepth(conditional);

      if (isConditional) {
        conditionalContexts.pop();
      }

      colonIsExpression = isConditional || insideObjectLiteral();
    } else if (!inType && ch === ';' && conditional !== undefined && atLexicalDepth(conditional)) {
      conditionalContexts.pop();
    }

    if (!inType && ch === '{') {
      // Record what this brace opens, so its `}` knows whether an expression or a statement ended.
      let isObject = opensObjectLiteral(
        prevKind,
        prevPunct,
        prevIdentifier,
        prevIsExpressionKeyword,
        frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr',
        colonIsExpression,
        tokenLineBreakBefore,
      );
      const pending = pendingFunctionContexts[pendingFunctionContexts.length - 1];
      let context: FuncContext | undefined;

      if (pending?.phase === 'awaiting-body' && atLexicalDepth(pending)) {
        context = pendingFunctionContexts.pop();
      }
      if (context !== undefined) {
        isObject = false;
      }

      const classExpression =
        !isObject && context === undefined
          ? takeClassBodyContext(pendingClassContexts, {
              parenDepth,
              bracketDepth,
              braceDepth: braceContexts.length,
              frameDepth: frames.length,
            })
          : undefined;
      const isClassBody = classExpression !== undefined;
      opensClassMemberBoundary = isClassBody;
      const isStaticBlock =
        !isObject &&
        !isClassBody &&
        insideClassBody() &&
        isIdentifier(tokens[tokens.length - 1], 'static');

      // A statement-block brace that consumes a pending function signature is a function body. A
      // function expression used as a value ends an expression (so a following `/` divides), while a
      // declaration in statement position starts a block (so a following `/` may be a regex).
      //
      // Methods consume the signature captured at their parameter opener. Arrows use their
      // contiguous operator; neither a control head nor an unrelated call can claim this brace.
      if (context === undefined && !isObject && !isClassBody) {
        const last = tokens[tokens.length - 1];
        context =
          isPunct(last, '>') && isArrowHead(tokens[tokens.length - 2])
            ? inferArrowContext(tokens, tokens.length - 2)
            : previousSignature !== undefined &&
                !previousSignature.isArrowSignature &&
                atLexicalDepth(previousSignature.owner)
              ? previousSignature.context
              : undefined;
      }

      if (!isObject && context !== undefined) {
        functionContextStack.push(context);
      }
      const owner = currentClass();
      if (context !== undefined) {
        braceContexts.push({
          role: 'function',
          context,
          ...(context.isClassMember === true && owner !== undefined ? { owner } : {}),
        });
      } else if (isClassBody) {
        braceContexts.push({
          role: 'class',
          isExpression: classExpression.isExpression,
          state: {
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length + 1,
            frameDepth: frames.length,
            member: undefined,
          },
        });
      } else if (isStaticBlock && owner !== undefined) {
        braceContexts.push({ role: 'static-block', owner });
      } else {
        braceContexts.push(
          isObject
            ? {
                role: 'object',
                depth: {
                  parenDepth,
                  bracketDepth,
                  braceDepth: braceContexts.length + 1,
                  frameDepth: frames.length,
                },
              }
            : { role: 'block' },
        );
      }

      // Count the brace inside the innermost open `${...}` or JSX `{...}` expression so its closing
      // `}` is found.
      if (frame?.kind === 'template-expr' || frame?.kind === 'jsx-expr') {
        frame.depth += 1;
      }
    } else if (!inType && ch === '(') {
      // A `(` after a control keyword opens a control head; only its matching `)` may then be
      // followed by a regex literal, so the nesting depth of every `(` has to be tracked.
      const pending = pendingFunctionContexts[pendingFunctionContexts.length - 1];
      const signatureCandidate = parameterSignatureContext(
        tokens,
        pending !== undefined && atLexicalDepth(pending) ? pending : undefined,
        atMethodContainer(),
        insideClassBody(),
        tokenLineBreakBefore,
        currentClass()?.member?.start,
      );
      // A ternary's alternate may itself be an arrow. Its => is not proof that
      // the consequent's parentheses were parameters: a typed arrow must still
      // leave the enclosing conditional's colon after its own body.
      const needsConditionalEnd = conditional !== undefined && atLexicalDepth(conditional);
      const selectedSignature =
        signatureCandidate?.isArrowSignature === true &&
        !arrowFollowsParametersSafely(source, i, n, jsx, needsConditionalEnd)
          ? undefined
          : signatureCandidate;
      const signature =
        selectedSignature === undefined
          ? undefined
          : {
              ...selectedSignature,
              context:
                selectedSignature.context.requireScope !== undefined
                  ? selectedSignature.context
                  : {
                      ...selectedSignature.context,
                      requireScope: {
                        parent: requireScopes[requireScopes.length - 1],
                        bindings: [],
                        inParameters: true,
                      },
                    },
            };
      if (signature?.context.requireScope !== undefined) {
        requireScopes.push(signature.context.requireScope);
      }
      parameterContexts.push({
        openIndex: tokens.length,
        bindingStart: tokens.length + 1,
        bindingEnd: undefined,
        bindingCommas: [],
        signature:
          signature === undefined
            ? undefined
            : {
                ...signature,
                owner: {
                  parenDepth,
                  bracketDepth,
                  braceDepth: braceContexts.length,
                  frameDepth: frames.length,
                },
              },
        control: pendingControlKeyword !== undefined,
        controlKeyword: pendingControlKeyword,
        functionDepth: functionContextStack.length,
        depth: {
          parenDepth: parenDepth + 1,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
        },
        phase: 'binding',
        ...(pendingControlKeyword === 'for' ? { forPhase: 'binding' } : {}),
      });

      if (
        pending?.phase === 'awaiting-parameters' &&
        atLexicalDepth(pending) &&
        signature?.isFunctionKeyword === true
      ) {
        pending.parameterDepth = parenDepth + 1;
        pending.phase = 'parameters';
      }

      parenDepth++;

      pendingControlKeyword = undefined;

      afterControlHead = false;
    } else if (!inType && ch === '[') {
      bracketDepth++;
    } else if (!inType && ch === ')') {
      const pending = pendingFunctionContexts[pendingFunctionContexts.length - 1];

      if (
        pending?.parameterDepth === parenDepth &&
        bracketDepth === pending.bracketDepth &&
        braceContexts.length === pending.braceDepth &&
        frames.length === pending.frameDepth
      ) {
        pending.phase = 'awaiting-body';
      }

      const parameters = parameterContexts.pop();
      if (parameters?.signature !== undefined) {
        recordRequireBinding(parameters, tokens.length);
        const scope = parameters.signature.context.requireScope;
        if (scope !== undefined) {
          scope.inParameters = false;
        }
      }
      matchingOpen = parameters?.openIndex;
      closedParameterSignature = parameters?.signature;
      if (
        closedParameterSignature !== undefined &&
        !closedParameterSignature.isFunctionKeyword &&
        !closedParameterSignature.isArrowSignature
      ) {
        pendingFunctionContexts.push({
          ...closedParameterSignature.context,
          ...closedParameterSignature.owner,
          parameterDepth: undefined,
          phase: 'awaiting-body',
        });
      }
      afterControlHead = parameters?.control === true;

      if (parenDepth > 0) {
        parenDepth--;
      }
    } else if (!inType && ch === ']') {
      if (bracketDepth > 0) {
        bracketDepth--;
      }
    }

    if (!inType && (ch === '+' || ch === '-') && source[i + 1] === ch) {
      const previous = tokens[tokens.length - 1];
      const postfix =
        !tokenLineBreakBefore &&
        previous !== undefined &&
        isMemberExpressionEnd(previous) &&
        !prevIsExpressionKeyword;
      emit({
        kind: 'punct',
        value: ch + ch,
        offset: i,
        endOffset: i + 2,
        expressionEnd: postfix,
      });
      prevKind = 'punct';
      prevPunct = ch + ch;
      i += 2;
      continue;
    }

    // An arrow's expression body has no brace where its function context can be consumed. Record
    // its bounded context after `=>`; a following delimiter removes it again.
    if (!inType && ch === '>' && isArrowHead(tokens[tokens.length - 1], i)) {
      const context = typedArrowContext ?? inferArrowContext(tokens, tokens.length - 1);
      const next = skipTrivia(source, i + 1, n);

      if (context !== undefined) {
        if (source[next] === '{') {
          pendingFunctionContexts.push({
            ...context,
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length,
            frameDepth: frames.length,
            parameterDepth: undefined,
            phase: 'awaiting-body',
          });
        } else {
          const parameterOwner = nearestFunctionParameter(parameterContexts);
          const classMemberOwner = nearestClassField(braceContexts);
          expressionFunctionContexts.push({
            ...context,
            isExpression: true,
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length,
            frameDepth: frames.length,
            functionDepth: functionContextStack.length,
            conditionalDepth: conditionalContexts.length,
            ...(parameterOwner === undefined ? {} : { parameterOwner }),
            ...(classMemberOwner === undefined ? {} : { classMemberOwner }),
          });
        }
      }
    }

    // A `*` right after `function` (whitespace/comments aside) marks a generator: `function*` and
    // `function *`. It is recorded on the pending signature, consumed at the body `{`.
    const pending = pendingFunctionContexts[pendingFunctionContexts.length - 1];
    const parameter = parameterContexts[parameterContexts.length - 1];
    if (ch === ';' && parameter?.forPhase !== undefined && atLexicalDepth(parameter.depth)) {
      parameter.forPhase = 'regular';
    }
    if (!inType && parameter !== undefined && atLexicalDepth(parameter.depth)) {
      if (ch === ',') {
        const scope = parameter.signature?.context.requireScope;
        if (scope !== undefined) {
          parameter.bindingCommas.push({
            index: tokens.length,
            bindingStart: parameter.bindingStart,
            bindingEnd: parameter.bindingEnd,
            phase: parameter.phase,
            bindingCount: scope.bindings.length,
          });
        }
        recordRequireBinding(parameter, tokens.length);
        parameter.bindingStart = tokens.length + 1;
        parameter.bindingEnd = undefined;
        parameter.phase = 'binding';
      } else if (equalsOperator?.operator === 'assignment') {
        parameter.bindingEnd ??= tokens.length;
        parameter.phase = 'initializer';
      }
    }

    if (
      !inType &&
      ch === '*' &&
      prevKind === 'identifier' &&
      prevIdentifier === 'function' &&
      pending !== undefined
    ) {
      pendingFunctionContexts[pendingFunctionContexts.length - 1] = {
        ...pending,
        generator: true,
      };
    }

    // A callback's statements cannot invalidate a signature outside its body or parameter list.
    if (!inType && ch === ';' && pending !== undefined && atLexicalDepth(pending)) {
      closeRequireScope(pendingFunctionContexts.pop()?.requireScope);
    }

    const previousToken = tokens[tokens.length - 1];
    const openingSignature =
      ch === '(' ? parameterContexts[parameterContexts.length - 1]?.signature?.context : undefined;
    emit({
      kind: 'punct',
      value: ch,
      offset: i,
      endOffset: i + 1,
      ...(ch === '!' &&
      source[i + 1] !== '=' &&
      previousToken !== undefined &&
      isMemberExpressionEnd(previousToken) &&
      !prevIsExpressionKeyword
        ? { expressionEnd: true }
        : {}),
      ...equalsOperator,
      ...(openingSignature === undefined ? {} : { signatureContext: openingSignature }),
      ...(matchingOpen !== undefined ? { matchingOpen } : {}),
      ...(closedClassMemberBoundary || opensClassMemberBoundary || (ch === ';' && insideClassBody())
        ? { memberSeparator: true }
        : {}),
      ...(closedExpressionBrace ? { expressionEnd: true } : {}),
    });
    if (
      !inType &&
      ch === '>' &&
      requireScopes[requireScopes.length - 1]?.inParameters === true &&
      !isArrowHead(tokens[tokens.length - 2], i)
    ) {
      const start = markParameterTypeArguments(tokens, tokens.length);
      const owner = parameterContexts[parameterContexts.length - 1];
      const scope = owner?.signature?.context.requireScope;
      if (start !== undefined && owner !== undefined && scope !== undefined) {
        // Commas were provisional until the closing > established a type-argument list.
        // Restore the initializer state as well as its binding ranges; do not re-lex source.
        let first = owner.bindingCommas.length;
        while (first > 0 && (owner.bindingCommas[first - 1]?.index ?? -1) >= start) {
          first--;
        }
        const checkpoint = owner.bindingCommas[first];
        if (checkpoint !== undefined) {
          owner.bindingStart = checkpoint.bindingStart;
          owner.bindingEnd = checkpoint.bindingEnd;
          owner.phase = checkpoint.phase;
          scope.bindings.length = checkpoint.bindingCount;
          owner.bindingCommas.length = first;
        }
      }
    }
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
  try {
    if (!isIdentifierStartAt(source, i)) {
      return false;
    }

    const identifier = readIdentifier(source, i);
    let k = identifier.end;
    const name = identifier.value;
    k = skipTrivia(source, k, n);
    const next = source[k];

    if (next === ',' || next === '=') {
      return true;
    }

    if (next === '>') {
      const j = skipTrivia(source, k + 1, n);

      if (source[j] === '(') {
        return arrowFollowsParameters(source, j, n);
      }
    }

    let end = k;
    while (end < n && isIdentifierPartAt(source, end)) {
      end++;
    }

    if (source.slice(k, end) === 'extends') {
      // `extends` is a generic constraint only when it introduces a constraint type that closes
      // the type-parameter list. `implements` is not a TypeScript type-parameter constraint and
      // remains a JSX boolean attribute.
      const j = skipTrivia(source, end, n);
      const after = source[j];

      if (
        after !== '=' &&
        after !== '"' &&
        after !== "'" &&
        after !== '`' &&
        after !== '>' &&
        after !== '/'
      ) {
        return true;
      }
    }

    // `const T, ...`: a TypeScript const type parameter, whose real name follows the modifier.
    if (name === 'const' && k < n && isIdentifierStartAt(source, k)) {
      return jsxTagIsGeneric(source, k, n);
    }

    return false;
  } catch (error) {
    if (error instanceof ModuleSpecifierError) {
      // This is speculative: an apostrophe or `/*` may be inert JSX children, not broken JS.
      // Let the normal JSX path scan it; genuinely incomplete markup will still fail there.
      return false;
    }
    throw error;
  }
}

// Scan a generic function signature's parameter list starting at its opening `(` (offset `open`).
// Returns true only when the list is closed and `=>` follows, so callers can treat `<T>(...) =>` as
// a generic signature rather than a JSX element.
//
// Brackets inside strings, template literals and regex literals are inert: a `)` inside any of them
// must not be counted as the parameter-list close. Template interpolations are skipped opaquely
// because a template literal is a single argument value, so its internal parentheses never shape
// the parameter list. Regex-vs-division tracking mirrors the main tokenizer so a regex default
// (for example `= /a/)`) is skipped instead of read as division.
function arrowFollowsParameters(
  source: string,
  open: number,
  n: number,
  jsx = false,
  needsConditionalEnd = false,
  mode: 'parameters' | 'conditional-body' = 'parameters',
): boolean {
  let depth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let conditionalDepth = 0;
  let assertionOwner: { paren: number; bracket: number; brace: number; frame: number } | undefined;
  let prevKind: PrevKind = 'start';
  let prevPunct: string | undefined;

  let k = open;
  const jsxFrames: Frame[] = [];
  const typeArgumentBounds = new Map<number, number | null>();

  while (k < n) {
    let ch = source[k];
    const frame = jsxFrames[jsxFrames.length - 1];
    if (frame?.kind === 'jsx-text') {
      if (ch === '{') {
        jsxFrames.push({ kind: 'jsx-expr', depth: 0, offset: k });
        prevKind = 'start';
        prevPunct = undefined;
        k++;
        continue;
      }
      if (ch === '<' && source[k + 1] === '/') {
        const end = source.indexOf('>', k + 2);
        if (end < 0) {
          return false;
        }
        jsxFrames.pop();
        prevKind = 'template';
        prevPunct = undefined;
        k = end + 1;
        continue;
      }
      // Quotes, parentheses, backticks and comment markers in children are inert.
      if (ch !== '<') {
        k++;
        continue;
      }
    } else if (frame?.kind === 'jsx-tag') {
      if (ch === '<' && skipTrivia(source, frame.nameEnd, n) === k) {
        k = readJsxTypeArguments(source, k, n, []);
      } else if (ch === '{') {
        jsxFrames.push({ kind: 'jsx-expr', depth: 0, offset: k });
        prevKind = 'start';
        prevPunct = undefined;
        k++;
      } else if (ch === '"' || ch === "'") {
        k = skipJsxAttributeValue(source, k, n);
      } else if (ch === '/' && source[k + 1] === '>') {
        jsxFrames.pop();
        prevKind = 'template';
        prevPunct = undefined;
        k += 2;
      } else if (ch === '>') {
        jsxFrames.pop();
        jsxFrames.push({ kind: 'jsx-text', name: frame.name, offset: frame.offset });
        k++;
      } else {
        k++;
      }
      continue;
    } else {
      k = skipTrivia(source, k, n);
      ch = source[k];
    }
    if (ch === undefined) {
      break;
    }
    if (
      jsx &&
      ch === '<' &&
      (frame?.kind === 'jsx-text' || isRegexStart(prevKind, prevPunct, false, false, false))
    ) {
      if (source[k + 1] === '>') {
        jsxFrames.push({ kind: 'jsx-text', name: null, offset: k });
        k += 2;
        continue;
      }
      if (
        isIdentifierStartAt(source, k + 1) &&
        (frame?.kind === 'jsx-text' || !jsxTagIsGeneric(source, k + 1, n))
      ) {
        const tag = readJsxTagName(source, k + 1, n);
        jsxFrames.push({ kind: 'jsx-tag', name: tag.name, offset: k, nameEnd: tag.end });
        k = tag.end;
        continue;
      }
    }
    if (frame?.kind === 'jsx-text') {
      k++;
      continue;
    }
    if (frame?.kind === 'jsx-expr') {
      if (ch === '}') {
        if (frame.depth === 0) {
          jsxFrames.pop();
          prevKind = 'template';
          prevPunct = undefined;
          k++;
          continue;
        }
        frame.depth--;
      } else if (ch === '{') {
        frame.depth++;
      }
    }

    if (mode === 'conditional-body' && ch === '<' && prevKind === 'identifier') {
      const inAssertion =
        assertionOwner?.paren === depth &&
        assertionOwner.bracket === bracketDepth &&
        assertionOwner.brace === braceDepth &&
        assertionOwner.frame === jsxFrames.length;
      const end = expressionTypeArgumentEnd(source, k, n, typeArgumentBounds, inAssertion);
      if (end !== undefined) {
        k = end;
        prevKind = 'identifier';
        prevPunct = undefined;
        continue;
      }
    }

    if (
      assertionOwner?.paren === depth &&
      assertionOwner.bracket === bracketDepth &&
      assertionOwner.brace === braceDepth &&
      assertionOwner.frame === jsxFrames.length &&
      ['+', '-', '*', '/', '%', '=', '?', '!'].includes(ch)
    ) {
      assertionOwner = undefined;
    }

    // Reuse the same opaque regions to confirm a typed nested arrow in a ternary.
    // Colons in JSX, object literals, nested delimiters or inner conditionals do not
    // close the enclosing conditional. Stop at this expression's own boundary.
    if (mode === 'conditional-body') {
      if (jsxFrames.length === 0 && depth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (ch === ':') {
          if (conditionalDepth === 0) {
            return true;
          }
          conditionalDepth--;
        } else if (
          ch === '?' &&
          source[k + 1] !== '?' &&
          source[k - 1] !== '?' &&
          source[k + 1] !== '.'
        ) {
          conditionalDepth++;
        } else if ([';', ',', ')', ']', '}'].includes(ch)) {
          return false;
        }
      }
      if (ch === '[') bracketDepth++;
      else if (ch === ']') bracketDepth--;
      else if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // String literals: their brackets and slashes are inert text, so skip the whole value.
    if (ch === "'" || ch === '"') {
      k = readString(source, k).next;
      prevKind = 'string';
      continue;
    }

    // Template literals: skip their text and interpolation so a `)` inside a template is not
    // counted as the parameter-list close.
    if (ch === '`') {
      k = skipTemplateLiteral(source, k);
      prevKind = 'template';
      continue;
    }

    // Regex literals: a `/` that begins a regex must be skipped so its `)` stays inside the pattern
    // rather than closing the parameter list.
    if (ch === '/' && isRegexStart(prevKind, prevPunct, false, false, false)) {
      k = skipRegex(source, k);
      prevKind = 'regex';
      continue;
    }

    if (ch === '(') {
      depth++;
      prevKind = 'punct';
      prevPunct = '(';
    } else if (ch === ')') {
      depth--;
      prevKind = 'punct';
      prevPunct = ')';

      if (depth === 0 && mode === 'parameters') {
        const j = skipTrivia(source, k + 1, n);
        if (source[j] === '=' && source[j + 1] === '>') {
          return true;
        }
        const arrow = source[j] === ':' ? arrowAfterReturnType(source, j + 1, n) : undefined;
        return (
          arrow !== undefined &&
          (!needsConditionalEnd ||
            arrowFollowsParameters(source, arrow + 2, n, jsx, false, 'conditional-body'))
        );
      }
    } else if (isIdentifierStartAt(source, k)) {
      const identifier = readIdentifier(source, k);
      if (
        mode === 'conditional-body' &&
        ['as', 'satisfies'].includes(identifier.value) &&
        prevKind !== 'start' &&
        !(prevKind === 'punct' && prevPunct === '.')
      ) {
        assertionOwner = {
          paren: depth,
          bracket: bracketDepth,
          brace: braceDepth,
          frame: jsxFrames.length,
        };
      }
      k = identifier.end - 1;
      prevKind = 'identifier';
      prevPunct = undefined;
    } else {
      prevKind = 'punct';
      prevPunct = ch;
    }

    k++;
  }

  return false;
}

/** Skip a balanced type-argument list only when its suffix can continue an expression. */
function expressionTypeArgumentEnd(
  source: string,
  open: number,
  n: number,
  bounds: Map<number, number | null>,
  typeAssertion = false,
): number | undefined {
  let end = bounds.get(open);
  if (end === undefined) {
    try {
      end = readJsxTypeArguments(source, open, n, [], true, bounds);
    } catch (error) {
      if (error instanceof ModuleSpecifierError) {
        bounds.set(open, null);
        return undefined;
      }
      throw error;
    }
  }
  if (end === null) return undefined;
  const next = skipTrivia(source, end, n);
  const ch = source[next];
  if (!typeAssertion) return ch === '(' ? end : undefined;
  if (isIdentifierStartAt(source, next) || isUnicodeEscapeStart(source, next)) {
    return ['as', 'satisfies', 'in', 'instanceof'].includes(readIdentifier(source, next).value)
      ? end
      : undefined;
  }
  return ch !== undefined && (isNumberStart(ch) || ch === '"' || ch === "'") ? undefined : end;
}

/** A newline computed method head ends a complete bodyless member return annotation. */
function computedMethodFollows(source: string, start: number, n: number): boolean {
  let depth = 0;
  let index = start;
  let previous: PrevKind = 'start';
  let punct: string | undefined;
  while (index < n) {
    index = skipTrivia(source, index, n);
    const ch = source[index];
    if (ch === undefined) {
      break;
    }
    if (ch === "'" || ch === '"') {
      index = readString(source, index).next;
      previous = 'string';
      continue;
    }
    if (ch === '`') {
      index = skipTemplateLiteral(source, index);
      previous = 'template';
      continue;
    }
    if (ch === '/' && isRegexStart(previous, punct, false, false, false)) {
      index = skipRegex(source, index);
      previous = 'regex';
      continue;
    }
    if (ch === '[') {
      depth++;
    } else if (ch === ']') {
      depth--;
      if (depth === 0) {
        return source[skipTrivia(source, index + 1, n)] === '(';
      }
    }
    if (isIdentifierStartAt(source, index) || isUnicodeEscapeStart(source, index)) {
      index = readIdentifier(source, index).end;
      previous = 'identifier';
    } else {
      previous = isNumberStart(ch) ? 'number' : 'punct';
      punct = ch;
      index++;
    }
  }
  return false;
}

function arrowAfterReturnType(source: string, start: number, n: number): number | undefined {
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;
  let index = start;

  while (index < n) {
    index = skipTrivia(source, index, n);
    const ch = source[index];
    if (ch === undefined) {
      return undefined;
    }

    if (ch === "'" || ch === '"') {
      index = readString(source, index).next;
      continue;
    }
    if (ch === '`') {
      index = skipTemplateLiteral(source, index);
      continue;
    }
    if (ch === '=' && source[index + 1] === '>') {
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
        return index;
      }
      index += 2;
      continue;
    }

    if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0 &&
      (isIdentifierStartAt(source, index) || isUnicodeEscapeStart(source, index))
    ) {
      const identifier = readIdentifier(source, index);
      const next = skipTrivia(source, identifier.end, n);
      // An operand followed by a call is runtime code (not a return type). In particular,
      // a conditional's `: async () =>` must not claim the preceding sequence expression.
      if (
        source[next] === '(' &&
        identifier.value !== 'import' &&
        !TYPE_OPERAND_KEYWORDS.has(identifier.value)
      ) {
        return undefined;
      }
      index = identifier.end;
      continue;
    }

    if (ch === '(') {
      parenDepth++;
    } else if (ch === ')') {
      if (parenDepth === 0) {
        return undefined;
      }
      parenDepth--;
    } else if (ch === '[') {
      bracketDepth++;
    } else if (ch === ']') {
      if (bracketDepth === 0) {
        return undefined;
      }
      bracketDepth--;
    } else if (ch === '{') {
      braceDepth++;
    } else if (ch === '}') {
      if (braceDepth === 0) {
        return undefined;
      }
      braceDepth--;
    } else if (ch === '<') {
      angleDepth++;
    } else if (ch === '>') {
      if (angleDepth === 0) {
        return undefined;
      }
      angleDepth--;
    } else if (
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0 &&
      (ch === ';' || ch === ',')
    ) {
      return undefined;
    }

    index++;
  }

  return undefined;
}

function arrowFollowsParametersSafely(
  source: string,
  open: number,
  n: number,
  jsx = false,
  needsConditionalEnd = false,
): boolean {
  try {
    return arrowFollowsParameters(source, open, n, jsx, needsConditionalEnd);
  } catch (error) {
    if (error instanceof ModuleSpecifierError) {
      return false;
    }
    throw error;
  }
}

// Skip a template literal starting at its opening backtick (offset `start`). Returns the index just
// past the closing backtick.
//
// `${...}` interpolations are skipped opaquely by brace depth: the caller only needs this region to
// be invisible so its brackets never reach the parameter-list accounting, which is why the body is
// not re-lexed here.
//
// @throws {ModuleSpecifierError} on an unterminated template literal.
function skipTemplateLiteral(source: string, start: number): number {
  const n = source.length;
  let i = start + 1; // past the opening backtick

  while (i < n) {
    const ch = source[i];

    // A backslash escapes the next character (including a nested backtick or `${`).
    if (ch === '\\') {
      i += 2;
      continue;
    }

    if (ch === '`') {
      return i + 1;
    }

    if (ch === '$' && source[i + 1] === '{') {
      // Skip the interpolation until its braces balance. Nested templates/braces are handled by the
      // depth counter; a raw line terminator is invalid inside a template and stops the scan.
      let depth = 1;

      i += 2;

      while (i < n && depth > 0) {
        const inner = source[i];

        if (inner === '\n' || inner === '\r') {
          throw new ModuleSpecifierError('Unterminated template literal', 'invalid-source', start);
        }

        if (inner === '\\') {
          i += 2;
          continue;
        }

        if (inner === '{') {
          depth++;
        } else if (inner === '}') {
          depth--;
        }

        i++;
      }

      continue;
    }

    i++;
  }

  throw new ModuleSpecifierError('Unterminated template literal', 'invalid-source', start);
}

/** Probe template types with the same type boundaries as their interpolated operands. */
function skipTemplateType(
  source: string,
  start: number,
  n: number,
  bounds?: Map<number, number | null>,
): number {
  let i = start + 1;
  while (i < n) {
    if (source[i] === '\\') i += 2;
    else if (source[i] === '`') return i + 1;
    else if (source[i] === '$' && source[i + 1] === '{') {
      i = readJsxTypeArguments(source, i + 1, n, [], true, bounds, '}');
    } else i++;
  }
  throw new ModuleSpecifierError('Unterminated template literal', 'invalid-source', start);
}

/** Only a complete type followed by a line break can begin another bodyless type member. */
function typeMemberFollowsLineBreak(tokens: readonly Token[], lineBreak: boolean): boolean {
  const complete = (token: Token | undefined): boolean => {
    if (token === undefined) return false;
    if (token.kind === 'identifier') return !TYPE_OPERAND_KEYWORDS.has(token.value);
    return (
      token.kind === 'string' ||
      token.kind === 'number' ||
      token.kind === 'template' ||
      (token.kind === 'punct' &&
        ([')', ']', '}', '>'].includes(token.value) || /^[0-9]$/.test(token.value)))
    );
  };
  let index = tokens.length - 1;
  if (lineBreak && complete(tokens[index])) return true;
  // The line break may precede a modifier rather than the method name (e.g. get b()).
  while (index >= 0) {
    const token = tokens[index];
    if (token?.kind !== 'identifier' || !MEMBER_MODIFIERS.has(token.value)) break;
    if (token.lineBreakBefore === true && complete(tokens[index - 1])) return true;
    index--;
  }
  return false;
}

/**
 * Lex only the boundaries of a component's type arguments. These tokens preserve literal imports
 * without changing the surrounding JavaScript function/brace state or treating type braces as JSX.
 */
function readJsxTypeArguments(
  source: string,
  open: number,
  n: number,
  tokens: Token[],
  expressionProbe = false,
  bounds?: Map<number, number | null>,
  rootClose: '>' | '}' = '>',
): number {
  const closers: string[] = [rootClose];
  const opens = [open];
  const conditions = [0];
  let i = open + 1;

  try {
    while (i < n) {
      const trivia = readTrivia(source, i, n);
      i = trivia.end;
      const ch = source[i];

      if (ch === undefined) {
        break;
      }

      // A speculative expression probe must not borrow a > from a later statement
      // or conditional branch. Colons in conditional types still belong to the list.
      if (
        expressionProbe &&
        (closers[closers.length - 1] === '>' || (rootClose === '}' && closers.length === 1))
      ) {
        const level = conditions.length - 1;
        if (ch === '?') conditions[level] = (conditions[level] ?? 0) + 1;
        else if (ch === ':' && (conditions[level] ?? 0) > 0)
          conditions[level] = (conditions[level] ?? 0) - 1;
        else if (
          ch === ';' ||
          ch === ':' ||
          (ch === '=' && source[i + 1] !== '>') ||
          ([')', ']', '}'].includes(ch) && ch !== closers[closers.length - 1])
        ) {
          throw new ModuleSpecifierError('Invalid type argument boundary', 'invalid-source', i);
        }
      }

      if (expressionProbe && ch === '/') {
        throw new ModuleSpecifierError('Runtime slash in type argument probe', 'invalid-source', i);
      }
      if (ch === "'" || ch === '"') {
        const callee = tokens[tokens.length - 2];
        if (
          expressionProbe &&
          isPunct(tokens[tokens.length - 1], '(') &&
          callee?.kind === 'identifier' &&
          callee.value !== 'import' &&
          !TYPE_OPERAND_KEYWORDS.has(callee.value)
        ) {
          throw new ModuleSpecifierError(
            'Literal method parameter in type argument probe',
            'invalid-source',
            i,
          );
        }
        const { value, next } = readString(source, i);
        tokens.push({
          kind: 'string',
          value,
          offset: i,
          endOffset: next,
          lineBreakBefore: trivia.lineBreak,
        });
        i = next;
        continue;
      }

      if (ch === '`') {
        if (expressionProbe) {
          const end = skipTemplateType(source, i, n, bounds);
          tokens.push({
            kind: 'template',
            offset: i,
            endOffset: end,
            lineBreakBefore: trivia.lineBreak,
          });
          i = end;
          continue;
        }
        throw new ModuleSpecifierError(
          'Template literal types in JSX type arguments are not supported',
          'invalid-source',
          i,
        );
      }

      if (isIdentifierStartAt(source, i)) {
        const start = i;
        const identifier = readIdentifier(source, i);
        const next = skipTrivia(source, identifier.end, n);
        if (
          expressionProbe &&
          source[next] === '(' &&
          identifier.value !== 'import' &&
          !TYPE_OPERAND_KEYWORDS.has(identifier.value) &&
          !(
            closers[closers.length - 1] === '}' &&
            closers.length > 1 &&
            (memberDeclarationHead(tokens, tokens.length, false) !== undefined ||
              typeMemberFollowsLineBreak(tokens, trivia.lineBreak))
          )
        ) {
          throw new ModuleSpecifierError(
            'Runtime call in type argument probe',
            'invalid-source',
            i,
          );
        }
        i = identifier.end;
        tokens.push({
          kind: 'identifier',
          value: identifier.value,
          offset: start,
          endOffset: i,
          lineBreakBefore: trivia.lineBreak,
        });
        continue;
      }

      if (expressionProbe && ch === '{' && isPunct(tokens[tokens.length - 1], ')')) {
        throw new ModuleSpecifierError('Runtime body in type argument probe', 'invalid-source', i);
      }
      if (ch === '<' || ch === '(' || ch === '{' || ch === '[') {
        closers.push(ch === '<' ? '>' : ch === '(' ? ')' : ch === '{' ? '}' : ']');
        opens.push(i);
        conditions.push(0);
      } else if (ch === closers[closers.length - 1] && !(ch === '>' && source[i - 1] === '=')) {
        closers.pop();
        const opened = opens.pop();
        conditions.pop();
        if (expressionProbe && ch === '>' && opened !== undefined) bounds?.set(opened, i + 1);
        if (closers.length === 0) {
          return i + 1;
        }
      }

      tokens.push({
        kind: 'punct',
        value: ch,
        offset: i,
        endOffset: i + 1,
        lineBreakBefore: trivia.lineBreak,
        ...(ch === '=' ? classifyEquals(source, i, true) : {}),
      });
      i++;
    }

    throw new ModuleSpecifierError('Unterminated JSX type arguments', 'invalid-source', open);
  } catch (error) {
    if (expressionProbe && bounds !== undefined) {
      // One failed walk classifies every still-open angle encountered along the way.
      for (let level = 0; level < closers.length; level++) {
        const opened = opens[level];
        if (closers[level] === '>' && opened !== undefined) bounds.set(opened, null);
      }
    }
    throw error;
  }
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
  return readTrivia(source, start, n).end;
}

function readTrivia(source: string, start: number, n: number): { end: number; lineBreak: boolean } {
  let i = start;
  let lineBreak = false;

  while (i < n) {
    if (isWhitespace(source[i])) {
      lineBreak ||= isLineTerminator(source[i]);
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
      const start = i;
      i = skipBlockComment(source, i);
      lineBreak ||= hasLineTerminator(source, start, i);
      continue;
    }

    break;
  }

  return { end: i, lineBreak };
}

/**
 * Type keywords that still expect a type after them, so a `{` following one opens an object type and
 * not a function body (`T extends { ok: boolean } ? A : B`).
 */
const TYPE_OPERAND_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract',
  'as',
  'asserts',
  'await',
  'const',
  'extends',
  'in',
  'infer',
  'is',
  'keyof',
  'new',
  'readonly',
  'satisfies',
  'typeof',
]);

/**
 * Whether a root-level `=>` inside a return annotation is an arrow of the return type itself rather
 * than the signature's runtime arrow. A function type keeps a second arrow at the same nesting level
 * (`(): (x: number) => void => {}`); once the return type is over, the next significant token is the
 * body (`{`), a statement terminator or a delimiter that closes the surrounding code.
 */
function functionTypeArrowContinues(
  source: string,
  arrowEnd: number,
  n: number,
  conditionalEnd = false,
): boolean {
  let depth = 0;

  for (let i = arrowEnd + 1; i < n; i++) {
    const ch = source[i];

    if (ch === '(' || ch === '[' || ch === '<') {
      depth++;
    } else if (ch === '>' && depth > 0) {
      depth--;
    } else if (ch === ')' || ch === ']') {
      if (depth === 0) {
        return false;
      }

      depth--;
    } else if (depth === 0) {
      if (ch === '{' || ch === ';' || ch === ',' || (conditionalEnd && ch === ':')) {
        return false;
      }

      if (ch === '=' && source[i + 1] === '>') {
        return true;
      }
    }
  }

  return false;
}

/** Preserve type-argument identity while inspecting a parameter binding pattern. */
function markParameterTypeArguments(tokens: Token[], openIndex: number): number | undefined {
  if (!isPunct(tokens[openIndex - 1], '>')) {
    return;
  }
  const start = signatureNameIndex(tokens, openIndex) + 1;
  if (!isPunct(tokens[start], '<')) {
    return;
  }
  // A real JS destructuring entry between comparison operators needs a default or property
  // separator. Do not mistake that binding for a generic argument. Nested type members may
  // contain their own separators inside balanced (), [] and {}.
  let depth = 0;
  for (let index = start + 1; index < openIndex - 1; index++) {
    const token = tokens[index];
    if (token?.kind !== 'punct') {
      continue;
    }
    if (['(', '[', '{'].includes(token.value)) {
      depth++;
    } else if ([')', ']', '}'].includes(token.value)) {
      depth--;
    } else if (
      depth === 0 &&
      (token.operator === 'assignment' || token.value === ':' || token.value === ';')
    ) {
      return;
    }
  }
  for (let index = start; index < openIndex; index++) {
    const token = tokens[index];
    if (token !== undefined) {
      tokens[index] = { ...token, parameterType: true };
    }
  }
  return start;
}

/**
 * Index of the token that names a `(` parameter list. A generic signature keeps its type-parameter
 * list between the name and the `(` (`async function f<T>(): T {}`, `async <T,>(value: T) => {}`,
 * `async check<T>(): T {}`), so a balanced `<...>` directly before the `(` is skipped. The index of
 * the token directly before the `(` is returned unchanged when no such list precedes it.
 */
function signatureNameIndex(tokens: readonly Token[], openIndex: number): number {
  let index = openIndex - 1;
  const angle = tokens[index];

  if (angle?.kind !== 'punct' || angle.value !== '>') {
    return index;
  }

  const closers: string[] = [];
  while (index >= 0) {
    const token = tokens[index];

    if (token === undefined) {
      break;
    }

    if (token.kind !== 'punct') {
      index--;
      continue;
    }

    if (token.value === '>' && isArrowHead(tokens[index - 1], token.offset)) {
      index -= 2;
      continue;
    }
    if (['>', ')', ']', '}'].includes(token.value)) {
      closers.push(token.value);
    } else if (['<', '(', '[', '{'].includes(token.value)) {
      const expected =
        token.value === '<' ? '>' : token.value === '(' ? ')' : token.value === '[' ? ']' : '}';
      if (closers.pop() !== expected) {
        break;
      }
      if (closers.length === 0) {
        return index - 1;
      }
    } else if (
      token.value === ';' &&
      token.syntheticBoundary !== true &&
      closers[closers.length - 1] === '>'
    ) {
      break;
    }
    index--;
  }

  // The `>` does not close a balanced type-parameter list, so the token before `(` names the list.
  return openIndex - 1;
}

/**
 * Modifiers that may sit between a member separator and a method name.
 *
 * `new`, `typeof`, `void` and `await` are absent on purpose: they are operators, so an identifier
 * after them belongs to an expression and never starts a member declaration.
 */
const MEMBER_MODIFIERS: ReadonlySet<string> = new Set([
  'abstract',
  'async',
  'get',
  'override',
  'private',
  'protected',
  'public',
  'set',
  'static',
]);

/** Punctuation that can start a member declaration inside an object literal, class body or interface. */
const MEMBER_SEPARATORS: ReadonlySet<string> = new Set(['{', ',', ';']);

type MemberHead = {
  readonly async: boolean;
  readonly generator: boolean;
};

/**
 * Index of the `@` that starts the decorator ending at `index`, or -1 when the tokens ending there
 * are not a decorator. Only the tail of a decorator is known from the member side, so the
 * LeftHandSideExpression of `@dec`, `@dec(1)`, `@a.b` and `@(dec)` is scanned backwards.
 */
function decoratorStartIndex(tokens: readonly Token[], index: number): number {
  let depth = 0;

  for (let k = index; k >= 0; k--) {
    const token = tokens[k];

    if (token === undefined) {
      return -1;
    }

    if (token.kind !== 'punct') {
      continue;
    }

    if (token.value === ')' || token.value === ']' || token.value === '}') {
      depth++;
    } else if (token.value === '(' || token.value === '[' || token.value === '{') {
      // An unmatched opener means the scan left the decorator expression.
      if (depth === 0) {
        return -1;
      }

      depth--;
    } else if (depth === 0) {
      if (token.value === '@') {
        return k;
      }

      // Only property access (`@a.b`, `@a?.b`) continues a decorator name.
      if (token.value !== '.' && token.value !== '?') {
        return -1;
      }
    }
  }

  return -1;
}

/**
 * The async/generator flags of the member declaration whose name is the token at `nameIndex`, or
 * `undefined` when no member declaration starts there.
 *
 * Class headers are bounded by the current member's forward-tracked start. Objects use explicit
 * separators, never class-field ASI. Only modifiers and decorators may precede the name.
 */
function memberDeclarationHead(
  tokens: readonly Token[],
  nameIndex: number,
  insideClassBody: boolean,
  memberStart?: number,
): MemberHead | undefined {
  // A computed member (`[key]() {}`) is named by the `]` that closes its key.
  let index = nameIndex - 1;

  if (isPunct(tokens[nameIndex], ']')) {
    const open = matchingOpenBracket(tokens, nameIndex);

    if (open < 0) {
      return undefined;
    }

    index = open - 1;
  }

  let async = false;
  let generator = false;

  for (;;) {
    while (index >= (memberStart ?? 0)) {
      const token = tokens[index];

      if (isPunct(token, '*') || isPunct(token, '#')) {
        generator ||= isPunct(token, '*');
        index--;
        continue;
      }

      if (token?.kind === 'identifier') {
        const nextToken = tokens[index + 1];
        const startsMethodModifier = nextToken !== undefined && nextToken.lineBreakBefore !== true;
        if (token.value === 'async' && startsMethodModifier) {
          async = true;
          index--;
          continue;
        }

        if (MEMBER_MODIFIERS.has(token.value) && startsMethodModifier) {
          index--;
          continue;
        }
      }

      break;
    }

    if (insideClassBody && memberStart !== undefined && index < memberStart) {
      return { async, generator };
    }

    const start = tokens[index];

    if (
      start?.kind === 'punct' &&
      (MEMBER_SEPARATORS.has(start.value) ||
        (start.value === '}' && start.memberSeparator === true))
    ) {
      return { async, generator };
    }

    // Decorators precede the modifiers they apply to, and each one ends just before them.
    const decorator = decoratorStartIndex(tokens, index);

    if (decorator < 0) {
      return undefined;
    }

    index = decorator - 1;
  }
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token?.kind === 'punct' && token.value === value;
}

function classifyEquals(
  source: string,
  offset: number,
  atTypeBoundary = false,
): { operator: 'assignment' | 'arrow' | 'other'; operatorEndOffset: number } {
  const next = source[offset + 1];
  const previous = source[offset - 1];
  if (next === '>') {
    return { operator: 'arrow', operatorEndOffset: offset + 2 };
  }
  if (
    next === '=' ||
    (previous !== undefined &&
      '=!<>+-*/%&|^?'.includes(previous) &&
      !(atTypeBoundary && previous === '>'))
  ) {
    let end = offset + 1;
    while (source[end] === '=') {
      end++;
    }
    return { operator: 'other', operatorEndOffset: end };
  }
  return { operator: 'assignment', operatorEndOffset: offset + 1 };
}

function readIdentifier(source: string, start: number): { value: string; end: number } {
  let end = start;
  let value = '';
  let first = true;

  while (end < source.length) {
    const escaped = isUnicodeEscapeStart(source, end);
    const segment = escaped ? readUnicodeEscape(source, end) : readCodePoint(source, end);
    if (segment === undefined) {
      break;
    }

    const allowed = first
      ? isIdentifierStartCharacter(segment.character)
      : isIdentifierPartCharacter(segment.character);
    if (!allowed) {
      if (escaped) {
        throw new ModuleSpecifierError(
          'Invalid Unicode escape in identifier',
          'invalid-source',
          end,
        );
      }
      break;
    }

    value += segment.character;
    end = segment.end;
    first = false;
  }

  if (first) {
    throw new ModuleSpecifierError('Invalid identifier', 'invalid-source', start);
  }

  return { value, end };
}

function isArrowHead(token: Token | undefined, greaterOffset?: number): boolean {
  return (
    token?.kind === 'punct' &&
    token.operator === 'arrow' &&
    (greaterOffset === undefined || token.operatorEndOffset === greaterOffset + 1)
  );
}

function lineBreakBetween(tokens: readonly Token[], start: number, end: number): boolean {
  for (let index = start + 1; index <= end; index++) {
    if (tokens[index]?.lineBreakBefore === true) {
      return true;
    }
  }
  return false;
}

function isMemberExpressionEnd(token: Token): boolean {
  if (token.assertionEnd === true) {
    return true;
  }
  if (token.kind === 'identifier') {
    return (
      token.propertyName === true ||
      (!REGEX_PRECEDING_KEYWORDS.has(token.value) && !['await', 'yield'].includes(token.value))
    );
  }

  return (
    EXPRESSION_ENDING.has(token.kind) ||
    isPunct(token, ')') ||
    isPunct(token, ']') ||
    (token.kind === 'punct' && token.expressionEnd === true)
  );
}

function advanceMember(member: ClassMember, token: Token, previous: Token | undefined): void {
  if (member.phase === 'initializer' || member.phase === 'parameters') {
    return;
  }
  if (isPunct(token, '@')) {
    member.phase = 'decorator';
    return;
  }
  if (member.phase === 'decorator') {
    if (
      token.lineBreakBefore !== true &&
      !isPunct(previous, ')') &&
      !(previous?.kind === 'identifier' && token.kind === 'identifier')
    ) {
      return;
    }
    member.phase = 'head';
  }
  if (token.kind === 'punct' && token.operator === 'assignment') {
    member.phase = 'initializer';
  } else if (isPunct(token, ':')) {
    member.phase = 'type';
  } else if (isPunct(token, '(') && member.phase !== 'type') {
    member.phase = 'parameters';
  } else if (
    member.phase === 'head' &&
    ((token.kind === 'identifier' &&
      !MEMBER_MODIFIERS.has(token.value) &&
      !['declare', 'readonly'].includes(token.value)) ||
      token.kind === 'string' ||
      token.kind === 'number' ||
      isPunct(token, '['))
  ) {
    member.phase = 'field';
  }
}

function classFieldCanEnd(
  member: ClassMember,
  previous: Token | undefined,
  next: string,
  nextIdentifier: string | undefined,
): boolean {
  if (previous === undefined || member.phase === 'parameters' || member.phase === 'decorator') {
    return false;
  }
  const canEnd =
    isMemberExpressionEnd(previous) ||
    ((member.phase === 'field' || member.phase === 'head') &&
      (previous.kind === 'identifier' || isPunct(previous, '?') || isPunct(previous, '!'))) ||
    (member.phase === 'type' &&
      ((previous.kind === 'identifier' && !TYPE_OPERAND_KEYWORDS.has(previous.value)) ||
        isPunct(previous, '>') ||
        isPunct(previous, '}')));
  if (!canEnd) {
    return false;
  }
  if (member.phase === 'initializer') {
    return !expressionContinues(next, nextIdentifier);
  }
  // An uninitialized field cannot continue by multiplication. Type operators and suffixes can.
  return !UNINITIALIZED_FIELD_CONTINUATIONS.has(next);
}

const UNINITIALIZED_FIELD_CONTINUATIONS: ReadonlySet<string> = new Set([
  '(',
  '[',
  '.',
  '?',
  '!',
  '=',
  ':',
  '<',
  '>',
  '|',
  '&',
  ',',
]);
function atTypeRoot(type: TypeDepth): boolean {
  return (
    type.parenDepth === 0 &&
    type.bracketDepth === 0 &&
    type.braceDepth === 0 &&
    type.angleDepth === 0
  );
}

function sameTypeDepth(left: TypeDepth, right: TypeDepth): boolean {
  return (
    left.parenDepth === right.parenDepth &&
    left.bracketDepth === right.bracketDepth &&
    left.braceDepth === right.braceDepth &&
    left.angleDepth === right.angleDepth
  );
}

/**
 * Infer an arrow signature using the index of `=` in `=>`, regardless of whether `>` is emitted.
 */
function inferArrowContext(tokens: readonly Token[], arrowIndex: number): FuncContext | undefined {
  const arrow = tokens[arrowIndex];

  if (!isArrowHead(arrow)) {
    return undefined;
  }

  const beforeArrow = arrowIndex - 1;
  const parameters = tokens[beforeArrow];
  let parametersIndex: number;

  if (parameters?.kind === 'punct' && parameters.value === ')') {
    parametersIndex = matchingOpenParen(tokens, beforeArrow);
  } else if (parameters?.kind === 'identifier') {
    parametersIndex = beforeArrow;
  } else {
    return undefined;
  }

  const parametersStart = parametersIndex >= 0 ? tokens[parametersIndex] : undefined;

  if (parametersStart?.kind !== 'identifier' && parametersStart?.kind !== 'punct') {
    return undefined;
  }

  // Only trivia before the parameters can break the async modifier; newlines inside `(...)` cannot.
  // A generic arrow keeps its type-parameter list between `async` and the parameter list.
  const markerIndex =
    parametersStart.kind === 'punct' && parametersStart.value === '('
      ? signatureNameIndex(tokens, parametersIndex)
      : parametersIndex - 1;
  const markerToken = tokens[markerIndex];
  const async =
    markerToken?.kind === 'identifier' &&
    markerToken.value === 'async' &&
    asyncModifierIsContinuous(tokens, markerIndex, parametersIndex);

  return (
    parametersStart.signatureContext ?? {
      async,
      generator: false,
      isExpression: false,
    }
  );
}

/** Parameter lists can start at expression/statement boundaries, never after a call's name. */
function arrowParameterPrefix(token: Token | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  if (token.kind === 'punct') {
    return (
      EXPRESSION_BEFORE_BRACE.has(token.value) || [':', '>', ';', '{', '/'].includes(token.value)
    );
  }
  return (
    token.kind === 'identifier' &&
    ['return', 'throw', 'yield', 'await', 'void', 'typeof', 'delete', 'default'].includes(
      token.value,
    )
  );
}

function parameterSignatureContext(
  tokens: readonly Token[],
  pending: PendingFuncContext | undefined,
  insideMethodContainer: boolean,
  insideClassBody: boolean,
  lineBreakBefore: boolean,
  memberStart?: number,
): TypedReturnSignature | undefined {
  const openIndex = tokens.length;
  const nameIndex = signatureNameIndex(tokens, openIndex);
  const name = tokens[nameIndex];
  const head =
    insideMethodContainer && isMethodName(name)
      ? memberDeclarationHead(tokens, nameIndex, insideClassBody, memberStart)
      : undefined;
  if (head !== undefined) {
    return {
      context: {
        ...head,
        isExpression: false,
        isClassMember: insideClassBody,
      },
      isFunctionKeyword: false,
      isArrowSignature: false,
    };
  }
  if (
    pending?.phase === 'awaiting-parameters' &&
    (name?.kind === 'identifier' || isPunct(name, '*'))
  ) {
    return { context: pending, isFunctionKeyword: true, isArrowSignature: false };
  }
  const marker = tokens[nameIndex - 1];
  // A generic signature has no name of its own before `(` when it is anonymous (`async <T,>(v: T) => {}`).
  const startsArrowParameters =
    arrowParameterPrefix(name) || (isIdentifier(name, 'async') && arrowParameterPrefix(marker));

  if (startsArrowParameters) {
    const asyncToken = name?.kind === 'identifier' && name.value === 'async' ? name : undefined;
    const async =
      asyncToken !== undefined &&
      !lineBreakBefore &&
      asyncModifierIsContinuous(tokens, nameIndex, openIndex - 1);

    return {
      context: { async, generator: false, isExpression: false },
      isFunctionKeyword: false,
      isArrowSignature: true,
    };
  }

  // Without a `function` keyword the parameter list must start a real member declaration, so the
  // `:` of a conditional expression or of an unrelated expression never claims a return annotation.
  return undefined;
}

function asyncModifierIsContinuous(
  tokens: readonly Token[],
  modifierIndex: number,
  parameterIndex: number,
): boolean {
  const genericOpen = isPunct(tokens[modifierIndex + 1], '<') ? modifierIndex + 1 : undefined;
  return !lineBreakBetween(tokens, modifierIndex, genericOpen ?? parameterIndex);
}

function nearestFunctionParameter(
  parameters: readonly ParameterContext[],
): ParameterContext | undefined {
  for (let index = parameters.length - 1; index >= 0; index--) {
    const parameter = parameters[index];
    if (parameter?.signature !== undefined) {
      return parameter;
    }
  }
  return undefined;
}

function nearestClassField(braces: readonly BraceContext[]): ClassMember | undefined {
  for (let index = braces.length - 1; index >= 0; index--) {
    const brace = braces[index];
    if (brace?.role === 'class' && brace.state.member?.phase === 'initializer') {
      return brace.state.member;
    }
  }
  return undefined;
}

function consumeForIterationSeparator(
  tokens: readonly Token[],
  parameters: readonly ParameterContext[],
  depth: LexicalDepth,
): boolean {
  const control = parameters[parameters.length - 1];
  if (
    control?.forPhase !== 'binding' ||
    control.depth.parenDepth !== depth.parenDepth ||
    control.depth.bracketDepth !== depth.bracketDepth ||
    control.depth.braceDepth !== depth.braceDepth ||
    control.depth.frameDepth !== depth.frameDepth ||
    tokens.length <= control.openIndex
  ) {
    return false;
  }

  const previous = tokens[tokens.length - 1];
  const isSeparator =
    previous !== undefined &&
    isMemberExpressionEnd(previous) &&
    !isIdentifier(previous, 'const') &&
    !isIdentifier(previous, 'let') &&
    !isIdentifier(previous, 'var');
  if (isSeparator) {
    control.forPhase = 'iteration';
  }
  return isSeparator;
}

// At the owner's root, a finished operand can still have a suffix or compose with another
// type. Only a runtime boundary retires the assertion; internal closers never do so themselves.
function assertionTypeContinues(
  annotation: Extract<TypeAnnotation, { role: 'assertion' }>,
  next: string,
  identifier: string | undefined,
  lineBreak: boolean,
  after: string | undefined,
): boolean {
  if (next === '-' && annotation.typeOperandExpected && after !== '-') {
    return true;
  }
  if (identifier !== undefined) {
    return annotation.typeOperandExpected || (identifier === 'extends' && !lineBreak);
  }
  if (next === '?') {
    return annotation.conditionalOperand;
  }
  if (next === ':') {
    return annotation.conditionalDepth > 0;
  }
  if (next === '(') {
    return annotation.typeOperandExpected || annotation.importCallPending;
  }
  if (next === '{' || next === '`' || next === "'" || next === '"') {
    return annotation.typeOperandExpected;
  }
  if (next === '<' || next === '[') {
    return after !== next && after !== '=' && (annotation.typeOperandExpected || !lineBreak);
  }
  if (next === '|' || next === '&') {
    return after !== next && after !== '=';
  }
  if (next === '.') {
    return true;
  }
  if (next === '=' && after === '>') {
    return true;
  }
  return (
    annotation.typeOperandExpected &&
    !['/', '+', '-', '*', '%', '!', ';', ',', ')', ']', '}', '=', '>'].includes(next)
  );
}

function canStartTypeAssertion(previous: Token | undefined): boolean {
  if (previous?.assertionEnd === true) {
    return true;
  }
  return (
    previous !== undefined &&
    isMemberExpressionEnd(previous) &&
    !(
      previous.kind === 'identifier' &&
      previous.propertyName !== true &&
      [
        'const',
        'let',
        'var',
        'function',
        'class',
        'type',
        'interface',
        'namespace',
        'import',
        'export',
        'extends',
        'implements',
      ].includes(previous.value)
    )
  );
}

function isMethodName(token: Token | undefined): boolean {
  return (
    token?.kind === 'identifier' ||
    token?.kind === 'string' ||
    token?.kind === 'number' ||
    isPunct(token, ']')
  );
}

function expressionFunctionBodyEnded(
  ch: string,
  parenDepth: number,
  bracketDepth: number,
  braceDepth: number,
  frameDepth: number,
  functionDepth: number,
  conditionalDepth: number,
  context: ExpressionFuncContext,
): boolean {
  if (
    functionDepth > context.functionDepth ||
    braceDepth > context.braceDepth ||
    frameDepth !== context.frameDepth
  ) {
    return false;
  }

  if (
    ch === ':' &&
    context.conditionalDepth > 0 &&
    conditionalDepth === context.conditionalDepth &&
    parenDepth === context.parenDepth &&
    bracketDepth === context.bracketDepth &&
    braceDepth === context.braceDepth
  ) {
    return true;
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

function lineTerminatorEndsExpressionFunctionBody(
  next: string,
  prevKind: PrevKind,
  prevPunct: string | undefined,
  previous: Token | undefined,
  nextIdentifier: string | undefined,
  nextIsUpdate: boolean,
  parenDepth: number,
  bracketDepth: number,
  braceDepth: number,
  frameDepth: number,
  functionDepth: number,
  context: ExpressionFuncContext,
): boolean {
  if (
    functionDepth > context.functionDepth ||
    parenDepth !== context.parenDepth ||
    bracketDepth !== context.bracketDepth ||
    braceDepth !== context.braceDepth ||
    frameDepth !== context.frameDepth
  ) {
    return false;
  }

  const previousEndsExpression =
    previous?.assertionEnd === true ||
    EXPRESSION_ENDING.has(prevKind) ||
    (prevKind === 'punct' &&
      ([')', ']', '}'].includes(prevPunct ?? '') ||
        (previous?.kind === 'punct' && previous.expressionEnd === true)));

  return previousEndsExpression && (nextIsUpdate || !expressionContinues(next, nextIdentifier));
}

function expressionContinues(next: string, identifier: string | undefined): boolean {
  return (
    EXPRESSION_CONTINUATION_CHARACTERS.has(next) ||
    identifier === 'in' ||
    identifier === 'instanceof'
  );
}

/** Whether a token is the given identifier. */
function isIdentifier(token: Token | undefined, value: string): boolean {
  return token?.kind === 'identifier' && token.value === value;
}

/**
 * The index of the `[` matching the `]` at `closeIndex`, or `-1` when the source has no match.
 */
function matchingOpenBracket(tokens: readonly Token[], closeIndex: number): number {
  let depth = 0;

  for (let k = closeIndex; k >= 0; k--) {
    const token = tokens[k];

    if (token?.kind !== 'punct') {
      continue;
    }

    if (token.value === ']') {
      depth++;
    } else if (token.value === '[') {
      depth--;

      if (depth === 0) {
        return k;
      }
    }
  }

  return -1;
}

/**
 * The index of the `(` matching the `)` at `closeIndex`, or `-1` when the source has no match.
 */
function matchingOpenParen(tokens: readonly Token[], closeIndex: number): number {
  const close = tokens[closeIndex];
  if (close?.kind === 'punct' && close.matchingOpen !== undefined) {
    return close.matchingOpen;
  }
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

/** Claim the most recent class header at this exact depth; nested heritage classes claim first. */
function takeClassBodyContext(
  contexts: PendingClassContext[],
  depth: LexicalDepth,
): PendingClassContext | undefined {
  for (let index = contexts.length - 1; index >= 0; index--) {
    const context = contexts[index];
    if (
      context?.parenDepth === depth.parenDepth &&
      context.bracketDepth === depth.bracketDepth &&
      context.braceDepth === depth.braceDepth &&
      context.frameDepth === depth.frameDepth
    ) {
      contexts.splice(index, 1);
      return context;
    }
  }
  return undefined;
}

/**
 * Read a JSX tag name starting at `i` (the first character after `<`). Member expressions
 * (`<UI.Panel>`), namespaced names (`<svg:rect>`) and dashed names (`<my-tag>`) are part of the name.
 */
function readJsxTagName(source: string, i: number, n: number): { name: string; end: number } {
  const start = i;

  while (i < n) {
    const ch = source[i];

    if (
      ch === undefined ||
      !(isIdentifierPartAt(source, i) || ch === '.' || ch === '-' || ch === ':')
    ) {
      break;
    }

    i += codePointLength(source, i);
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
 * statement heads and blocks. `:` is classified separately using property/conditional depth,
 * because labels and `case`/`default` clauses instead introduce statements.
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
  colonIsExpression: boolean,
  expressionExpected: boolean,
): boolean {
  if (expressionExpected) {
    return true;
  }
  if (prevKind === 'punct') {
    return prevPunct === ':' ? colonIsExpression : EXPRESSION_BEFORE_BRACE.has(prevPunct ?? '');
  }
  return prevKind === 'regex';
}

/**
 * Whether a `{` opens an expression (an object literal or a destructuring pattern) instead of a
 * statement block or function body. `colonIsExpression` distinguishes property/conditional colons
 * from statement separators. Statement position is the default, so an unknown context keeps the existing
 * behaviour of allowing a regex literal after the matching `}`.
 */
function opensObjectLiteral(
  prevKind: PrevKind,
  prevPunct: string | undefined,
  prevIdentifier: string | undefined,
  prevIsExpressionKeyword: boolean,
  inTemplateExpression: boolean,
  colonIsExpression: boolean,
  lineBreakBefore: boolean,
): boolean {
  if (prevKind === 'punct') {
    // Inside an object literal a `:` separates a property from its value (`{ scale: {} }`, where a
    // following `/` divides), while at statement level the same `:` follows a label
    // (`label: {}`) or a `case`/`default` clause, whose `{` opens a block.
    if (prevPunct === ':') {
      return colonIsExpression;
    }

    return EXPRESSION_BEFORE_BRACE.has(prevPunct ?? '');
  }

  if (prevKind === 'identifier') {
    // `return {` is an expression, `else {`/`do {` are blocks and every other identifier
    // (`function f`, `class C`) sits in statement position.
    return (
      prevIsExpressionKeyword &&
      !BLOCK_AFTER_KEYWORD.has(prevIdentifier ?? '') &&
      !(prevIdentifier === 'return' && lineBreakBefore)
    );
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
  previous?: Token,
): boolean {
  if (previous?.assertionEnd === true) {
    return false;
  }
  if (previous?.kind === 'punct' && previous.value !== '}' && previous.expressionEnd === true) {
    return false;
  }
  if (previous?.kind === 'punct' && (previous.value === '++' || previous.value === '--')) {
    return previous.expressionEnd !== true;
  }
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
  let closingDelimiters: ReadonlyMap<number, number> | undefined;
  const closingDelimiter = (openIndex: number): number | undefined => {
    closingDelimiters ??= indexClosingDelimiters(tokens);
    return closingDelimiters.get(openIndex);
  };
  const resolvedRequireScopes = new Map<RequireScope, boolean>();
  const requireIsShadowed = (scope: RequireScope): boolean => {
    const path: RequireScope[] = [];
    let current: RequireScope | undefined = scope;
    while (current !== undefined && !resolvedRequireScopes.has(current)) {
      path.push(current);
      current = current.parent;
    }
    let shadowed = current === undefined ? false : (resolvedRequireScopes.get(current) ?? false);
    for (let index = path.length - 1; index >= 0; index--) {
      const owner = path[index];
      if (owner !== undefined) {
        shadowed ||= owner.bindings.some((range) =>
          bindingHasRequire(tokens, range.start, range.end, closingDelimiter),
        );
        resolvedRequireScopes.set(owner, shadowed);
      }
    }
    return shadowed;
  };
  let i = 0;

  while (i < n) {
    const token = tokens[i];

    if (token?.kind !== 'identifier') {
      i++;
      continue;
    }

    if (token.value === 'import') {
      i = handleImport(tokens, i, occurrences, closingDelimiter);
      continue;
    }

    if (token.value === 'export') {
      i = handleExport(tokens, i, occurrences);
      continue;
    }

    if (token.value === 'require') {
      if (token.requireScope !== undefined && requireIsShadowed(token.requireScope)) {
        i++;
        continue;
      }
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
 * - Dynamic import accepts a literal source with optional bounded object-literal options.
 */
/**
 * Whether the identifier at `i` is a property name (`obj.require`), which is never the global
 * `require`/`import`. A `.` that belongs to a spread (`...require('pkg')`) is not member access.
 */
function isMemberName(tokens: readonly Token[], i: number): boolean {
  const prev = tokens[i - 1];

  if (prev?.kind === 'punct' && prev.value === '#') {
    return true;
  }

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
  closingDelimiter: (openIndex: number) => number | undefined,
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

  // Keep literal specifiers with sole-argument or bounded object-literal options forms.
  if (next?.kind === 'punct' && next.value === '(') {
    const specifier = dynamicImportSpecifier(tokens, i + 2, closingDelimiter);

    if (specifier !== undefined) {
      occurrences.push({ specifier, kind: 'dynamic-import' });
      return i + 3;
    }

    return i + 1;
  }

  // Static `import ... from 'pkg'`: consume only the supported clause.
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

/** Read only the supported clause; unrelated statements cannot supply its source. */
function scanImportSource(
  tokens: readonly Token[],
  i: number,
  occurrences: ModuleSpecifierOccurrence[],
  kind: ModuleSpecifierKind,
): number {
  const sourceIndex =
    kind === 'export-from' ? exportSourceIndex(tokens, i) : importSourceIndex(tokens, i);
  const source = sourceIndex === undefined ? undefined : tokens[sourceIndex];
  if (source?.kind === 'string' && sourceIndex !== undefined) {
    occurrences.push({ specifier: source.value, kind });
    return sourceIndex + 1;
  }
  return i + 1;
}

/**
 * Consume a default binding and/or a namespace/named clause, then require `from` + literal.
 * Each property lookalike fails locally. Named clauses accept only specifiers, never arbitrary
 * brace contents, so failed candidates cannot repeatedly search an unrelated suffix.
 */
function importSourceIndex(tokens: readonly Token[], importIndex: number): number | undefined {
  let index = importIndex + 1;
  if (
    isIdentifier(tokens[index], 'type') &&
    (isPunct(tokens[index + 1], '{') ||
      isPunct(tokens[index + 1], '*') ||
      (tokens[index + 1]?.kind === 'identifier' &&
        (!isIdentifier(tokens[index + 1], 'from') || tokens[index + 2]?.kind !== 'string') &&
        (!isIdentifier(tokens[index + 1], 'as') || isIdentifier(tokens[index + 2], 'from'))))
  ) {
    index++;
  }

  if (tokens[index]?.kind === 'identifier') {
    index++;
    // Preserve the historical synthetic default-alias form supported by this scanner.
    if (isIdentifier(tokens[index], 'as') && tokens[index + 1]?.kind === 'identifier') {
      index += 2;
    }
    if (isPunct(tokens[index], ',')) {
      index++;
    } else {
      return importFromSourceIndex(tokens, index);
    }
  }

  if (isPunct(tokens[index], '*')) {
    if (!isIdentifier(tokens[index + 1], 'as') || tokens[index + 2]?.kind !== 'identifier') {
      return undefined;
    }
    index += 3;
  } else if (isPunct(tokens[index], '{')) {
    index++;
    while (!isPunct(tokens[index], '}')) {
      // `type as T` imports the value `type`, but `type as` imports the type `as`.
      // A second `as` plus an alias distinguishes `type as as Alias` from `type as as`.
      if (
        isIdentifier(tokens[index], 'type') &&
        tokens[index + 1]?.kind === 'identifier' &&
        (!isIdentifier(tokens[index + 1], 'as') ||
          isPunct(tokens[index + 2], ',') ||
          isPunct(tokens[index + 2], '}') ||
          (isIdentifier(tokens[index + 2], 'as') && tokens[index + 3]?.kind === 'identifier'))
      ) {
        index++;
      }
      const imported = tokens[index];
      if (imported?.kind !== 'identifier' && imported?.kind !== 'string') {
        return undefined;
      }
      index++;
      if (isIdentifier(tokens[index], 'as')) {
        if (tokens[index + 1]?.kind !== 'identifier') {
          return undefined;
        }
        index += 2;
      } else if (imported.kind === 'string') {
        return undefined;
      }
      if (!isPunct(tokens[index], ',')) {
        break;
      }
      index++;
    }
    if (!isPunct(tokens[index], '}')) {
      return undefined;
    }
    index++;
  } else {
    return undefined;
  }
  return importFromSourceIndex(tokens, index);
}

function importFromSourceIndex(tokens: readonly Token[], index: number): number | undefined {
  return isIdentifier(tokens[index], 'from') && tokens[index + 1]?.kind === 'string'
    ? index + 1
    : undefined;
}

function exportSourceIndex(tokens: readonly Token[], exportIndex: number): number | undefined {
  let index = exportIndex + 1;
  if (isIdentifier(tokens[index], 'type')) {
    index++;
  }

  if (isPunct(tokens[index], '*')) {
    index++;
    if (isIdentifier(tokens[index], 'as')) {
      index += 2;
    }
  } else if (isPunct(tokens[index], '{')) {
    let depth = 1;
    index++;
    while (index < tokens.length && depth > 0) {
      if (isPunct(tokens[index], '{')) {
        depth++;
      } else if (isPunct(tokens[index], '}')) {
        depth--;
      }
      index++;
    }
    if (depth !== 0) {
      return undefined;
    }
  } else {
    return undefined;
  }

  return isIdentifier(tokens[index], 'from') && tokens[index + 1]?.kind === 'string'
    ? index + 1
    : undefined;
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

  // A sole string argument, with an optional trailing comma, is static; options are not supported.
  if (next?.kind === 'punct' && next.value === '(') {
    const specifier = soleStringSpecifier(tokens, i + 2);

    if (specifier !== undefined) {
      occurrences.push({ specifier, kind: 'require' });
      return i + 3;
    }
  }

  return i + 1;
}

/** Inspect binding targets only, skipping property keys, types and initializer expressions. */
function bindingHasRequire(
  tokens: readonly Token[],
  start: number,
  end: number,
  closingDelimiter: (openIndex: number) => number | undefined,
): boolean {
  const targets = [{ start, end }];
  while (targets.length > 0) {
    const target = targets.pop();
    if (target === undefined) {
      break;
    }
    let index = bindingAfterRest(tokens, target.start);
    // Constructor parameter properties prefix the binding, rather than naming it.
    let modifier = tokens[index];
    while (
      index + 1 < target.end &&
      modifier?.kind === 'identifier' &&
      ['public', 'private', 'protected', 'readonly', 'override'].includes(modifier.value)
    ) {
      index++;
      modifier = tokens[index];
    }
    const token = tokens[index];
    if (token?.kind === 'identifier') {
      const next = tokens[index + 1];
      if (
        token.value === 'require' &&
        (index + 1 >= target.end ||
          isPunct(next, ',') ||
          isPunct(next, '?') ||
          (next?.kind === 'punct' && next.operator === 'assignment'))
      ) {
        return true;
      }
      continue;
    }
    const object = isPunct(token, '{');
    if (!object && !isPunct(token, '[')) {
      continue;
    }
    const close = closingDelimiter(index);
    if (close === undefined || close >= target.end) {
      continue;
    }
    const frame = token?.parameterFrame;
    index++;
    while (index < close) {
      if (isPunct(tokens[index], ',')) {
        index++;
        continue;
      }
      index = bindingAfterRest(tokens, index);
      let binding = index;
      if (object) {
        const keyClose = isPunct(tokens[index], '[') ? closingDelimiter(index) : index;
        if (keyClose === undefined) {
          break;
        }
        if (isPunct(tokens[keyClose + 1], ':')) {
          binding = keyClose + 2;
        }
      }
      targets.push({ start: binding, end: close });
      index = bindingElementEnd(tokens, binding, close, frame, closingDelimiter);
    }
  }
  return false;
}

function bindingAfterRest(tokens: readonly Token[], index: number): number {
  return isPunct(tokens[index], '.') &&
    isPunct(tokens[index + 1], '.') &&
    isPunct(tokens[index + 2], '.')
    ? index + 3
    : index;
}

function bindingElementEnd(
  tokens: readonly Token[],
  start: number,
  end: number,
  frame: number | undefined,
  closingDelimiter: (openIndex: number) => number | undefined,
): number {
  let index = start;
  while (index < end) {
    const token = tokens[index];
    if (isPunct(token, ',') && token?.parameterFrame === frame && token?.parameterType !== true) {
      return index + 1;
    }
    if (isPunct(token, '(') || isPunct(token, '[') || isPunct(token, '{')) {
      const close = closingDelimiter(index);
      if (close !== undefined && close < end) {
        index = close + 1;
        continue;
      }
    }
    index++;
  }
  return end;
}

/** Index balanced delimiters once, lazily, so nested option calls do not rescan suffixes. */
function indexClosingDelimiters(tokens: readonly Token[]): ReadonlyMap<number, number> {
  const closing = new Map<number, number>();
  const stack: number[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token?.kind !== 'punct') {
      continue;
    }

    if (token.value === '(' || token.value === '[' || token.value === '{') {
      stack.push(index);
      continue;
    }

    const opener = closerFor(token.value);

    if (opener === undefined) {
      continue;
    }

    const open = stack.pop();

    if (open === undefined || !isPunct(tokens[open], opener)) {
      // Do not pair an enclosing option object across a malformed nested delimiter.
      stack.length = 0;
    } else {
      closing.set(open, index);
    }
  }

  return closing;
}

/** The opener a closer matches, or undefined when the token is not a closer. */
function closerFor(value: string): string | undefined {
  if (value === ')') {
    return '(';
  }

  return value === ']' ? '[' : value === '}' ? '{' : undefined;
}

/**
 * Recognize the supported dynamic import arguments: a literal source plus either no further
 * argument or one balanced object-literal options expression. Option contents are never evaluated
 * and never contribute evidence. `require` keeps the stricter sole-literal rule.
 */
function dynamicImportSpecifier(
  tokens: readonly Token[],
  argIndex: number,
  closingDelimiter: (openIndex: number) => number | undefined,
): string | undefined {
  const sole = soleStringSpecifier(tokens, argIndex);

  if (sole !== undefined) {
    return sole;
  }

  const specifier = tokens[argIndex];

  if (
    specifier?.kind !== 'string' ||
    !isPunct(tokens[argIndex + 1], ',') ||
    !isPunct(tokens[argIndex + 2], '{')
  ) {
    return undefined;
  }

  const optionsClose = closingDelimiter(argIndex + 2);

  if (optionsClose === undefined) {
    return undefined;
  }

  const next = isPunct(tokens[optionsClose + 1], ',') ? optionsClose + 2 : optionsClose + 1;

  return isPunct(tokens[next], ')') ? specifier.value : undefined;
}

/**
 * The decoded string at `argIndex` when it is the only argument of the surrounding call, that is
 * when it is a string followed by an optional trailing comma and `)`. Returns undefined otherwise,
 * so a dynamic argument (e.g. `'pkg-' + name`) or a call with extra arguments (e.g.
 * `require('pkg', ctx)`) never yields a static specifier.
 */
function soleStringSpecifier(tokens: readonly Token[], argIndex: number): string | undefined {
  const arg = tokens[argIndex];
  const closingIndex = isPunct(tokens[argIndex + 1], ',') ? argIndex + 2 : argIndex + 1;
  const closing = tokens[closingIndex];

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

/** A dynamic import remains valid script syntax; only static forms and meta signal a module. */
function importSignalsModule(source: string, end: number, atRoot: boolean): boolean {
  const next = skipTrivia(source, end, source.length);
  if (source[next] === '.') {
    const meta = skipTrivia(source, next + 1, source.length);
    return (
      (isIdentifierStartAt(source, meta) || isUnicodeEscapeStart(source, meta)) &&
      readIdentifier(source, meta).value === 'meta'
    );
  }
  return (
    atRoot &&
    (source[next] === "'" ||
      source[next] === '"' ||
      source[next] === '{' ||
      source[next] === '*' ||
      isIdentifierStartAt(source, next) ||
      isUnicodeEscapeStart(source, next))
  );
}

function exportSignalsModule(source: string, end: number): boolean {
  const next = skipTrivia(source, end, source.length);
  return (
    source[next] === '{' ||
    source[next] === '*' ||
    (isIdentifierStartAt(source, next) &&
      ['default', 'const', 'let', 'var', 'function', 'async', 'class'].includes(
        readIdentifier(source, next).value,
      ))
  );
}

/**
 * Probe top-level await without treating every identifier named await as a keyword. A complete
 * regex may be read opaquely during this pass even when its following operand makes it script
 * division. That protects apostrophes until a later static declaration settles the whole file.
 * Calls, indexing, tags and unary +/- remain ambiguous script expressions absent another signal.
 */
function probeAwaitOperand(
  source: string,
  end: number,
  inForHead: boolean,
): { keyword: boolean; module: boolean } {
  const trivia = readTrivia(source, end, source.length);
  const next = trivia.end;
  const ch = source[next];
  if (ch === '/') {
    const finish = regexEnd(source, next);
    if (finish === undefined) {
      return { keyword: false, module: false };
    }
    const following = skipTrivia(source, finish, source.length);
    const tail = source[following];
    const unambiguous =
      tail === undefined ||
      [';', ',', ')', ']', '}', '?'].includes(tail) ||
      (tail === '.' && !isNumberStart(source[following + 1] ?? '')) ||
      source.startsWith('&&', following) ||
      source.startsWith('||', following);
    return { keyword: true, module: unambiguous };
  }
  // A newline also permits a bare await identifier statement followed by another statement.
  if (trivia.lineBreak) {
    return { keyword: false, module: false };
  }
  if (isIdentifierStartAt(source, next) || isUnicodeEscapeStart(source, next)) {
    const name = readIdentifier(source, next).value;
    const operand = !['in', 'instanceof'].includes(name) && !(name === 'of' && inForHead);
    return { keyword: operand, module: operand };
  }
  const operand =
    ch !== undefined &&
    (isNumberStart(ch) ||
      (ch === '.' && isNumberStart(source[next + 1] ?? '')) ||
      ["'", '"', '{', '~'].includes(ch) ||
      (ch === '!' && source[next + 1] !== '='));
  return { keyword: operand, module: operand };
}

function skipRegex(source: string, start: number): number {
  const end = regexEnd(source, start);
  if (end === undefined) {
    throw new ModuleSpecifierError('Unterminated regex literal', 'invalid-source', start);
  }
  return end;
}

function regexEnd(source: string, start: number): number | undefined {
  const n = source.length;
  let i = start + 1;
  let inClass = false;

  while (i < n) {
    const ch = source[i];

    // A regex literal cannot contain a raw line terminator. Rejecting it here stops a wrong regex
    // start from swallowing the following lines.
    if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
      return undefined;
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

  return undefined;
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

const IDENTIFIER_START = /^[$_\p{ID_Start}]$/u;
const IDENTIFIER_PART = /^[$_\u200C\u200D\p{ID_Continue}]$/u;

function isIdentifierStartAt(source: string, index: number): boolean {
  const codePoint = readCodePoint(source, index);
  return codePoint !== undefined && isIdentifierStartCharacter(codePoint.character);
}

function isIdentifierPartAt(source: string, index: number): boolean {
  const codePoint = readCodePoint(source, index);
  return codePoint !== undefined && isIdentifierPartCharacter(codePoint.character);
}

function isIdentifierStartCharacter(character: string): boolean {
  return IDENTIFIER_START.test(character);
}

function isIdentifierPartCharacter(character: string): boolean {
  return IDENTIFIER_PART.test(character);
}

function codePointLength(source: string, index: number): number {
  return (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function readCodePoint(
  source: string,
  index: number,
): { character: string; end: number } | undefined {
  const point = source.codePointAt(index);
  if (point === undefined) {
    return undefined;
  }
  const end = index + (point > 0xffff ? 2 : 1);
  return { character: String.fromCodePoint(point), end };
}

function isUnicodeEscapeStart(source: string, index: number): boolean {
  return source[index] === '\\' && source[index + 1] === 'u';
}

function readUnicodeEscape(source: string, start: number): { character: string; end: number } {
  let end = start + 2;
  let digits: string;

  if (source[end] === '{') {
    const digitsStart = ++end;
    while (end < source.length && /[0-9A-Fa-f]/.test(source[end] ?? '')) {
      end++;
    }
    if (end === digitsStart || source[end] !== '}' || end - digitsStart > 6) {
      throw new ModuleSpecifierError(
        'Invalid Unicode escape in identifier',
        'invalid-source',
        start,
      );
    }
    digits = source.slice(digitsStart, end);
    end++;
  } else {
    digits = source.slice(end, end + 4);
    if (digits.length !== 4 || !/^[0-9A-Fa-f]{4}$/.test(digits)) {
      throw new ModuleSpecifierError(
        'Invalid Unicode escape in identifier',
        'invalid-source',
        start,
      );
    }
    end += 4;
  }

  const value = Number.parseInt(digits, 16);
  if (value > 0x10ffff) {
    throw new ModuleSpecifierError('Invalid Unicode escape in identifier', 'invalid-source', start);
  }
  return { character: String.fromCodePoint(value), end };
}

function isNumberStart(ch: string): boolean {
  return /[0-9]/.test(ch);
}
