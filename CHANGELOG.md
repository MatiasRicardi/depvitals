# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-11-09

### Added

- Versioned JSON scan reports and exact-package explanations in terminal or JSON. Explanations show
  declaration groups, effective exclusions and source, script or configuration evidence.
- A packaged Draft 7 schema, normative JSON examples and a tested fixed-version CI recipe that
  preserves report, diagnostics and exit status.

### Fixed

- Supported explicit Node preloads in root scripts now count as usage evidence for declared packages.
  Dynamic options or selectors discard preload evidence for their segment. An entry path with a
  fixed `./`, `../` or `/` prefix keeps earlier preload evidence even if its suffix expands.
  The four-project comparison found two visible changes from v0.3.0. `tsx` and `@babel/register`
  ceased to be reported as unused devDependencies in their respective pinned roots.
- The CI report adapter rejects incomplete package records, and scans retain large ESLint and Jest
  evidence batches without exceeding Node's argument limit.

### Changed

- JSON scans and all explanations bypass the optional notifier. Ordinary terminal scans retain
  their existing eligibility and project-wide exit status.
- Documented the manual Depcheck migration, supported scope and remaining limits. See the
  [candidate notes](docs/releases/v0.4.0.md) and [external corpus comparison](docs/compatibility/v0.4.0.md).

## [0.3.0]

### Added

- Optional strict `depvitals.config.json` with literal source-path exclusions and exact dependency
  finding exclusions. Configuration is read only from the selected project root; invalid files or
  rules fail without a partial report. Exclusions narrow the meaning of a clean result.

### Fixed

- Import/export property names no longer manufacture package references. Function/class expression
  boundaries, template interpolations and implicit ESM detection preserve genuine calls while
  keeping regex text inert, including await-identifier division and awaited-regex comparisons.
- Literal require/import calls accept a trailing comma; dynamic imports recognize bounded
  object-literal options without treating their strings as usage hints.
- A parameter named `require` suppresses calls owned by supported function, arrow and method
  signatures, without hiding calls outside that scope or treating type names/property keys as bindings.
- Here-document and unsupported shell-region payloads no longer leak package-command evidence;
  only proven exterior commands remain eligible.
- Root and required nested manifests reject symlinks and non-regular entries before content reads.
  Supported exact self-exports use nearest package ownership without loading export targets.

### Changed

- Documented global installation alongside `npx`, optional configuration and the remaining static
  analysis limits. Existing CLI commands, finding categories and exit codes are unchanged.

## [0.2.0] - 2026-10-28

### Added

- Bounded static usage hints for legacy ESLint configuration in `package.json` and strict
  `.eslintrc.json`, and for supported Jest manifest presets, environments and transformers. These
  hints only prevent unused findings for declared packages and respect root configuration precedence.
- An optional, cached CLI-self-update notice after eligible interactive scans. Core analysis remains
  offline; CI, non-TTY, help/version and failed scans skip the check. Set
  `DEPVITALS_NO_UPDATE_CHECK=1` to disable it.

### Fixed

- More precise JavaScript/TypeScript source detection across function, arrow, class, assertion and
  JSX/TSX boundaries, preserving real dependency usage while keeping regex, comment and other inert
  text out of findings. Unfinished lexical constructs still fail operationally.
- More conservative script-command and shell-comment handling, avoiding evidence from command
  arguments, quoted payloads and unsupported shell syntax.

### Changed

- Reorganized the README into a compact product guide with a focused technical reference, current
  contributor guidance and more specific package discovery metadata.

## [0.1.2] - 2026-10-20

### Added

- Script executable mapping expanded from the two v0.1.1 aliases to a static allowlist of 60 known
  executable names resolving to 46 declared packages, so a declared dependency invoked through its real
  CLI executable in a supported direct `package.json` script command is no longer reported as unused.
  Examples: `tsserver` → `typescript`, `ng` → `@angular/cli`, `ngc` → `@angular/compiler-cli`,
  `nest` → `@nestjs/cli`, `babel-node` → `@babel/node`, `vue-cli-service` → `@vue/cli-service`,
  `electron-forge` → `@electron-forge/cli`, `eas` → `eas-cli`, `tauri` → `@tauri-apps/cli`,
  `depcruise` → `dependency-cruiser`, `ts-node-esm` → `ts-node`, `sls` → `serverless`,
  `cdk` → `aws-cdk`, `dotenvx` → `@dotenvx/dotenvx`, `cz` → `commitizen`, `manypkg` → `@manypkg/cli`,
  `markdownlint` → `markdownlint-cli`, `lessc` → `less`, `gulp` → `gulp-cli`, `sequelize` →
  `sequelize-cli`.
- 32 of the mapped executables are collision-sensitive: when a package with exactly the same name as the
  executable is also declared, that same-name package keeps precedence and the mapped provider receives
  no evidence, so a single command never marks two competing providers as used.
- Every alias was verified against published `bin` metadata before being added. The catalog remains a
  fixed allowlist: no `bin` field is auto-discovered, `node_modules` is never inspected, ambiguous
  provider families (`tailwindcss`, `playwright`, `webpack`) stay unmapped, and script evidence still
  only suppresses `unused` findings and never creates a `missing` finding.

### Tests

- Added an integrated mapping matrix derived from the production catalog, so all 60 aliases are asserted
  in both directions at the analyzer boundary, plus fixture lockstep checks, composition fixtures, and
  tricky-text negatives that must never be credited. The existing `unused`/`missing` categories and the
  CLI `0`/`1` exit-status contract are preserved.

## [0.1.1] - 2026-10-19

### Fixed

- Declared `typescript` is no longer reported as unused when a supported direct `package.json`
  script command invokes `tsc`. Script evidence counts only for the matching declared package and
  never creates a missing finding.
- Declared `docsify-cli` is no longer reported as unused when a supported direct `package.json`
  script command invokes `docsify`. Script evidence counts only for the matching declared package
  and never creates a missing finding.

### Tests

- Added regression coverage for script-command boundaries, shell and runner composition, and
  mapping collisions. Existing `unused`/`missing` categories and the CLI `0`/`1` exit-status
  contract are preserved.

## [0.1.0] - 2026-10-16

### Added

- Project manifest discovery: the root `package.json` is read as static data, including
  `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies` and `scripts`.
- JavaScript/TypeScript source discovery (`js`, `jsx`, `ts`, `tsx`, `mjs`, `cjs`, `mts`, `cts`,
  including declaration files) with generated and vendor trees skipped (`node_modules`, `dist`,
  `build`, `coverage`, `out`, `.next`, `.nuxt`, `.cache`, `.turbo`, `.git`).
- Static module-specifier extraction: ES `import`, side-effect imports, `import type`,
  `export ... from`, literal dynamic `import("...")` and literal `require("...")` calls, while
  comments, strings, template text and regular expressions are never treated as usage.
- External package classification with package-root normalization: Node.js builtins are ignored,
  relative and absolute specifiers are treated as internal, and scoped packages and subpaths are
  reduced to their package root.
- Basic `package.json` script-use detection, so dependencies invoked by script commands count as
  used.
- Unused dependency analysis for `dependencies` and `devDependencies`, and missing dependency
  analysis for external packages referenced by source but declared in no dependency section.
- Deterministic terminal report: each non-empty findings category is printed with its count and
  alphabetically sorted package names, and a clean scan prints a single clear message.
- Real CLI scanning of the current directory or of an explicit project path argument.
- Operational error handling for missing or invalid manifests and for unreadable or unanalyzable
  source files, with exit code `1` for both findings and errors, reports on `stdout` and errors on
  `stderr`.

### Changed

- Running `depvitals` without arguments now scans the current directory instead of printing the
  early-development bootstrap message.

## [0.0.1] - 2026-10-06

### Added

- Project scaffolding: pnpm package layout, TypeScript build, ESLint, Prettier, Vitest, CI, and
  contribution documentation.
- Initial DepVitals CLI bootstrap (`src/cli`).
- `--help`/`-h` and `--version`/`-v` CLI flags.
- npm executable packaging (`bin` for `depvitals`).
- Package consumer smoke verification (`verify:package`).
- Cross-platform CI foundation.

[Unreleased]: https://github.com/MatiasRicardi/depvitals/compare/v0.4.0...main
[0.4.0]: https://github.com/MatiasRicardi/depvitals/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/MatiasRicardi/depvitals/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/MatiasRicardi/depvitals/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/MatiasRicardi/depvitals/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/MatiasRicardi/depvitals/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/MatiasRicardi/depvitals/releases/tag/v0.1.0
[0.0.1]: https://github.com/MatiasRicardi/depvitals/releases/tag/v0.0.1
