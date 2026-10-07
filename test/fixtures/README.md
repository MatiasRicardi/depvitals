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
