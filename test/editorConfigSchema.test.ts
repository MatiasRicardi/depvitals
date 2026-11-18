import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const schema = JSON.parse(
  readFileSync(new URL('../schemas/depvitals-config.schema.json', import.meta.url), 'utf8'),
) as { $schema: string; examples: unknown[] };
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);

describe('project configuration editor schema', () => {
  it('is self-contained Draft 7 and validates its examples', () => {
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.examples.length).toBeGreaterThan(0);
    for (const example of schema.examples)
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    {},
    { ignorePaths: [] },
    { ignoreDependencies: [] },
    { ignorePaths: [], ignoreDependencies: [] },
    { ignorePaths: ['test/generated', 'sample data/inputs'] },
    { ignorePaths: ['./sample data//inputs/', 'src\\generated', 'a/./b', 'a//b'] },
    { ignorePaths: ['generated', 'generated'], ignoreDependencies: ['Foo', 'Foo'] },
    { ignoreDependencies: ['Foo', 'a', 'a.b_c-d', '@Scope/Pkg', '@scope/_demo', '@scope/-demo'] },
    { ignoreDependencies: ['x'.repeat(214)] },
    { ignoreDependencies: ['@s/' + 'x'.repeat(211)] },
  ])('accepts supported configuration %j without mutation', (config) => {
    const before = structuredClone(config);
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true);
    expect(config).toEqual(before);
  });

  it.each([
    null,
    [],
    'config',
    { ignorePaths: 'generated' },
    { ignorePaths: [1] },
    { ignorePaths: [''] },
    { ignorePaths: [' \t\n'] },
    { ignoreDependencies: 'pkg' },
    { ignoreDependencies: [null] },
    { ignoreDependencies: [''] },
    { ignoreDependencies: ['pkg@1'] },
    { ignoreDependencies: ['pkg/subpath'] },
    { ignoreDependencies: ['@scope/pkg/subpath'] },
    { ignoreDependencies: ['_pkg'] },
    { ignoreDependencies: ['-pkg'] },
    { ignoreDependencies: ['@_scope/pkg'] },
    { ignoreDependencies: ['@scope/.pkg'] },
    { ignoreDependencies: ['pkg*'] },
    { ignoreDependencies: ['pkg\n'] },
    { ignoreDependencies: ['pkg\r'] },
    { ignoreDependencies: ['pkg\u2028'] },
    { ignoreDependencies: ['x'.repeat(215)] },
    { ignoreDependencies: ['@s/' + 'x'.repeat(212)] },
    { $schema: 'https://example.com/schema.json' },
    { schemaVersion: 1 },
    { unexpected: [] },
    JSON.parse('{"__proto__":{}}') as object,
  ])('rejects malformed or unknown configuration %j', (config) => {
    expect(validate(config)).toBe(false);
  });

  it.each(['../outside', 'src/*.js', './.', './ generated', '/absolute'])(
    'leaves complete path validation of %s to the CLI',
    (path) => {
      expect(validate({ ignorePaths: [path] })).toBe(true);
    },
  );
});
