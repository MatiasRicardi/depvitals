import { spawnSync } from 'node:child_process';

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

/**
 * The same assertion with the bounded JSX mode enabled, as `.jsx`/`.tsx` files are analyzed.
 */
function jsxSpecifiers(source: string): string[] {
  return [...extractModuleSpecifiers(source, { jsx: true })].map((occ) => occ.specifier);
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

    it('extracts a require divided by an empty object literal', () => {
      // `{}` is an object literal, so both slashes divide and the call stays visible.
      expect(specifiers(`const value = {} / require('division-empty') / 2;`)).toEqual([
        'division-empty',
      ]);
    });

    it('extracts a require divided by an object literal without a second slash', () => {
      const source = `const value = {} / require('division-single');`;

      // The `/` after `}` divides, so no regex literal is opened and the scan does not fail.
      expect(() => extractModuleSpecifiers(source)).not.toThrow();
      expect(specifiers(source)).toEqual(['division-single']);
    });

    it('extracts a require divided by a populated object literal', () => {
      const source = `const value = { count: 1 } / require('division-populated') / 2;`;

      expect(specifiers(source)).toEqual(['division-populated']);
    });

    it('extracts a require divided by a nested object literal', () => {
      const source = `const value = { outer: { inner: {} } } / require('division-nested') / 2;`;

      expect(specifiers(source)).toEqual(['division-nested']);
    });

    it('extracts a require divided by an object literal inside a call argument', () => {
      const source = `const value = fn({ a: 1 } / require('division-argument') / 2);`;

      expect(specifiers(source)).toEqual(['division-argument']);
    });

    it('extracts specifiers around a regex literal that follows an object literal', () => {
      const source = `
        const value = {} / require('real-package') / 2;
        const matcher = /require\\('fake-package'\\)/;
        import 'another-package';
      `;

      expect(specifiers(source)).toEqual(['real-package', 'another-package']);
    });

    it('extracts a require divided by an object literal used as a property value', () => {
      // Inside an object literal a `:` separates a property from its value, so `{}` still ends an
      // expression and both slashes divide.
      const source = `const config = { scale: {} / require('division-property') / 2 };`;

      expect(specifiers(source)).toEqual(['division-property']);
    });

    it('extracts a require divided by a nested object literal used as a property value', () => {
      const source = `const config = { outer: { inner: {} / require('division-inner') / 2 } };`;

      expect(specifiers(source)).toEqual(['division-inner']);
    });

    it('extracts a require divided by a property value without a second slash', () => {
      const source = `const config = { scale: {} / require('division-property-single') };`;

      expect(() => extractModuleSpecifiers(source)).not.toThrow();
      expect(specifiers(source)).toEqual(['division-property-single']);
    });

    it('extracts a require divided by the object literal exported as default', () => {
      const source = `export default {} / require('division-default') / 2;`;

      expect(specifiers(source)).toEqual(['division-default']);
    });

    it('still recognizes a static call closed immediately after the string', () => {
      // Two adjacent static calls prove the closing paren is consumed as part of each call.
      expect(specifiers(`await import('pkg-a'); const b = require('pkg-b');`)).toEqual([
        'pkg-a',
        'pkg-b',
      ]);
    });

    it('finds specifiers after a line comment ended by CR, U+2028 or U+2029', () => {
      // Each terminator ends the `//` comment, so the require on the next line is real code.
      expect(specifiers(`// comment\rrequire('cr-comment');`)).toEqual(['cr-comment']);

      const lineSeparator = String.fromCharCode(0x2028);
      const paragraphSeparator = String.fromCharCode(0x2029);

      expect(specifiers(`// comment${lineSeparator}require('ls-comment');`)).toEqual([
        'ls-comment',
      ]);
      expect(specifiers(`// comment${paragraphSeparator}import 'ps-comment';`)).toEqual([
        'ps-comment',
      ]);
    });

    it('finds specifiers after a line comment ended by LF or CRLF', () => {
      // Preserved behavior for the existing line terminators.
      expect(specifiers(`// comment\nrequire('lf-comment');`)).toEqual(['lf-comment']);
      expect(specifiers(`// comment\r\nrequire('crlf-comment');`)).toEqual(['crlf-comment']);
    });

    it('extracts sources from clauses that bind a name called require', () => {
      // A binding named `require` must not stop the search for the `from` source.
      expect(extractModuleSpecifiers(`import { require } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'import' },
      ]);
      expect(extractModuleSpecifiers(`import { require as loader } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'import' },
      ]);
      expect(extractModuleSpecifiers(`export { require } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'export-from' },
      ]);
    });

    it('extracts sources from clauses that bind import or export as names', () => {
      // `import`/`export` are legal binding names inside a named clause, so they must not end the
      // search for the `from` source of the current statement.
      expect(extractModuleSpecifiers(`import { export as value } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'import' },
      ]);
      expect(extractModuleSpecifiers(`import { import as value } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'import' },
      ]);
      expect(extractModuleSpecifiers(`export { value as import } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'export-from' },
      ]);
      expect(extractModuleSpecifiers(`export { value as export } from 'pkg';`)).toEqual([
        { specifier: 'pkg', kind: 'export-from' },
      ]);
    });

    it('still stops at a real construct that follows the clause', () => {
      // Depth-0 boundaries keep working, including a direct require call inside a block body.
      expect(specifiers(`import { value } from 'a'; require('b');`)).toEqual(['a', 'b']);
      expect(specifiers(`export const run = () => { require('pkg'); };`)).toEqual(['pkg']);
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

    it('treats ECMAScript whitespace and line terminators as token separators', () => {
      // Built from code points so the sources contain the real characters.
      const noBreakSpace = String.fromCharCode(0x00a0);
      const lineSeparator = String.fromCharCode(0x2028);
      const paragraphSeparator = String.fromCharCode(0x2029);
      const byteOrderMark = String.fromCharCode(0xfeff);

      expect(specifiers(`require${noBreakSpace}('nbsp-require');`)).toEqual(['nbsp-require']);
      expect(specifiers(`import${noBreakSpace}'nbsp-import';`)).toEqual(['nbsp-import']);
      expect(specifiers(`require${lineSeparator}('ls-require');`)).toEqual(['ls-require']);
      expect(specifiers(`require${paragraphSeparator}('ps-require');`)).toEqual(['ps-require']);
      expect(specifiers(`${byteOrderMark}import 'bom-import';`)).toEqual(['bom-import']);
      expect(specifiers(`const value = require${byteOrderMark}('bom-require');`)).toEqual([
        'bom-require',
      ]);
    });

    it('keeps a division slash after a U+2028 separator a division', () => {
      // The separator must not become punctuation, or the `/` would look like a regex literal and
      // swallow the following import.
      const lineSeparator = String.fromCharCode(0x2028);
      const source = `const x = 4${lineSeparator}/ 2;\nimport 'after-ls-division';`;

      expect(specifiers(source)).toEqual(['after-ls-division']);
    });

    it('treats Unicode Space_Separator characters as token separators', () => {
      // Built from code points so the sources contain the real characters.
      const enSpace = String.fromCharCode(0x2002);
      const emSpace = String.fromCharCode(0x2003);
      const ideographicSpace = String.fromCharCode(0x3000);

      expect(specifiers(`require${emSpace}('em-space-require');`)).toEqual(['em-space-require']);
      expect(specifiers(`import${emSpace}'em-space-import';`)).toEqual(['em-space-import']);
      expect(specifiers(`require${enSpace}('en-space-require');`)).toEqual(['en-space-require']);
      expect(specifiers(`require${ideographicSpace}('ideographic-space-require');`)).toEqual([
        'ideographic-space-require',
      ]);
    });

    it('keeps a division slash after a Space_Separator a division', () => {
      const emSpace = String.fromCharCode(0x2003);
      const source = `const x = 4${emSpace}/ 2;\nimport 'after-em-division';`;

      expect(specifiers(source)).toEqual(['after-em-division']);
    });

    it('extracts a require in the body of a for await loop', () => {
      const source = `
        async function run(items) {
          for await (const item of items) {
            require('pkg');
          }
        }
      `;

      expect(specifiers(source)).toEqual(['pkg']);
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

  describe('Step 68.8: arrow frames and typed return boundaries', () => {
    // A body whose `/require('fake')/` decoy stays inert only while the enclosing signature is
    // async, so the extraction reports the context the scanner really inferred.
    const asyncBody = `{ await /require('fake')/; require('real'); }`;

    // Each case keeps a real usage after the decoy so a scanner that stops scanning at the
    // template frame cannot pass by accident.
    it.each([
      [
        'template punctuation',
        `const f = async () => \`,\` + require('inside') + (await /require('fake')/);`,
        ['inside'],
      ],
      [
        'template interpolation closure',
        "const f = async () => `${0}` + require('inside') + (await /require('fake')/);",
        ['inside'],
      ],
      [
        'template text preserves an ordinary arrow context',
        'async function outer() { const f = () => `,` + await / require("real") / 2; }',
        ['real'],
      ],
    ] as const)('keeps expression-arrow context across %s', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    it.each([
      [
        'JSX text',
        `const f = async () => <p>,</p> + require('inside') + (await /require('fake')/);`,
        ['inside'],
      ],
      [
        'sibling JSX expression containers',
        `const f = async () => (<p>{0}{require('inside')}{await /require('fake')/}</p>);`,
        ['inside'],
      ],
    ] as const)('keeps expression-arrow context across %s', (_name, source, expected) => {
      expect(jsxSpecifiers(source)).toEqual(expected);
    });

    it('recognizes a real require in an ordinary arrow inside a template', () => {
      expect(
        specifiers(
          'async function outer() { const t = `${(() => await / require("first") / 2)()},${await /require(\'fake\')/}`; require("after"); }',
        ),
      ).toEqual(['first', 'after']);
    });

    it('does not let an ordinary arrow in a JSX container inherit async context', () => {
      expect(
        jsxSpecifiers(
          `async function outer() { const view = (<p>{() => 0}{await /require('fake')/}</p>); require('real'); }`,
        ),
      ).toEqual(['real']);
    });

    it('does not scan a regex decoy after a typed async function return annotation', () => {
      const source = `async function check(): Promise<{ ok: boolean }> { const ok = await /don't/.test("don't"); require('inside'); return { ok }; } require('real');`;

      expect(() => extractModuleSpecifiers(source)).not.toThrow();
      expect(specifiers(source)).toEqual(['inside', 'real']);
    });

    // The `inside` usage proves the body is still scanned after the return annotation ends.
    it.each([
      [
        'typed async function declaration',
        `async function check(): Promise<{ ok: boolean }> { await /require('fake')/; require("inside"); return { ok: true }; } require("real");`,
        ['inside', 'real'],
      ],
      [
        'typed async arrow',
        `const check = async (): Promise<{ ok: boolean }> => { await /require('fake')/; require("inside"); return { ok: true }; }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'typed async method',
        `class C { async check(): Promise<{ ok: boolean }> { await /require('fake')/; require("inside"); return { ok: true }; } } require("real");`,
        ['inside', 'real'],
      ],
    ] as const)('does not inherit async through a %s return type', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    it('keeps division after a typed async function expression', () => {
      expect(
        specifiers(
          `const n = async function (): Promise<{ ok: boolean }> { return { ok: true }; } / require("real") / 2;`,
        ),
      ).toEqual(['real']);
    });

    it('preserves literal type imports inside a return annotation', () => {
      expect(
        specifiers(
          `async function load(): Promise<{ value: import("types-pkg").Value }> { await /require('fake')/; return null as never; } require("real");`,
        ),
      ).toEqual(['types-pkg', 'real']);
    });

    it.each([
      // Each case keeps a real usage inside the annotated body so a scanner that swallows the body
      // after the return annotation cannot pass by accident.
      [
        'generator return type',
        `function* values(): Generator<number> { yield /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'async generator return type',
        `async function* values(): AsyncGenerator<number> { await /require('fake')/; yield 1; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'nested ordinary function with a typed return',
        `async function outer() { function inner(await: number): { ok: boolean } { require("inside"); const n = await / require("real") / 2; return { ok: !!n }; } }`,
        ['inside', 'real'],
      ],
      [
        'typed async arrow expression body',
        `const check = async (): Promise<boolean> => await /require('fake')/ || require("inside"); require("real");`,
        ['inside', 'real'],
      ],
      [
        'callback function return type',
        `async function check(): () => void { await /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'typed class-field arrow',
        `class C { check = async (): Promise<{ ok: boolean }> => { await /require('fake')/; require("inside"); return { ok: true }; }; } require("real");`,
        ['inside', 'real'],
      ],
      [
        'object method with nested callback return type and semicolons',
        `const service = { async check(): Promise<{ readonly result?: { ok: boolean }; callback: (value: string) => { done: boolean } }> { await /require('fake')/; require("inside"); return null as never; } }; require("real");`,
        ['inside', 'real'],
      ],
    ] as const)('keeps typed %s boundaries', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    // The return annotation must end exactly where the runtime body begins, whatever the shape of
    // the annotated type.
    it.each([
      [
        'an intersection with an object type',
        `async function check(): Promise<void> & { ok: boolean } { await /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'a union with an object type',
        `async function check(): null | { ok: boolean } { await /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'a parenthesized object type',
        `async function check(): (Promise<{ ok: boolean }>) { await /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'a template literal type',
        "async function check(): `a${number}b` { await /require('fake')/; require('inside'); } require('real');",
        ['inside', 'real'],
      ],
      [
        'an alias of a template literal type',
        "type Name = `a${'x'}b`;\nasync function check(): Name { await /require('fake')/; require('inside'); } require('real');",
        ['inside', 'real'],
      ],
      [
        'a function type return on an arrow',
        `const make = (): () => void => { require("inside"); return () => 0; }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'a parenthesized function type return on an arrow',
        `const make = (): (() => void) => { require("inside"); return () => 0; }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'a parenthesized non-function type on an arrow',
        `const check = async (): (Promise<void>) => { await /require('fake')/; require("inside"); }; require("real");`,
        ['inside', 'real'],
      ],
    ] as const)('ends a return annotation of %s before the body', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    // A signature terminated by `;` must not keep its annotation alive for whatever follows.
    it.each([
      [
        'an async function declaration',
        `declare function check(): Promise<void>;\nasync function check(): Promise<void> { await /require('fake')/; require("inside"); } require("real");`,
        ['inside', 'real'],
      ],
      [
        'an async method implementation',
        `class C { check(): Promise<void>; async check(): Promise<void> { await /require('fake')/; require("inside"); } } require("real");`,
        ['inside', 'real'],
      ],
      [
        'an async function expression',
        `interface I { check(): void; }\nconst run = async function (): Promise<void> { await /require('fake')/; require("inside"); }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'an async arrow',
        `declare function check(): Promise<void>;\nconst run = async (): Promise<void> => { await /require('fake')/; require("inside"); }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'a following regular expression',
        `interface I { check(): void; }\nconst decoy = /require('fake')/;\nrequire('real');`,
        ['real'],
      ],
    ] as const)('ends a `;`-terminated signature before %s', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    it('ends a `;`-terminated signature before a JSX element', () => {
      expect(
        jsxSpecifiers(
          `declare function check(): Promise<void>;\nconst el = <p>hi</p>;\nrequire('real');`,
        ),
      ).toEqual(['real']);
    });

    // A `:` after a `)` is not a return annotation unless a plausible member precedes it.
    it.each([
      [
        'a ternary branch ending in a call',
        `const o = { x: cond ? f() : g(), async run(): Promise<void> { await /require('fake')/; require("inside"); } }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'a computed property key',
        `const o = { [key()]: 1, async run(): Promise<void> { await /require('fake')/; require("inside"); } }; require("real");`,
        ['inside', 'real'],
      ],
    ] as const)('does not start a return annotation at %s', (_name, source, expected) => {
      expect(specifiers(source)).toEqual(expected);
    });

    it.each([
      [
        'generic async arrow',
        `const check = async <T,>(value: T): Promise<T> => { await /require('fake')/; require("inside"); return value; }; require("real");`,
        ['inside', 'real'],
      ],
      [
        'generic async method',
        `class C { async check<T>(): Promise<T> { await /require('fake')/; require("inside"); } } require("real");`,
        ['inside', 'real'],
      ],
      [
        'generic async generator method',
        `class C { async *check<T>(): AsyncGenerator<T> { await /require('fake')/; yield 1; require("inside"); } } require("real");`,
        ['inside', 'real'],
      ],
    ] as const)(
      'keeps the async context of a %s with a return annotation',
      (_name, source, expected) => {
        expect(specifiers(source)).toEqual(expected);
      },
    );

    // The `:` of a conditional expression is never a return annotation, whatever the branch before
    // it holds: the candidate member has to start at a real member position, not at the tail of an
    // expression such as `new F()`, `typeof f()` or `2 * f()`.
    it.each([
      [
        'a `new` branch',
        `const o = {
  x: cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a `typeof` branch',
        `const o = {
  x: cond ? typeof f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a `void` branch',
        `const o = {
  x: cond ? void f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a multiplication branch',
        `const o = {
  x: cond ? 2 * f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'an `await` branch inside an async function',
        `async function outer() {
  const o = {
    x: cond ? await f() : async () => {
      await /require('fake')/;
      require('real');
    }
  };
}`,
        ['real'],
      ],
      [
        'a class field ternary',
        `class C {
  field = cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  };
}`,
        ['real'],
      ],
      [
        'a computed property key ternary',
        `const o = {
  [cond ? new F() : async () => {
    await /require('fake')/;
    require('real');
  }]: 1
};`,
        ['real'],
      ],
      [
        'an `async` call branch',
        `const o = {
  x: cond ? async f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a member call branch',
        `const o = {
  x: cond ? a?.b['c'](1) : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a sequence expression branch',
        `const o = {
  x: cond ? (1, 2) : async () => {
    await /require('fake')/;
    require('real');
  }
};`,
        ['real'],
      ],
      [
        'a multi-line `new` branch',
        `const o = {
  x: cond
    ? new F()
    : async () => {
        await /require('fake')/;
        require('real');
      }
};`,
        ['real'],
      ],
    ] as const)(
      'does not treat the colon of %s as a return annotation',
      (_name, source, expected) => {
        expect(specifiers(source)).toEqual(expected);
      },
    );

    // Modifiers, decorators and computed names still describe a real member, so the async context
    // of their typed signatures survives.
    it.each([
      ['an object method', `const o = { async check(): Promise<void> ${asyncBody} };`],
      ['a static async method', `class C { static async check(): Promise<void> ${asyncBody} }`],
      [
        'an override async method',
        `class C { override async check(): Promise<void> ${asyncBody} }`,
      ],
      [
        'an async generator method',
        `class C { async *check(): AsyncGenerator<void> { await /require('fake')/; yield; require('real'); } }`,
      ],
      ['a decorated async method', `class C { @dec async check(): Promise<void> ${asyncBody} }`],
      [
        'a decorated call async method',
        `class C { @dec(1) async check(): Promise<void> ${asyncBody} }`,
      ],
      [
        'a parenthesized decorator async method',
        `class C { @(dec) async check(): Promise<void> ${asyncBody} }`,
      ],
      [
        'a member decorator async method',
        `class C { @a.b async check(): Promise<void> ${asyncBody} }`,
      ],
      [
        'two decorators on an async method',
        `class C { @a @b async check(): Promise<void> ${asyncBody} }`,
      ],
      ['a computed async method', `const o = { async [k](): Promise<void> ${asyncBody} }`],
      [
        'a computed async method with a nested key',
        `const o = { async [a[0]](): Promise<void> ${asyncBody} }`,
      ],
    ] as const)('keeps the async context of %s', (_name, source) => {
      expect(specifiers(source)).toEqual(['real']);
    });

    // A decorator elsewhere in the class body does not make an expression colon a signature.
    it('does not treat the colon of a decorated class field as a return annotation', () => {
      const source = `class C {
  @dec
  field = cond ? a.b() : async () => {
    await /require('fake')/;
    require('real');
  };
}`;

      expect(specifiers(source)).toEqual(['real']);
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

    it('ignores a regex used as an object literal property value', () => {
      expect(specifiers(`const config = { re: /require\\('fake-prop'\\)/, n: 1 };`)).toEqual([]);
    });

    it('treats a regex after a statement block as a regex', () => {
      // The `}` closes a block, so the following `/` starts a regex literal again.
      const source = `
        if (ready) {
          doSomething();
        }

        /require\\('fake-block'\\)/.test(value);
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats a regex after a function, class or arrow body as a regex', () => {
      const fn = `
        function prepare() { load(); }

        /require\\('fake-fn'\\)/.test(value);
      `;
      const klass = `
        class Service { run() {} }

        /require\\('fake-class'\\)/.test(value);
      `;
      const arrow = `const handler = () => { doWork(); };

        /require\\('fake-arrow'\\)/.test(value);
      `;

      expect(specifiers(fn)).toEqual([]);
      expect(specifiers(klass)).toEqual([]);
      expect(specifiers(arrow)).toEqual([]);
    });

    it('treats a regex after a nested or adjacent block as a regex', () => {
      expect(
        specifiers(`if (a) { if (b) { c(); } }\n/require\\('fake-nested'\\)/.test(v);`),
      ).toEqual([]);
      expect(
        specifiers(`if (a) { b(); } else { c(); }\n/require\\('fake-else'\\)/.test(v);`),
      ).toEqual([]);
      expect(
        specifiers(`try { work(); } catch (e) {}\n/require\\('fake-try'\\)/.test(v);`),
      ).toEqual([]);
    });

    it('treats a regex after an unmatched closing brace as a regex', () => {
      // A fragment source keeps the conservative behaviour: an unknown brace is not an object.
      expect(specifiers(`}\n/require\\('fake-stray'\\)/.test(v);`)).toEqual([]);
    });

    it('treats a regex after a labeled block as a regex', () => {
      // A `:` that labels a statement is not a property separator, so `{}` is a block.
      expect(specifiers(`label: {}\n/require\\('fake-label'\\)/.test(value);`)).toEqual([]);
    });

    it('ignores a template literal ? before a labeled block and regex', () => {
      // A `?` inside template text is inert: it must never enter conditionalContexts, so the
      // trailing `label: {}` stays a block and the following `/` starts a regex, not a division.
      // `label: {}` is always a block, so this form always reports no dependency. A leaked template
      // `?` would instead classify `{}` as an object, turn the `/` into a division and report a
      // false dependency; the line break (no `;`) is exactly the case that would expose such a leak.
      const withTemplate = `let note = \`value ? more\`\nlabel: {} /require('fake-template') / 2;`;
      const withoutTemplate = `label: {} /require('fake-template') / 2;`;

      expect(specifiers(withTemplate)).toEqual([]);
      // The template must not change behavior: the no-template form is equally empty.
      expect(specifiers(withoutTemplate)).toEqual([]);
      // Positive control: an object literal followed by a real division is detected, so the empty
      // results above are meaningful and are not just the scanner refusing to report anything.
      expect(specifiers(`const o = {} / require('real-division') / 2;`)).toEqual(['real-division']);
    });

    it('still reports a real division after a labeled block even with a template ? present', () => {
      // Positive control: an object literal followed by a real division is detected, and a
      // preceding template `?` does not suppress it.
      const withTemplate = `let note = \`a ? b\`; const o = {} / require('real-template-division') / 2;`;
      const withoutTemplate = `const o = {} / require('real-template-division') / 2;`;

      expect(specifiers(withTemplate)).toEqual(['real-template-division']);
      expect(specifiers(withoutTemplate)).toEqual(['real-template-division']);
    });

    it('treats a regex after a switch block as a regex', () => {
      const clauses = `
        switch (kind) {
          case 'x': {
            doWork();
          }
        }

        /require\\('fake-switch'\\)/.test(value);
      `;
      const defaultClause = `
        switch (kind) {
          default: {}
          /require\\('fake-default-clause'\\)/.test(value);
        }
      `;

      expect(specifiers(clauses)).toEqual([]);
      expect(specifiers(defaultClause)).toEqual([]);
    });

    it('treats a regex exported as the default value as a regex', () => {
      // `default` needs an expression, so the `/` opens a regex literal rather than dividing.
      expect(specifiers(`export default /require\\('fake-default-regex'\\)/.test(value);`)).toEqual(
        [],
      );
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

    it('ignores a dynamic import whose argument is a concatenation', () => {
      // The string is not the whole argument, so nothing is statically known.
      expect(specifiers(`import('pkg-' + name);`)).toEqual([]);
    });

    it('ignores a require whose argument is a concatenation', () => {
      expect(specifiers(`const value = require('pkg-' + name);`)).toEqual([]);
    });

    it('ignores require and dynamic import with extra arguments', () => {
      // Only `keyword ( STRING )` is static, so a trailing argument disqualifies the call.
      expect(specifiers(`require('pkg', other);`)).toEqual([]);
      expect(specifiers(`import('pkg', options);`)).toEqual([]);
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

    it('treats a regex after a for await control head as a regex', () => {
      // `await` sits between `for` and its `(`, so the head still ends at that `)` and the slash
      // that follows starts a regex literal, not a division.
      const source = `
        async function run(items) {
          for await (const item of items)
            /require('fake')/.test(item);
        }
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats a regex after nested control-head parentheses as a regex', () => {
      expect(specifiers(`if ((ok)) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`if (isValid(value)) /require('fake')/.test(value);`)).toEqual([]);
      expect(specifiers(`while (isValid(value)) /require('fake')/.test(value);`)).toEqual([]);
    });

    it('does not treat control keywords used as member properties as control heads', () => {
      // The real `if` head ends after `obj.while(x)`, so the following `/` starts a regex literal.
      expect(specifiers(`if (obj.while(x)) /require('fake')/.test(value);`)).toEqual([]);
      // Inside the `if` head the `/` is division, so the require stays visible.
      expect(specifiers(`if (obj.while(x) / require('pkg')) {}`)).toEqual(['pkg']);
      // A member call is not a control head at all, so the following `/` stays division.
      expect(specifiers(`obj.if(ok) / require('pkg') / 2;`)).toEqual(['pkg']);
      expect(specifiers(`obj.for(ok) / require('pkg') / 2;`)).toEqual(['pkg']);
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

  describe('async/generator keyword vs regex/division boundary', () => {
    it('treats await as a keyword (regex) inside an async function declaration', () => {
      const source = `async function f(){ await /require('fake')/; require('real'); }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats yield as a keyword (regex) inside a generator function declaration', () => {
      const source = `function* f(){ yield /require('fake')/; require('real'); }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats yield* (regex) inside a generator function declaration', () => {
      const source = `function* f(){ yield* /require('fake')/; require('real'); }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats await as a keyword (regex) inside a nested async function', () => {
      const source = `async function f(){ const r = await /require('fake')/; return r; }`;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats yield as a keyword (regex) inside a nested generator function', () => {
      const source = `function* f(){ const r = yield /require('fake')/; return r; }`;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats a bare await as division (require visible) inside an ordinary function', () => {
      const source = `function f(await){ return await / require('real') / 2; }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a bare yield as division (require visible) inside an ordinary function', () => {
      const source = `function f(yield){ return yield / require('real') / 2; }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('does not leak an inner async context to an enclosing ordinary function', () => {
      // The inner `await` is a keyword (regex); the outer `await` is division.
      const source = `
        function outer(){
          async function inner(){ await /require('fake')/; }
          return await / require('real') / 2;
        };
      `;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('does not leak an inner generator context to an enclosing ordinary function', () => {
      const source = `
        function outer(){
          function* inner(){ yield /require('fake')/; }
          return yield / require('real') / 2;
        };
      `;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('keeps await as a keyword across a nested statement inside the async function', () => {
      const source = `
        async function f(){
          const x = 1;
          const r = await /require('fake')/;
          return r;
        }
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('treats await as a keyword after an else branch inside an async function', () => {
      const source = `
        async function f(cond){
          if (cond) { const a = 1; }
          else { const b = 2; }
          return await /require('fake')/;
        }
      `;

      expect(specifiers(source)).toEqual([]);
    });
  });

  describe('function expression used as a value before a division', () => {
    it('treats a slash after a function-expression body as division', () => {
      const source = `const n = function() {} / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a slash after a named function-expression body as division', () => {
      const source = `const n = function named() {} / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a slash after an arrow-expression body as division', () => {
      const source = `const n = (() => {}) / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a slash after an object literal as division', () => {
      const source = `const n = {} / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a slash after a function declaration body as a regex', () => {
      // A declaration in statement position keeps the existing regex-after-`}` behaviour.
      const source = `
        function prepare() { load(); }
        /require\\('fake-fn'\\)/.test(value);
      `;

      expect(specifiers(source)).toEqual([]);
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

    it('throws ModuleSpecifierError on an unterminated regex literal', () => {
      // A `/` that opens a regex literal but is never closed must fail conservatively rather than
      // silently producing a clean report. The import-like text inside it is never usage evidence.
      expect(() => extractModuleSpecifiers(`const r = /import("pkg";`)).toThrow(
        ModuleSpecifierError,
      );
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

  describe('async arrows and async/generator methods', () => {
    const keywordBodies: readonly (readonly [string, string])[] = [
      [
        'an async arrow with a parameter list',
        `const f = async () => { await /require('fake')/; };`,
      ],
      [
        'an async arrow with one bare parameter',
        `const f = async x => { await /require('fake')/; };`,
      ],
      ['an async arrow passed as an argument', `foo(async () => { await /require('fake')/; });`],
      ['an async method', `const o = { async run() { await /require('fake')/; } };`],
      ['a generator method', `const o = { *run() { yield /require('fake')/; } };`],
      ['an async generator method', `const o = { async *run() { await /require('fake')/; } };`],
      ['an async class method', `class C { async run() { await /require('fake')/; } }`],
    ];

    for (const [label, source] of keywordBodies) {
      it(`treats await/yield as a keyword in ${label}`, () => {
        expect(specifiers(source)).toEqual([]);
      });
    }

    it('keeps a real require inside an async arrow body', () => {
      expect(specifiers(`const f = async () => { require('real'); };`)).toEqual(['real']);
    });

    it('does not read a control-statement head as a method signature', () => {
      // `if (cond) {` has the same token shape as `name() {`, so only an `async`/`*` marker may
      // open a function context; otherwise the enclosing async body would be lost here.
      expect(specifiers(`async function f(){ if (c) { await /require('fake')/; } }`)).toEqual([]);
      expect(specifiers(`while (c) { require('real'); }`)).toEqual(['real']);
    });

    it('suspends the enclosing async context inside an ordinary nested arrow', () => {
      // An ordinary arrow is its own function boundary, so await is an identifier and the slashes
      // are division in its body.
      const source = `async function f(){ const g = () => { await /require('fake')/; }; }`;

      expect(specifiers(source)).toEqual(['fake']);
    });

    it('finds a require divided by await in an ordinary function nested in async code', () => {
      const source = `async function outer(){ function inner(await){ return await / require('real') / 2; } }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('finds a require divided by yield in an ordinary function nested in generator code', () => {
      const source = `function* outer(){ function inner(yield){ return yield / require('real') / 2; } }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats await as an identifier in an ordinary method nested in async code', () => {
      const source = `async function outer(){ const object = { inner() { return await /require('fake')/; } }; }`;

      expect(specifiers(source)).toEqual(['fake']);
    });

    it('does not leak an inner async arrow context to the enclosing ordinary function', () => {
      const source = `function f(){ const g = async () => { await /require('fake')/; }; return await / require('real') / 2; }`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a declaration after a line-terminated `async` as an ordinary function', () => {
      // A line terminator ends the `async` statement, so the declaration below is not async and
      // `await` is an ordinary identifier, which makes both slashes divisions.
      const source = `async\nfunction f() {\n  return await / require('real') / 2;\n}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats an arrow after a line-terminated `async` as an ordinary arrow', () => {
      // A line terminator between `async` and the arrow parameters means the arrow is not async,
      // so `await` is an ordinary identifier and the slashes are divisions, not a regex decoy.
      const source = `async\nx => await / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });
  });

  describe('async arrow expression bodies and module await', () => {
    it('does not scan a regex decoy in an async arrow expression body', () => {
      const source = `
        const first = async () => await /require('fake')/;
        const second = async (value) => await /require('fake')/;
        const third = async () => await /require('fake')/;
        require('after');
      `;

      expect(specifiers(source)).toEqual(['after']);
    });

    it('uses an async expression arrow inside an ordinary function as the nearest context', () => {
      const source = `
        function outer() {
          const nested = async () => await /require('fake')/;
          require('real');
        }
      `;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('uses an ordinary expression arrow inside an async function as the nearest context', () => {
      const source = `
        async function outer() {
          const nested = () => await / require('real') / 2;
        }
      `;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('keeps an outer async arrow active across a nested arrow parameter list', () => {
      const source = `
        const nested = async () => (() => 1, await /require('fake')/);
        require('after');
      `;

      expect(specifiers(source)).toEqual(['after']);
    });

    it('ends every nested expression-arrow context at their shared boundary', () => {
      const source = `
        const nested = async () => value => await / require('inside') / 2;
        await / require('after') / 2;
      `;

      expect(specifiers(source)).toEqual(['inside', 'after']);
    });

    it('ends an async arrow expression at a call argument boundary', () => {
      const source = `call(async () => await /require('fake')/, () => require('real'));`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('ends expression arrows at enclosing call, array and object boundaries', () => {
      const call = `foo(async () => 1); async function f(){ await /require('fake')/; }`;
      const array = `[value => value]; await /require('fake')/;`;
      const object = `({ f: value => value }); await /require('fake')/;`;

      expect(specifiers(call)).toEqual([]);
      expect(
        extractModuleSpecifiers(array, { module: true }).map(({ specifier }) => specifier),
      ).toEqual([]);
      expect(
        extractModuleSpecifiers(object, { module: true }).map(({ specifier }) => specifier),
      ).toEqual([]);
    });

    it('keeps an async expression arrow active across nested calls and indexes', () => {
      const source = `
        const first = async () => foo(value) + await /require('fake-call')/;
        const second = async () => values[index] && await /require('fake-index')/;
      `;

      expect(specifiers(source)).toEqual([]);
    });

    it('ends an expression arrow at ASI and enclosing-brace boundaries', () => {
      const asi = `
        const f = async () => 1
        await / require('after-asi') / 2;
      `;
      const brace = `
        if (condition) { const f = async () => 1 }
        await / require('after-brace') / 2;
      `;

      expect(specifiers(asi)).toEqual(['after-asi']);
      expect(specifiers(brace)).toEqual(['after-brace']);
    });

    it('recognizes a commented block arrow without leaking an expression context', () => {
      const source = `
        const f = async () => /* block body follows */ {}
        await / require('real') / 2;
      `;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats top-level await as a keyword only in module mode', () => {
      const source = `await /require('fake')/; require('after');`;

      expect(specifiers(source)).toEqual(['fake', 'after']);
      expect(
        extractModuleSpecifiers(source, { module: true }).map(({ specifier }) => specifier),
      ).toEqual(['after']);
    });

    it('keeps CommonJS script behavior as the default', () => {
      expect(specifiers(`await / require('real') / 2;`)).toEqual(['real']);
    });
  });

  describe('async signature boundaries', () => {
    const lineTerminators = [
      ['LF', '\n'],
      ['CR', '\r'],
      ['CRLF', '\r\n'],
      ['LS', '\u2028'],
      ['PS', '\u2029'],
    ] as const;
    const bodies = [
      ['expression', `await / require('real') / 2`],
      ['block', `{ return await / require('real') / 2; }`],
    ] as const;

    for (const [bodyName, body] of bodies) {
      for (const [name, newline] of lineTerminators) {
        it.each([newline, ` /*${newline}*/ `])(
          `keeps a ${bodyName} arrow ordinary after ${name} in %j`,
          (separator) => {
            expect(specifiers(`async${separator}x => ${body}; require('after');`)).toEqual([
              'real',
              'after',
            ]);
          },
        );
      }

      it(`keeps a ${bodyName} arrow ordinary after a line comment`, () => {
        expect(specifiers(`async // note\nx => ${body}; require('after');`)).toEqual([
          'real',
          'after',
        ]);
      });
    }

    for (const [bodyName, body] of [
      ['expression', `await /require('fake')/`],
      ['block', `{ return await /require('fake')/; }`],
    ] as const) {
      it.each([
        'x',
        '(x)',
        '/* note */ x',
        '/* note */ (x)',
        '(\n x\n)',
        '( /*\n*/ x)',
        ...lineTerminators.map(([, newline]) => `(${newline}x${newline})`),
      ])(`preserves async for a ${bodyName} arrow with parameters %j`, (parameters) => {
        const source = `const f = async ${parameters} => ${body}; require('after');`;

        expect(specifiers(source)).toEqual(['after']);
      });

      it(`restores ordinary await after an async ${bodyName} arrow`, () => {
        expect(specifiers(`const f = async x => ${body}; await / require('after') / 2;`)).toEqual([
          'after',
        ]);
      });
    }

    it('keeps a parenthesized block arrow ordinary after a separate async statement', () => {
      expect(specifiers(`async;\n(x) => { return await / require('real') / 2; };`)).toEqual([
        'real',
      ]);
    });

    it.each([
      `const n = async function () {} / require('real') / 2;`,
      `const n = async function named() {} / require('real') / 2;`,
      `const n = function () {} / require('real') / 2;`,
      `const n = (async function () {}) / require('real') / 2;`,
      `const n = async /* note */ function () {} / require('real') / 2;`,
      `const n = async \t function named() {} / require('real') / 2;`,
      `function outer() { return async function () {} / require('real') / 2; }`,
      `export default (async function () {} / require('real') / 2);`,
    ])('preserves function expression division in %s', (source) => {
      expect(specifiers(source)).toEqual(['real']);
    });

    it.each([
      `async function declared() {}\n/require('fake')/.test('');`,
      `function declared() {}\n/require('fake')/.test('');`,
      `async /* note */ function declared() {}\n/require('fake')/.test('');`,
      `async\nfunction declared() {}\n/require('fake')/.test('');`,
      `async /*\n*/ function declared() {}\n/require('fake')/.test('');`,
      `export default async function declared() {}\n/require('fake')/.test('');`,
    ])('preserves regex after a function declaration in %s', (source) => {
      expect(specifiers(`${source} require('after');`)).toEqual(['after']);
    });
  });

  describe('Step 68.7 nested signatures', () => {
    const cases = [
      [
        'default function callback',
        `async function outer(cb = function () {}) { await /require('fake')/; }`,
        [],
      ],
      [
        'default block arrow callback',
        `async function outer(cb = () => {}) { await /require('fake')/; }`,
        [],
      ],
      [
        'valid apostrophe regex and real require',
        `async function outer(cb = function () {}) { await /don't/; require("real"); }`,
        ['real'],
      ],
      [
        'nested callback default',
        `async function outer(cb = function inner(value = function () {}) {}) {
          await /require('fake')/;
        }`,
        [],
      ],
      [
        'callback and outer body evidence',
        `async function outer(cb = function () { require("default-real"); }) {
          await /require('fake')/;
          require("body-real");
        }`,
        ['default-real', 'body-real'],
      ],
      [
        'async callback does not inherit outer context',
        `async function outer(cb = async function () { await /require('fake-inner')/; }) {
          await /require('fake-outer')/;
          require("real");
        }`,
        ['real'],
      ],
      [
        'ordinary outer function with async callback',
        `function outer(cb = async function () { await /require('fake-inner')/; }) {
          return await / require("real") / 2;
        }`,
        ['real'],
      ],
      [
        'async generator with callback defaults',
        `async function* outer(cb = function () {}) {
          await /require('fake-await')/;
          yield /require('fake-yield')/;
          require("real");
        }`,
        ['real'],
      ],
      [
        'async function expression with callback default',
        `const outer = async function (cb = function () {}) { await /require('fake')/; };`,
        [],
      ],
      [
        'object and destructuring defaults',
        `async function outer(options = {}, { value } = {}) { await /require('fake')/; }`,
        [],
      ],
      [
        'expression arrow default',
        `async function outer(cb = () => 0) { await /require('fake')/; }`,
        [],
      ],
      [
        'async arrow with callback default',
        `const outer = async (cb = function () {}) => { await /require('fake')/; };`,
        [],
      ],
    ] as const;

    it.each(cases)('%s', (_name, source, expected) => {
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(syntax.error).toBeUndefined();
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(specifiers(source)).toEqual(expected);
    });
  });

  describe('Step 68.7 function expressions after colons', () => {
    const cases = [
      ['ordinary property', `const obj = { f: function () {} / require("real") / 2 };`, ['real']],
      [
        'async property',
        `const obj = { f: async function () {} / require("real") / 2 };`,
        ['real'],
      ],
      [
        'ordinary conditional alternative',
        `const n = flag ? function () {} : function () {} / require("real") / 2;`,
        ['real'],
      ],
      [
        'async conditional alternative',
        `const n = flag ? function () {} : async function () {} / require("real") / 2;`,
        ['real'],
      ],
      [
        'computed async property',
        `const obj = { ['f']: async function () {} / require("real") / 2 };`,
        ['real'],
      ],
      [
        'nested conditional',
        `const n = a ? (b ? 1 : function () {} / require('first') / 2)
          : async function () {} / require('second') / 2;`,
        ['first', 'second'],
      ],
      [
        'labeled block remains a regex',
        `label: {} /require('fake')/.test(text); require("real");`,
        ['real'],
      ],
      [
        'case and default blocks remain regexes',
        `switch (kind) {
          case 1: {} /require('fake-case')/.test(text); break;
          default: {} /require('fake-default')/.test(text);
        } require("real");`,
        ['real'],
      ],
      [
        'control statements inside an async property function',
        `const obj = { f: async function () {
          if (ok) /require('fake-head')/.test(text);
          if (ok) { await /require('fake-block')/; }
        } / require('real') / 2 };`,
        ['real'],
      ],
    ] as const;

    it.each(cases)('%s', (_name, source, expected) => {
      const syntax = spawnSync(process.execPath, ['--check', '--input-type=commonjs'], {
        input: source,
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(syntax.error).toBeUndefined();
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(specifiers(source)).toEqual(expected);
    });
  });

  describe('ordinary method function boundaries', () => {
    it.each([
      ['number field', 'value = 1'],
      ['string field', "value = 'text'"],
      ['array field', 'value = []'],
      ['call field', 'value = getValue()'],
    ])('recognizes an async method after a newline-terminated %s', (_label, field) => {
      const source = `class C {
  ${field}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it.each([
      [
        'without a return annotation',
        `class C {
  value = 1
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      ],
      [
        'with a return annotation',
        `class C {
  value = 1
  async run(): Promise<void> {
    await /require('fake')/;
    require('real');
  }
}`,
      ],
      [
        'with an explicit semicolon',
        `class C {
  value = 1;
  async run() {
    await /require('fake')/;
    require('real');
  }
}`,
      ],
    ])('keeps only the real require for a class method %s', (_label, source) => {
      expect(specifiers(source)).toEqual(['real']);
    });

    it('does not parse an apostrophe in a regex as an unterminated string', () => {
      const source = `class C {
  value = 1
  async run() {
    await /don't/;
    require('real');
  }
}`;

      expect(() => specifiers(source)).not.toThrow();
      expect(specifiers(source)).toEqual(['real']);
    });

    it('recognizes the boundary after a static initialization block', () => {
      const source = `class C {
  static {}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('does not split a class field after an operator that needs an operand', () => {
      const sources = ['new', 'typeof', 'void'].map(
        (operator) => `class C {
  value = cond ? ${operator}
    F() : async () => {
      await /require('fake')/;
      require('real');
    };
}`,
      );

      for (const source of sources) {
        expect(specifiers(source)).toEqual(['real']);
      }
    });

    it.each([
      ['a regex initializer', '/abc/'],
      ['a template initializer', '`require("fake")`'],
    ])('recognizes the boundary after %s', (_label, initializer) => {
      const source = `class C {
  value = ${initializer}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('keeps code in a template interpolation while ending the field correctly', () => {
      const source = `class C {
  value = \`text \${require('template-real')}\`
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['template-real', 'real']);
    });

    it('recognizes a generator after a field without an initializer', () => {
      const source = `class C {
  value
  *run() {
    yield /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats of as an initializer value before an async method', () => {
      const source = `const of = 1;
class C {
  value = of
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('recognizes an uninitialized field named of before an async method', () => {
      const source = `class C {
  of
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it.each([
      ['a definite-assignment typed field', 'value!: number'],
      ['a typed field', 'value: number'],
      ['a private field', '#value'],
      ['a computed field', '[key]'],
    ])('recognizes a generator after %s without an initializer', (_label, field) => {
      const source = `const key = 'value';
class C {
  ${field}
  *run() {
    yield /require('fake')/;
    require('real');
  }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it.each(['get', 'set', 'async'])(
      'does not consume %s when it is the preceding field initializer',
      (initializer) => {
        const source = `const ${initializer} = () => 0;
class C {
  value = ${initializer}
  async run() {
    await /require('fake')/;
    require('real');
  }
}`;

        expect(specifiers(source)).toEqual(['real']);
      },
    );

    it.each([
      ['an empty object', '{}'],
      ['a populated object', '{ x: 1 }'],
    ])(
      'does not treat a multiplication operand closing brace as a member separator for %s',
      (_label, object) => {
        const source = `const o = {
  x: cond ? ${object} * f() : async () => {
    await /require('fake')/;
    require('real');
  }
};`;

        expect(specifiers(source)).toEqual(['real']);
      },
    );

    it.each([
      [
        'a class field ternary',
        `class C {
  value = cond ? {} * f() : async () => {
    await /require('fake')/;
    require('real');
  }
}`,
      ],
      [
        'a computed object key ternary',
        `const o = {
  [cond ? {} * f() : async () => {
    await /require('fake')/;
    require('real');
  }]: 1
};`,
      ],
    ])('keeps the decoy regex inert in %s', (_label, source) => {
      expect(specifiers(source)).toEqual(['real']);
    });

    it('does not turn a line-continued multiplication into a generator boundary', () => {
      const source = `class C {
  value = cond ? {}
    * f() : async () => {
      await /require('fake')/;
      require('real');
    }
}`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('preserves a legitimate generator method and multiplication control', () => {
      expect(
        specifiers(
          `const o = {
  *run() {
    yield /require('fake')/;
    require('real');
  }
};
const n = 2 * f();`,
        ),
      ).toEqual(['real']);
    });

    it('suspends outer async grammar in computed-name and keyword-named methods', () => {
      const source = `
        async function outer() {
          const object = {
            [name](await) { return await / require('computed') / 2; },
            if(await) { return await / require('keyword') / 2; }
          };

          class Example {
            [name](await) { return await / require('computed-class') / 2; }
            if(await) { return await / require('keyword-class') / 2; }
          }
        }
      `;

      expect(specifiers(source)).toEqual([
        'computed',
        'keyword',
        'computed-class',
        'keyword-class',
      ]);
    });

    it('does not treat a for-await loop body as an ordinary method', () => {
      const source = `
        async function outer(values) {
          for await (const value of values) {
            await /require('fake')/;
          }
        }
      `;

      expect(specifiers(source)).toEqual([]);
    });
  });

  describe('await/yield as identifiers and member names', () => {
    it('treats a slash after an `await` member access as division', () => {
      const source = `const o = {await: 12}; o.await / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('treats a slash after a `yield` member access as division', () => {
      const source = `const o = {yield: 12}; o.yield / require('real') / 2;`;

      expect(specifiers(source)).toEqual(['real']);
    });

    it('still reads a regex argument of an `await` member call', () => {
      const source = `const o = {}; o.await(/require('fake')/);`;

      expect(specifiers(source)).toEqual([]);
    });

    it('still reads a regex argument of a `yield` member call', () => {
      const source = `const o = {}; o.yield(/require('fake')/);`;

      expect(specifiers(source)).toEqual([]);
    });
  });

  describe('spread of a call result', () => {
    it('reads a required specifier spread into an object literal', () => {
      expect(specifiers(`const o = {...require('real')};`)).toEqual(['real']);
    });

    it('still ignores a member call named require', () => {
      expect(specifiers(`const o = {...obj.require('fake')};`)).toEqual([]);
    });
  });

  describe('jsx mode', () => {
    it('is off by default, so JSX is read as JavaScript', () => {
      // `</div>` opens an unterminated regex literal when the source is read as plain JavaScript.
      expect(() => extractModuleSpecifiers(`const a = <div>Hello</div>;`)).toThrow(
        ModuleSpecifierError,
      );
    });

    describe('inert markup', () => {
      const inert: readonly (readonly [string, string])[] = [
        ['an element with text', `const a = <div>Hello</div>;`],
        ['text containing an apostrophe', `const a = <div>don't</div>;`],
        ['a self-closing element', `const a = <div />;`],
        ['a fragment with siblings', `const a = <><span>A</span><span>B</span></>;`],
        ['a member-expression tag', `const a = <UI.Panel title="don't" />;`],
        ['a namespaced tag', `const a = <svg:rect x='1' />;`],
        ['a dashed tag and a boolean attribute', `const a = <my-tag data-x>text</my-tag>;`],
        ['require-looking text', `const a = <div>require('fake')</div>;`],
        ['a require-looking attribute', `const a = <div title="require('fake')" />;`],
        ['an import-looking attribute', `const a = <div title="import 'fake'" />;`],
        [
          'text that looks like quotes, templates and comments',
          "const a = <div>`tpl` // /* import 'fake' */ 'q'</div>;",
        ],
        ['a JSX comment container', `const a = <div>{/* import 'fake' */}</div>;`],
        [
          'a regex inside an expression container',
          `const a = <div>{/require('fake')/.test(v)}</div>;`,
        ],
        ['a comparison inside an expression container', `const a = <div>{b < c}</div>;`],
      ];

      for (const [label, source] of inert) {
        it(`reports nothing for ${label}`, () => {
          expect(jsxSpecifiers(source)).toEqual([]);
        });
      }
    });

    describe('real expressions inside markup', () => {
      const real: readonly (readonly [string, string, string[]])[] = [
        ['a child expression container', `const a = <div>{require('real')}</div>;`, ['real']],
        ['an attribute expression', `const a = <Comp value={require('real')} />;`, ['real']],
        ['a spread attribute', `const a = <Comp {...require('real')} />;`, ['real']],
        ['a dynamic import child', `const a = <div>{import('real')}</div>;`, ['real']],
        [
          'an object literal inside a container',
          `const a = <div>{({a: require('real')}).a}</div>;`,
          ['real'],
        ],
        [
          'a nested element inside a container',
          `const a = <div>{ok ? <span>{require('inner')}</span> : null}</div>;`,
          ['inner'],
        ],
        [
          'a template literal inside a container',
          "const a = <div>{`text require('fake') ${require('real')}`}</div>;",
          ['real'],
        ],
        [
          'an awaited dynamic import inside a container',
          `async function f(){ return <div>{await import('real')}</div>; }`,
          ['real'],
        ],
      ];

      for (const [label, source, expected] of real) {
        it(`reads ${label}`, () => {
          expect(jsxSpecifiers(source)).toEqual(expected);
        });
      }

      it('keeps an import before a component', () => {
        const source = `import React from 'react';\nexport const App = () => <div>Hello</div>;`;

        expect(jsxSpecifiers(source)).toEqual(['react']);
      });

      it('keeps a require in a statement after a component', () => {
        const source = `const a = <div>x</div>;\nrequire('after');`;

        expect(jsxSpecifiers(source)).toEqual(['after']);
      });

      it('keeps JSX text in parentheses as markup when no arrow follows', () => {
        const source = `const a = <b>(note)</b>;\nrequire('after');`;

        expect(jsxSpecifiers(source)).toEqual(['after']);
      });

      it('does not glue two sibling containers into one import', () => {
        // `{import}{('fake')}` are two separate expressions; dropping the markup between them must
        // not fabricate a dynamic import that is not in the source.
        expect(jsxSpecifiers(`const a = <div>{import}{('fake')}</div>;`)).toEqual([]);
      });

      it('does not glue markup text into an import statement', () => {
        expect(jsxSpecifiers(`const a = <div>{import}x{'fake'}</div>;`)).toEqual([]);
      });
    });

    describe('type syntax is not markup', () => {
      it('does not read a generic arrow parameter list as a tag', () => {
        expect(jsxSpecifiers(`const id = <T,>(x: T) => x; require('real');`)).toEqual(['real']);
      });

      it('does not read a constrained generic as a tag', () => {
        expect(jsxSpecifiers(`const f = <T extends object>(x: T) => x; require('real');`)).toEqual([
          'real',
        ]);
      });

      it('does not read a const type parameter as a tag', () => {
        expect(jsxSpecifiers(`const id = <const T,>(x: T) => x; require('real');`)).toEqual([
          'real',
        ]);
      });

      it('does not read a generic function type as a tag', () => {
        expect(jsxSpecifiers(`type Fn = <T>(x: T) => T; require('real');`)).toEqual(['real']);
      });

      it('reads a type assertion as JavaScript when jsx mode is off', () => {
        expect(specifiers(`const x = <Foo>value; require('real');`)).toEqual(['real']);
      });

      it('does not read a comparison as a tag', () => {
        expect(jsxSpecifiers(`const ok = a < b && c > d; require('real');`)).toEqual(['real']);
      });
    });

    describe('incomplete markup', () => {
      const incomplete: readonly (readonly [string, string])[] = [
        ['an unterminated attribute value', `const a = <div title='x />;`],
        ['an unterminated expression container', `const a = <div>{require(</div>;`],
        ['an element that reaches the end of the file', `const a = <div>text`],
        ['an open tag that reaches the end of the file', `const a = <div title="x"`],
        ['an unterminated template inside a container', 'const a = <div>{`unterminated}</div>;'],
        ['an unterminated regex inside a container', `const a = <div>{/unterminated}</div>;`],
        ['an unterminated block comment inside a container', `const a = <div>{/* x}</div>;`],
      ];

      for (const [label, source] of incomplete) {
        it(`throws ModuleSpecifierError on ${label}`, () => {
          expect(() => extractModuleSpecifiers(source, { jsx: true })).toThrow(
            ModuleSpecifierError,
          );
        });
      }

      it('exposes an offset for an unterminated element', () => {
        try {
          extractModuleSpecifiers(`const a = <div>text`, { jsx: true });
          throw new Error('expected throw');
        } catch (error) {
          expect(error).toBeInstanceOf(ModuleSpecifierError);
          expect((error as ModuleSpecifierError).code).toBe('invalid-source');
          expect((error as ModuleSpecifierError).offset).toBe(10);
        }
      });
    });
  });
});
