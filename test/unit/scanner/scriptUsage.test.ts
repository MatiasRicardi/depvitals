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
