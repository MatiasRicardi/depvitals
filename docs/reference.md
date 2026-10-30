# DepVitals technical reference

This reference describes the implementation on `main`, which can include unreleased behavior. See the [README](../README.md) for commands and the [changelog](../CHANGELOG.md) for published release boundaries. DepVitals is a CLI for one project root, not a full JavaScript/TypeScript compiler, module resolver or replacement for reviewing dependency changes.

## Findings and evidence

| Evidence                                  | Suppresses unused for declared packages | Creates missing findings |
| ----------------------------------------- | --------------------------------------- | ------------------------ |
| Supported source imports/exports/requires | Yes                                     | Yes                      |
| Recognized `package.json` script command  | Yes                                     | No                       |
| Supported static configuration hint       | Yes                                     | No                       |
| Arbitrary text or unsupported pattern     | No                                      | No                       |

Unused findings apply separately to `dependencies` and `devDependencies`. Missing means a source-referenced external package is undeclared in all four groups, including `peerDependencies` and `optionalDependencies`. Those last two groups are never reported unused. Installation state is not checked; an installed but undeclared package can still be missing.

A clean report means no issues were found through supported evidence. It does not establish that every dependency is needed, that removing an unused package is safe, or that the project will build. Findings are deduplicated and sorted alphabetically within the fixed category order: unused dependencies, unused devDependencies, missing dependencies.

## Source scanning and discovery

Supported extensions are `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts` and `.cts`, including declaration files such as `.d.ts`. Literal static imports, side-effect imports, `import type`, `export ... from`, dynamic `import('package')` and CommonJS `require('package')` supply evidence. Code inside template/JSX expressions is scanned; comments, ordinary strings, template text, JSX text and regex text stay inert.

Literal `require` and dynamic `import` calls accept an optional trailing comma. Dynamic imports also accept a literal specifier followed by balanced object-literal options, for example `import('package', { with: { type: 'json' } })`, including legacy `assert` objects, quoted keys, nested objects, trivia and an optional comma after the options. Option values are not evaluated or used as package hints, and recognizing the specifier does not validate runtime attributes or module exports. Non-object options (variables, calls or arrays), wrapped/continued object expressions and additional arguments remain unsupported for the outer import. Independently supported imports/requires inside their expressions are still scanned. `require` remains limited to one literal argument.

The custom static scanner has tested structural handling for functions, arrows, classes and TypeScript annotations/assertions. It preserves real imports/requires across those boundaries; this is not a guarantee for every language construct. Incomplete strings, comments, templates, regexes or JSX constructs that cannot be safely scanned cause an operational error rather than a partial report.

For explicit ordinary/async/generator function signatures, a parameter binding named `require` suppresses module evidence from calls owned by that function's parameter initializers and body, including inherited nested scopes. Defaults, rest and destructuring bound names are supported; a property key (`{ require: load }`) or annotation type named `require` is not a binding. Global calls outside the owner and real imports/reexports remain evidence. This bounded parameter rule does not resolve local variable declarations, imported aliases, reassignment, eval/with or new bindings introduced by arrow/method parameters; those parameter families are a separate delivery step.

Package subpaths collapse to their roots: `lodash/chunk` becomes `lodash`, and `@scope/ui/button` becomes `@scope/ui`. Node builtins with or without `node:` and relative/absolute file paths do not create missing findings. URI schemes and unsupported `#` aliases are not resolved into packages.

Discovery skips symlinked entries and rejects a symlinked project root. It prunes these directories wherever encountered: `.git`, `node_modules`, `dist`, `build`, `coverage`, `out`, `.cache`, `.turbo`, `.next`, `.nuxt`. It does not interpret `.gitignore` or custom ignore rules. Nested source directories are traversed, but child manifests and lockfiles do not become separate dependency inventories; nested package scopes only inform source module mode. There is no workspace aggregation.

For source-mode purposes, `.mjs`/`.mts` are modules and `.cjs`/`.cts` are scripts. An explicit nearest `type: "module"` or `type: "commonjs"` controls `.js`; a child manifest without `type` starts its own ambiguous scope. For ambiguous `.js`, bounded static detection recognizes static imports/exports, `import.meta` and supported unambiguous top-level `await` operands, including awaited regexes. Dynamic import alone is not a module signal. This follows the selected subset of [Node syntax detection](https://nodejs.org/download/release/v22.23.3/docs/api/packages.html#syntax-detection), enabled by default since Node 22.7.0. JSX/TypeScript extensions retain the existing explicit package-type policy. Detection is not a universal Node resolver: it does not model runtime flags or lexical redeclarations of CommonJS wrapper names. Calls, indexing, tags and unary `+`/`-` using an identifier named `await` remain script-compatible absent a separate module signal. Source is read once; ambiguous `.js` gets a lexical probe and a definitive extraction, without execution or catch-and-retry on lexical failures.

## Script commands

Only `package.json#scripts` is examined; nothing is executed. The first effective command of a supported segment can credit an exact package name or a known executable mapping. Leading POSIX assignments are skipped; supported separators are `&&`, `||`, `;`, `|` and newline outside quotes. POSIX comments are ignored.

For example, with `typescript` declared:

```json
{ "scripts": { "build": "tsc -p tsconfig.json" } }
```

This suppresses unused `typescript`. The [production catalog](../src/scanner/scriptUsage.ts) owns the explicit executable mappings. Collision-sensitive mappings give a declared exact-name package precedence: `gulp` wins over `gulp-cli` when both are declared. Other mappings, such as `tsc` to `typescript`, use the mapped provider. A command never credits two competing providers.

The immediate package positions in `npx PKG`, `npm exec PKG`, `pnpm exec PKG`, `pnpm dlx PKG` and `yarn dlx PKG` also support exact package-name matching. Executable mappings do not apply to those arguments: `npx tsc` does not imply `typescript`. Flags, versions/tags and additional wrapper syntax are not guessed.

Arguments, paths, `node -e` text and nested shell commands do not imply usage of the packages they mention. Ambiguous aliases such as `tailwindcss`, `playwright` and `webpack` remain unmapped. Redirection, background execution, shell expansion/substitution, unsupported escapes and unfinished quotes invalidate their segment; independent supported segments can still contribute evidence. There is no arbitrary executable discovery, installed `bin` inspection or lookup in `node_modules`.

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

Core scanning is offline and never executes or modifies the analyzed project. Only a completed normal CLI scan can trigger the optional update check, after its report is written. Both stdout and stderr must be TTYs; recognized CI environments, opt-out, help/version, argument errors and failed scans suppress cache access, requests and notices. Findings alone do not suppress it.

The check requests public dist-tags for **DepVitals itself** from `https://registry.npmjs.org/-/package/depvitals/dist-tags`. It sends no project path, manifest, dependency list, source, authentication token or telemetry. Strict stable versions are compared; prerelease or malformed versions produce no notice. The lookup defaults to 400 ms and the whole optional check has a 1000 ms budget; cache/network failures are silent and cannot change the scan status.

A successful lookup is cached for about 24 hours in `depvitals/update-check.json` below an absolute `XDG_CACHE_HOME` on POSIX or `LOCALAPPDATA` on Windows, otherwise `~/.cache/depvitals/update-check.json`. This user cache is separate from the analyzed project and stores only the public latest version and check timestamp. A fresh cache avoids a request; unsuccessful lookups are not cached.

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

## Errors and remaining limits

Completed reports use stdout; operational diagnostics use stderr with no misleading partial clean report. Exit codes are 0 for clean/help/version and 1 for findings/errors. An optional notice uses stderr after the report without altering its exit status.

Unreadable mandatory inputs fail the scan. Unsupported config shapes instead contribute no hints, except the strict external ESLint JSON errors above. Non-literal imports, template-literal specifiers, `require.resolve()` and property calls such as `obj.require()` are not supported evidence.

There is no alias/tsconfig resolver, blanket ambient `@types` inference, JSON CLI output, why/confidence or Needs Review category, public analyzer API, automatic remediation, vulnerability scan or dependency upgrade service. Exported internal modules are not a supported public API.
