# Test fixtures

Each fixture is a synthetic project (or a single project file) used by the tests. Fixtures are real
files on disk: DepVitals reads them statically and never installs or executes anything from them.

Fixtures are excluded from the root TypeScript project, from ESLint and from Prettier on purpose, so
they may contain intentionally invalid content. Do not "fix" a fixture to satisfy root tooling.

## `manifest/`

Input fixtures for `src/scanner/projectManifest.ts` (project manifest discovery).

### Successful loads

- `basic/` - name, all four dependency sections and scripts, deliberately unsorted so the loader has
  to produce deterministic key order.
- `minimal/` - only `version`, so every recognized section is absent and the `name` property must be
  omitted.

### Structural errors (`invalid-shape`)

- `invalid-root-array/` - JSON root is an array.
- `invalid-root-null/` - JSON root is `null`.
- `invalid-root-number/` - JSON root is a number.
- `invalid-root-string/` - JSON root is a string.
- `invalid-name-type/` - `name` is present but is not a string.
- `invalid-shape/` - `dependencies` is an array instead of a name/version map.
- `invalid-scripts-shape/` - `scripts` is an array instead of a name/command map.
- `non-string-dependency-value/` - a `devDependencies` value is a number instead of a string.

### Parse errors (`invalid-json`)

- `invalid-json/` - truncated JSON.

### Static analysis guarantee

- `scripts-not-executed/` - declares a `postinstall` that would create `marker.txt` if it were ever
  run. The test loads the manifest and asserts the script stays an inert string and no marker exists.

### Missing manifest

The `manifest/` directory itself intentionally has no `package.json`, while the repository root
several levels above it does. Tests point the loader at it to prove no parent manifest lookup happens.

## `source-discovery/`

Input fixtures for `src/scanner/sourceFiles.ts` (source file discovery).

### `basic/`

A minimal tree that exercises the discovery contract without adding many files:

- root source files (`index.js`, `app.tsx`, `entry.mjs`, `types.d.ts`);
- nested source files (`src/main.ts`, `src/util.jsx`, `src/nested/deep.{mts,cts}`);
- an unsupported-extension file at root (`README.md`, `styles.css`, `config.json`) that must be ignored;
- every built-in ignored directory populated with files that must never be returned (`node_modules`,
  `dist`, `build`, `coverage`, `out`, `.cache`, `.turbo`, `.next`, `.nuxt`);
- a hidden directory that is **not** on the ignore list (`.config/`) whose contents **must** be
  discovered.

## `analysis/`

Input fixtures for `src/core/analyzeProject.ts` (unused and missing dependency analysis). Each
scenario is a real project directory with a `package.json` and supported source files so the full
pipeline runs against real files on disk.

### `basic/`

The main pipeline fixture. `src/index.ts` and `src/util.ts` reference a mix of dependencies:

- declared dependencies that are referenced from source (`axios`, `lodash`, `left-pad`,
  `@scope/formatter`) - not unused;
- `moment` declared in `devDependencies` and never referenced - unused;
- `vitest` referenced from source and `eslint` referenced only by the `lint` script - not unused;
- `zod` imported from source but never declared - missing;
- `react` imported from source but declared only as a peer dependency - never missing;
- `node:fs` (builtin) and `./util` (relative) - never missing.

### `clean/`

A project where every declared dependency is referenced from source. All three result arrays are
empty.

### `no-source/`

A project with declared dependencies but no discoverable source files. Every declared dependency and
every package in `devDependencies` is reported as unused, and nothing is reported as missing.

### `duplicate-declaration/`

Two scenarios for a package declared in **both** `dependencies` and `devDependencies`:

- `unused/` - the package is never referenced, so it appears in both unused arrays;
- `used/` - the package is referenced from source, so it appears in neither unused array.

### `script-only-undeclared/`

`left-pad` is declared in `dependencies` but never referenced from source, while a script command
references an undeclared tool. The declared package is reported as unused, and the undeclared script
tool never creates a missing finding.

### `esm/`

ESM JavaScript exercising every import form the extractor supports in one project:

- static import (`axios`), side-effect import (`side-effect-pkg`), re-export (`reexport-pkg`),
  literal dynamic import (`dynamic-pkg`), Node builtin (`node:fs`) and a relative import (`./local`);
- `lodash` referenced through a subpath (`lodash/chunk`) - not unused;
- `unused-esm-dep` declared but never referenced - unused;
- `side-effect-pkg`, `reexport-pkg` and `dynamic-pkg` imported but never declared - missing;
- `vitest` referenced only by a script - not unused.

### `commonjs/`

CommonJS JavaScript with a strong false-positive audit. `src/index.js` contains real `require()`
calls alongside text that must **not** count as usage:

- `require('left-pad')` - used; `require('missing-cjs')` - missing; `unused-cjs-dep` - unused;
- a `require(...)` inside a comment, an ordinary string, a template literal and a regex literal;
- a non-literal `require(dynamicName)` and a property call `obj.require('...')`.

The golden result keeps `missingDependencies` limited to `['missing-cjs']`, so a lexical match on any
of the fake forms would fail the test.

### `typescript/`

TypeScript covering `import type`, a normal import, `export ... from` (including a scoped subpath
`@scope/ui/util`), a `.tsx` file, and one unused declared dependency, with no missing dependencies.

### `scripts-only-devtools/`

`eslint`, `prettier` and `vite` are declared in `devDependencies` and referenced only by the
`scripts` commands (`eslint .`, `prettier --write .`, `vite`, `vite build`), never imported from
source. None is reported as unused, and no missing finding is created from the script commands.

### `declarations/`

A `types/app.d.ts` file imports an external package (`some-types`) with `import type`. The
declaration file is discovered and the import counts as usage, so `some-types` is not reported as
unused.

### `ignored-directories/`

`src/index.ts` uses `real-used`, while source-like files with package-like imports are placed inside
the ignored/generated directories `node_modules`, `dist`, `coverage` and `build`. Those imports
(`should-be-ignored-dep`, `also-ignored-dep`, `build-ignored-dep`, `node-module-ignored-dep`) must
never be discovered, so the golden result stays clean. A discovery regression would surface those
names as missing dependencies and fail the test.

### `peer-optional/`

`react` is declared only in `peerDependencies` and `optional-pkg` only in `optionalDependencies`, and
both are imported from source along with the used `main-pkg` dependency. Neither peer nor optional
package is reported as missing nor as unused.

### `invalid-source/`

A source file with a lexical error (an unterminated string literal). The analyzer must reject with an
`AnalysisError` of code `invalid-source`, never return a partial result.

### `integration-gate/`

Step 62 composition fixtures, used together by `test/unit/core/detectionIntegrationGate.test.ts` and
`test/cliGate.test.ts` to prove binary evidence (Steps 23-55) and configuration evidence (Steps 56-61)
combine without changing any contract. Each subdirectory is one project:

- `composed-all-sources/` - a source import, a `tsc` and `docsify` script, `package.json#eslintConfig`
  and `package.json#jest` in one project, with every credited package credited exactly once;
- `composed-negatives/` - the same names as inert text: script arguments, `echo`/`node -e`/`printf`
  commands, import-like string literals and unsupported ESLint/Jest config shapes; nothing is credited
  and no missing finding is created;
- `composed-rc-and-jest/` - the external `.eslintrc.json` channel composed with `package.json#jest`,
  where `jest --config jest.config.js` is an argument and must not disable the manifest hints;
- `composed-aliases-and-collisions/` - activated executable aliases (including two aliases of one
  `@graphql-codegen/cli` package), the `gulp`/`gulp-cli` collision, ambiguous providers reachable only
  through the pre-existing exact-name rule, and misleading `echo ng` / `node -e "ng babel"` commands;
- `project-boundary/` - a workspace parent with `workspaces`, three lockfiles and a child package whose
  own manifest is never consulted from the parent scan.

### Missing / unreadable sources (no fixture)

The unreadable-source case is exercised at runtime with a narrowly targeted mock of
`node:fs/promises.readFile` (an `EACCES` failure for a single selected file) rather than a fixture,
so the behavior is deterministic across platforms.
