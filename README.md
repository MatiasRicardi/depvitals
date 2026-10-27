# DepVitals

> A simple, lightweight dependency health checker for Node.js projects.

DepVitals scans a Node.js project to identify declared dependencies that appear unused and imported packages that are not declared in `package.json`.

Inspired by [depcheck](https://github.com/depcheck/depcheck), DepVitals stays deliberately small. It performs lightweight static analysis locally, without making network requests, modifying the analyzed project, or executing its code.

## Usage

```bash
npx depvitals
npx depvitals ./path/to/project
npx depvitals --help
npx depvitals --version
```

Run it from a project directory to scan the current directory, or provide a path to analyze another project.

**Requirements:** Node.js `>=22.13.0`.

**Version note:** Dependency scanning was introduced in v0.1.0, and v0.1.2 expanded the script executable allowlist. The earlier v0.0.1 release contains only the initial CLI bootstrap.

**Exit status:**

```text
0 = successful clean scan, help, or version
1 = dependency findings or an operational/CLI error
```

Scan results, including dependency findings, are printed to `stdout`. Argument errors and operational errors are printed to `stderr`.

## What it detects

- **Unused dependencies** — packages declared in `dependencies` for which no supported source file or `package.json` script provides usage evidence.
- **Unused devDependencies** — the same analysis applied to packages declared in `devDependencies`.
- **Missing dependencies** — external packages referenced by supported source imports but not declared in the project's `package.json`.

DepVitals does not inspect `node_modules`, so **"missing" means "not declared", not "not installed"**. An installed but undeclared package can still be reported as missing, and package installation state is never validated.

Similarly, a dependency is reported as unused only when no supported usage evidence is found. Indirect or unsupported usage may still exist.

`peerDependencies` and `optionalDependencies` are considered when checking whether imported packages are declared, but are never reported as unused.

**Example output:**

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

- **JavaScript and TypeScript:** `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`, including `.d.ts`-style declaration files.
- **Static ESM imports and exports:** regular imports, side-effect imports, `import type`, and `export ... from`.
- **Literal dynamic imports:** expressions such as `import("express")`.
- **Literal CommonJS requires:** expressions such as `require("express")`.
- **Basic `package.json` script awareness:** a declared dependency invoked by a supported script command counts as used, for example `eslint` in `"lint": "eslint ."`. Script usage can prevent unused findings but does not generate missing-dependency findings.
- **Known executable names:** since v0.1.2, a static allowlist of 60 known executable commands resolves to 46 declared packages, so a real CLI executable credits the package that declares it, for example `tsserver` → `typescript`, `ng` → `@angular/cli`, `vue-cli-service` → `@vue/cli-service`, `depcruise` → `dependency-cruiser`, `sls` → `serverless`, and `gulp` → `gulp-cli`. Each alias was verified against published `bin` metadata beforehand: nothing is auto-discovered from `bin` fields or from `node_modules`. 32 of them are collision-sensitive, meaning a same-named declared package wins and the mapped provider gets no evidence.
- **Node.js builtins:** built-in modules, with or without the `node:` prefix, are excluded from missing-dependency findings.
- **Scoped packages and subpaths:** package specifiers are normalized to their package root. For example, `@scope/ui/button` counts as `@scope/ui`, and `lodash/chunk` counts as `lodash`.
- **Ignored directories:** generated and vendor trees are skipped, including `node_modules`, `dist`, `build`, `coverage`, `out`, `.next`, `.nuxt`, `.cache`, `.turbo`, and `.git`.
- **Deterministic output:** findings are grouped into sections in a fixed order, with package names sorted alphabetically within each section.

Detection uses a lightweight static lexical scanner rather than a full JavaScript/TypeScript parser. Comments, ordinary strings, template text, and regular expressions that merely resemble imports are not counted as dependency usage.

Function callbacks in default parameters preserve the enclosing function's async/generator context. Function expressions used as object property values or conditional alternatives also preserve real `require()` calls after division operators; regex text after declarations or statement blocks remains inert.

Class members retain separate structural contexts, including consecutive newline-terminated fields and TypeScript function-typed fields before generator methods. Block-bodied arrow, function, and class-expression initializers preserve the boundary before a following method, while operators that continue the initializer remain part of that expression. Type annotations keep literal `import()` evidence without turning type arrows into runtime functions. Regex text in those methods remains inert, while real calls in initializers, computed keys, and method bodies still count.

## Current limitations

- **Single-project analysis:** only one `package.json` is analyzed. Workspaces, monorepos, and parent-manifest lookup are not supported.
- **No configuration-aware resolution:** framework-specific configurations, plugins, TypeScript `paths`, and bundler aliases are not resolved.
- **Static specifiers only:** non-literal dynamic `import()`, template-literal specifiers, `require.resolve()`, and property calls such as `obj.require()` are not recognized as usage evidence.
- **Limited script detection:** script usage relies on supported command patterns, and only the executables in the static allowlist above are translated to their declaring package, and only when the executable appears in a supported direct command position. Every other executable name keeps exact-name matching, mappings are never applied to runner arguments such as `npx tsc` or `pnpm exec tsc`, and ambiguous provider families such as `tailwindcss`, `playwright`, and `webpack` are deliberately unmapped, so only an exactly declared same-name package is credited.
- **Fixed directory exclusions:** source discovery uses the built-in ignored-directory list above. `.gitignore` and custom ignore rules are not interpreted.
- **Conservative error handling:** unreadable source files or source content the lexical scanner cannot safely finish scanning, such as unterminated strings, comments, templates, or regular expressions, abort the scan rather than producing partial results.
- **No remediation features yet:** automatic fixes, custom configuration files, and per-dependency explanations are not available.

## License

MIT
