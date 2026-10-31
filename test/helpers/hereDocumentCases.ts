/** Shell text is scanned statically; syntax=true permits only a development bash -n check. */
type HereDocumentCase = {
  readonly name: string;
  readonly script: string;
  readonly expected: readonly string[];
  readonly syntax: boolean;
};

const backslash = String.fromCharCode(92);
const lf = String.fromCharCode(10);
const crlf = String.fromCharCode(13, 10);
const tab = String.fromCharCode(9);

export const hereDocumentCases: readonly HereDocumentCase[] = [
  ...['EOF', "'EOF'", '"EOF"'].flatMap((delimiter) =>
    ['<<', '<<-'].flatMap((operator) =>
      [lf, crlf].map((newline) => ({
        name: 'payload continuation ' + operator + delimiter + ' ' + JSON.stringify(newline),
        script: [
          'before-tool; cat ' + operator + delimiter,
          'payload ' + backslash,
          (operator === '<<-' ? tab : '') + 'EOF',
          'eslint',
          'EOF',
          'prettier',
        ].join(newline),
        expected: delimiter === 'EOF' ? ['before-tool'] : ['before-tool', 'eslint', 'prettier'],
        syntax: newline === lf,
      })),
    ),
  ),
  ...[2, 3, 4].map((slashes) => ({
    name: 'payload continuation parity ' + String(slashes),
    script: [
      'before-tool; cat <<EOF',
      'payload ' + backslash.repeat(slashes),
      'EOF',
      'eslint',
      'EOF',
      'prettier',
    ].join(lf),
    expected: slashes % 2 === 0 ? ['before-tool', 'eslint', 'prettier'] : ['before-tool'],
    syntax: true,
  })),
  {
    name: 'backslash followed by spaces does not continue the payload line',
    script: [
      'before-tool; cat <<EOF',
      'payload ' + backslash + '  ',
      'EOF',
      'eslint',
      'prettier',
    ].join(lf),
    expected: ['before-tool', 'eslint', 'prettier'],
    syntax: true,
  },
  {
    name: 'continued delimiter spelling is outside the resume subset',
    script: ['before-tool; cat <<EOF', 'E' + backslash, 'OF', 'prettier'].join(lf),
    expected: ['before-tool'],
    syntax: true,
  },
  ...['EOF', "'EOF'", '"EOF"'].flatMap((delimiter) =>
    ['<<', '<<-'].flatMap((operator) =>
      ['\n', '\r\n'].map((newline) => ({
        name: `${operator}${delimiter} with ${JSON.stringify(newline)}`,
        script: [
          'before-tool; cat ' + operator + delimiter,
          'eslint; tsc && npx eslint',
          '"quoted" | eslint',
          '# prettier && eslint',
          '${VALUE} $(printf text) `printf text`',
          (operator === '<<-' ? '\t\t' : '') + 'EOF',
          'after-tool && prettier',
        ].join(newline),
        expected: ['after-tool', 'before-tool', 'prettier'],
        syntax: newline === '\n',
      })),
    ),
  ),
  ...(
    [
      [
        'attached redirection',
        'before-tool; cat<<EOF\neslint\nEOF\nprettier',
        ['before-tool', 'prettier'],
      ],
      ['quoted attached redirection', "cat<<'EOF'\neslint\nEOF\nprettier", ['prettier']],
      [
        'comment on header',
        "cat << 'EOF' # ignored \" <<OTHER ; eslint\neslint\nEOF\nprettier",
        ['prettier'],
      ],
      ['literal delimiter alphabet', 'cat << _END_123\neslint\n_END_123\nprettier', ['prettier']],
      ['delimiter matches a tool name', 'cat <<eslint\ntsc\neslint\nprettier', ['prettier']],
      [
        'prefixes and suffixes do not close',
        'cat <<EOF\neslint\nEOFX\nEOF \ntsc\nEOF\nprettier',
        ['prettier'],
      ],
      ['quotes on a close are payload', "cat <<'EOF'\n'EOF'\neslint\nEOF\nprettier", ['prettier']],
      ['tabs stripped only for dash form', 'cat <<-EOF\n\teslint\n\tEOF\nprettier', ['prettier']],
      ['spaces are not tabs', 'cat <<-EOF\neslint\n EOF\ntsc\nEOF\nprettier', ['prettier']],
      ['plain form does not strip tabs', 'cat <<EOF\n\tEOF\neslint\nEOF\nprettier', ['prettier']],
      ['sequential documents', "cat <<A\neslint\nA\ncat <<'B'\ntsc\nB\nprettier", ['prettier']],
      [
        'quoted payload is completely opaque',
        "cat <<'EOF'\n' \" ` $( ${ ; | && <<SECOND\neslint\nEOF\nprettier",
        ['prettier'],
      ],
      ['real mapped tool after close', "cat <<'EOF'\neslint\nEOF\ntsc", ['typescript']],
      ['real payload-named tool after close', "cat <<'EOF'\neslint\nEOF\neslint", ['eslint']],
      ['real command before opaque header', "eslint; cat <<'EOF'\ntsc\nEOF", ['eslint']],
      ['redirection text inside quotes', "eslint '<<EOF' && prettier", ['eslint', 'prettier']],
      ['quoted multiline argument', 'echo "<<EOF\neslint\nEOF"; prettier', ['prettier']],
      ['comment opener is not a document', '# cat <<EOF\neslint', ['eslint']],
      ['opaque substitution opener', 'echo $(cat <<EOF\neslint\nEOF\n); prettier', ['prettier']],
    ] as const
  ).map(([name, script, expected]) => ({
    name,
    script,
    expected,
    syntax: true,
  })),
  ...[
    '<<EOF <<SECOND',
    '<<EOF && eslint',
    '<<EOF | cat',
    '<<EOF;',
    '<<EOF > output',
    '<<EOF extra',
    '<<EOF#suffix',
    "<<E'OF'",
    '<<"EO"F',
    '<<$EOF',
    '<<"$EOF"',
    "<<'EO F'",
    "<<''",
    '<<ÉOF',
    '<<<EOF',
    '<<',
    '<<-',
    "<<'EOF",
  ].map((header) => ({
    name: `unknown header ${header}`,
    script: `before-tool; cat ${header}\neslint\nEOF\nSECOND\ntsc\nprettier`,
    expected: ['before-tool'],
    syntax: false,
  })),
  ...(
    [
      ['unterminated payload', 'before-tool; cat <<EOF\neslint\nprettier'],
      ['space-indented close remains payload', 'before-tool; cat <<-EOF\neslint\n EOF\nprettier'],
      ['wrong delimiter', 'before-tool; cat <<EOF\neslint\nEND\nprettier'],
      ['unsupported prefix redirection', 'before-tool; cat > out <<EOF\neslint\nEOF\nprettier'],
      ['header without a newline', 'before-tool; cat <<EOF'],
    ] as const
  ).map(([name, script]) => ({
    name,
    script,
    expected: ['before-tool'],
    syntax: false,
  })),
];

export const hereDocumentDeclaredNames = [
  'after-tool',
  'before-tool',
  'cat',
  'eslint',
  'prettier',
  'typescript',
];
