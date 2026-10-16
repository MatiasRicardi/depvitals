# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/MatiasRicardi/depvitals/commits/main
[0.0.1]: https://github.com/MatiasRicardi/depvitals/releases/tag/v0.0.1
