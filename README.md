# DepVitals

> A dependency health checker for Node.js projects.

DepVitals is a focused, explainable dependency health checker. It answers a small number of
questions extremely well:

- Is this dependency actually being used?
- Is a dependency being used without being declared?
- Is a dependency declared in the correct dependency group?

**Status: pre-alpha.** The package is not published on npm yet and no functionality is implemented.
The current repository contains only the engineering foundation (tooling, CI, contribution docs).
User-facing documentation, install instructions and the CLI experience land with the `v0.1.x`
releases.

## Planned experience

```bash
npx depvitals
```

```text
✓ 47 dependencies checked

Unused
  moment

Missing
  zod
```

Zero configuration, conservative detection, explainable results, offline by default.

## Requirements

- Node.js `>=22.13.0` (current and active LTS lines)
- pnpm (see the `packageManager` field; enable it with `corepack enable`)

## Development

```bash
pnpm install       # install dependencies
pnpm run check     # format check + lint + typecheck + tests
pnpm run build     # type declarations and JS output into dist/
pnpm run test:watch
```

Run `pnpm run check` before pushing: CI enforces the same steps.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for conventions and the planned source layout.

## Repository layout

```text
src/          # package sources (TypeScript, ESM)
test/         # Vitest unit tests; fixture-based tests land with v0.1
.github/      # CI workflow, issue templates, pull request template
```

## License

[MIT](./LICENSE)
