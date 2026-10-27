# Contributing to DepVitals

Keep changes focused on dependency analysis and the active task. Discuss broader features before implementing them. Read repository instructions when present, then inspect the current code and tests; historical plans may describe behavior that has changed. Public documentation and code comments use English.

## Local setup

Use Node.js **22.13.0 or newer** and the exact pnpm version recorded in `package.json#packageManager`. With Corepack available:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check
pnpm run build
```

Use pnpm for development. Do not replace the toolchain or add dependencies as a side effect of another task. Dependency changes must be justified and include a consistent `pnpm-lock.yaml`.

To exercise development behavior without resolving the published npm release:

```sh
node dist/cli/index.js --help
node dist/cli/index.js --version
node dist/cli/index.js ./path/to/project
```

The [technical reference](docs/reference.md#update-notice-and-privacy) explains how to disable the optional CLI update check in POSIX and PowerShell environments.

## Validation

| Command                   | Purpose                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm run format:check`   | Check Prettier formatting.                                                                  |
| `pnpm run format`         | Format files; review the resulting diff.                                                    |
| `pnpm run lint`           | Type-aware ESLint with warnings treated as errors.                                          |
| `pnpm run typecheck`      | Check source, tests and tooling configuration.                                              |
| `pnpm run test`           | Run Vitest once; pass a test path for focused work.                                         |
| `pnpm run test:watch`     | Watch tests during development.                                                             |
| `pnpm run test:coverage`  | Run tests with V8 coverage.                                                                 |
| `pnpm run build`          | Emit the CLI and declarations into `dist/`.                                                 |
| `pnpm run clean`          | Remove generated `dist/`.                                                                   |
| `pnpm run verify:package` | Pack, inspect and install the local tarball in a temporary consumer, then exercise its CLI. |

`pnpm run check` runs format checking, lint, typechecking and tests. Build, coverage and package smoke are separate commands. Before a change is considered complete, run `check`, `build` and `git diff --check`; run package smoke when CLI, notifier or packaging is affected. Review the full diff and Git status afterward.

CI covers the exact minimum Node runtime, other supported Node versions and Linux/macOS/Windows. Package smoke runs separately. The aggregate branch-protection check is named `CI`; do not rename it or weaken the matrix to hide failures.

## Meaningful tests and invariants

Tests live under `test/`, use `*.test.ts`, and explicitly import Vitest helpers. Integration fixtures belong under `test/fixtures/`; document representative fixture additions there. Fixtures can deliberately contain unusual or invalid source and are excluded from root lint/typechecking.

Every detection change needs positive coverage and a nearby negative control. Verify observable findings, output channels and exit codes rather than implementation details. For scanners, include decoy text and malformed-input cases. Never relax an existing expectation or skip a regression to make a change pass.

Normal scanning must remain static, offline, deterministic and read-only: never execute analyzed source, scripts, lifecycle hooks or config modules. Source evidence can create missing findings; script/configuration evidence can only suppress unused. Tests should use temporary projects, assert non-mutation, and clean up on success and failure.

Notifier tests use injected clocks, cache paths and transports or local test servers, never the public registry or real user cache. An eligible CLI-self-update lookup is separate from core analysis; preserve its gating, time bounds and silent failures.

## Code and repository conventions

The implemented areas are `src/cli/` (including `notifier/`), `src/core/`, `src/scanner/`, `src/detectors/` and `src/reporters/`. Keep detection, analysis and formatting separate; do not create speculative future modules.

Follow strict TypeScript and type-aware ESLint rules. Prefer `type`, type-only imports and explicit return types. Relative ESM imports use `.js`. Prettier owns formatting; use single quotes, semicolons and LF on every platform. Do not weaken compiler, lint or coverage rules.

Branch from current `main`. Keep commits focused and use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:` or `ci:`). Do not commit generated `dist/`, coverage, `node_modules` or ignored internal planning files. Preserve unrelated local work. Do not commit secrets or perform publish actions without authorization.

## Release discipline

Use the [changelog](CHANGELOG.md) to distinguish historical releases from unreleased changes. Version bumps, publication and release notes are supervised release work, not incidental feature changes. Before publishing, confirm the license attribution, finalize public docs, validate the candidate tarball and review CI.

Publishing automation and npm provenance are not configured. Do not create tags, publish to npm, push, merge or create a GitHub Release without explicit maintainer authorization. Changes that remove detection coverage, add false negatives or change evidence semantics require compatibility review.
