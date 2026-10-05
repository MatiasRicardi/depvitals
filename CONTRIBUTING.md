# Contributing to DepVitals

Thanks for helping. This document describes the local setup, the conventions the tooling enforces,
and the release discipline the project follows.

## Before you start

DepVitals deliberately stays small. Every release has an agreed scope, and **features must not be
implemented ahead of the roadmap**. If you want to work on something that is not scheduled yet, open
an issue first instead of opening a pull request.

Rules of thumb:

- Normal scanning must never mutate the analyzed project. DepVitals does not modify `package.json`,
  lockfiles or any other project file during a scan. Mutations may only happen through an explicit
  fix command, and only once the roadmap release that implements it actually exists.
- Never execute project code while scanning a repository. DepVitals analyzes projects statically; it
  does not run the files or the configurations of the project it scans.
- Prefer marking a result as `Needs Review` over guessing.
- Keep pull requests small: one feature, one bug fix, one refactor.

## Local setup

Requirements: Node.js `>=22.13.0` and pnpm (the exact version is pinned in the `packageManager`
field of `package.json`).

```bash
corepack enable      # makes the pinned pnpm available
pnpm install
pnpm run check       # format check + lint + typecheck + tests
```

## Commands

| Command                  | What it does                                                    |
| ------------------------ | --------------------------------------------------------------- |
| `pnpm run check`         | Everything CI runs: `format:check`, `lint`, `typecheck`, `test` |
| `pnpm run lint`          | ESLint (`--max-warnings 0`)                                     |
| `pnpm run lint:fix`      | ESLint with autofix                                             |
| `pnpm run format`        | Prettier write                                                  |
| `pnpm run format:check`  | Prettier check                                                  |
| `pnpm run typecheck`     | `tsc --noEmit` over sources, tests and config files             |
| `pnpm run test`          | Vitest single run                                               |
| `pnpm run test:watch`    | Vitest watch mode                                               |
| `pnpm run test:coverage` | Vitest with V8 coverage into `coverage/`                        |
| `pnpm run build`         | Emit JavaScript, source maps and declarations into `dist/`      |
| `pnpm run clean`         | Remove `dist/`                                                  |

## Code style

- **Prettier** owns formatting. Do not hand-format against it; run `pnpm run format`.
- **ESLint** runs type-aware rules (`strictTypeChecked` + `stylisticTypeChecked`) using
  `tsconfig.json`, with warnings treated as errors.
- TypeScript is configured aggressively: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`.
- ESM only: relative imports must include the `.js` extension (NodeNext resolution).
- Functions returning values need explicit return types (expressions and typed function
  expressions are exempt).
- Prefer `type` over `interface`, and `import type` for type-only imports.
- No abstractions that are not required by a scheduled release.

## Testing

- Tests live in `test/` and are named `*.test.ts` (Vitest).
- Import `describe` / `it` / `expect` explicitly from `vitest`; globals are not enabled.
- Fixture-based integration tests use `test/fixtures/<scenario>/`, where each fixture is a real
  repository (its own `package.json`) scanned by the engine. Fixture folders are excluded from the
  root TypeScript project by design: add them to the fixtures README, not to `src/`.
- Every bug fix requires a regression test, and every supported scenario requires a fixture. Only
  advertise scenarios that are tested.
- Coverage thresholds are raised per release; keep new code covered by tests even when the gate is
  loose.

## Planned source layout

The intended structure (introduced incrementally by the roadmap releases, not created upfront):

```text
src/
  cli/          # command parsing, CLI output
  core/         # scanning + analysis orchestration
  scanner/      # filesystem discovery, ignore rules
  analyzers/    # unused, missing, dependency-group analysis
  evidence/     # usage evidence and source locations
  reporters/    # human, JSON, GitHub annotations
  config/       # configuration loading and merging
  detectors/    # framework-specific detection
  package-manager/  # package.json / lockfile support
  utils/        # path, string and module-id normalization
test/
  unit/
  integration/
  fixtures/
```

## Git conventions

- Branch from `main`; keep branches short-lived.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat: ...`, `fix: ...`, `refactor: ...`, `test: ...`, `docs: ...`, `chore: ...`, `ci: ...`.
  Use `!` and `BREAKING CHANGE:` for breaking changes.
- Do not commit `dist/`, `coverage/`, `node_modules/` or anything under `instructions/` (already
  covered by `.gitignore`). `pnpm-lock.yaml` **must** be committed.
- The `instructions/` directory holds internal planning documents and is never published.

## Pull requests

Fill in the pull request template and make sure `pnpm run check` passes locally. CI runs lint,
typecheck, tests (Node.js matrix: lowest supported engine plus current majors, macOS and Windows)
and the build. All matrix results are aggregated into a single `CI` check, which is the one branch
protection on `main` requires.

## Toolchain notes

- `typescript` is pinned to the 5.9 line on purpose: `typescript-eslint` supports `>=4.8.4 <6.1`, so
  TypeScript 7 cannot be used until the linting stack supports it. Bump it together with
  `typescript-eslint`.
- `@types/node` tracks the lowest supported Node.js major (22), so code cannot accidentally rely on
  APIs that are newer than `engines.node`.
- pnpm 11 reads project settings from `pnpm-workspace.yaml` (its `package.json` `pnpm` field is no
  longer read) and blocks install scripts unless a dependency is listed under `allowBuilds`.
- ESLint ignores `test/fixtures/**` and `instructions/**`; Prettier ignores both plus
  `pnpm-lock.yaml`.

## Releases

Publishing is not wired up yet: the first publish happens with the `v0.1.0` roadmap release. Until
then, do not create version tags or bump `package.json` (`0.0.0` is a deliberate placeholder).

Before the first publish:

- confirm the `LICENSE` copyright holder;
- wire up publishing automation (GitHub Actions / npm trusted publishing) and only then enable npm
  provenance (`publishConfig.provenance`);
- update `README.md`, `CHANGELOG.md` and create the GitHub Release.

Versioning is conservative: removing a detection capability, adding false negatives, changing
evidence semantics or changing default ignore behavior are breaking changes.
