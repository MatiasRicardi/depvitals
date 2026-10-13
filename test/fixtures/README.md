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
dependency-dev is reported as unused, and nothing is reported as missing.

### `duplicate-declaration/`

Two scenarios for a package declared in **both** `dependencies` and `devDependencies`:

- `unused/` - the package is never referenced, so it appears in both unused arrays;
- `used/` - the package is referenced from source, so it appears in neither unused array.

### `script-only-undeclared/`

`left-pad` is declared in `dependencies` but never referenced from source, while a script command
references an undeclared tool. The declared package is reported as unused, and the undeclared script
tool never creates a missing finding.

### `invalid-source/`

A source file with a lexical error (an unterminated string literal). The analyzer must reject with an
`AnalysisError` of code `invalid-source`, never return a partial result.

### Missing / unreadable sources (no fixture)

The unreadable-source case is exercised at runtime with a narrowly targeted mock of
`node:fs/promises.readFile` (an `EACCES` failure for a single selected file) rather than a fixture,
so the behavior is deterministic across platforms.
