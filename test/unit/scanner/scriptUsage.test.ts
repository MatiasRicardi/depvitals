import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { findPackageScriptUsage } from '../../../src/scanner/scriptUsage.js';

describe('findPackageScriptUsage', () => {
  describe('direct command tokens', () => {
    it('counts a declared package used as the first command token', () => {
      expect(findPackageScriptUsage({ lint: 'eslint .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('counts a declared package used as a build command', () => {
      expect(findPackageScriptUsage({ build: 'vite build' }, new Set(['vite']))).toEqual(
        new Set(['vite']),
      );
    });

    it('counts a script that is only the declared package name', () => {
      expect(findPackageScriptUsage({ lint: 'eslint' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('counts an exact scoped package name used as the first command token', () => {
      expect(findPackageScriptUsage({ build: '@scope/pkg' }, new Set(['@scope/pkg']))).toEqual(
        new Set(['@scope/pkg']),
      );
    });

    it('does not count a package subpath used as a command token', () => {
      expect(findPackageScriptUsage({ lint: 'eslint/bin/cli .' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage({ lint: '@scope/pkg/bin/cli' }, new Set(['@scope/pkg'])),
      ).toEqual(new Set());
    });

    it('does not count a package referenced only through an argument', () => {
      expect(findPackageScriptUsage({ note: 'echo eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not count a package referenced after `which`/`command -v`', () => {
      expect(findPackageScriptUsage({ check: 'which eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ check: 'command -v eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not extract a basename from a command argument', () => {
      expect(findPackageScriptUsage({ run: 'some-command eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not count a package referenced as an option value', () => {
      expect(
        findPackageScriptUsage({ check: 'depcheck --ignores=eslint' }, new Set(['eslint'])),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ check: '--config eslint.json' }, new Set(['eslint'])),
      ).toEqual(new Set());
    });

    it('does not count `tsc` from `node script.js --tool=tsc`', () => {
      // `node` is the command token; `--tool=tsc` is an incidental argument value. Even though
      // `node` is a real command here, `typescript` must never be inferred from the argument.
      expect(
        findPackageScriptUsage(
          { build: 'node script.js --tool=tsc' },
          new Set(['node', 'typescript']),
        ),
      ).toEqual(new Set(['node']));
    });

    it('does not extract a basename from a node_modules path', () => {
      expect(
        findPackageScriptUsage({ lint: './node_modules/.bin/eslint .' }, new Set(['eslint'])),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ lint: 'node_modules/.bin/eslint .' }, new Set(['eslint'])),
      ).toEqual(new Set());
      expect(findPackageScriptUsage({ lint: '../bin/eslint .' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not extract a basename from a script path', () => {
      expect(findPackageScriptUsage({ build: 'scripts/build.js' }, new Set(['build.js']))).toEqual(
        new Set(),
      );
    });
  });

  describe('multiple segments', () => {
    it('treats `&&` as a segment separator and unions both packages', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint && prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });

    it('treats `||` as a segment separator', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint || prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });

    it('treats `;` as a segment separator', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint; prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });

    it('treats `|` as a segment separator', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint | prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });

    it('treats a newline as a segment separator', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint\nprettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });

    it('treats CRLF line endings as a segment separator', () => {
      expect(
        findPackageScriptUsage({ check: 'eslint\r\nprettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set(['eslint', 'prettier']));
    });
  });

  describe('shell composition of mapped executables (Step 25)', () => {
    it('gives evidence to both declared tools across a `&&` separator', () => {
      // `tsc` maps to `typescript`; `eslint` matches by exact name. Both are command tokens in
      // separate segments, so both declared packages receive usage evidence.
      expect(
        findPackageScriptUsage({ check: 'tsc && eslint .' }, new Set(['typescript', 'eslint'])),
      ).toEqual(new Set(['eslint', 'typescript']));
    });

    it('gives evidence to a mapped tool and an exact-name tool across `&&`', () => {
      expect(
        findPackageScriptUsage(
          { check: 'docsify serve docs && eslint .' },
          new Set(['docsify-cli', 'eslint']),
        ),
      ).toEqual(new Set(['docsify-cli', 'eslint']));
    });

    it('does not treat `echo docsify` as usage even when followed by a real command', () => {
      // Only the second segment (`eslint`) is a real command token; `docsify` is the argument of
      // `echo`, so only eslint receives evidence.
      expect(
        findPackageScriptUsage(
          { check: 'echo docsify && eslint .' },
          new Set(['docsify-cli', 'eslint']),
        ),
      ).toEqual(new Set(['eslint']));
    });
  });

  describe('quoting', () => {
    it('counts a single-quoted command token', () => {
      expect(
        findPackageScriptUsage({ lint: "'prettier' --check ." }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('counts a double-quoted command token', () => {
      expect(findPackageScriptUsage({ lint: '"eslint" .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('does not read separators or text inside quotes as evidence', () => {
      expect(
        findPackageScriptUsage(
          { note: 'echo "eslint && prettier"' },
          new Set(['eslint', 'prettier']),
        ),
      ).toEqual(new Set());
    });

    it('keeps an environment assignment whose value contains a separator', () => {
      expect(findPackageScriptUsage({ lint: 'FOO="a;b" eslint .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });
  });

  describe('environment assignments', () => {
    it('counts a declared package after a single assignment', () => {
      expect(
        findPackageScriptUsage({ build: 'NODE_ENV=test vite build' }, new Set(['vite'])),
      ).toEqual(new Set(['vite']));
    });

    it('counts a declared package after multiple leading assignments', () => {
      expect(
        findPackageScriptUsage({ build: 'FOO=1 BAR=2 vite build' }, new Set(['vite'])),
      ).toEqual(new Set(['vite']));
    });

    it('does not count `docsify` from an environment variable value', () => {
      // `docsify` is the value of `VAR`, not a command token, so `docsify-cli` must never be
      // inferred here even when it is declared.
      expect(
        findPackageScriptUsage({ run: 'env VAR=docsify other-command' }, new Set(['docsify-cli'])),
      ).toEqual(new Set());
    });
  });

  describe('supported runner forms', () => {
    it('recognizes `npx PACKAGE`', () => {
      expect(findPackageScriptUsage({ lint: 'npx eslint .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('recognizes `npm exec PACKAGE`', () => {
      expect(findPackageScriptUsage({ lint: 'npm exec eslint' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('recognizes `pnpm exec PACKAGE`', () => {
      expect(findPackageScriptUsage({ lint: 'pnpm exec eslint' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('recognizes `pnpm dlx PACKAGE`', () => {
      expect(findPackageScriptUsage({ build: 'pnpm dlx create-x' }, new Set(['create-x']))).toEqual(
        new Set(['create-x']),
      );
    });

    it('recognizes `yarn dlx PACKAGE`', () => {
      expect(findPackageScriptUsage({ build: 'yarn dlx create-x' }, new Set(['create-x']))).toEqual(
        new Set(['create-x']),
      );
    });

    it('recognizes a runner package after a leading environment assignment', () => {
      expect(
        findPackageScriptUsage({ lint: 'FOO=1 npm exec eslint' }, new Set(['eslint'])),
      ).toEqual(new Set(['eslint']));
    });
  });

  describe('unsupported runner complexity (documented false negatives)', () => {
    it('does not count a runner followed by a flag', () => {
      expect(
        findPackageScriptUsage({ lint: 'npx --no-install eslint' }, new Set(['eslint'])),
      ).toEqual(new Set());
      expect(findPackageScriptUsage({ lint: 'npx -p foo eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not strip a version or dist-tag suffix from a runner package', () => {
      expect(findPackageScriptUsage({ lint: 'npx eslint@8' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage({ lint: 'pnpm dlx eslint@latest' }, new Set(['eslint'])),
      ).toEqual(new Set());
    });

    it('does not treat `npm run`/`pnpm test` as usage of the package manager', () => {
      expect(findPackageScriptUsage({ build: 'npm run build' }, new Set(['npm']))).toEqual(
        new Set(),
      );
    });
  });

  describe('Step 25: runner recognition vs binary mapping', () => {
    // Runner recognition (which package position a supported runner exposes) is independent from the
    // direct executable `BINARY_TO_PACKAGE` mapping. A supported runner still yields its exact-name
    // package, but the explicit `tsc`/`docsify` translation must NOT be applied to a runner package
    // argument. Unsupported runner syntax never invents usage evidence.
    const runnerCases: [string, ReadonlySet<string>, ReadonlySet<string>][] = [
      // [script, declared, expected]
      ['npx tsc', new Set(['typescript']), new Set()],
      ['npx docsify', new Set(['docsify-cli']), new Set()],
      ['pnpm exec tsc', new Set(['typescript']), new Set()],
      ['npm exec docsify', new Set(['docsify-cli']), new Set()],
      ['npx eslint', new Set(['eslint']), new Set(['eslint'])],
      ['pnpm dlx docsify-cli', new Set(['docsify-cli']), new Set(['docsify-cli'])],
    ];

    it.each(runnerCases)(
      'runner form %p recognizes the exact-name package but never applies the binary mapping',
      (script, declared, expected) => {
        expect(findPackageScriptUsage({ run: script }, declared)).toEqual(expected);
      },
    );
  });

  describe('no binary-to-package guessing for unverified binaries', () => {
    it('maps a direct tsc executable to the declared typescript package', () => {
      // Step 23: the explicit `tsc` -> `typescript` mapping resolves the direct executable to its
      // declared package. Undeclared typescript still yields no evidence.
      expect(findPackageScriptUsage({ build: 'tsc' }, new Set(['typescript']))).toEqual(
        new Set(['typescript']),
      );
      expect(findPackageScriptUsage({ build: 'tsc' }, new Set(['lodash']))).toEqual(new Set());
    });

    it('maps a direct docsify executable to the declared docsify-cli package', () => {
      // Step 24: the explicit `docsify` -> `docsify-cli` mapping resolves the direct executable to
      // its declared package. Undeclared docsify-cli still yields no evidence.
      expect(
        findPackageScriptUsage({ docs: 'docsify serve docs' }, new Set(['docsify-cli'])),
      ).toEqual(new Set(['docsify-cli']));
      expect(findPackageScriptUsage({ docs: 'docsify serve docs' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('gives script evidence only to the mapped docsify-cli, not a bare docsify', () => {
      // When both are declared, the `docsify` executable maps to `docsify-cli`; the bare `docsify`
      // package receives no script evidence and stays unused without independent source/import use.
      expect(
        findPackageScriptUsage({ docs: 'docsify serve docs' }, new Set(['docsify', 'docsify-cli'])),
      ).toEqual(new Set(['docsify-cli']));
    });

    it('does not mark a bare docsify package as used by the docsify-cli mapping', () => {
      // A project declaring only `docsify` must not be treated as used just because the executable
      // `docsify` maps to the unrelated declared package `docsify-cli`.
      expect(findPackageScriptUsage({ docs: 'docsify serve docs' }, new Set(['docsify']))).toEqual(
        new Set(),
      );
    });

    it('does not count `docsify` as an argument of an adjacent command', () => {
      // `docsify` here is the argument of `eslint`, never a command token, so it is not evidence.
      expect(findPackageScriptUsage({ lint: 'eslint docsify' }, new Set(['docsify-cli']))).toEqual(
        new Set(),
      );
    });

    it('does not guess a scoped package bin from its name', () => {
      // A command token is only evidence for a scoped package when the allowlist proves the executable
      // (Step 35 added `vue-cli-service`); an unlisted command never resolves to a scoped package.
      expect(findPackageScriptUsage({ build: 'nuxt generate' }, new Set(['@nuxt/cli']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage({ build: 'vite-node entry.ts' }, new Set(['@vitejs/cli'])),
      ).toEqual(new Set());
    });

    it('maps a direct ng executable to the declared @angular/cli package', () => {
      // Step 28: the explicit `ng` -> `@angular/cli` mapping resolves the direct executable to its
      // declared package. Undeclared @angular/cli still yields no evidence.
      expect(findPackageScriptUsage({ build: 'ng build' }, new Set(['@angular/cli']))).toEqual(
        new Set(['@angular/cli']),
      );
      expect(findPackageScriptUsage({ build: 'ng build' }, new Set(['lodash']))).toEqual(new Set());
    });

    it('maps a direct nest executable to the declared @nestjs/cli package', () => {
      // Step 28: the explicit `nest` -> `@nestjs/cli` mapping resolves the direct executable to its
      // declared package. Undeclared @nestjs/cli still yields no evidence.
      expect(findPackageScriptUsage({ build: 'nest build' }, new Set(['@nestjs/cli']))).toEqual(
        new Set(['@nestjs/cli']),
      );
      expect(findPackageScriptUsage({ build: 'nest build' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('does not treat `echo ng`/`echo nest` as CLI usage evidence', () => {
      // `ng`/`nest` are only the argument of `echo`, never a command position.
      expect(findPackageScriptUsage({ build: 'echo ng' }, new Set(['@angular/cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ build: 'echo nest' }, new Set(['@nestjs/cli']))).toEqual(
        new Set(),
      );
    });

    it('does not treat `node -e "ng"` as CLI usage evidence', () => {
      expect(
        findPackageScriptUsage(
          { probe: 'node -e "console.log(\'ng\')"' },
          new Set(['@angular/cli']),
        ),
      ).toEqual(new Set());
    });

    it('does not count `ng`/`nest` as an argument of an adjacent command', () => {
      // `ng`/`nest` here are the arguments of `eslint`, never command tokens, so they are not
      // evidence for the mapped CLI packages.
      expect(findPackageScriptUsage({ lint: 'eslint ng' }, new Set(['@angular/cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint nest' }, new Set(['@nestjs/cli']))).toEqual(
        new Set(),
      );
    });

    it('does not map ng to a framework runtime package', () => {
      // `ng build` maps only to @angular/cli, never to the declared @angular/core runtime.
      expect(
        findPackageScriptUsage({ build: 'ng build' }, new Set(['@angular/core', '@angular/cli'])),
      ).toEqual(new Set(['@angular/cli']));
    });

    it('maps a direct babel executable to the declared @babel/cli package', () => {
      // Step 29: the explicit `babel` -> `@babel/cli` mapping resolves the direct executable to its
      // declared package. Undeclared @babel/cli still yields no evidence.
      expect(
        findPackageScriptUsage({ build: 'babel src -d dist' }, new Set(['@babel/cli'])),
      ).toEqual(new Set(['@babel/cli']));
      expect(findPackageScriptUsage({ build: 'babel src -d dist' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('maps a direct swc executable to the declared @swc/cli package', () => {
      // Step 29: the explicit `swc` -> `@swc/cli` mapping resolves the direct executable to its
      // declared package. Undeclared @swc/cli still yields no evidence.
      expect(findPackageScriptUsage({ build: 'swc src -d dist' }, new Set(['@swc/cli']))).toEqual(
        new Set(['@swc/cli']),
      );
      expect(findPackageScriptUsage({ build: 'swc src -d dist' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('does not map babel or swc to a companion core library package', () => {
      // The CLI executable is evidence for the CLI package only; the separately declared core
      // libraries receive no script evidence.
      expect(
        findPackageScriptUsage(
          { build: 'babel src -d dist' },
          new Set(['@babel/core', '@babel/cli']),
        ),
      ).toEqual(new Set(['@babel/cli']));
      expect(
        findPackageScriptUsage({ build: 'swc src -d dist' }, new Set(['@swc/core', '@swc/cli'])),
      ).toEqual(new Set(['@swc/cli']));
    });

    it('does not treat `echo babel`/`echo swc` as CLI usage evidence', () => {
      // `babel`/`swc` are only the argument of `echo`, never a command position.
      expect(findPackageScriptUsage({ build: 'echo babel' }, new Set(['@babel/cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ build: 'echo swc' }, new Set(['@swc/cli']))).toEqual(
        new Set(),
      );
    });

    it('does not count `babel`/`swc` as an argument of an adjacent command', () => {
      // Here they are the arguments of `eslint`, never command tokens, so they are not evidence.
      expect(findPackageScriptUsage({ lint: 'eslint babel' }, new Set(['@babel/cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint swc' }, new Set(['@swc/cli']))).toEqual(
        new Set(),
      );
    });

    it('maps a direct postcss executable to the declared postcss-cli package', () => {
      // Step 30: with only the CLI package declared, the `postcss` executable resolves to it.
      expect(
        findPackageScriptUsage(
          { build: 'postcss src/index.css -o dist/index.css' },
          new Set(['postcss-cli']),
        ),
      ).toEqual(new Set(['postcss-cli']));
      expect(
        findPackageScriptUsage(
          { build: 'postcss src/index.css -o dist/index.css' },
          new Set(['lodash']),
        ),
      ).toEqual(new Set());
    });

    it('maps a direct dotenv executable to the declared dotenv-cli package', () => {
      // Step 30: with only the CLI package declared, the `dotenv` executable resolves to it. The
      // executable after `--` is never parsed, so no other package gets evidence.
      expect(
        findPackageScriptUsage(
          { start: 'dotenv -e .env -- node index.js' },
          new Set(['dotenv-cli']),
        ),
      ).toEqual(new Set(['dotenv-cli']));
      expect(
        findPackageScriptUsage({ start: 'dotenv -e .env -- node index.js' }, new Set(['lodash'])),
      ).toEqual(new Set());
    });

    it('keeps exact-name precedence for the collision-sensitive postcss pair', () => {
      // `postcss` is also a real unrelated package. When both are declared the exact-name package
      // keeps the evidence and the CLI provider is not auto-suppressed as well.
      expect(
        findPackageScriptUsage(
          { build: 'postcss src/index.css -o dist/index.css' },
          new Set(['postcss', 'postcss-cli']),
        ),
      ).toEqual(new Set(['postcss']));
    });

    it('keeps exact-name precedence for the collision-sensitive dotenv pair', () => {
      // Same rule as `postcss`: never two competing providers from one executable.
      expect(
        findPackageScriptUsage(
          { start: 'dotenv -e .env -- node index.js' },
          new Set(['dotenv', 'dotenv-cli']),
        ),
      ).toEqual(new Set(['dotenv']));
    });

    it('does not parse the executable that dotenv runs after `--`', () => {
      // `dotenv` is a runner, but this scanner never looks past the command token, so `tsc` after
      // `--` is not usage evidence for the declared `typescript` package.
      expect(
        findPackageScriptUsage(
          { typecheck: 'dotenv -e .env -- tsc --noEmit' },
          new Set(['typescript']),
        ),
      ).toEqual(new Set());
    });

    it('does not treat `echo postcss`/`echo dotenv` or adjacent arguments as CLI usage evidence', () => {
      expect(findPackageScriptUsage({ build: 'echo postcss' }, new Set(['postcss-cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ start: 'echo dotenv' }, new Set(['dotenv-cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint postcss' }, new Set(['postcss-cli']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage(
          { probe: 'node -e "console.log(\'dotenv\')"' },
          new Set(['dotenv-cli']),
        ),
      ).toEqual(new Set());
    });

    it('maps a direct changeset executable to the declared @changesets/cli package', () => {
      // Step 31: `changeset version` is a command plus arguments, so the command token maps to the
      // declared CLI package. Undeclared @changesets/cli still yields no evidence.
      expect(
        findPackageScriptUsage({ version: 'changeset version' }, new Set(['@changesets/cli'])),
      ).toEqual(new Set(['@changesets/cli']));
      expect(findPackageScriptUsage({ version: 'changeset version' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('maps a direct commitlint executable to the declared @commitlint/cli package', () => {
      expect(
        findPackageScriptUsage({ lint: 'commitlint --edit' }, new Set(['@commitlint/cli'])),
      ).toEqual(new Set(['@commitlint/cli']));
      expect(findPackageScriptUsage({ lint: 'commitlint --edit' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('does not match the unverified plural changesets spelling', () => {
      // Only the singular `changeset` bin is published; the plural spelling must never be treated as
      // an alias of `@changesets/cli`.
      expect(
        findPackageScriptUsage({ version: 'changesets version' }, new Set(['@changesets/cli'])),
      ).toEqual(new Set());
    });

    it('does not treat `echo changeset`/`echo commitlint` as CLI usage evidence', () => {
      // Both names appear only as the argument of `echo`, never in command position.
      expect(
        findPackageScriptUsage(
          { notes: 'echo changeset version pending' },
          new Set(['@changesets/cli']),
        ),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ notes: 'echo commitlint --edit' }, new Set(['@commitlint/cli'])),
      ).toEqual(new Set());
    });

    it('maps each verified code-generator alias to the declared @graphql-codegen/cli package', () => {
      // Step 32: three published executables of the same package each resolve to it individually.
      expect(
        findPackageScriptUsage(
          { generate: 'graphql-codegen --config codegen.yml' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set(['@graphql-codegen/cli']));
      expect(
        findPackageScriptUsage(
          { generate: 'gql-gen --config codegen.yml' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set(['@graphql-codegen/cli']));
      expect(
        findPackageScriptUsage(
          { generate: 'graphql-code-generator --config codegen.yml' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set(['@graphql-codegen/cli']));
      expect(
        findPackageScriptUsage(
          { generate: 'graphql-codegen --config codegen.yml' },
          new Set(['lodash']),
        ),
      ).toEqual(new Set());
    });

    it('classifies several aliases of one package as a single usage', () => {
      // Two verified aliases from two different scripts still produce one classification for the one
      // declared package, never two.
      expect(
        findPackageScriptUsage(
          {
            'generate:client': 'graphql-codegen --config client.yml',
            'generate:server': 'gql-gen --config server.yml',
          },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set(['@graphql-codegen/cli']));
    });

    it('maps openapi-generator-cli to the declared @openapitools/openapi-generator-cli package', () => {
      expect(
        findPackageScriptUsage(
          { generate: 'openapi-generator-cli generate' },
          new Set(['@openapitools/openapi-generator-cli']),
        ),
      ).toEqual(new Set(['@openapitools/openapi-generator-cli']));
      expect(
        findPackageScriptUsage({ generate: 'openapi-generator-cli generate' }, new Set(['lodash'])),
      ).toEqual(new Set());
    });

    it('does not treat echo or node -e mentions as generator usage evidence', () => {
      expect(
        findPackageScriptUsage(
          { notes: 'echo graphql-codegen' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage(
          { probe: 'node -e "console.log(\'gql-gen\')"' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage(
          { build: 'node scripts/run.js graphql-codegen' },
          new Set(['@graphql-codegen/cli']),
        ),
      ).toEqual(new Set());
    });

    it('maps run-p and run-s to the declared npm-run-all package', () => {
      // Step 33: both executables ship in `npm-run-all`; each resolves individually.
      expect(
        findPackageScriptUsage({ check: 'run-p lint test' }, new Set(['npm-run-all'])),
      ).toEqual(new Set(['npm-run-all']));
      expect(
        findPackageScriptUsage({ build: 'run-s clean build' }, new Set(['npm-run-all'])),
      ).toEqual(new Set(['npm-run-all']));
      expect(findPackageScriptUsage({ check: 'run-p lint test' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('maps conc to the declared concurrently package and ncu to npm-check-updates', () => {
      expect(
        findPackageScriptUsage({ dev: 'conc "vite" "tsc"' }, new Set(['concurrently'])),
      ).toEqual(new Set(['concurrently']));
      expect(
        findPackageScriptUsage({ upgrade: 'ncu --target minor' }, new Set(['npm-check-updates'])),
      ).toEqual(new Set(['npm-check-updates']));
      expect(findPackageScriptUsage({ dev: 'conc "vite" "tsc"' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('never infers a runner argument as used', () => {
      // `run-p`/`run-s`/`conc` are recognized as the tool that runs; their arguments (script names or
      // quoted commands) are never analyzed, so the argument package stays unused.
      expect(
        findPackageScriptUsage({ check: 'run-p vite' }, new Set(['npm-run-all', 'vite'])),
      ).toEqual(new Set(['npm-run-all']));
      expect(
        findPackageScriptUsage({ dev: 'conc "vite" "tsc"' }, new Set(['vite', 'typescript'])),
      ).toEqual(new Set());
    });

    it('does not treat echo or adjacent-command arguments as runner usage evidence', () => {
      expect(
        findPackageScriptUsage({ notes: 'echo run-s build' }, new Set(['npm-run-all'])),
      ).toEqual(new Set());
      expect(findPackageScriptUsage({ notes: 'echo ncu' }, new Set(['npm-check-updates']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint conc' }, new Set(['concurrently']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage(
          { probe: 'node -e "console.log(\'ncu\')"' },
          new Set(['npm-check-updates']),
        ),
      ).toEqual(new Set());
    });

    it('maps gulp, grunt and sequelize to their declared CLI packages', () => {
      // Step 34: CLI-only manifests resolve through the verified bin provider.
      expect(findPackageScriptUsage({ build: 'gulp build' }, new Set(['gulp-cli']))).toEqual(
        new Set(['gulp-cli']),
      );
      expect(findPackageScriptUsage({ test: 'grunt test' }, new Set(['grunt-cli']))).toEqual(
        new Set(['grunt-cli']),
      );
      expect(
        findPackageScriptUsage({ migrate: 'sequelize db:migrate' }, new Set(['sequelize-cli'])),
      ).toEqual(new Set(['sequelize-cli']));
      expect(findPackageScriptUsage({ build: 'gulp build' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    it('never marks a CLI and its same-name package used from one command', () => {
      // Collision-sensitive names keep exact-name precedence: one `gulp` command is evidence for the
      // declared `gulp` package only, and never for `gulp-cli` at the same time.
      expect(
        findPackageScriptUsage({ build: 'gulp build' }, new Set(['gulp', 'gulp-cli'])),
      ).toEqual(new Set(['gulp']));
      expect(
        findPackageScriptUsage({ test: 'grunt test' }, new Set(['grunt', 'grunt-cli'])),
      ).toEqual(new Set(['grunt']));
      expect(
        findPackageScriptUsage(
          { migrate: 'sequelize db:migrate' },
          new Set(['sequelize', 'sequelize-cli']),
        ),
      ).toEqual(new Set(['sequelize']));
    });

    it('does not treat echo or argument mentions as task-runner or database CLI evidence', () => {
      expect(findPackageScriptUsage({ notes: 'echo grunt test' }, new Set(['grunt-cli']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ notes: 'echo gulp' }, new Set(['gulp-cli']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage(
          { build: 'node scripts/run.js sequelize' },
          new Set(['sequelize-cli']),
        ),
      ).toEqual(new Set());
    });

    it('never maps ambiguous binary providers that publish the same executable', () => {
      // Step 36: `tailwindcss` is published by `tailwindcss` (v3) and by `@tailwindcss/cli` (v4), and
      // `playwright` is published by both `playwright` and `@playwright/test`. A static scanner cannot
      // pick a provider, so it only credits an exactly declared same-name package and abstains otherwise.
      expect(
        findPackageScriptUsage(
          { css: 'tailwindcss -i input.css -o output.css' },
          new Set(['tailwindcss', '@tailwindcss/cli']),
        ),
      ).toEqual(new Set(['tailwindcss']));
      expect(
        findPackageScriptUsage(
          { css: 'tailwindcss -i input.css -o output.css' },
          new Set(['@tailwindcss/cli']),
        ),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage(
          { e2e: 'playwright test' },
          new Set(['playwright', '@playwright/test']),
        ),
      ).toEqual(new Set(['playwright']));
      expect(
        findPackageScriptUsage({ e2e: 'playwright test' }, new Set(['@playwright/test'])),
      ).toEqual(new Set());
    });

    it('never treats the webpack executable as evidence for webpack-cli', () => {
      // `webpack` publishes its own `webpack` bin and `webpack-cli` publishes `webpack-cli`; there is
      // no published `webpack` bin in `webpack-cli`, so no alias may be invented here.
      expect(
        findPackageScriptUsage(
          { bundle: 'webpack --mode production' },
          new Set(['webpack', 'webpack-cli']),
        ),
      ).toEqual(new Set(['webpack']));
      expect(
        findPackageScriptUsage({ bundle: 'webpack --mode production' }, new Set(['webpack-cli'])),
      ).toEqual(new Set());
    });

    it('keeps exact-name precedence for every collision-sensitive mapping', () => {
      // One command never marks a CLI package and its same-name package used together (Steps 30, 34, 35).
      const cases: readonly [string, string, string][] = [
        ['dotenv', 'dotenv-cli', 'dotenv -e .env'],
        ['postcss', 'postcss-cli', 'postcss styles.css -o dist.css'],
        ['gulp', 'gulp-cli', 'gulp build'],
        ['grunt', 'grunt-cli', 'grunt test'],
        ['sequelize', 'sequelize-cli', 'sequelize db:migrate'],
        ['vue-cli-service', '@vue/cli-service', 'vue-cli-service build'],
        ['babel-node', '@babel/node', 'babel-node src/server.js'],
      ];

      for (const [sameName, cliPackage, command] of cases) {
        expect(
          findPackageScriptUsage({ run: command }, new Set([sameName, cliPackage])),
          `${command} must credit ${sameName} only`,
        ).toEqual(new Set([sameName]));
      }
    });

    it('never infers a dependency from the node or pnpm binary itself', () => {
      // `node` and `pnpm` are not evidence for any unrelated declared package; only a literal
      // same-name declaration could ever match, and no alias is invented for them.
      expect(
        findPackageScriptUsage(
          { build: 'node scripts/build.js', release: 'pnpm node scripts/release.js' },
          new Set(['webpack-cli', 'tailwindcss', '@playwright/test']),
        ),
      ).toEqual(new Set());
    });

    it('does not map the sibling spack executable', () => {
      // `spack` ships with @swc/cli but is deliberately not a candidate.
      expect(findPackageScriptUsage({ build: 'spack src -o dist' }, new Set(['@swc/cli']))).toEqual(
        new Set(),
      );
    });

    it('maps vue-cli-service and babel-node to their declared packages', () => {
      // Step 35: both executables are verified published bins of the mapped packages.
      expect(
        findPackageScriptUsage({ build: 'vue-cli-service build' }, new Set(['@vue/cli-service'])),
      ).toEqual(new Set(['@vue/cli-service']));
      expect(
        findPackageScriptUsage({ start: 'babel-node src/server.js' }, new Set(['@babel/node'])),
      ).toEqual(new Set(['@babel/node']));
      expect(
        findPackageScriptUsage({ build: 'vue-cli-service build' }, new Set(['lodash'])),
      ).toEqual(new Set());
    });

    it('keeps exact-name precedence for the collision-sensitive Step 35 names', () => {
      // `vue-cli-service` and `babel-node` are themselves published package names.
      expect(
        findPackageScriptUsage(
          { build: 'vue-cli-service build' },
          new Set(['vue-cli-service', '@vue/cli-service']),
        ),
      ).toEqual(new Set(['vue-cli-service']));
      expect(
        findPackageScriptUsage(
          { start: 'babel-node src/server.js' },
          new Set(['babel-node', '@babel/node']),
        ),
      ).toEqual(new Set(['babel-node']));
    });

    it('never infers the matching runtime library from these CLI commands', () => {
      expect(
        findPackageScriptUsage(
          { build: 'vue-cli-service build' },
          new Set(['vue', '@vue/cli-service']),
        ),
      ).toEqual(new Set(['@vue/cli-service']));
      expect(
        findPackageScriptUsage(
          { start: 'babel-node src/server.js' },
          new Set(['@babel/core', '@babel/cli']),
        ),
      ).toEqual(new Set());
    });

    it('does not treat echo or node -e mentions as Step 35 CLI usage evidence', () => {
      expect(
        findPackageScriptUsage(
          { notes: 'echo vue-cli-service build' },
          new Set(['@vue/cli-service']),
        ),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ notes: 'echo babel-node' }, new Set(['@babel/node'])),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage(
          { probe: 'node -e "console.log(\'babel-node\')"' },
          new Set(['@babel/node']),
        ),
      ).toEqual(new Set());
    });
  });

  describe('Step 42: TypeScript language-server and ts-node executable aliases', () => {
    it('maps tsserver to the declared typescript package', () => {
      // `tsserver` ships in the `typescript` package next to `tsc`; the language server is only
      // recognized as a command token and never started.
      expect(findPackageScriptUsage({ lsp: 'tsserver --stdio' }, new Set(['typescript']))).toEqual(
        new Set(['typescript']),
      );
      expect(findPackageScriptUsage({ lsp: 'tsserver --stdio' }, new Set(['lodash']))).toEqual(
        new Set(),
      );
    });

    const tsNodeVariants: readonly (readonly [string, string])[] = [
      ['ts-node-cwd src/main.ts', 'cwd variant in command position'],
      ['ts-node-esm src/main.ts', 'ESM variant in command position'],
      ['ts-node-script src/main.ts', 'script variant in command position'],
      ['ts-node-transpile-only src/main.ts', 'transpile-only variant in command position'],
      ['tsc -p tsconfig.json && ts-node-esm src/main.ts', '&& separated segment'],
      ['"ts-node-esm" src/main.ts', 'quoted command token'],
      ['NODE_ENV=development ts-node-esm src/main.ts', 'leading environment assignment'],
    ];

    it.each(tsNodeVariants)('maps %s to ts-node (%s)', (script) => {
      expect(findPackageScriptUsage({ run: script }, new Set(['ts-node']))).toEqual(
        new Set(['ts-node']),
      );
    });

    const negatives: readonly (readonly [string, string])[] = [
      ['echo tsserver', 'argument of echo'],
      ['echo ts-node-transpile-only', 'argument of echo'],
      ['node scripts/run.js --tool=ts-node-esm', 'flag value of another command'],
      ['./scripts/ts-node-esm', 'path, never a package'],
      ['npx ts-node-esm src/main.ts', 'runner arguments never use the binary mapping'],
      ['pnpm exec ts-node-cwd src/main.ts', 'runner arguments never use the binary mapping'],
      ['tsserver@1 --stdio', 'version suffix is never stripped'],
    ];

    it.each(negatives)('rejects %s (%s)', (script) => {
      expect(findPackageScriptUsage({ run: script }, new Set(['ts-node', 'typescript']))).toEqual(
        new Set(),
      );
    });

    it('keeps exact-name precedence for the collision-sensitive variant packages', () => {
      // `ts-node-cwd`, `ts-node-esm`, `ts-node-script` and `ts-node-transpile-only` are each published
      // as their own packages, so one command never marks both the wrapper and `ts-node` as used.
      expect(
        findPackageScriptUsage(
          { dev: 'ts-node-esm src/main.ts' },
          new Set(['ts-node', 'ts-node-esm']),
        ),
      ).toEqual(new Set(['ts-node-esm']));
      expect(
        findPackageScriptUsage(
          { cwd: 'ts-node-cwd src/main.ts' },
          new Set(['ts-node', 'ts-node-cwd']),
        ),
      ).toEqual(new Set(['ts-node-cwd']));
      expect(
        findPackageScriptUsage(
          { run: 'ts-node-script src/main.ts && ts-node-transpile-only src/main.ts' },
          new Set(['ts-node', 'ts-node-script', 'ts-node-transpile-only']),
        ),
      ).toEqual(new Set(['ts-node-script', 'ts-node-transpile-only']));
    });

    it('credits ts-node itself only by its exact name, which is not a mapping', () => {
      expect(findPackageScriptUsage({ dev: 'ts-node src/main.ts' }, new Set(['ts-node']))).toEqual(
        new Set(['ts-node']),
      );
      // A declared `ts-node` is never inferred from a different variant name it does not provide.
      expect(findPackageScriptUsage({ dev: 'tsx src/main.ts' }, new Set(['ts-node']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage({ dev: 'ts-script src/main.ts' }, new Set(['ts-node'])),
      ).toEqual(new Set());
    });
  });

  describe('Step 37: command-boundary matrix for representative mapped binaries', () => {
    // Representative aliases from different steps (`tsc`, `docsify`, `ng`, `babel`, `run-p`) exercised
    // only through the command positions and separators the scanner actually supports.
    const declared = new Set([
      '@angular/cli',
      '@babel/cli',
      'docsify-cli',
      'npm-run-all',
      'typescript',
      'eslint',
    ]);

    const positives: readonly [string, string, readonly string[]][] = [
      ['direct command', 'tsc -p tsconfig.json', ['typescript']],
      ['direct command', 'docsify serve docs', ['docsify-cli']],
      ['direct command', 'ng build', ['@angular/cli']],
      ['direct command', 'babel src -d lib', ['@babel/cli']],
      ['direct command', 'run-p lint test', ['npm-run-all']],
      ['&& separator', 'tsc && eslint .', ['eslint', 'typescript']],
      ['|| separator', 'ng build || ng test', ['@angular/cli']],
      ['; separator', 'ng build; run-p lint', ['@angular/cli', 'npm-run-all']],
      ['pipe separator', 'babel src -d lib | tee log', ['@babel/cli']],
      ['newline separator', 'ng build\nbabel src -d lib', ['@angular/cli', '@babel/cli']],
      ['quoted command token', '"ng" build', ['@angular/cli']],
      ['leading environment assignment', 'FOO=1 ng build', ['@angular/cli']],
    ];

    it.each(positives)('accepts %s: %p', (_label, script, expected) => {
      expect(findPackageScriptUsage({ run: script }, declared)).toEqual(new Set(expected));
    });

    const hardNegatives: readonly [string, string][] = [
      ['echo ng', 'argument of echo'],
      ['node -e "console.log(\'babel\')"', 'inside a node -e program'],
      ["printf '%s' run-p", 'argument of printf'],
      ['./scripts/ng', 'path, never a package'],
      ['node_modules/.bin/tsc', 'path inside node_modules'],
      ['node scripts/run.js --tool=babel', 'flag value of another command'],
      ['TOOL=ng', 'environment assignment only, no command'],
      ['# ng build', 'comment'],
      ['echo "$(ng build)"', 'command substitution invalidates the segment'],
      ['sh -c "ng build"', 'nested shell command is not unwrapped'],
      ['concurrently "ng serve" "tsc"', 'quoted arguments of another command'],
      ['cross-env NODE_ENV=production ng build', 'wrapper command is not unwrapped'],
    ];

    it.each(hardNegatives)('rejects %p (%s)', (script: string) => {
      expect(findPackageScriptUsage({ run: script }, declared)).toEqual(new Set());
    });

    it('credits only the real command in a mixed echo segment', () => {
      // `echo tsc` contributes nothing; the second segment really runs eslint. Only Step 36-style
      // abstinence would be wrong here: the declared exact-name tool is used.
      expect(findPackageScriptUsage({ run: 'echo tsc && eslint .' }, declared)).toEqual(
        new Set(['eslint']),
      );
    });

    const unsupportedRunners: readonly [string, string][] = [
      ['npx ng', 'runner package argument never applies the binary mapping'],
      ['npm exec ng', 'runner package argument never applies the binary mapping'],
      ['pnpm exec babel', 'runner package argument never applies the binary mapping'],
      ['yarn ng build', 'bare yarn exposes no supported package position'],
      ['npx --no-install ng', 'runner followed by a flag is unsupported'],
      ['ng@1 build', 'version suffix is never stripped'],
    ];

    it.each(unsupportedRunners)(
      'invents nothing for unsupported runner syntax %p (%s)',
      (script) => {
        expect(findPackageScriptUsage({ run: script }, declared)).toEqual(new Set());
      },
    );

    it('supported runner forms still expose only their exact-name package', () => {
      // The five supported forms behave exactly as in Step 25 after the catalog grew.
      expect(findPackageScriptUsage({ run: 'npx eslint .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ run: 'npm exec eslint' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ run: 'pnpm exec eslint' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ run: 'pnpm dlx create-x' }, new Set(['create-x']))).toEqual(
        new Set(['create-x']),
      );
      expect(findPackageScriptUsage({ run: 'yarn dlx create-x' }, new Set(['create-x']))).toEqual(
        new Set(['create-x']),
      );
    });
  });

  describe('paths do not count', () => {
    it('does not count a package under node_modules/.bin', () => {
      expect(
        findPackageScriptUsage({ lint: './node_modules/.bin/eslint .' }, new Set(['eslint'])),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ lint: 'node_modules/.bin/eslint .' }, new Set(['eslint'])),
      ).toEqual(new Set());
    });

    it('does not count a script path whose first segment is a declared package', () => {
      expect(findPackageScriptUsage({ build: 'scripts/build.js' }, new Set(['scripts']))).toEqual(
        new Set(),
      );
    });

    it('does not count a command token that only shares a prefix with a package', () => {
      expect(findPackageScriptUsage({ lint: 'eslinthelper' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });
  });

  describe('mapped executable quoting and paths (Step 25)', () => {
    it('counts a double-quoted mapped executable in command position', () => {
      // Quoting preserves the token, so `"docsify"` is still the command token and maps to
      // `docsify-cli`.
      expect(
        findPackageScriptUsage({ docs: '"docsify" serve docs' }, new Set(['docsify-cli'])),
      ).toEqual(new Set(['docsify-cli']));
    });

    it('does not count `echo "tsc"` as usage', () => {
      expect(findPackageScriptUsage({ docs: 'echo "tsc"' }, new Set(['typescript']))).toEqual(
        new Set(),
      );
    });

    it('does not trigger the mapping from a script path', () => {
      expect(
        findPackageScriptUsage({ docs: './scripts/docsify serve' }, new Set(['docsify-cli'])),
      ).toEqual(new Set());
    });

    it('does not trigger the mapping from a node_modules/.bin path', () => {
      expect(
        findPackageScriptUsage(
          { docs: './node_modules/.bin/docsify serve' },
          new Set(['docsify-cli']),
        ),
      ).toEqual(new Set());
    });
  });

  describe('declared intersection', () => {
    it('only keeps declared command tokens and never reports undeclared ones', () => {
      expect(
        findPackageScriptUsage(
          { check: 'eslint src && unknown-tool' },
          new Set(['eslint', 'typescript']),
        ),
      ).toEqual(new Set(['eslint']));
    });

    it('produces a union across multiple scripts in alphabetical order', () => {
      expect(
        findPackageScriptUsage(
          { a: 'eslint .', b: 'vite build', c: 'echo skip' },
          new Set(['vite', 'eslint', 'typescript']),
        ),
      ).toEqual(new Set(['eslint', 'vite']));
    });

    it('returns an empty set for empty scripts', () => {
      expect(findPackageScriptUsage({}, new Set(['eslint']))).toEqual(new Set());
    });
  });

  describe('determinism', () => {
    it('returns package names in alphabetical order regardless of declaration order', () => {
      const result = findPackageScriptUsage(
        { a: 'vite build', b: 'eslint .', c: 'prettier --check .' },
        new Set(['vite', 'eslint', 'prettier']),
      );

      // `toEqual` ignores set ordering, so the deterministic insertion order is asserted explicitly.
      expect([...result]).toEqual(['eslint', 'prettier', 'vite']);
    });

    it('is stable across repeated calls with identical input', () => {
      const scripts = { check: 'eslint . && prettier', build: 'vite build' };
      const declared = new Set(['eslint', 'prettier', 'vite']);

      expect([...findPackageScriptUsage(scripts, declared)]).toEqual([
        ...findPackageScriptUsage(scripts, declared),
      ]);
    });

    it('does not mutate the scripts or the declared package names', () => {
      const scripts = { lint: 'eslint .', build: 'vite build' };
      const declared = new Set(['eslint', 'vite', 'typescript']);
      const scriptsBefore = JSON.stringify(scripts);
      const declaredBefore = [...declared].join();

      findPackageScriptUsage(scripts, declared);

      expect(JSON.stringify(scripts)).toBe(scriptsBefore);
      expect([...declared].join()).toBe(declaredBefore);
    });
  });

  describe('unsupported shell syntax invalidates its segment', () => {
    it('produces no evidence for a double quote left open at the end of the script', () => {
      expect(findPackageScriptUsage({ lint: '"eslint' }, new Set(['eslint']))).toEqual(new Set());
    });

    it('produces no evidence for a single quote left open at the end of the script', () => {
      expect(findPackageScriptUsage({ lint: "'eslint" }, new Set(['eslint']))).toEqual(new Set());
    });

    it('does not trust the command of a segment that contains command substitution', () => {
      expect(findPackageScriptUsage({ lint: 'eslint $(something)' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ run: 'echo $(ls)' }, new Set(['ls', 'echo']))).toEqual(
        new Set(),
      );
    });

    it('does not trust the command of a segment that contains parameter expansion', () => {
      expect(findPackageScriptUsage({ lint: 'eslint ${FLAGS}' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ run: 'echo ${HOME} eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not trust the command of a segment that redirects output', () => {
      expect(findPackageScriptUsage({ lint: 'eslint > output.txt' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint >> output.txt' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not trust the command of a segment that redirects input', () => {
      expect(findPackageScriptUsage({ lint: 'eslint < input.txt' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not trust a command after leading assignments once the segment redirects', () => {
      expect(
        findPackageScriptUsage({ lint: 'NODE_ENV=test eslint > out.txt' }, new Set(['eslint'])),
      ).toEqual(new Set());
    });

    it('never treats a single `&` as a separator and drops the whole segment', () => {
      expect(
        findPackageScriptUsage({ lint: 'eslint & prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set());
    });

    it('keeps invalidation local when the next segment starts after `;`', () => {
      expect(
        findPackageScriptUsage(
          { lint: 'eslint $(something); prettier' },
          new Set(['eslint', 'prettier']),
        ),
      ).toEqual(new Set(['prettier']));
    });

    it('keeps invalidation local when the next segment starts after `&&`', () => {
      expect(
        findPackageScriptUsage(
          { lint: 'eslint > out.txt && prettier' },
          new Set(['eslint', 'prettier']),
        ),
      ).toEqual(new Set(['prettier']));
    });

    it('keeps invalidation local when the next segment starts on a new line', () => {
      expect(
        findPackageScriptUsage(
          { lint: 'eslint & prettier\nvitest run' },
          new Set(['eslint', 'prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('does not let an invalid segment leak evidence from its own command token', () => {
      // The `eslint` token exists in the script, but its segment is invalid.
      expect(findPackageScriptUsage({ lint: 'eslint &&' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: 'npx eslint & npm ls' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });
  });

  describe('unsupported expansions are consumed opaquely', () => {
    it('does not let a `;` inside `$()` become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(something; prettier )' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('does not let a `;` inside `${...}` become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo ${VALUE:-foo; prettier }' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('does not let a `&&` inside `$()` become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(something && prettier )' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('does not let a `||` inside `${...}` become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo ${VALUE:-foo || prettier}' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('recovers after `$()` closes and analyzes the next outer segment', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo $(something; prettier ); vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('recovers after `${...}` closes and analyzes the next outer segment', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo ${VALUE:-foo; prettier}; vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('recovers after `${...}` closes on an outer `&&`', () => {
      expect(
        findPackageScriptUsage(
          { run: 'eslint ${FLAGS:-foo && prettier} && vitest' },
          new Set(['eslint', 'prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('handles nested `$()` and stops at the outer delimiter', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(outer $(inner; prettier))' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('handles nested `${...}` and stops at the outer delimiter', () => {
      expect(
        findPackageScriptUsage({ run: 'echo ${A:-${B:-prettier; foo}}' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('leaves the segment unsupported when `$()` is unterminated', () => {
      expect(findPackageScriptUsage({ lint: 'eslint $(something' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('leaves the segment unsupported when `${...}` is unterminated', () => {
      expect(findPackageScriptUsage({ lint: 'eslint ${FLAGS' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not close an expansion at a delimiter that appears inside a quote', () => {
      // The whole segment is unsupported, so nothing is counted here.
      expect(findPackageScriptUsage({ run: 'echo $(echo ")")' }, new Set(['echo']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ run: 'echo ${VALUE:-"}"}' }, new Set(['echo']))).toEqual(
        new Set(),
      );
    });

    it('keeps scanning outer separators after a quoted delimiter inside an expansion', () => {
      // A quoted `)` must not close the expansion early; the outer `;` after it still flushes the
      // segment so `vitest` becomes a fresh, analyzed segment.
      expect(
        findPackageScriptUsage({ run: 'eslint $(x ")"); vitest' }, new Set(['eslint', 'vitest'])),
      ).toEqual(new Set(['vitest']));
    });
  });

  describe('mixed nesting inside opaque regions', () => {
    it('does not close `${...}` early at a nested `$(...)` boundary', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo ${X:-$(echo }; prettier; echo done)}; vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('does not close `$()` early at a nested `${...}` boundary', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo $(echo ${X:-)}; prettier; echo done); vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('keeps a backtick substitution inside `${...}` opaque', () => {
      // The `}` inside the backticks must not close the outer `${...}`.
      expect(
        findPackageScriptUsage({ run: 'echo ${X:-`echo }; prettier`}' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('keeps a backtick substitution containing `${...}` inside `$()` opaque', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(echo `${X:-)}`; prettier)' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });
  });

  describe('quotes inside opaque regions', () => {
    it('treats a single quote inside double quotes as literal text', () => {
      // The apostrophe is literal inside `"..."`, so the double-quoted run still closes and the
      // outer `;` stays available for segment recovery.
      expect(
        findPackageScriptUsage({ run: 'echo $(echo "it\'s"); prettier' }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('treats a single quote inside double quotes in `${...}` as literal text', () => {
      expect(
        findPackageScriptUsage({ run: 'echo ${X-"it\'s"}; prettier' }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('treats a single quote inside double quotes in backticks as literal text', () => {
      expect(
        findPackageScriptUsage({ run: 'echo `echo "it\'s"`; prettier' }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('keeps double and single quoted runs nested in the same region balanced', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo $(echo "don\'t" "${X-\'y\'}"); prettier' },
          new Set(['prettier']),
        ),
      ).toEqual(new Set(['prettier']));
    });

    it('keeps a separator inside a double-quoted run opaque when an apostrophe is present', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(echo "a;b\'c"); prettier' }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('leaves the segment unsupported when a double quote inside a region never closes', () => {
      expect(
        findPackageScriptUsage({ run: 'echo $(echo "it); prettier' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });
  });

  describe('backslash escapes', () => {
    it('does not treat an escaped `;` as a segment separator', () => {
      expect(findPackageScriptUsage({ run: 'echo a\\; prettier' }, new Set(['prettier']))).toEqual(
        new Set(),
      );
    });

    it('does not treat an escaped `|` as a segment separator', () => {
      expect(findPackageScriptUsage({ run: 'echo a\\| prettier' }, new Set(['prettier']))).toEqual(
        new Set(),
      );
    });

    it('invalidates the segment instead of trusting an escaped `&`', () => {
      expect(
        findPackageScriptUsage({ run: 'echo a\\& prettier' }, new Set(['echo', 'prettier'])),
      ).toEqual(new Set());
    });

    it('invalidates the segment for an escaped redirection character', () => {
      expect(findPackageScriptUsage({ run: 'echo a\\> prettier' }, new Set(['prettier']))).toEqual(
        new Set(),
      );
    });

    it('invalidates a segment whose own command token is followed by an escape', () => {
      expect(
        findPackageScriptUsage({ lint: 'eslint a\\; prettier' }, new Set(['eslint', 'prettier'])),
      ).toEqual(new Set());
    });

    it('recovers on a real separator that follows an escaped one', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo a\\; prettier; vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });
  });

  describe('legacy backtick substitution', () => {
    it('does not let a `;` inside backticks become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo `something; prettier`' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('does not let `&&` inside backticks become an outer separator', () => {
      expect(
        findPackageScriptUsage({ run: 'echo `something && prettier`' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('recovers after a backtick substitution closes', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo `something; prettier`; vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('does not close a substitution at an escaped backtick', () => {
      // The escaped backticks must not end the region, so the inner `;` stays inside it.
      expect(
        findPackageScriptUsage({ run: 'echo `echo \\`value\\`; prettier`' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('recovers on the outer separator after an escaped backtick closes the region', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo `echo \\`value\\`; prettier`; vitest' },
          new Set(['prettier', 'vitest']),
        ),
      ).toEqual(new Set(['vitest']));
    });

    it('leaves the segment unsupported when a backtick is unterminated', () => {
      expect(findPackageScriptUsage({ lint: 'eslint `something' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not expose a command token that follows a separator inside backticks', () => {
      // The closing backtick is separated by a space, so a naive tokenizer would hand `prettier` to
      // the next segment as a clean command token. The region must stay opaque instead.
      expect(findPackageScriptUsage({ run: 'echo `x; prettier `' }, new Set(['prettier']))).toEqual(
        new Set(),
      );
      expect(
        findPackageScriptUsage({ run: 'echo `x && prettier `' }, new Set(['prettier'])),
      ).toEqual(new Set());
      expect(
        findPackageScriptUsage({ run: 'echo `x || prettier `' }, new Set(['prettier'])),
      ).toEqual(new Set());
    });

    it('keeps an escaped backtick inside the region even when the close follows a separator', () => {
      expect(
        findPackageScriptUsage(
          { run: 'echo `echo \\`value\\`; prettier `' },
          new Set(['prettier']),
        ),
      ).toEqual(new Set());
    });
  });

  describe('quoted literal safety', () => {
    it('keeps single-quoted shell metacharacters literal instead of invalidating', () => {
      expect(
        findPackageScriptUsage({ lint: "eslint '$(something)'" }, new Set(['eslint'])),
      ).toEqual(new Set(['eslint']));
      expect(findPackageScriptUsage({ lint: "eslint '${FLAGS}'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint 'a & b'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint 'a > b'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint 'a < b'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint '`something`'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint 'a\\;b'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: "eslint 'a\\|b'" }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('keeps operator characters inside double quotes literal', () => {
      expect(findPackageScriptUsage({ lint: 'eslint "a & b"' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: 'eslint "a > b"' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
      expect(findPackageScriptUsage({ lint: 'eslint "a < b"' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('still invalidates expansion that survives double quotes', () => {
      expect(findPackageScriptUsage({ lint: 'eslint "$(cmd)"' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint "${FLAGS}"' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ note: 'echo "$(cmd)"' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ lint: 'eslint "`something`"' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      // An escaped double quote is an escape, so it invalidates the segment rather than ending the
      // quoted run early.
      expect(findPackageScriptUsage({ lint: 'eslint "a\\"b"' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      // A Windows-style path inside double quotes is a documented conservative false negative: the
      // scanner does not model exact POSIX double-quote escape rules, so `\t` invalidates the segment
      // the same way on every platform.
      expect(
        findPackageScriptUsage(
          { postinstall: "node -e \"require('fs').writeFileSync('C:\\temp.txt', 'x')\"" },
          new Set(['node']),
        ),
      ).toEqual(new Set());
      // A substitution inside double quotes stays opaque, so its inner `;` never reaches the outer.
      expect(
        findPackageScriptUsage(
          { lint: 'eslint "`cmd; prettier`; vitest"' },
          new Set(['eslint', 'prettier', 'vitest']),
        ),
      ).toEqual(new Set());
    });

    it('never manufactures evidence from quoted echo text', () => {
      expect(findPackageScriptUsage({ note: "echo '$(something)'" }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ note: "echo '${FLAGS}'" }, new Set(['eslint']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ note: "echo 'a & b'" }, new Set(['a', 'b']))).toEqual(
        new Set(),
      );
      expect(findPackageScriptUsage({ note: 'echo "a & b"' }, new Set(['a', 'b']))).toEqual(
        new Set(),
      );
    });
  });

  describe('newlines inside quotes', () => {
    it('treats a newline inside a quoted token as literal text, not as malformed', () => {
      expect(findPackageScriptUsage({ lint: 'eslint "a\nb"' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
    });

    it('finds a later segment after a multiline quoted string closes', () => {
      expect(
        findPackageScriptUsage({ check: 'echo "hello\nworld"; prettier' }, new Set(['prettier'])),
      ).toEqual(new Set(['prettier']));
    });

    it('does not count an open multiline quote at the end of the script', () => {
      expect(findPackageScriptUsage({ check: 'echo "hello\nworld' }, new Set(['echo']))).toEqual(
        new Set(),
      );
    });
  });

  describe('no command is executed', () => {
    it('never runs the script string, even one that would create a marker file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'depvitals-script-usage-'));
      const marker = join(dir, 'marker.txt');
      // A backslash inside double quotes is read as a shell escape, so a conservative scanner
      // invalidates such a segment. Windows paths always contain `\`, which would make this script
      // string platform dependent, so only the embedded location uses forward slashes while the
      // filesystem check keeps using the native path.
      const markerForScript = marker.replaceAll('\\', '/');

      try {
        const scripts = {
          // A command that would create the marker file if it were ever executed.
          postinstall: `node -e "require('fs').writeFileSync('${markerForScript}', 'x')"`,
        };

        // The command is recognized as usage evidence...
        expect(findPackageScriptUsage(scripts, new Set(['node']))).toEqual(new Set(['node']));
        // ...but the script string is never executed, so the marker is never created.
        expect(existsSync(marker)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('tsc -> typescript executable mapping (Step 23)', () => {
    it('maps a direct tsc executable to the declared typescript package only', () => {
      // The explicit mapping takes precedence over same-name matching: a single `tsc` executable
      // yields exactly one piece of evidence (typescript), never both tsc and typescript.
      expect(
        findPackageScriptUsage(
          { build: 'tsc -p tsconfig.json' },
          new Set(['typescript', 'lodash']),
        ),
      ).toEqual(new Set(['typescript']));
    });

    it('keeps mapping precedence even when a same-name tsc package is also declared (Step 26)', () => {
      // Category A (explicit mapping) wins: with both `typescript` and a hypothetical `tsc` declared,
      // the `tsc` executable marks only `typescript` used, never the same-name package.
      expect(
        findPackageScriptUsage({ build: 'tsc -p tsconfig.json' }, new Set(['typescript', 'tsc'])),
      ).toEqual(new Set(['typescript']));
    });

    it('leaves unrelated declared dependencies unused when tsc is the command', () => {
      expect(
        findPackageScriptUsage(
          { build: 'tsc -p tsconfig.json' },
          new Set(['typescript', 'lodash']),
        ),
      ).toEqual(new Set(['typescript']));
    });

    it('never emits evidence for an undeclared typescript mapped from tsc', () => {
      expect(
        findPackageScriptUsage({ build: 'tsc -p tsconfig.json' }, new Set(['lodash'])),
      ).toEqual(new Set());
    });

    it('does not map tsc invoked through a supported runner form', () => {
      // `npx tsc` resolves the runner's package position, not a direct executable, so typescript is
      // not marked used here. Documented limitation for a future step.
      expect(findPackageScriptUsage({ build: 'npx tsc' }, new Set(['typescript']))).toEqual(
        new Set(),
      );
    });
  });
});
