# `typescript-limits/` fixtures (Step 61)

Synthetic TypeScript projects used by `test/unit/core/typescriptLimits.test.ts`. They record what the
shipped scanner actually does with ambient `@types/*` packages and `tsconfig.json` compiler options.
They do **not** declare new supported behavior.

The matching technical decision (what may be handled deterministically today and what is deferred, and
why) is recorded in `instructions/phase3/reference/typescript-decision.md`, which is an internal
planning document and is therefore not part of the published package or of Git.

| Fixture | Observed behavior |
| --- | --- |
| `types-node-no-import` | `@types/node` declared, Node globals used without an import: reported `unused`. |
| `types-jest-ambient-globals` | `@types/jest` declared, Jest globals used without an import: reported `unused`. |
| `tsconfig-types-explicit` | `tsconfig.json` is never read, so an explicit `compilerOptions.types` entry changes nothing. |
| `typeroots-extends` | `extends` plus a local `typeRoots` directory: nothing is read, and a `types` entry may name a local folder instead of a package. |
| `types-ambient-with-source-import` | Type-only `import type { Request } from 'express'` with only `@types/express` declared: `express` is `missing` and `@types/express` is `unused`. TypeScript erases `import type`, so the fixture proves the two findings stay separate, not that `express` is required at runtime. |
| `declaration-file-evidence` | Type-level imports inside a `.d.ts` file count as usage; `declare module '...'` and `/// <reference types="..." />` do not. |

Fixtures are read as text only. Nothing is installed, resolved, executed or written.
