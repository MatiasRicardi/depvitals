import { describe, expect, it } from 'vitest';

import {
  ModuleSpecifierError,
  extractModuleSpecifiers,
} from '../../../src/scanner/moduleSpecifiers.js';

/**
 * Assert the exact ordered list of specifiers for a source snippet, ignoring the kind.
 */
function specifiers(source: string): string[] {
  return [...extractModuleSpecifiers(source)].map((occ) => occ.specifier);
}

describe('extractModuleSpecifiers', () => {
  describe('positive cases', () => {
    it('extracts default and named imports', () => {
      const source = `
        import value from 'pkg';
        import { a, b } from 'pkg-named';
        import value as V from 'pkg-as';
      `;

      expect(specifiers(source)).toEqual(['pkg', 'pkg-named', 'pkg-as']);
    });

    it('extracts side-effect imports with single and double quotes', () => {
      expect(specifiers(`import 'single';`)).toEqual(['single']);
      expect(specifiers(`import "double";`)).toEqual(['double']);
    });

    it('extracts import type', () => {
      expect(specifiers(`import type { Type } from 'pkg-type';`)).toEqual(['pkg-type']);
    });

    it('extracts re-export named and export type', () => {
      expect(specifiers(`export { value } from 'pkg-export';`)).toEqual(['pkg-export']);
      expect(specifiers(`export type { Type } from 'pkg-export-type';`)).toEqual([
        'pkg-export-type',
      ]);
    });

    it('extracts export * from', () => {
      expect(specifiers(`export * from 'pkg-star';`)).toEqual(['pkg-star']);
      expect(specifiers(`export * as ns from 'pkg-ns';`)).toEqual(['pkg-ns']);
    });

    it('extracts dynamic import with single and double quotes', () => {
      expect(specifiers(`import('dynamic-single');`)).toEqual(['dynamic-single']);
      expect(specifiers(`import ("dynamic-double");`)).toEqual(['dynamic-double']);
    });

    it('extracts require', () => {
      expect(specifiers(`const value = require('commonjs');`)).toEqual(['commonjs']);
    });

    it('extracts the CommonJS require inside a TypeScript import-equals', () => {
      expect(specifiers(`import value = require('ts-require');`)).toEqual(['ts-require']);
    });

    it('tolerates whitespace and newlines between tokens', () => {
      const source = `import\n  value\n  from   'whitespace-pkg' ;`;

      expect(specifiers(source)).toEqual(['whitespace-pkg']);
    });

    it('tolerates semicolonless code', () => {
      expect(specifiers(`import 'no-semicolon'`)).toEqual(['no-semicolon']);
    });

    it('preserves encounter order without deduplicating', () => {
      const source = `
        import 'zod';
        require('lodash');
        import 'zod';
      `;

      expect(specifiers(source)).toEqual(['zod', 'lodash', 'zod']);
    });

    it('handles a shebang line at the start of the file', () => {
      const source = `#!/usr/bin/env node\n\nimport 'after-hashbang';\n`;

      expect(specifiers(source)).toEqual(['after-hashbang']);
    });

    it('decodes string escapes to the semantic specifier value', () => {
      expect(specifiers(`import 'tab\\tand\\nnewline';`)).toEqual(['tab\tand\nnewline']);
      expect(specifiers(`import "back\\\\slash";`)).toEqual(['back\\slash']);
    });
  });

  describe('false positives must not be reported', () => {
    it('ignores specifiers inside line and block comments', () => {
      const source = `
        // require('fake-a')
        /* import x from 'fake-b' */
        /*
          import x from 'fake-b2';
        */
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('ignores specifiers inside ordinary string literals', () => {
      const source = `
        const a = "require('fake-c')";
        const b = 'import("fake-d")';
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('ignores specifiers inside template literals', () => {
      const source = `
        const template = \`
          import('fake-e')
          require('fake-f')
        \`;
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('ignores specifiers inside regex literals', () => {
      const source = `const matcher = /require\\('fake-e'\\)/;`;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats a plain division as division, not a regex', () => {
      const source = `const ratio = total / count;`;

      expect(specifiers(source)).toEqual([]);
    });

    it('ignores import.meta', () => {
      expect(specifiers(`import.meta.url;`)).toEqual([]);
    });

    it('ignores dynamic and require with a non-literal argument', () => {
      expect(specifiers(`import(variable);`)).toEqual([]);
      expect(specifiers(`require(variable);`)).toEqual([]);
    });

    it('ignores obj.require property access', () => {
      expect(specifiers(`obj.require('fake-h');`)).toEqual([]);
    });

    it('does not treat the word "important" as an import', () => {
      expect(specifiers(`const important = 1;`)).toEqual([]);
    });

    it('ignores template-literal specifiers in v0.1.0', () => {
      expect(specifiers(`import(\`pkg\`);`)).toEqual([]);
      expect(specifiers(`require(\`pkg\`);`)).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws ModuleSpecifierError on an unterminated single-quoted string', () => {
      expect(() => extractModuleSpecifiers(`import 'unterminated;`)).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on an unterminated double-quoted string', () => {
      expect(() => extractModuleSpecifiers(`import "unterminated;`)).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on an unterminated block comment', () => {
      expect(() => extractModuleSpecifiers(`/* never closed import 'x';`)).toThrow(
        ModuleSpecifierError,
      );
    });

    it('throws ModuleSpecifierError on an unterminated template literal', () => {
      expect(() => extractModuleSpecifiers('const t = `unclosed;')).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on a malformed string escape', () => {
      expect(() => extractModuleSpecifiers(`import 'bad\\q';`)).toThrow(ModuleSpecifierError);
    });

    it('exposes an error code and offset', () => {
      try {
        extractModuleSpecifiers(`import 'unterminated;`);
        throw new Error('expected throw');
      } catch (error) {
        expect(error).toBeInstanceOf(ModuleSpecifierError);
        expect((error as ModuleSpecifierError).code).toBe('invalid-source');
        expect(typeof (error as ModuleSpecifierError).offset).toBe('number');
      }
    });

    it('does not execute analyzed source', () => {
      // A side-effecting expression inside a string must never run.
      expect(specifiers(`const x = "require('not-run')";`)).toEqual([]);
    });
  });
});
