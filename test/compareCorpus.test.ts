import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

type Capture = { status: number; signal: null | number; stdout: string; stderr: string };
type Sample = { elapsedMs: number; peakRssKiB: number };
const { assertScan, summarize, decodeCapture, measurementEnvironment, assertReportIdentity } =
  (await import(new URL('../scripts/compare-corpus.mjs', import.meta.url).href)) as {
    decodeCapture: (bytes: Buffer) => string;
    measurementEnvironment: (output: string, ambient: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
    assertReportIdentity: (report: object, root: string, version: string) => void;
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

  it.each(['unusedDependencies', 'unusedDevDependencies', 'missingDependencies'])(
    'rejects a schema-valid inconsistent %s count',
    (category) => {
      const report = {
        ...clean,
        counts: {
          unusedDependencies: 0,
          unusedDevDependencies: 0,
          missingDependencies: 0,
          [category]: 1,
        },
      };
      expect(validate(report)).toBe(true);
      expect(() => assertScan(capture(report), expected, validate)).toThrow('Counts disagree');
    },
  );

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

describe('capture and artifact identity', () => {
  it('preserves valid UTF-8 bytes and rejects distinct invalid byte sequences', () => {
    const text = 'é 😀 \uFFFD\n';
    expect(decodeCapture(Buffer.from(text))).toBe(text);
    for (const invalid of [0xff, 0xfe]) {
      expect(() => decodeCapture(Buffer.from([0x22, invalid, 0x22]))).toThrow('invalid UTF-8');
    }
  });

  it('checks each artifact version before comparison normalization, including explanations', () => {
    const report = readJson('../schemas/examples/explain-missing.json') as {
      project: { root: string };
      tool: { version: string };
    };
    expect(validate(report)).toBe(true);
    expect(() => {
      assertReportIdentity(report, report.project.root, report.tool.version);
    }).not.toThrow();
    expect(() => {
      assertReportIdentity(report, report.project.root, 'stale-version');
    }).toThrow('version differs');
    expect(() => {
      assertReportIdentity(report, '/different/root', report.tool.version);
    }).toThrow('project root differs');
  });

  it('prevents inherited instrumentation and cache settings from reaching Node children', () => {
    const directory = mkdtempSync(join(tmpdir(), 'depvitals-measure-env-'));
    try {
      const coverage = join(directory, 'coverage');
      const compileCache = join(directory, 'compile-cache');
      const ambient = {
        ...process.env,
        NODE_OPTIONS: '--throw-deprecation',
        NODE_PATH: directory,
        NODE_V8_COVERAGE: coverage,
        NODE_COMPILE_CACHE: compileCache,
        NODE_DISABLE_COMPILE_CACHE: '0',
      };
      const env = measurementEnvironment(directory, ambient);
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          'process.stdout.write(JSON.stringify({coverage:process.env.NODE_V8_COVERAGE,cache:process.env.NODE_COMPILE_CACHE,disabled:process.env.NODE_DISABLE_COMPILE_CACHE,options:process.env.NODE_OPTIONS,path:process.env.NODE_PATH}))',
        ],
        { env, encoding: 'utf8', timeout: 5000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ disabled: '1' });
      expect(existsSync(coverage)).toBe(false);
      expect(existsSync(compileCache)).toBe(false);
      expect(ambient.NODE_V8_COVERAGE).toBe(coverage);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

type ChildMetric = { status: number; signal: number | null; elapsedMs: number; peakRssKiB: number };
const helper = fileURLToPath(new URL('../scripts/measure-child.py', import.meta.url));

describe.skipIf(process.platform !== 'linux')('Linux child timer', () => {
  it.each([
    {
      name: 'normal exit',
      code: 'process.stdout.write("authored\\n")',
      status: 0,
      signal: null,
      stdout: 'authored\n',
      stderr: '',
    },
    {
      name: 'nonzero exit',
      code: 'process.stderr.write("authored error\\n");process.exit(7)',
      status: 7,
      signal: null,
      stdout: '',
      stderr: 'authored error\n',
    },
    {
      name: 'signal',
      code: 'process.kill(process.pid,"SIGTERM")',
      status: -15,
      signal: 15,
      stdout: '',
      stderr: '',
    },
  ])('records $name and kernel metrics', (testCase) => {
    const directory = mkdtempSync(join(tmpdir(), 'depvitals-child-timer-'));
    try {
      const stdout = join(directory, 'stdout');
      const stderr = join(directory, 'stderr');
      const metric = join(directory, 'metric.json');
      const result = spawnSync(
        'python3',
        ['-I', helper, stdout, stderr, metric, process.execPath, '-e', testCase.code],
        { env: measurementEnvironment(directory, process.env), encoding: 'utf8', timeout: 5000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const measured = JSON.parse(readFileSync(metric, 'utf8')) as ChildMetric;
      expect(measured.status).toBe(testCase.status);
      expect(measured.signal).toBe(testCase.signal);
      expect(measured.elapsedMs).toBeGreaterThan(0);
      expect(measured.peakRssKiB).toBeGreaterThan(0);
      expect(readFileSync(stdout, 'utf8')).toBe(testCase.stdout);
      expect(readFileSync(stderr, 'utf8')).toBe(testCase.stderr);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['alarm', 'sigterm', 'missing-pids', 'missing-pids-stopped-helper'])(
    'stops and reaps the authored child and descendant on %s without a success metric',
    (mode) => {
      const directory = mkdtempSync(join(tmpdir(), 'depvitals-child-cleanup-'));
      try {
        const supervisor = fileURLToPath(
          new URL('./helpers/measureChildSupervisor.py', import.meta.url),
        );
        const result = spawnSync(
          'python3',
          ['-I', supervisor, mode, helper, process.execPath, directory],
          {
            env: measurementEnvironment(directory, process.env),
            encoding: 'utf8',
            timeout: 35000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual({
          childGone: true,
          descendantGone: true,
          successMetric: false,
          ...(mode.startsWith('missing-pids') ? { discoveryFailed: true, noChildren: true } : {}),
        });
        expect(existsSync(join(directory, 'metric.json'))).toBe(false);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
    40000,
  );
});
