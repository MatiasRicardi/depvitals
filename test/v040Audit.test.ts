import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonReport } from '../src/reporters/jsonReporter.js';

const entry = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/notifierFetchProbe.mjs', import.meta.url));
const env = { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' };
let lab: string;
let project: string;

beforeEach(() => {
  lab = mkdtempSync(join(tmpdir(), 'depvitals-release-audit-'));
  project = join(lab, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'package.json'), '{}');
});
afterEach(() => {
  rmSync(lab, { recursive: true, force: true });
});

function scan(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, project, '--format', 'json', ...args], {
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function report(status: number, ...args: string[]): JsonReport {
  const result = scan(...args);
  expect(result).toMatchObject({ status, stderr: '' });
  return JSON.parse(result.stdout) as JsonReport;
}

describe('v0.4.0 release audit', () => {
  it.each([
    "import 'node:fs'\n/require('fake')/.test('');",
    "import 'node:fs'\n/'/.test('foo');",
    "export * from 'node:fs'\n/require('fake')/.test('');",
    "import { readFile } from 'node:fs';\n/require('fake')/.test('');",
    "import { readFile } from 'node:fs' /*\n*/ /require('fake')/.test('');",
  ])('recognizes regex after the static declaration %j', (source) => {
    const file = join(project, 'index.mjs');
    writeFileSync(file, source);
    execFileSync(process.execPath, ['--check', file]);
    expect(report(0).findings.missingDependencies).toEqual([]);
  });

  it.each([
    ['index.cjs', "const q = 12\n/ require('real') / 2;"],
    ['index.mjs', "export default '12'\n/ require('real') / 2;"],
  ])('keeps division and its real require after a line break in %s', (name, source) => {
    const file = join(project, name);
    writeFileSync(file, source);
    execFileSync(process.execPath, ['--check', file]);
    const result = report(1);
    expect(result.findings.missingDependencies).toEqual(['real']);
    expect(result.packages[0]).toMatchObject({
      name: 'real',
      status: 'missing',
      evidence: [{ file: name, reference: 'require', position: { line: 2 } }],
    });
  });

  it.skipIf(process.platform === 'win32')(
    'escapes hostile diagnostic paths and preserves JSON values',
    () => {
      const name = 'payload\u001b[2J\nproof.js';
      const file = join(project, name);
      writeFileSync(file, "'");
      const error = scan();
      expect(error).toMatchObject({ status: 1, stdout: '' });
      expect(error.stderr).toContain('payload\\u001b[2J\\u000aproof.js could not be analyzed:');
      expect(error.stderr).toContain('Unterminated string literal\n');
      expect(error.stderr.match(/\n/g)).toEqual(['\n']);
      expect(error.stderr).not.toContain('\u001b');
      writeFileSync(file, "require('missing');");
      expect(report(1).packages[0]?.evidence[0]?.file).toBe(name);
    },
  );

  it('escapes untrusted arguments without escaping the help separator', () => {
    const result = scan('--unknown\u001b\noption');
    expect(result).toMatchObject({ status: 1, stdout: '' });
    expect(result.stderr).toContain('--unknown\\u001b\\u000aoption\nRun ');
  });

  it.each([false, true])('accepts one BOM in the manifest (nested=%s)', (nested) => {
    const dir = nested ? join(project, 'nested') : project;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'package.json');
    writeFileSync(file, '\ufeff{"name":"bom-probe","type":"module"}');
    writeFileSync(join(dir, 'entry.js'), "import 'node:fs';");
    expect(report(0).findings.missingDependencies).toEqual([]);
    writeFileSync(file, '\ufeff\ufeff{}');
    const invalid = scan();
    expect(invalid).toMatchObject({ status: 1, stdout: '' });
    expect(invalid.stderr).toContain('not valid JSON');
  });

  it.each(['@scope/_demo', '@scope/-demo'])(
    'explains and excludes the exact scoped name %s',
    (name) => {
      writeFileSync(join(project, 'index.mjs'), "import '" + name + "';");
      const missing = report(1, '--explain', name);
      expect(missing.query).toEqual({ packageName: name, known: true });
      expect(missing.packages[0]).toMatchObject({
        name,
        status: 'missing',
        evidence: [{ kind: 'source', specifier: name }],
      });
      writeFileSync(
        join(project, 'depvitals.config.json'),
        JSON.stringify({ ignoreDependencies: [name] }),
      );
      expect(report(0).findings.missingDependencies).toEqual([]);
      const excluded = report(0, '--explain', name);
      expect(excluded.query).toEqual(missing.query);
      expect(excluded.packages[0]).toMatchObject({
        status: 'excluded',
        underlyingFindings: ['missingDependencies'],
        findings: [],
        evidence: missing.packages[0]?.evidence,
      });
    },
  );

  it('assigns ordinals only to supported runner candidates', () => {
    const scripts = {
      flags: 'npx --yes prettier; prettier --check .',
      version: 'npx prettier@3; node --import=tsx ./entry.js',
      subpath: 'pnpm dlx prettier/path; prettier --check .',
      'preload-control': 'node --import=tsx ./entry.js',
      'undeclared-control': 'npx unlisted; prettier --check .',
    };
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ devDependencies: { prettier: '1', tsx: '1' }, scripts }),
    );
    const result = report(0);
    expect(
      result.packages.map(({ name, evidence }) => [
        name,
        evidence.map((item) => (item.kind === 'script' ? [item.pointer, item.occurrence] : item)),
      ]),
    ).toEqual([
      [
        'prettier',
        [
          ['/scripts/flags', 0],
          ['/scripts/subpath', 0],
          ['/scripts/undeclared-control', 1],
        ],
      ],
      [
        'tsx',
        [
          ['/scripts/preload-control', 1],
          ['/scripts/version', 1],
        ],
      ],
    ]);
  });

  it.each([
    'node --import=tsx/$0 ./entry.js',
    'node --import "tsx/$0" ./entry.js',
    'node --import=tsx/$1 ./entry.js',
    'node --import=tsx/$? ./entry.js',
    'node --import "tsx/$$" ./entry.js',
    'node --import tsx "$@" ./entry.js',
  ])('rejects a dynamic preload batch for %s', (check) => {
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({ devDependencies: { tsx: '1' }, scripts: { check } }),
    );
    const result = report(1, '--explain', 'tsx');
    expect(result.findings.unusedDevDependencies).toEqual(['tsx']);
    expect(result.packages[0]).toMatchObject({ status: 'unused', evidence: [] });
  });

  it('preserves single-quoted parameters as literal selector text', () => {
    writeFileSync(
      join(project, 'package.json'),
      JSON.stringify({
        devDependencies: { tsx: '1' },
        scripts: { check: "node --import 'tsx/$0' ./entry.js" },
      }),
    );
    expect(report(0).packages[0]).toMatchObject({
      status: 'used',
      evidence: [{ command: 'tsx/$0', via: 'node-preload', occurrence: 1 }],
    });
  });

  it.each([0, 1])(
    'keeps exit %s when the reader closes a large JSON report',
    async (status) => {
      writeFileSync(join(project, 'package.json'), '{"dependencies":{"fixture":"1"}}');
      writeFileSync(
        join(project, 'index.mjs'),
        'import "fixture";\n'.repeat(50_000) + (status === 1 ? 'import "missing";\n' : ''),
      );
      const result = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawn(process.execPath, [entry, project, '--format', 'json'], {
          env,
          timeout: 10_000,
        });
        let stderr = '';
        child.once('error', reject);
        child.stdout.once('data', () => child.stdout.destroy());
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('close', (code, signal) => {
          resolve({ code, signal, stderr });
        });
      });
      expect(result).toEqual({ code: status, signal: null, stderr: '' });
    },
    15_000,
  );

  it.each(['inside', 'redirected', 'seeded', 'sibling'] as const)(
    'guards the effective %s cache path',
    (kind) => {
      const inside = join(project, '.cache');
      const sibling = join(lab, 'project-cache');
      const alias = join(lab, 'redirected');
      if (kind === 'redirected') {
        mkdirSync(inside);
        symlinkSync(inside, alias, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const cache = kind === 'sibling' ? sibling : kind === 'redirected' ? alias : inside;
      const cacheFile = join(cache, 'depvitals', 'update-check.json');
      const seeded = JSON.stringify({ latest: '888.888.888', checkedAt: Date.now() });
      if (kind === 'seeded') {
        mkdirSync(join(cache, 'depvitals'), { recursive: true });
        writeFileSync(cacheFile, seeded);
      }
      const before = readdirSync(project, { recursive: true });
      const result = spawnSync(process.execPath, ['--import', probe, entry, project], {
        env: {
          ...env,
          CI: undefined,
          GITHUB_ACTIONS: undefined,
          DEPVITALS_NO_UPDATE_CHECK: undefined,
          DEPVITALS_TEST_FORCE_TTY: '1',
          DEPVITALS_TEST_RESPONSE_LATEST: '999.999.999',
          DEPVITALS_TEST_REQUEST_FILE: join(lab, 'requests'),
          XDG_CACHE_HOME: cache,
          LOCALAPPDATA: cache,
        },
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result).toMatchObject({
        status: 0,
        stdout: 'DepVitals\n\nNo dependency issues found.\n',
      });
      expect(result.stderr).toContain('999.999.999');
      expect(readdirSync(project, { recursive: true })).toEqual(before);
      expect(existsSync(cacheFile)).toBe(kind === 'sibling' || kind === 'seeded');
      if (kind === 'seeded') expect(readFileSync(cacheFile, 'utf8')).toBe(seeded);
    },
  );
});
