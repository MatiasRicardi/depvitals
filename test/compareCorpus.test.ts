import { readFileSync } from 'node:fs';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

type Capture = { status: number; signal: null | number; stdout: string; stderr: string };
type Sample = { elapsedMs: number; peakRssKiB: number };
const { assertScan, summarize } = (await import(
  new URL('../scripts/compare-corpus.mjs', import.meta.url).href
)) as {
  assertScan: (
    capture: Capture,
    expected: object,
    validate: Ajv.ValidateFunction,
    diagnostics?: boolean,
  ) => unknown;
  summarize: (samples: Sample[]) => {
    elapsedMs: { median: number; min: number; max: number };
    peakRssKiB: { median: number; min: number; max: number };
  };
};
const readJson = (path: string): object =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as object;
const validate = new Ajv().compile(readJson('../schemas/report-v1.schema.json'));
const clean = readJson('../schemas/examples/scan-clean.json');
const findings = { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] };
const facts = {
  sourceFilesScanned: 0,
  nestedPackageSourceFiles: 0,
  notices: ['no-supported-sources'],
};
const expected = {
  expectedProcess: { status: 0, stdout: 'completed-report', stderr: 'empty' },
  expectedFindings: findings,
  expectedExclusions: { ignorePaths: [], ignoreDependencies: [] },
  expectedScopeFacts: facts,
};
function capture(report: object): Capture {
  return { status: 0, signal: null, stdout: JSON.stringify(report, null, 2) + '\n', stderr: '' };
}

describe('reviewed corpus comparison gates', () => {
  it('accepts complete ordinary and additive diagnostic scans with the independent oracle', () => {
    expect(assertScan(capture(clean), expected, validate)).toEqual(clean);
    const diagnostic = { ...clean, diagnostics: facts };
    expect(assertScan(capture(diagnostic), expected, validate, true)).toEqual(diagnostic);
  });

  it.each([
    [
      'findings',
      {
        ...clean,
        findings: { ...findings, missingDependencies: ['new-package'] },
        counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 1 },
      },
    ],
    [
      'exclusions',
      {
        ...clean,
        scope: { ...(clean as { scope: object }).scope, ignoreDependencies: ['hidden'] },
      },
    ],
    ['unexpected diagnostics', { ...clean, diagnostics: facts }],
  ])('rejects changed %s even when the report schema accepts them', (_name, report) => {
    expect(validate(report)).toBe(true);
    expect(() => assertScan(capture(report), expected, validate)).toThrow();
  });

  it('rejects schema-valid scope counts that disagree with review', () => {
    const report = { ...clean, diagnostics: { ...facts, sourceFilesScanned: 3 } };
    expect(validate(report)).toBe(true);
    expect(() => assertScan(capture(report), expected, validate, true)).toThrow('Scope disagrees');
  });

  it.each([
    { status: 1 },
    { signal: 9 },
    { stderr: 'unexpected warning\n' },
    { stdout: JSON.stringify(clean) + '\n' },
    { stdout: '{truncated' },
  ])('rejects process or serialization drift %j', (change) => {
    expect(() => assertScan({ ...capture(clean), ...change }, expected, validate)).toThrow();
  });
});

describe('five-run cost summary', () => {
  it('reports the middle observation and actual range independently for time and RSS', () => {
    expect(
      summarize([
        { elapsedMs: 8, peakRssKiB: 100 },
        { elapsedMs: 2, peakRssKiB: 500 },
        { elapsedMs: 9, peakRssKiB: 300 },
        { elapsedMs: 5, peakRssKiB: 200 },
        { elapsedMs: 1, peakRssKiB: 400 },
      ]),
    ).toEqual({
      elapsedMs: { median: 5, min: 1, max: 9 },
      peakRssKiB: { median: 300, min: 100, max: 500 },
    });
  });

  it('rejects incomplete samples and unavailable high-water metrics', () => {
    expect(() => summarize([{ elapsedMs: 1, peakRssKiB: 100 }])).toThrow();
    expect(() =>
      summarize(Array.from({ length: 5 }, () => ({ elapsedMs: 1, peakRssKiB: 0 }))),
    ).toThrow();
  });
});
