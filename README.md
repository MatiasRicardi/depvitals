# DepVitals

> A simple, lightweight dependency health checker for Node.js projects.

DepVitals reads a Node.js project and tells you which declared dependencies are no longer referenced
and which imported packages are not declared at all. It is inspired by
[depcheck](https://github.com/depcheck/depcheck) and stays deliberately small: analysis is static,
it runs offline, it never mutates the analyzed project and it never executes any code from it.

## Usage

```bash
npx depvitals
npx depvitals ./path/to/project
npx depvitals --help
npx depvitals --version
```

Run it in a project directory to scan that directory, or pass a path to scan another project.
DepVitals requires Node.js `>=22.13.0`.

**Release status:** dependency scanning is implemented in the repository and will be available on
npm starting with `v0.1.0`. The currently published `v0.0.1` release still contains the initial CLI
bootstrap.

Exit status:

```text
0 = successful clean scan, help, or version
1 = dependency findings or an operational/CLI error
```

Findings are printed to `stdout`; argument errors and operational errors are printed to `stderr`.

## What it detects

- **Unused dependencies** - `dependencies` that neither a supported source file nor a
  `package.json` script references.
- **Unused devDependencies** - the same check applied to `devDependencies`.
- **Missing dependencies** - external packages referenced by supported source imports but not
  declared in the project's `package.json`.

DepVitals never inspects `node_modules`, so "missing" means "not declared" and not "not installed":
an installed but undeclared package is still reported as missing, and installation state is never
validated. Conversely, a dependency is reported as unused only when no supported usage evidence was
found, so indirect or unsupported usage may still exist. `peerDependencies` and
`optionalDependencies` are read only to avoid false missing findings and are never reported as
unused.

```text
DepVitals

Unused dependencies (2)
  dotenv
  lodash

Unused devDependencies (1)
  eslint

Missing dependencies (1)
  zod
```

## Supported in v0.1.0

- JavaScript and TypeScript source files: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`,
  `.cts`, including `.d.ts`-style declaration files.
- Static ESM usage: `import`, side-effect imports, `import type` and `export ... from`.
- Literal dynamic imports such as `import("express")`.
- Literal CommonJS usage such as `require("express")`.
- Basic `package.json` script awareness: a declared dependency invoked by a script command counts as
  used, for example `eslint` in `"lint": "eslint ."`.
- Node.js builtin modules (with or without the `node:` prefix) are ignored and never reported as
  missing.
- Scoped packages and subpaths are normalized to the package root: `@scope/ui/button` counts as
  usage of `@scope/ui`, and `lodash/chunk` as usage of `lodash`.
- Generated and vendor trees are skipped: `node_modules`, `dist`, `build`, `coverage`, `out`,
  `.next`, `.nuxt`, `.cache`, `.turbo` and `.git`.
- Deterministic output: categories and package names are always sorted alphabetically.

Detection is a lightweight static lexical scan rather than a full JavaScript/TypeScript parser, so
comments, strings, template text and regular expressions that only look like imports are not counted
as usage.

## Current limitations

- A single `package.json` is analyzed: no workspaces or monorepos, and no parent-manifest lookup.
- No framework-specific configuration or plugin detection, and no TypeScript `paths` or bundler
  alias resolution.
- Only literal specifiers become usage evidence: non-literal dynamic `import()`, template-literal
  specifiers, `require.resolve()` and property calls such as `obj.require()` are not recognized.
- Script usage is matched by exact command name, so a binary that differs from its package name is
  not mapped (`tsc` does not mark `typescript` as used).
- Source discovery uses the fixed directory list above; `.gitignore` and custom ignore rules are not
  interpreted.
- Unreadable source files, and source that the lexical scanner cannot safely read to the end (an
  unterminated string, comment, template or regular expression), abort the scan instead of producing
  partial results.
- No automatic fixes, no configuration file and no per-dependency explanation of a finding.

## License

MIT
