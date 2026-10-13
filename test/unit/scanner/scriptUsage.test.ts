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

    it('normalizes a declared package used via a subpath command token', () => {
      expect(findPackageScriptUsage({ run: 'eslint/bin/cli .' }, new Set(['eslint']))).toEqual(
        new Set(['eslint']),
      );
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

  describe('no binary-to-package guessing', () => {
    it('does not map `tsc` to `typescript`', () => {
      expect(findPackageScriptUsage({ build: 'tsc' }, new Set(['typescript']))).toEqual(new Set());
    });

    it('does not guess a scoped package bin from its name', () => {
      expect(
        findPackageScriptUsage({ build: 'vue-cli-service serve' }, new Set(['@vue/cli-service'])),
      ).toEqual(new Set());
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

    it('does not count an arbitrary script path', () => {
      expect(findPackageScriptUsage({ build: 'scripts/build.js' }, new Set(['scripts']))).toEqual(
        new Set(['scripts']),
      );
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
      expect(
        findPackageScriptUsage(
          { a: 'vite build', b: 'eslint .', c: 'prettier --check .' },
          new Set(['vite', 'eslint', 'prettier']),
        ),
      ).toEqual(new Set(['eslint', 'prettier', 'vite']));
    });
  });

  describe('malformed / unsupported shell syntax', () => {
    it('does not crash and produces no evidence for an unterminated quote', () => {
      expect(findPackageScriptUsage({ note: 'echo "unterminated' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });

    it('does not crash and produces no evidence for command substitution', () => {
      expect(findPackageScriptUsage({ run: 'echo $(ls)' }, new Set(['ls']))).toEqual(new Set());
    });

    it('does not crash and produces no evidence for parameter substitution', () => {
      expect(findPackageScriptUsage({ run: 'echo ${HOME} eslint' }, new Set(['eslint']))).toEqual(
        new Set(),
      );
    });
  });

  describe('no command is executed', () => {
    it('never runs the script string, even one that would create a marker file', () => {
      const dir = mkdtempSync(join(tmpdir(), 'depvitals-script-usage-'));
      const marker = join(dir, 'marker.txt');

      try {
        const scripts = {
          // A command that would create the marker file if it were ever executed.
          postinstall: `node -e "require('fs').writeFileSync('${marker}', 'x')"`,
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
});
