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

    it('scans JavaScript inside template interpolations', () => {
      expect(specifiers("const value = `${require('pkg')}`;")).toEqual(['pkg']);
      expect(specifiers("const other = `${import('other-pkg')}`;")).toEqual(['other-pkg']);
    });

    it('supports nested template interpolations', () => {
      // Outer template with a nested template whose expression contains a require.
      const source = "const x = `${ `x${require('nested')}` }`";

      expect(specifiers(source)).toEqual(['nested']);
    });

    it('does not let an object literal brace close the template interpolation', () => {
      const source = "const a = `${fn({ a: 1 }, require('pkg'))}`;";

      expect(specifiers(source)).toEqual(['pkg']);
    });

    it('does not let a function body brace close the template interpolation', () => {
      const source = "const b = `${(() => { return require('pkg'); })()}`;";

      expect(specifiers(source)).toEqual(['pkg']);

      // The interpolation stays open after the arrow body closes, so the later require still counts.
      const after = "const b = `${(() => { return 1; })() + require('pkg')}`;";

      expect(specifiers(after)).toEqual(['pkg']);
    });

    it('accepts a nested template with an apostrophe inside an interpolation', () => {
      const source = 'const c = `${f({}) + ' + '`' + "don't" + '`' + '}`;';

      expect(specifiers(source)).toEqual([]);
    });

    it('returns to template text when the interpolation itself closes', () => {
      // The `}` after `{}` closes the interpolation, so the text after it is template text.
      const source = "const d = `${ { a: 1 } }require('fake-interp')`;";

      expect(specifiers(source)).toEqual([]);
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

    it('keeps unrecognized non-decimal escapes unchanged', () => {
      expect(specifiers(`import 'a\\qb\\/c';`)).toEqual(['aqb/c']);
    });

    it('treats a backslash before U+2028 as a line continuation', () => {
      const source = `import 'a` + '\\' + String.fromCharCode(0x2028) + `b';`;
      expect(specifiers(source)).toEqual(['ab']);
    });

    it('keeps a raw U+2028 line separator inside a quoted string', () => {
      const lineSeparator = String.fromCharCode(0x2028);

      expect(specifiers(`import 'a${lineSeparator}b';`)).toEqual([`a${lineSeparator}b`]);
      expect(specifiers(`import "a${lineSeparator}b";`)).toEqual([`a${lineSeparator}b`]);
    });

    it('keeps a raw U+2029 paragraph separator inside a quoted string', () => {
      const paragraphSeparator = String.fromCharCode(0x2029);

      expect(specifiers(`import 'a${paragraphSeparator}b';`)).toEqual([`a${paragraphSeparator}b`]);
      expect(specifiers(`import "a${paragraphSeparator}b";`)).toEqual([`a${paragraphSeparator}b`]);
    });

    it('decodes legacy octal escapes instead of rejecting them', () => {
      expect(specifiers(`import '\\033[31m';`)).toEqual(['\u001b[31m']);
      expect(specifiers(`import '\\7';`)).toEqual(['\u0007']);
      expect(specifiers(`import '\\33';`)).toEqual(['\u001b']);
      expect(specifiers(`import '\\377';`)).toEqual(['\u00ff']);
      expect(specifiers(`import '\\1';`)).toEqual(['\u0001']);
    });

    it('decodes a lone NUL escape', () => {
      expect(specifiers(`import '\\0';`)).toEqual(['\u0000']);
    });

    it('decodes the non-octal decimal escapes as the digit itself', () => {
      expect(specifiers(`import '\\8';`)).toEqual(['8']);
      expect(specifiers(`import '\\9';`)).toEqual(['9']);
    });

    it('keeps extracting specifiers from a source containing legacy octal escapes', () => {
      const source = `
        const color = '\\033[31m';
        require('after-octal');
      `;

      expect(specifiers(source)).toEqual(['after-octal']);
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

    it('treats a slash after a template literal as division', () => {
      const source = 'const half = `' + '${n}' + '` / 2;';

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

    it('ignores obj.import member call', () => {
      expect(specifiers(`System.import('fake-system');`)).toEqual([]);
    });

    it('treats a regex after an expression-starting keyword as a regex', () => {
      expect(specifiers(`function isQuote(c) { return /["']/.test(c); }`)).toEqual([]);
    });

    it('treats a regex after a control-statement head as a regex', () => {
      expect(specifiers(`if (ok) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`while (ok) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`for (;;) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`with (o) /require('fake')/.test(value);`)).toEqual([]);
    });

    it('treats a regex after nested control-head parentheses as a regex', () => {
      expect(specifiers(`if ((ok)) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`if (isValid(value)) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`while (isValid(value)) /require('fake')/.test(value);`)).toEqual([]);
    });

    it('treats comments around a control head as whitespace', () => {
      expect(specifiers(`if /* comment */ (ok) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`if (ok) /* comment */ /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`for /* c */ (; 0; 1) /require('fake')/.test(value);`)).toEqual([]);
    });

    it('does not treat a nested closing paren as a control head', () => {
      expect(specifiers(`const ratio = fn((a), b) / 2;`)).toEqual([]);
      expect(specifiers(`const value = (total) / count;`)).toEqual([]);
    });

    it('treats a slash after a closing paren as division, not a regex', () => {
      expect(specifiers(`const ratio = total / count;`)).toEqual([]);
      expect(specifiers(`const value = fn() / 2;`)).toEqual([]);
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

    it('throws ModuleSpecifierError on a raw line terminator inside a single-quoted string', () => {
      expect(() => extractModuleSpecifiers("import 'pkg\nother';")).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on a raw line terminator inside a double-quoted string', () => {
      expect(() => extractModuleSpecifiers('import "pkg\nother";')).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on a raw CR inside a quoted string', () => {
      expect(() => extractModuleSpecifiers("import 'pkg\rother';")).toThrow(ModuleSpecifierError);
      expect(() => extractModuleSpecifiers('import "pkg\rother";')).toThrow(ModuleSpecifierError);
    });

    it('keeps a valid line continuation inside a quoted string', () => {
      expect(specifiers(`import 'line-` + '\\' + `continues';`)).toEqual(['line-continues']);
    });

    it('throws ModuleSpecifierError on an unterminated template literal', () => {
      expect(() => extractModuleSpecifiers('const t = `unclosed;')).toThrow(ModuleSpecifierError);
    });

    it('throws ModuleSpecifierError on a malformed hex escape', () => {
      expect(() => extractModuleSpecifiers(`import 'bad\\xZZ';`)).toThrow(ModuleSpecifierError);
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
