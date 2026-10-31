/** Opaque shell boundaries only; scripts are never executed by the scanner. */
type OpaqueShellCase = {
  readonly name: string;
  readonly script: string;
  readonly expected: readonly string[];
  readonly syntax: boolean;
};

export const opaqueShellCases: readonly OpaqueShellCase[] = [
  ...[
    'echo $( (echo hi); eslint )',
    'echo $(true&&(echo hi); eslint)',
    'echo $(! (echo hi); eslint)',
    'echo $(! true; eslint)',
    'echo $(echo ! case)',
    'echo $("!" case)',
    'echo $(!literal case)',
    'echo $(echo word\\\n#literal)',
    'echo $(\\\n# ")\necho hi\n)',
    'echo $(echo \\); eslint)',

    'echo $( ( (echo hi) ); eslint )',
    'echo $( (echo hi) | (echo bye); eslint )',
    'echo $(echo $( (echo hi); eslint ))',
    'echo ${VALUE:-$( (echo hi); eslint )}',
    'echo "$( (echo hi); eslint )"',
    'echo $(echo `printf "("`; (echo hi); eslint)',
    'echo $(# "\necho hi\n)',
    "echo $(# ' ) } $( ` ; eslint\necho hi\n)",
    'echo $(echo hi;# ") ; eslint\necho hi\n)',
    'echo $( (echo hi)# ") ; eslint\necho hi\n)',
    'echo $(echo $(# ")\necho hi\n))',
    'echo ${VALUE:-$(# ") }\necho hi\n)}',
    'echo "$(# ")\necho hi\n)"',
    'echo $(echo ${#VALUE}; eslint)',
    'echo $(echo word#literal)',
    "echo $(echo ''#literal)",
    'echo $(echo $(echo hi)#literal)',
    'echo $(echo ${VALUE}#literal)',
    'echo $(echo "# ) \'")',
    'echo $(echo \\#literal)',
    'echo $(echo "case")',
    'echo $(echo case)',
    'echo $("case")',
    'echo $(echo "((" ")")',
    "echo $(echo ')'; eslint)",
    "echo $(cat <<'EOF'\n)\n# \"\neslint\nEOF\n)",
    'echo $(cat <<EOF # " )\neslint\nEOF\n)',
  ].flatMap((region) =>
    [' && ', '; ', '\n'].map((separator) => ({
      name: `trusted exterior after ${region} via ${JSON.stringify(separator)}`,
      script: `before-tool; ${region}${separator}prettier`,
      expected: ['before-tool', 'prettier'],
      syntax: true,
    })),
  ),
  ...[
    'echo $( (echo hi); eslint && prettier',
    'echo $(echo "unterminated); eslint && prettier',
    'echo $(# ") ; eslint && prettier',
    'echo $((1 + 2)) && prettier',
    'echo $(echo $((1 + 2)); eslint) && prettier',
    'echo $( ((1 + 2)); eslint) && prettier',
    'echo $(case x in x) eslint;; esac) && prettier',
    'echo $(f() { eslint; }; f) && prettier',
    'echo $(cat <<A <<B\neslint\nA\nprettier\nB\n) && prettier',
    'echo $(cat <<EOF\npayload \\\nEOF\neslint\nEOF\n) && prettier',
  ].map((region) => ({
    name: `unproven remainder stays opaque: ${region}`,
    script: `before-tool; ${region}`,
    expected: ['before-tool'],
    syntax: false,
  })),
  ...[
    'echo $(! case x in x) :; eslint;; esac) && prettier',
    'echo $(!\tcase x in x) :; eslint;; esac) && prettier',
    'echo $(true && ! case x in x) :; eslint;; esac) && prettier',
    'echo $(echo $(! case x in x) :; eslint;; esac)) && prettier',
  ].map((region) => ({
    name: `negated case keeps remainder opaque: ${region}`,
    script: `before-tool; ${region}`,
    expected: ['before-tool'],
    syntax: true,
  })),
  {
    name: 'real mapped command after balanced groups',
    script: 'echo $( (echo hi); eslint ); tsc',
    expected: ['typescript'],
    syntax: true,
  },
  {
    name: 'real command before and after comment region',
    script: 'eslint; echo $(# "\necho hi\n); eslint',
    expected: ['eslint'],
    syntax: true,
  },
];

export const opaqueShellDeclaredNames = ['before-tool', 'eslint', 'prettier', 'typescript'];
