# DepVitals technical reference

This reference describes the current development build targeting DepVitals v0.6.0. See the [README](../README.md) for commands and the [changelog](../CHANGELOG.md) for published release boundaries. DepVitals is a CLI for one project root, not a full JavaScript/TypeScript compiler, module resolver or replacement for reviewing dependency changes.

## Findings and evidence

| Evidence                                  | Suppresses unused for declared packages | Creates missing findings |
| ----------------------------------------- | --------------------------------------- | ------------------------ |
| Supported source imports/exports/requires | Yes                                     | Yes                      |
| Recognized `package.json` script command  | Yes                                     | No                       |
| Supported static configuration hint       | Yes                                     | No                       |
| Arbitrary text or unsupported pattern     | No                                      | No                       |

Unused findings apply separately to `dependencies` and `devDependencies`. Missing means a source-referenced external package is undeclared in all four groups, including `peerDependencies` and `optionalDependencies`. Those last two groups are never reported unused. Installation state is not checked; an installed but undeclared package can still be missing.

A clean report means no issues were found through supported evidence. It does not establish that every dependency is needed, that removing an unused package is safe, or that the project will build. Findings are deduplicated and sorted alphabetically within the fixed category order: unused dependencies, unused devDependencies, missing dependencies.

## CLI and JSON reports

The current build supports JSON v2 reports, package explanations and optional full-scan diagnostics.
Check the installed version with standalone `--version`. JSON reports and explanations have been
available since v0.4.0; `--diagnostics` was added in v0.5.0.

```text
depvitals [project] [--format terminal|json] [--explain <package>] [--diagnostics]
depvitals --help
depvitals --version
```

- With no path, scan the current directory. Supply at most one nonempty project path. The
  positional argument `why` still names a directory. Prefix a dash-leading path with `./`.
- `--format` defaults to `terminal` and also accepts lowercase `json`. `--explain` takes one
  exact, case-sensitive package root, including scoped names. It uses the [dependency name grammar](#dependency-finding-exclusions)
  and its 214-character limit.
- Each option can occur once, before or after the path and in either order. Use separate option
  and value tokens. Equals forms, `--json`, short format/query aliases and standalone `--` are
  argument errors. Missing, empty or dash-leading option values also fail.
- `--diagnostics` is a case-sensitive, valueless flag for full scans only. Use it once, before
  or after the path/format option. It cannot be combined with `--explain`. `--diagnostics=true`,
  `--no-diagnostics` and `-d` are invalid. `--diagnostics true` selects the directory `true`;
  the word is not a boolean value. `--format --diagnostics` is a missing-format-value error.
- Help (`-h`, `--help`) and version (`-v`, `--version`) must be used alone. They skip the project.

| Invocation result                                | Exit | stdout                  | stderr                                   |
| ------------------------------------------------ | ---: | ----------------------- | ---------------------------------------- |
| Clean full scan                                  |    0 | Report                  | Empty or eligible terminal update notice |
| Full scan with findings                          |    1 | Report                  | Empty or eligible terminal update notice |
| Explanation for `used`, `declared` or `excluded` |    0 | One package explanation | Empty                                    |
| Explanation for `unused`, `missing` or `unknown` |    1 | One package explanation | Empty                                    |
| Invalid arguments or operational failure         |    1 | Empty                   | Diagnostic                               |
| Standalone help or version                       |    0 | Help or version         | Empty                                    |

Argument errors retain their precedence: a non-standalone help/version flag fails first;
other token errors (unknown/missing/duplicate options) fail left to right, followed by too many
paths, an empty path, then a valid diagnostics/explanation conflict. The conflict is checked
before filesystem reads. For example, duplicate diagnostics wins over a later explanation
conflict, while a second path wins over the conflict.

A completed diagnostic scan exits 0 for no findings or 1 for findings, with empty stderr.
Its optional notices do not change findings, evidence or status. Argument/operational failures
exit 1, emit no report or partial counters, and put an escaped diagnostic on stderr. Diagnostics
bypass the notifier before cache or network access even in interactive terminals.

An explanation comes from a complete scan. An unrelated fatal input can prevent a query result.
Unrelated dependency findings do not change the query's exit status, findings or counts. A
declaration, retained source reference or exact dependency exclusion makes a package known.
An absent package gets an `unknown` record. A name listed only in `ignoreDependencies` gets an
`excluded` record. The explanation preserves usage evidence and underlying findings for excluded
packages.

Terminal text and error diagnostics escape control characters in paths, arguments and error text; JSON keeps decoded values. A reader that closes an output pipe early leaves the computed scan status intact.

JSON stdout is one UTF-8 document with two-space indentation and one trailing LF. An operational
error produces empty stdout, including with `--format json`. The package ships the
[Draft 7 report v2 schema](../schemas/report-v2.schema.json),
[v2 semantic contract](../schemas/README.md#report-v2-semantic-contract) and
[normative v2 examples](../schemas/examples/v2/README.md). Consumers validate the report and its
cross-field counts, finding and package relationships. Every completed scan or explanation emits
`schemaVersion: 2`. `tool.version` identifies the installed CLI package. Use the
[tagged v0.5.0 schema and guide](https://github.com/MatiasRicardi/depvitals/tree/v0.5.0/schemas)
with that historical v1 producer.

The report identifies the absolute native project root, effective source extensions, fixed
directory exclusions and normalized user exclusions. Evidence paths are project-relative with
`/` separators. A source position points to the opening quote in the original UTF-8-decoded text.
Offsets are zero-based UTF-16 code units, with one-based line and column. CRLF counts as one line
break and two offset units. Script and config records identify fields with escaped RFC 6901
JSON Pointers. The [format guide](../schemas/README.md#evidence-meaning-and-position-units) defines
the full position and evidence rules.

## Scan scope diagnostics

Both commands opt into
facts collected during the same scan; reporters do not rescan the project:

```sh
depvitals ./project --diagnostics
depvitals ./project --format json --diagnostics
```

Terminal output appends a blank line and `Scan diagnostics` after the ordinary report, then
`Source files scanned` and `Nested-package source files` with two-space indentation. Applicable
notice sentences follow in the fixed code order below. Ordinary terminal output has no scope
section. Ordinary JSON and explanations omit the object entirely.

Diagnostic JSON appends `diagnostics` after `query`. Its members appear as `sourceFilesScanned`,
`nestedPackageSourceFiles`, `notices`. Counts are safe nonnegative integers (at most
9007199254740991); nested is at most total. These counts cover supported files whose existing
read/extraction finished, including empty/comment-only sources and declaration files. A file
with many references counts once. Pruned or linked sources do not count. Manifest, lockfile and
configuration reads are not source counts unless that file was itself an eligible source.
A required malformed/linked nested manifest still fails the scan; it produces no partial counts.

| Notice code             | Condition and meaning                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-supported-sources`  | Total source count is zero. Script/config evidence can still contribute.                                                                                                     |
| `nested-package-inputs` | Nested source count is positive; its nearest manifest lies below the selected root. Findings still use the selected root inventory.                                          |
| `workspace-declared`    | The root has a nonempty `workspaces` array, or `workspaces.packages` array, containing only strings with nonblank trimmed values. Patterns are context and are not expanded. |
| `tsconfig-skipped`      | The exact root `tsconfig.json` entry was selected and could not be read as supported configuration. This notice appears once and last. An absent entry emits no notice.      |

Notices are unique and always follow this order; the first two cannot co-occur. A nameless or
empty nested manifest still establishes ownership. A nested source need not belong to a declared
workspace. Empty/mixed/blank workspace arrays, nested declarations and `pnpm-workspace.yaml` alone
supply no workspace notice. A recognized declaration does not prove that members exist or that
another tool accepts its patterns. No workspace inventory is aggregated.

### Zero sources

For `empty-project/package.json` containing `{}` and no other files, run
`depvitals ./empty-project --diagnostics` from outside it. Exit is 0, stderr is empty, and stdout is:

```text
DepVitals

No dependency issues found.

Scan diagnostics
  Source files scanned: 0
  Nested-package source files: 0
  No supported source files were scanned.
```

The JSON command `depvitals ./empty-project --format json --diagnostics` also exits 0 and appends
this object to its complete report:

```json
{
  "sourceFilesScanned": 0,
  "nestedPackageSourceFiles": 0,
  "notices": ["no-supported-sources"]
}
```

### Nested inputs and workspace context

The [nested README example](../README.md#understand-scan-scope) scans one child source against
an empty parent inventory and reports the child's dependency as missing. Select the child as
root to use its inventory, or deliberately exclude its path through `ignorePaths`. Exclusions
narrow the result; the notice does not decide which scope is appropriate for your project.

For `workspace-only/package.json` containing `{"workspaces":["packages/*"]}` and no other files,
`depvitals ./workspace-only --diagnostics` exits 0 with empty stderr and this stdout:

```text
DepVitals

No dependency issues found.

Scan diagnostics
  Source files scanned: 0
  Nested-package source files: 0
  No supported source files were scanned.
  The root package.json declares workspaces. This scan uses only the selected root inventory.
```

No member directory is needed. `depvitals ./workspace-only --format json --diagnostics` appends:

```json
{
  "sourceFilesScanned": 0,
  "nestedPackageSourceFiles": 0,
  "notices": ["no-supported-sources", "workspace-declared"]
}
```

The [complete v2 diagnostic example](../schemas/examples/v2/scan-diagnostics.json) uses an
illustrative CLI version of 0.6.0 and root `/example/project`. It also shows a skipped TypeScript
configuration. Actual reports use the installed package version and selected absolute root.
The [v2 semantic contract](../schemas/README.md#report-v2-semantic-contract) defines the skip
predicate and required notice order. Structural validation and semantic count/notice checks
are separate.

The [six-root comparison](compatibility/v0.5.0.md) and
[reviewed expectation ledger](../test/fixtures/external-corpus/v0.5.0/review.json) record immutable inputs,
ordinary-output agreement, explanation samples, diagnostic scope facts and shared-host cost
observations. They establish behavior on those inputs, not safe-removal or framework-wide claims.

## Optional project configuration

This configuration requires DepVitals 0.3.0 or newer. The npm commands in the README use the npm release; check `depvitals --version` when using an older installation.

A scan reads only `<selected project root>/depvitals.config.json`, using that exact filename and casing. There is no parent/child config search, `package.json` field, executable config, alternate format, inheritance, preset or CLI override. Help/version bypass project/config reads. No file, `{}`, and empty arrays all use the corrected defaults.

The file must contain a strict JSON object with only these optional string-array fields:

| Field                | Effect                                                                                |
| -------------------- | ------------------------------------------------------------------------------------- |
| `ignorePaths`        | Skip matching source files and prune matching directory subtrees before reading them. |
| `ignoreDependencies` | Omit exact selected package names from all three final findings categories.           |

A leading UTF-8 BOM is accepted; comments/JSON5 are not. Unknown keys, wrong types and invalid entries reject the whole configuration; there is no coercion, trimming or partial application. Duplicate normalized entries are removed deterministically. A present file must be a readable, non-symlink regular file. Invalid JSON, invalid rules, unreadable files, symlinks (including dangling ones), directories and other non-regular entries fail with exit 1, empty stdout and a path-identifying stderr diagnostic; field/index information is included for invalid rules. Failed scans do not access the notifier cache or network.

### Editor validation

The v0.5.0 package includes `schemas/depvitals-config.schema.json`. Install DepVitals in your
workspace to use the local schema, including while offline.

In VS Code, add this mapping to `.vscode/settings.json` in the workspace root. Merge the entry
into any existing `json.schemas` array.

```json
{
  "json.schemas": [
    {
      "fileMatch": ["/depvitals.config.json"],
      "url": "./node_modules/depvitals/schemas/depvitals-config.schema.json"
    }
  ]
}
```

The URL resolves relative to the workspace root. The mapping selects the root
`depvitals.config.json`. Keep its contents in normal JSON mode with the two supported keys.

```json
{
  "ignorePaths": ["test/generated", "./sample data//inputs/"],
  "ignoreDependencies": ["Foo", "@scope/_demo", "@scope/-demo"]
}
```

The configuration reader rejects `$schema` as an unknown configuration key. Editor association
belongs in the workspace settings shown above. Both exclusion arrays accept duplicates, which
the CLI normalizes. The editor schema checks nonblank path strings and exact package names.
The CLI additionally enforces portable literal paths and normalization, including rejection of
`../outside`, `src/*.js` and `./.`. VS Code supports workspace settings and relative schema
URLs. [VS Code JSON schema settings](https://code.visualstudio.com/docs/languages/json#_json-schemas-and-settings)

To pin editor validation to v0.5.0, the same mapping can use the immutable URL
`https://raw.githubusercontent.com/MatiasRicardi/depvitals/v0.5.0/schemas/depvitals-config.schema.json`.
The installed-schema URL also supports offline editing.

### Source path exclusions

Paths are literal and relative to the selected project root. Matching is case-sensitive on every platform: use the discovered casing. A rule matches an exact normalized path or its subtree at a full segment boundary: `src/gen` does not match `src/generator`. Nonexistent valid rules have no effect. Fixed discovery exclusions remain active.

Both `/` and `\` are accepted as separators on every host. Leading `./`, repeated separators, trailing separators and `.` segments normalize away; normalized empty/root rules are invalid. Any `..` segment is rejected, even if it would stay inside the project. POSIX/Windows absolute, rooted, UNC and drive-relative paths such as `C:src` are rejected on every platform, as are colons, control characters and leading/trailing whitespace, including whitespace exposed by normalization. Interior spaces are literal.

Globs, negation and pattern matching are unsupported: `*`, `?`, `[`, `]`, `{`, `}` and `!` are reserved and rejected even in literal filenames. Exclude a containing literal directory instead. `$` and `~` remain literal; there is no environment/home expansion or following of rule destinations.

Path exclusions apply to source discovery, not mandatory metadata or dedicated detector reads. Ignoring `package.json` does not bypass required manifest validation; retained source still requires its nearest scope metadata. Ignoring `.eslintrc.json` does not bypass its dedicated detector read. Ignoring `eslint.config.js` skips its imports but its presence still blocks legacy ESLint hints. No ignored file can reactivate a lower-priority detector source.

### Dependency finding exclusions

Names match exactly and case-sensitively: `foo` does not hide `foo-extra`, and scopes remain distinct. The accepted forms are a single component or `@scope/component`, at most 214 characters combined. Components use ASCII letters/digits, `.`, `_` or `-`. They start with a letter or digit, with `_` and `-` also allowed at the start of the name after `@scope/`. Uppercase legacy names are preserved. This is a bounded identifier grammar, not an npm publication validator.

Subpaths, trailing slashes, versions/tags, whitespace, URLs, paths, patterns and empty components are invalid. An undeclared name is allowed, so a rule can suppress missing findings. Builtin-like names such as `fs` are accepted independently of source builtin filtering; there is no registry or installation lookup.

Exclusions are applied after evidence collection and classification using the original dependency inventory. A selected name declared in both dependencies and devDependencies disappears from both unused categories. Rules do not create usage evidence or change script-command collisions: declaring both `gulp` and `gulp-cli` keeps the original command ownership. Retained source still gets parsed; ignoring a dependency cannot hide a source read/lexical error.

### Precedence and meaning of clean output

A scan validates the selected root and root manifest, validates this configuration once, collects static detector hints, analyzes retained sources/scripts, applies exact dependency exclusions, then renders the ordinary report. The optional notifier follows the existing eligibility policy. Configuration adds no flags, output categories or result headings.

Exclusions narrow the scope of a clean report. Removing the only source usage can make a declared package unused; suppressing a name hides a finding, rather than proving that the dependency is used or safe to remove. No configuration means the corrected default at the same implementation, not preservation of earlier incorrect findings.

## Source scanning and discovery

Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts`, including declaration files such as `.d.ts`. Literal static imports, side-effect imports, `import type`, `export ... from`, dynamic `import('package')` and CommonJS `require('package')` supply evidence. Code inside template/JSX expressions is scanned; comments, ordinary strings, template text, JSX text and regex text stay inert.

Literal `require` and dynamic `import` calls accept an optional trailing comma. Dynamic imports also accept a literal specifier followed by balanced object-literal options, for example `import('package', { with: { type: 'json' } })`, including legacy `assert` objects, quoted keys, nested objects, trivia and an optional comma after the options. Option values are not evaluated or used as package hints, and recognizing the specifier does not validate runtime attributes or module exports. Non-object options (variables, calls or arrays), wrapped/continued object expressions and additional arguments remain unsupported for the outer import. Independently supported imports/requires inside their expressions are still scanned. `require` remains limited to one literal argument.

The custom static scanner has tested structural handling for functions, arrows, classes and TypeScript annotations/assertions. It preserves real imports/requires across those boundaries; this is not a guarantee for every language construct. Incomplete strings, comments, templates, regexes or JSX constructs that cannot be safely scanned cause an operational error rather than a partial report.

For ordinary/async/generator function signatures, single-identifier and parenthesized arrows (including async arrows), and object/class methods (including async and generator methods), a parameter binding named `require` suppresses module evidence from calls owned by that function's parameter initializers and body, including inherited nested scopes. Defaults, rest and destructuring bound names are supported; a property key (`{ require: load }`) or annotation type named `require` is not a binding. Global calls outside the owner and real imports/reexports remain evidence. This bounded parameter rule does not resolve local variable declarations, imported aliases, reassignment, or eval/with. Expression-arrow boundaries restore the surrounding scope; computed method keys are evaluated in that surrounding scope, and a method/property name `require` alone does not bind the name.

Package subpaths collapse to their roots: `lodash/chunk` becomes `lodash`, and `@scope/ui/button` becomes `@scope/ui`. Node builtins with or without `node:` and relative/absolute file paths do not create missing findings. URI schemes and unsupported `#` aliases are not resolved into packages.

A source reference is internal when its nearest package scope has a matching name and supported exact `exports` metadata. The supported subset is a direct root `./...` target string or a map consisting entirely of exact subpath keys with safe direct string targets. For example, `self-pkg/feature` is internal for `{ "name": "self-pkg", "exports": { "./feature": "./feature.js" } }`; `self-pkg/missing-key` stays external. Names and raw subpaths match case-sensitively before package-root normalization. Targets need not exist and are never loaded to establish ownership. Conditions, arrays, patterns, mixed maps and unsafe/unsupported lexical paths (including traversal, node_modules segments, backslashes, percent-encoded forms and URL/query/fragment forms) do not prove ownership. An unsupported entry leaves the whole exports map unsupported. A child manifest without name/exports blocks root ownership; child source cannot borrow the root scope's exports to suppress a reference to the root package. Only the root dependency inventory is used. A declared self dependency can remain unused when its only source references are internal.

Discovery skips symlinked entries and rejects a symlinked project root. It prunes these directories wherever encountered: `.git`, `node_modules`, `dist`, `build`, `coverage`, `out`, `.cache`, `.turbo`, `.next`, `.nuxt`. It does not interpret `.gitignore`; optional `ignorePaths` rules only narrow discovery further. Nested source directories are traversed, but child manifests and lockfiles do not become separate dependency inventories; nested package scopes inform source module mode and bounded self-reference ownership. There is no workspace aggregation.

The selected root is validated before manifest or detector reads. Root and required nested `package.json` entries must be regular files checked with `lstat`; symlinks (including dangling links), directories and other non-regular entries fail operationally without reading their contents. Only an absent nested manifest inherits the parent scope. A present unreadable or invalid manifest fails instead. These checks cover stable filesystem entries; they are not a general filesystem sandbox or a guarantee against replacement between checks and reads. Optional `.eslintrc.json` keeps its separate skip and presence-barrier rules.

For source-mode purposes, `.mjs`/`.mts` are modules and `.cjs`/`.cts` are scripts. An explicit nearest `type: "module"` or `type: "commonjs"` controls `.js`; a child manifest without `type` starts its own ambiguous scope. For ambiguous `.js`, bounded static detection recognizes static imports/exports, `import.meta` and supported unambiguous top-level `await` operands, including awaited regexes. Dynamic import alone is not a module signal. This follows the selected subset of [Node syntax detection](https://nodejs.org/download/release/v22.23.3/docs/api/packages.html#syntax-detection), enabled by default since Node 22.7.0. JSX/TypeScript extensions retain the existing explicit package-type policy. Detection is not a universal Node resolver: it does not model runtime flags or lexical redeclarations of CommonJS wrapper names. Calls, indexing, tags, unary `+`/`-` and flag-like identifier divisors (for example, the `g` in `await / value /g`) remain script-compatible absent a separate module signal. Without a flag-like divisor, binary continuations such as `===` after an awaited regex establish module grammar. This bounded choice does not resolve bindings to decide between otherwise ambiguous expressions. Source is read once; ambiguous `.js` gets a lexical probe and a definitive extraction, without execution or catch-and-retry on lexical failures.

### Corrected source boundaries

These examples describe supported recognition, not execution of the source:

- A member named `import` or `export` is not a declaration. `box.export * from` followed by a separate string statement does not reexport that string; an actual `export * from 'package'` does supply evidence.
- `const f = () => function() {} / require('real') / 2;` retains the real call after the function expression; the same ownership rules cover supported class expressions and await/yield contexts.
- A `require` template tag does not turn its interpolation text into a call. Actual `require('real')` calls inside template expressions remain evidence.
- In an ambiguous `.js`, `var await = 4, g = 2; await / require('real') /g;` keeps real division evidence. In contrast, `await /require('fake')/ === 1;` is an unambiguous awaited regex and contributes no fake call. Explicit/nearest package type and extension rules still take precedence.

## Script commands

Only `package.json#scripts` is examined; nothing is executed. The first effective command of a supported segment can credit an exact package name or a known executable mapping. Leading POSIX assignments are skipped; supported separators are `&&`, `||`, `;`, `|` and newline outside quotes. POSIX comments are ignored.

For example, with `typescript` declared:

```json
{ "scripts": { "build": "tsc -p tsconfig.json" } }
```

This suppresses unused `typescript`. The [production catalog](../src/scanner/scriptUsage.ts) owns the explicit executable mappings. Collision-sensitive mappings give a declared exact-name package precedence: `gulp` wins over `gulp-cli` when both are declared. Other mappings, such as `tsc` to `typescript`, use the mapped provider. A command never credits two competing providers.

The immediate package positions in `npx PKG`, `npm exec PKG`, `pnpm exec PKG`, `pnpm dlx PKG` and `yarn dlx PKG` also support exact package-name matching. Executable mappings do not apply to those arguments: `npx tsc` does not imply `typescript`. Unsupported runner arguments such as flags, version/tag suffixes and subpaths do not consume script evidence ordinals.

In v0.4.0, supported explicit Node preloads also credit declared dependencies or devDependencies.
The prefix starts with the exact `node` command after supported leading assignments. It accepts
`-r MODULE`, `--require MODULE`, `--require=MODULE`, `--import MODULE`, `--import=MODULE` and
the pass-through `--test` flag. Collection stops at the first operand or `--`. An unsupported
or malformed prefix option, including eval, print, loader and compact flags, discards all preload
candidates in that Node segment, including earlier ones. Ordinary outer command credit follows
the existing shell rules. Named, positional and special shell parameters discard the preload batch
when they can affect options or a selector. Single-quoted text is literal, and an entry path with a
fixed `./`, `../` or `/` prefix ends option parsing even when its suffix expands.

Preloads are classified as module specifiers. For example, `node --test --import=tsx/esm` credits
declared `tsx` and retains `tsx/esm` in the script evidence with its pointer and ordinal.
The scanner neither resolves nor runs the preloaded module. Preload evidence cannot create missing
findings.

Arguments, paths, `node -e` text and nested shell commands do not imply usage of the packages they mention. Ambiguous aliases such as `tailwindcss`, `playwright` and `webpack` remain unmapped. Redirection, background execution, shell expansion/substitution, unsupported escapes and unfinished quotes invalidate their segment; independent supported segments can still contribute evidence. Here-document payloads are opaque. Scanning resumes only for a single `<<` or `<<-` header ending at a newline, with a nonempty ASCII alphanumeric/underscore delimiter that is unquoted or wholly single/double quoted, followed only by optional spaces/TABs and an optional whitespace-separated comment. LF/CRLF are accepted; the closing line must match exactly. `<<-` removes leading TABs for this comparison, never spaces. The redirected command itself remains unsupported. Multiple simultaneous documents, mixed/expanded delimiters, extra header operators/redirections, here-strings, headers in already unsupported segments and unterminated documents discard the unproven remainder; independently proven preceding segments remain eligible. Unquoted payloads with an unescaped backslash-newline continuation also discard the remainder, since their logical closing line is outside this resume subset. Quoted delimiters keep backslashes literal; escaped backslash pairs do not continue a line. No payload expansion or script execution occurs.

Within `$()` substitutions, simple command-position grouping parentheses and word-boundary `#` comments are balanced without collecting command evidence from their contents. Quotes and escaped closers remain opaque; `#` inside a word, quote or parameter expansion is literal. Supported literal here-document boundaries are reused inside substitutions. Arithmetic syntax, case patterns, function declarations and other unproven boundaries conservatively keep the remainder opaque. Independently proven exterior segments retain their evidence; substitutions are never executed.

There is no arbitrary executable discovery, installed `bin` inspection or lookup in `node_modules`.

## Legacy ESLint hints

The CLI reads a bounded subset of `package.json#eslintConfig` or a root `.eslintrc.json`, using fixed, case-sensitive value matches:

| Field                      | Accepted values → declared package                                                                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extends`, string or array | `prettier` / `eslint-config-prettier` → `eslint-config-prettier`; `airbnb` / `eslint-config-airbnb` → `eslint-config-airbnb`; `plugin:react/recommended` → `eslint-plugin-react` |
| `plugins`, array           | `react` / `eslint-plugin-react` → `eslint-plugin-react`                                                                                                                          |

For example, with `eslint-config-prettier` declared:

```json
{ "eslintConfig": { "extends": "prettier" } }
```

No hints come from `overrides`, rules, unknown/scoped shorthands or arbitrary config names. A bare `eslint-plugin-react` in `extends` is not a supported plugin reference.

Precedence is based on root directory entry names, compared case-insensitively, without opening barrier entries:

1. Any `eslint.config.js`, `.mjs`, `.cjs`, `.ts`, `.mts` or `.cts`, or any `.eslintrc.js`, `.cjs`, `.yaml` or `.yml`, disables both legacy hint sources. Presence suffices even for a directory or symlink.
2. Otherwise `.eslintrc.json` displaces the manifest block. Only a regular, non-symlink file is read, using its actual on-disk casing; canonical lowercase wins if both spellings exist.
3. An extensionless `.eslintrc` also displaces the manifest block but is not read and does not disable the JSON reader. These sources are never merged as competing ESLint configurations.

The JSON file accepts a leading UTF-8 BOM, but no comments/JSON5. A present regular file that is unreadable or invalid JSON fails operationally. Valid JSON with an unusable top-level shape contributes no evidence. A skipped non-regular entry still displaces the manifest by name. No config module, parent configuration or `extends` file is loaded.

## Jest manifest hints

Only `package.json#jest` fields below contribute configuration evidence:

| Field              | Supported subset                                                                  |
| ------------------ | --------------------------------------------------------------------------------- |
| `preset`           | `ts-jest`, including literal package subpaths                                     |
| `testEnvironment`  | `jest-environment-jsdom`, including literal package subpaths                      |
| `transform` values | `ts-jest` or `["ts-jest", optionsObject]`, including literal transformer subpaths |

For example, with `ts-jest` declared:

```json
{ "jest": { "transform": { "^.+\\.tsx?$": ["ts-jest", {}] } } }
```

Transform keys and options contents are not package evidence. The `jsdom` shorthand, unknown transformers and local/rootDir/URL paths are unsupported. Tuples must have exactly two elements and an object as the second element.

A root `jest.config.js`, `.mjs`, `.cjs`, `.ts` or `.json` entry disables all manifest Jest hints, regardless of contents or filesystem entry type. Names match case-insensitively. `.mts`/`.cts` are not in this fixed barrier list. Script arguments do not activate that barrier. Ordinary imports in supported JS/TS config files remain source evidence, not broad framework-configuration support.

## Update notice and privacy

Core scanning is offline and never executes or modifies the analyzed project. Only a completed ordinary terminal full scan can trigger the optional update check, after its report is written. Both stdout and stderr must be TTYs; recognized CI environments, opt-out, help/version, argument errors and failed scans suppress cache access, requests and notices. Findings alone do not suppress it. JSON scans, both explanation formats and all `--diagnostics` scans skip the notifier before any cache read, write or transport request, including with both streams interactive.

The check requests public dist-tags for **DepVitals itself** from `https://registry.npmjs.org/-/package/depvitals/dist-tags`. It sends no project path, manifest, dependency list, source, authentication token or telemetry. Strict stable versions are compared; prerelease or malformed versions produce no notice. The lookup defaults to 400 ms and the whole optional check has a 1000 ms budget; cache/network failures are silent and cannot change the scan status.

A successful lookup is cached for about 24 hours in `depvitals/update-check.json` below an absolute `XDG_CACHE_HOME` on POSIX or `LOCALAPPDATA` on Windows, otherwise `~/.cache/depvitals/update-check.json`. The cache stores only the public latest version and check timestamp. Cache reads and writes are skipped when the effective cache directory resolves inside the selected project, including through an existing symlink. A fresh cache avoids a request; unsuccessful lookups are not cached.

Disable the check with exactly `DEPVITALS_NO_UPDATE_CHECK=1`:

POSIX shells:

```sh
DEPVITALS_NO_UPDATE_CHECK=1 npx depvitals
```

PowerShell, for the current session:

```powershell
$env:DEPVITALS_NO_UPDATE_CHECK = '1'
npx depvitals
```

These examples run the npm release; use `node dist/cli/index.js` from a local checkout to test unreleased behavior.

## CI consumer recipe

The [v2 GitHub Actions recipe](examples/ci/README.md) targets `depvitals@0.6.0` and
`ajv@6.15.0`. Its local-tarball instructions cover development-build verification.
Its default capture is ordinary JSON. The optional second `--diagnostics` capture argument adds
scope facts to the JSON artifact; `depvitals-diagnostics.txt` remains stderr and is empty for
completed scans. Keep `npm run --silent check:dependencies` for direct script enforcement.

The v2 verifier accepts clean diagnostic scans with notices (exit 0), enforces findings and
operational errors (exit 1), and rejects malformed, unsupported, missing or inconsistent artifact
sets (adapter exit 2). The copied workflow uploads available artifacts before enforcing the
recorded result. Hosted upload is separate from local verification of the script steps.

**Historical v1 compatibility.** The exact v0.4.1 verifier accepted the diagnostic scan reports
introduced in v0.5.0 because those reports used schema version 1. The v1 verifiers reject version 2.
For v1, pin `depvitals@0.5.0` with the [tagged v0.5.0 recipe](https://github.com/MatiasRicardi/depvitals/tree/v0.5.0/docs/examples/ci).

## Manual migration from Depcheck

Review the flags, policy and JSON consumers together. Depcheck documents `--json`, ignore
patterns and a result shape with fields such as `using`, `invalidFiles` and `invalidDirs`. [Depcheck usage and JSON example](https://github.com/depcheck/depcheck#usage).

| Area                | Current DepVitals build                                                                                                                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine output      | Use `--format json`. Read `findings`, `counts` and package `evidence` from the versioned schema.                                                                                                                                    |
| Exclusions          | Review each `.depcheckrc` or CLI ignore rule. Translate intentional exclusions to literal `ignorePaths` or exact `ignoreDependencies` in the selected root's strict `depvitals.config.json`. Expand and review glob rules manually. |
| Invalid input       | Check status and streams. A fatal retained-input failure emits a diagnostic with empty stdout. Handle that path before parsing JSON.                                                                                                |
| Scope and detection | Pick one root inventory per scan. Nested sources may be discovered under that root. Review differences from custom parsers, detectors and framework rules against the supported scope.                                              |

Run the full scan on each chosen root, review unexplained differences, then update automation to
validate the new schema and enforce scan status. Use `--explain` when inspecting one name.

## Errors and remaining limits

Use the [CLI exit table](#cli-and-json-reports) to distinguish completed scans, explanations and operational failures.

Unreadable mandatory inputs fail the scan. Unusable shapes in the bounded ESLint/Jest hint sources contribute no hints, subject to the strict external ESLint JSON errors above. The optional DepVitals configuration is stricter: invalid shapes or rules fail the scan. Non-literal imports, template-literal specifiers, `require.resolve()` and property calls such as `obj.require()` are not supported evidence.

Unsupported areas include alias and tsconfig resolution, blanket ambient `@types` inference, automatic remediation, vulnerability scanning and dependency upgrades. The CLI and versioned report are the supported interfaces.
