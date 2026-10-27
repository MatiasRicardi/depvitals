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

type Token = {
  readonly lineBreakBefore?: boolean;
} & (
  | {
      readonly kind: 'identifier';
      readonly value: string;
      readonly classExpression?: boolean;
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
  readonly signature: OwnedSignature | undefined;
  readonly control: boolean;
  readonly depth: LexicalDepth;
  phase: 'binding' | 'type' | 'initializer';
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
  );

type ClassMember = {
  readonly start: number;
  phase: 'head' | 'decorator' | 'field' | 'type' | 'initializer' | 'parameters';
};

type ClassContext = LexicalDepth & {
  member: ClassMember | undefined;
};

// A brace owns its closing action. In particular an initializer's object/function cannot close
// the enclosing class member, and only a function body restores the nearest function grammar.
type BraceContext =
  | { readonly role: 'object' | 'block' }
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
  // Preserve the position before an `async` modifier for a following `function` keyword.
  let asyncFunctionIsExpression = false;
  // A line terminator in trivia may end an expression-bodied arrow through ASI. It is consumed
  // only when the next significant token cannot continue the preceding expression.
  let lineTerminatorSinceLastToken = false;
  let tokenLineBreakBefore = false;
  const emit = (token: Token): void => {
    const significant = tokenLineBreakBefore ? { ...token, lineBreakBefore: true } : token;
    if (memberAtToken !== undefined) {
      advanceMember(memberAtToken, significant, tokens[tokens.length - 1]);
    }
    tokens.push(significant);
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
  // The nearest function body owns the await/yield grammar. An ordinary nested function therefore
  // suspends an async/generator context from an outer function instead of inheriting it.
  // A default callback may open and finish while an outer signature is still reading parameters.
  // Only a signature with closed parameters at its original depth can own the next body brace.
  const pendingFunctionContexts: PendingFuncContext[] = [];
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

  // JSX markup and sibling expression containers are separate expressions. Emitting an explicit
  // boundary keeps the token stream from gluing two of them into an import/require sequence that
  // does not exist in source (for example `<p>{import}{('pkg')}</p>`).
  const pushBoundary = (offset: number): void => {
    emit({ kind: 'punct', value: ';', offset, endOffset: offset + 1 });
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

    let expressionFunctionContext =
      expressionFunctionContexts[expressionFunctionContexts.length - 1];

    while (
      expressionFunctionContext !== undefined &&
      typeAnnotation === undefined &&
      !inText &&
      frames[frames.length - 1]?.kind !== 'jsx-text' &&
      frames[frames.length - 1]?.kind !== 'jsx-tag' &&
      !closingParenBelongsToArrowParameters(source, i, n) &&
      expressionFunctionBodyEnded(
        ch,
        parenDepth,
        bracketDepth,
        braceContexts.length,
        frames.length,
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

    if (isWhitespace(ch) || (ch === '/' && (source[i + 1] === '/' || source[i + 1] === '*'))) {
      const trivia = readTrivia(source, i, n);
      i = trivia.end;
      lineTerminatorSinceLastToken ||= trivia.lineBreak;
      continue;
    }

    tokenLineBreakBefore = lineTerminatorSinceLastToken;
    const previousSignature = closedParameterSignature;
    closedParameterSignature = undefined;
    memberAtToken = undefined;
    const classState = currentClass();
    const identifier = isIdentifierStart(ch) ? readIdentifier(source, i) : undefined;
    if (
      typeAnnotation?.role === 'return' &&
      tokenLineBreakBefore &&
      atLexicalDepth(typeAnnotation.signature.owner) &&
      atTypeRoot(typeAnnotation) &&
      !typeAnnotation.typeOperandExpected &&
      identifier !== undefined &&
      (!TYPE_OPERAND_KEYWORDS.has(identifier.value) || identifier.value === 'const')
    ) {
      const signature = typeAnnotation.signature;
      if (pendingFunctionContexts[pendingFunctionContexts.length - 1] === signature.context) {
        pendingFunctionContexts.pop();
      }
      if (classState !== undefined && signature.context.isClassMember === true) {
        classState.member = undefined;
      }
      typeAnnotation = undefined;
      inType = false;
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
        classState.member ??= { start: tokens.length, phase: 'head' };
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
          parenDepth,
          bracketDepth,
          braceContexts.length,
          frames.length,
          functionContextStack.length,
          context,
        )
      ) {
        expressionFunctionContexts.pop();
        context = expressionFunctionContexts[expressionFunctionContexts.length - 1];
      }

      lineTerminatorSinceLastToken = false;
    }
    const equalsOperator =
      ch === '='
        ? classifyEquals(source, i, typeAnnotation !== undefined && atTypeRoot(typeAnnotation))
        : undefined;

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

      if (after !== undefined && isIdentifierStart(after) && !jsxTagIsGeneric(source, i + 1, n)) {
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

        if (!annotation.signature.isFunctionKeyword) {
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
        !functionTypeArrowContinues(source, i, n)
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
          prevIsExpressionKeyword,
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
        // `keyof`/`extends`/... still expect a type to follow; any other name completes one.
        typeAnnotation.typeOperandExpected = TYPE_OPERAND_KEYWORDS.has(value);
      }
      const previousIdentifier = prevIdentifier;
      if (value === 'async') {
        asyncFunctionIsExpression = functionIsExpressionPosition(
          prevKind,
          prevPunct,
          previousIdentifier,
          colonIsExpression,
        );
        if (
          isIdentifier(tokens[tokens.length - 1], 'default') &&
          isIdentifier(tokens[tokens.length - 2], 'export')
        ) {
          asyncFunctionIsExpression = false;
        }
      }
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
        isMemberName || insideObjectLiteral() || insideClassBody(),
        pendingControlKeyword,
      );
      // A `function` keyword (not a property name) starts a function signature. Track whether it is
      // an expression (`const f = function(){}`) or a declaration (`function f(){}`), and whether it
      // is async (`async function`, i.e. preceded by `async`) or a generator (`function*`, resolved
      // when a following `*` is seen). The context is consumed at the body `{`.
      const methodName =
        value === 'function' &&
        (insideObjectLiteral() || insideClassBody()) &&
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
          async: isAsync,
          generator: false,
          isExpression: isAsync
            ? asyncFunctionIsExpression
            : functionIsExpressionPosition(
                prevKind,
                prevPunct,
                previousIdentifier,
                colonIsExpression,
              ),
          parenDepth,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
          parameterDepth: undefined,
          phase: 'awaiting-parameters',
        });
      }
      emit({
        kind: 'identifier',
        value,
        offset: start,
        endOffset: i,
        ...(isMemberName ? { propertyName: true } : {}),
        ...(value === 'class'
          ? {
              classExpression:
                functionIsExpressionPosition(
                  prevKind,
                  prevPunct,
                  previousIdentifier,
                  colonIsExpression,
                ) ||
                (isPunct(tokens[tokens.length - 1], '>') && isArrowHead(tokens[tokens.length - 2])),
            }
          : {}),
      });
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
        !isObject && context === undefined ? classBodyExpression(tokens) : undefined;
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
          isExpression: classExpression,
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
        braceContexts.push({ role: isObject ? 'object' : 'block' });
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
      const signature = parameterSignatureContext(
        tokens,
        pending !== undefined && atLexicalDepth(pending) ? pending : undefined,
        insideObjectLiteral() || insideClassBody(),
        insideClassBody(),
        tokenLineBreakBefore,
        currentClass()?.member?.start,
      );
      parameterContexts.push({
        openIndex: tokens.length,
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
        depth: {
          parenDepth: parenDepth + 1,
          bracketDepth,
          braceDepth: braceContexts.length,
          frameDepth: frames.length,
        },
        phase: 'binding',
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
      matchingOpen = parameters?.openIndex;
      closedParameterSignature = parameters?.signature;
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
          if (typedArrowContext !== undefined) {
            pendingFunctionContexts.push({
              ...typedArrowContext,
              parenDepth,
              bracketDepth,
              braceDepth: braceContexts.length,
              frameDepth: frames.length,
              parameterDepth: undefined,
              phase: 'awaiting-body',
            });
          }
        } else {
          expressionFunctionContexts.push({
            ...context,
            isExpression: true,
            parenDepth,
            bracketDepth,
            braceDepth: braceContexts.length,
            frameDepth: frames.length,
            functionDepth: functionContextStack.length,
          });
        }
      }
    }

    // A `*` right after `function` (whitespace/comments aside) marks a generator: `function*` and
    // `function *`. It is recorded on the pending signature, consumed at the body `{`.
    const pending = pendingFunctionContexts[pendingFunctionContexts.length - 1];
    const parameter = parameterContexts[parameterContexts.length - 1];
    if (!inType && parameter !== undefined && atLexicalDepth(parameter.depth)) {
      if (ch === ',') {
        parameter.phase = 'binding';
      } else if (equalsOperator?.operator === 'assignment') {
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
      pendingFunctionContexts.pop();
    }

    emit({
      kind: 'punct',
      value: ch,
      offset: i,
      endOffset: i + 1,
      ...equalsOperator,
      ...(matchingOpen !== undefined ? { matchingOpen } : {}),
      ...(closedClassMemberBoundary || opensClassMemberBoundary || (ch === ';' && insideClassBody())
        ? { memberSeparator: true }
        : {}),
      ...(closedExpressionBrace ? { expressionEnd: true } : {}),
    });
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
    if (!isIdentifierStart(source[i])) {
      return false;
    }

    let k = i;

    while (k < n && isIdentifierPart(source[k])) {
      k++;
    }

    const name = source.slice(i, k);
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
    while (end < n && isIdentifierPart(source[end])) {
      end++;
    }

    if (source.slice(k, end) === 'extends' || source.slice(k, end) === 'implements') {
      // `extends`/`implements` is a generic constraint only when it introduces a constraint type that
      // closes the type-parameter list (for example `<T extends object>`). As a JSX attribute it is
      // followed by `=`, a quote, the tag close `>` or a self-close `/`, so it must stay JSX markup
      // instead of being read as a generic signature.
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
    if (name === 'const' && k < n && isIdentifierStart(source[k])) {
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
function arrowFollowsParameters(source: string, open: number, n: number): boolean {
  let depth = 0;
  let prevKind: PrevKind = 'start';
  let prevPunct: string | undefined;

  let k = open;

  while (k < n) {
    k = skipTrivia(source, k, n);
    const ch = source[k];

    if (ch === undefined) {
      break;
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

      if (depth === 0) {
        const j = skipTrivia(source, k + 1, n);

        return source[j] === '=' && source[j + 1] === '>';
      }
    } else if (isIdentifierStart(ch)) {
      let end = k + 1;

      while (end < n && isIdentifierPart(source[end])) {
        end++;
      }

      k = end - 1;
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

/**
 * Lex only the boundaries of a component's type arguments. These tokens preserve literal imports
 * without changing the surrounding JavaScript function/brace state or treating type braces as JSX.
 */
function readJsxTypeArguments(source: string, open: number, n: number, tokens: Token[]): number {
  const closers = ['>'];
  let i = open + 1;

  while (i < n) {
    const trivia = readTrivia(source, i, n);
    i = trivia.end;
    const ch = source[i];

    if (ch === undefined) {
      break;
    }

    if (ch === "'" || ch === '"') {
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
      throw new ModuleSpecifierError(
        'Template literal types in JSX type arguments are not supported',
        'invalid-source',
        i,
      );
    }

    if (isIdentifierStart(ch)) {
      const start = i;
      const identifier = readIdentifier(source, i);
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

    if (ch === '<' || ch === '(' || ch === '{' || ch === '[') {
      closers.push(ch === '<' ? '>' : ch === '(' ? ')' : ch === '{' ? '}' : ']');
    } else if (ch === closers[closers.length - 1] && !(ch === '>' && source[i - 1] === '=')) {
      closers.pop();
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
function functionTypeArrowContinues(source: string, arrowEnd: number, n: number): boolean {
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
      if (ch === '{' || ch === ';' || ch === ',') {
        return false;
      }

      if (ch === '=' && source[i + 1] === '>') {
        return true;
      }
    }
  }

  return false;
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
    } else if (token.value === ';' && closers[closers.length - 1] === '>') {
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
  let end = start + 1;
  while (end < source.length && isIdentifierPart(source[end])) {
    end++;
  }
  return { value: source.slice(start, end), end };
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
    !lineBreakBetween(tokens, markerIndex, parametersIndex);

  return {
    async,
    generator: false,
    isExpression: false,
  };
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
  const genericParameters = nameIndex !== openIndex - 1;
  const startsArrowParameters =
    openIndex === 0 ||
    ((isIdentifier(name, 'async') || genericParameters) &&
      (openIndex === 1 ||
        (marker?.kind === 'punct' && ['=', '(', '[', ',', ':'].includes(marker.value)) ||
        isIdentifier(marker, 'return'))) ||
    (name?.kind === 'punct' && ['=', '(', '[', ',', ':'].includes(name.value)) ||
    isIdentifier(name, 'return') ||
    (isPunct(name, '>') && isPunct(marker, '='));

  if (startsArrowParameters) {
    const asyncToken = name?.kind === 'identifier' && name.value === 'async' ? name : undefined;
    const async =
      asyncToken !== undefined &&
      !lineBreakBefore &&
      !lineBreakBetween(tokens, nameIndex, openIndex - 1);

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
  context: ExpressionFuncContext,
): boolean {
  if (
    functionDepth > context.functionDepth ||
    braceDepth > context.braceDepth ||
    frameDepth !== context.frameDepth
  ) {
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
  previous: Token | undefined,
  nextIdentifier: string | undefined,
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
    EXPRESSION_ENDING.has(prevKind) ||
    (prevKind === 'punct' &&
      ([')', ']', '}'].includes(prevPunct ?? '') ||
        (previous?.kind === 'punct' && previous.expressionEnd === true)));

  return previousEndsExpression && !expressionContinues(next, nextIdentifier);
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

/** Recover a class header without crossing its boundary or inspecting nested heritage operands. */
function classBodyExpression(tokens: readonly Token[]): boolean | undefined {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];

    if (token?.kind === 'identifier' && token.value === 'class') {
      const afterClass = tokens[index + 1];

      return afterClass?.kind !== 'punct' || afterClass.value !== '('
        ? token.classExpression === true &&
            !(
              isIdentifier(tokens[index - 1], 'default') &&
              isIdentifier(tokens[index - 2], 'export')
            )
        : undefined;
    }

    if (isPunct(token, ')') || isPunct(token, ']')) {
      const open = isPunct(token, ')')
        ? matchingOpenParen(tokens, index)
        : matchingOpenBracket(tokens, index);
      if (open < 0) {
        return undefined;
      }
      index = open;
      continue;
    }

    if (
      token?.kind === 'punct' &&
      (token.value === ';' || token.value === '{' || token.value === '}')
    ) {
      return undefined;
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
  previousIdentifier: string | undefined,
  colonIsExpression: boolean,
): boolean {
  if (prevKind === 'punct') {
    return prevPunct === ':' ? colonIsExpression : EXPRESSION_BEFORE_BRACE.has(prevPunct ?? '');
  }
  if (prevKind === 'identifier') {
    return REGEX_PRECEDING_KEYWORDS.has(previousIdentifier ?? '');
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
  previous?: Token,
): boolean {
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
