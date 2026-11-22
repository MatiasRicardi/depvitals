import { readFileSync, readdirSync } from 'node:fs';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

const schemas = new URL('../schemas/', import.meta.url);
const examples = new URL('examples/', schemas);
const examplesV2 = new URL('v2/', examples);
const schema = (version: 1 | 2): object =>
  JSON.parse(
    readFileSync(new URL(`report-v${String(version)}.schema.json`, schemas), 'utf8'),
  ) as object;

type Fixture = {
  schemaVersion: number;
  packages: [{ evidence: Record<string, unknown>[] }];
  diagnostics?: Record<string, unknown>;
};

function example(name: string, directory = examplesV2): Fixture {
  return JSON.parse(readFileSync(new URL(name, directory), 'utf8')) as Fixture;
}

const ajv = new Ajv({ allErrors: true });
const validateV1 = ajv.compile(schema(1));
const validateV2 = ajv.compile(schema(2));

describe('report v2 schema', () => {
  it('accepts each installed-format example only at its own schema version', () => {
    for (const [directory, own, other] of [
      [examples, validateV1, validateV2],
      [examplesV2, validateV2, validateV1],
    ] as const) {
      const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const report = example(name, directory);
        expect(own(report), name).toBe(true);
        expect(other(report), name).toBe(false);
      }
    }
  });

  it('preserves the existing v1 projections in v2', () => {
    for (const name of readdirSync(examples).filter((file) => file.endsWith('.json'))) {
      expect(validateV2({ ...example(name, examples), schemaVersion: 2 }), name).toBe(true);
    }
    for (const detector of ['eslint', 'jest']) {
      const report = example('explain-typescript-used.json');
      report.packages[0].evidence = [
        { kind: 'config', file: 'package.json', pointer: '/fixture', value: 'legacy', detector },
      ];
      expect(validateV2(report), detector).toBe(true);
    }
  });

  it.each([
    { file: 'nested/tsconfig.json' },
    { file: 'Tsconfig.json' },
    { pointer: '/compilerOptions/extends' },
    { pointer: '/extends/' },
    { pointer: '/extends/00' },
    { pointer: '/extends/-1' },
    { pointer: '/extends/1/2' },
    { pointer: '/extends/1\n' },
    { value: '' },
    { value: ['shared'] },
    { value: './shared' },
    { value: 'shared/.' },
    { value: 'shared/../base' },
    { value: 'shared//base' },
    { value: 'shared/base?mode=x' },
    { value: 'shared/base\n' },
    { value: 'node:path' },
    { value: 'C:/shared' },
    { value: 'a'.repeat(215) },
    { value: '@scope/' + 'a'.repeat(208) + '/base' },
    { detector: 'unknown' },
  ])('rejects malformed config evidence %j', (patch) => {
    const report = example('explain-typescript-used.json');
    report.packages[0].evidence[0] = { ...report.packages[0].evidence[0], ...patch };
    expect(validateV2(report)).toBe(false);
  });

  it.each([
    'path',
    '@scope/_shared/.../a_b.json',
    'a'.repeat(214) + '/base',
    '@scope/' + 'a'.repeat(207) + '/base',
  ])('accepts a supported selector shape %s', (value) => {
    const report = example('explain-typescript-used.json');
    report.packages[0].evidence[0] = { ...report.packages[0].evidence[0], value };
    expect(validateV2(report)).toBe(true);
  });

  it.each([
    { sourceFilesScanned: '0' },
    { nestedPackageSourceFiles: -1 },
    { notices: ['tsconfig-skipped', 'tsconfig-skipped'] },
    { notices: ['unknown-notice'] },
  ])('rejects malformed diagnostics %j', (patch) => {
    const report = example('scan-diagnostics.json');
    expect(validateV2({ ...report, diagnostics: { ...report.diagnostics, ...patch } })).toBe(false);
  });

  it('guards mode and version boundaries independently of the new detector and notice', () => {
    const report = example('explain-typescript-used.json');
    const diagnostics = example('scan-diagnostics.json').diagnostics;
    expect(validateV2({ ...report, diagnostics })).toBe(false);
    expect(validateV2({ ...report, query: null })).toBe(false);
    expect(validateV2({ ...report, packages: [] })).toBe(false);
    expect(validateV2({ ...example('scan-clean.json'), query: report.packages[0] })).toBe(false);
    expect(validateV1({ ...report, schemaVersion: 1 })).toBe(false);
    expect(validateV1({ ...example('scan-diagnostics.json'), schemaVersion: 1 })).toBe(false);
  });
});
