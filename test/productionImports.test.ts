import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const { findExternalProductionImports } = (await import(
  new URL('../scripts/productionImports.mjs', import.meta.url).href
)) as { findExternalProductionImports: (source: string) => Promise<readonly string[]> };

const externalCases = [
  "import value from 'external';",
  "import { value } from 'external';",
  "import 'external';",
  "  import value from 'external';",
  "\timport 'external';",
  "import {\n value,\n other\n} from 'external';",
  "  import {\n value\n}\n from\n 'external';",
  "import * as namespace\n from 'external';",
  "export * from 'external';",
  "export { value } from 'external';",
  "  export { value } from 'external';",
  "\texport * as namespace from 'external';",
  "export {\n value as renamed,\n other\n} from 'external';",
  "  export {\n value\n}\n from\n 'external';",
  "import /* trivia */ { value } /* trivia */ from 'external';",
  "export /* trivia */ * from 'external';",
];

const inertCases = [
  "import fs from 'node:fs'; export { join } from 'node:path';",
  "  import { value } from './local.js'; export * from '../local.js';",
  "import {\n value\n} from './local.js'; export {\n other\n} from 'node:fs';",
  "// import value from 'external';\n/* export * from 'external'; */",
  "/*\nimport 'external';\nexport * from 'external';\n*/",
  'const text = "import value from \'external\';";',
  "const text = `\nimport 'external';\nexport * from 'external';\n`;",
  "const pattern = /import 'external'/;",
  "const load = () => import('external');",
  "export const label = 'external';",
];

describe('packaged production import guard', () => {
  it.each(externalCases)('detects an external static dependency: %s', async (source) => {
    expect(await findExternalProductionImports(source)).toEqual(['external']);
  });

  it.each(inertCases)('accepts internal/builtin imports and inert text: %s', async (source) => {
    expect(await findExternalProductionImports(source)).toEqual([]);
  });

  it.each([
    { source: "await /'/;", expected: [] },
    { source: "await /'/; import fs from 'node:fs'; export * from './local.js';", expected: [] },
    {
      source: "await /'/;\nimport {\n value\n} from 'external';\nexport * from 'another';",
      expected: ['external', 'another'],
    },
  ])('scans valid ESM with top-level await and a regex: $source', async ({ source, expected }) => {
    const syntax = spawnSync(process.execPath, ['--check', '--input-type=module'], {
      input: source,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(syntax.error).toBeUndefined();
    expect(syntax.status, syntax.stderr).toBe(0);
    expect(await findExternalProductionImports(source)).toEqual(expected);
  });

  it('accepts bare Node builtin module names', async () => {
    expect(
      await findExternalProductionImports("import fs from 'fs'; export * from 'fs/promises';"),
    ).toEqual([]);
  });

  it('rejects unfinished lexical input instead of proving imports safe', async () => {
    await expect(
      findExternalProductionImports("import './local.js'; /* unfinished"),
    ).rejects.toThrow('Unterminated block comment');
  });

  it('preserves duplicates and order while ignoring comment decoys', async () => {
    const source =
      "/*\nimport 'fake';\n*/\n  import 'first';\nexport {\nvalue\n} from 'second';\nimport 'first';";
    expect(await findExternalProductionImports(source)).toEqual(['first', 'second', 'first']);
  });
});
