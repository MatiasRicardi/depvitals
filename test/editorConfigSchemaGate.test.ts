import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';

import type { JsonReport } from '../src/reporters/jsonReporter.js';

const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const schema = JSON.parse(
  readFileSync(new URL('../schemas/depvitals-config.schema.json', import.meta.url), 'utf8'),
) as object;
const reportSchema = JSON.parse(
  readFileSync(new URL('../schemas/report-v2.schema.json', import.meta.url), 'utf8'),
) as object;
const validate = new Ajv({ allErrors: true }).compile(schema);
const validateReport = new Ajv({ allErrors: true }).compile(reportSchema);

type ParityCase = {
  readonly name: string;
  readonly value: unknown;
  readonly editor: boolean;
  readonly cli: boolean;
  readonly normalized?: {
    readonly ignorePaths: readonly string[];
    readonly ignoreDependencies: readonly string[];
  };
};
// Literal outcomes are authored independently of the runtime validators and their regular expressions.
const cases: readonly ParityCase[] = [
  { name: 'empty object', value: {}, editor: true, cli: true },
  { name: 'paths alone', value: { ignorePaths: ['generated'] }, editor: true, cli: true },
  { name: 'dependencies alone', value: { ignoreDependencies: ['Foo'] }, editor: true, cli: true },
  {
    name: 'empty arrays',
    value: { ignorePaths: [], ignoreDependencies: [] },
    editor: true,
    cli: true,
  },
  {
    name: 'interior spaces',
    value: { ignorePaths: ['sample data/inputs'] },
    editor: true,
    cli: true,
  },
  {
    name: 'duplicates and path aliases',
    value: {
      ignorePaths: ['./src//generated/', 'src\\generated', 'assets', 'assets'],
      ignoreDependencies: ['Foo', 'foo', '@scope/_demo', '@scope/_demo'],
    },
    editor: true,
    cli: true,
    normalized: {
      ignorePaths: ['assets', 'src/generated'],
      ignoreDependencies: ['@scope/_demo', 'Foo', 'foo'],
    },
  },
  {
    name: 'documented configuration',
    value: {
      ignorePaths: ['test/generated', './sample data//inputs/'],
      ignoreDependencies: ['Foo', '@scope/_demo', '@scope/-demo'],
    },
    editor: true,
    cli: true,
    normalized: {
      ignorePaths: ['sample data/inputs', 'test/generated'],
      ignoreDependencies: ['@scope/-demo', '@scope/_demo', 'Foo'],
    },
  },
  {
    name: 'scoped underscore',
    value: { ignoreDependencies: ['@scope/_demo'] },
    editor: true,
    cli: true,
  },
  {
    name: 'scoped hyphen',
    value: { ignoreDependencies: ['@scope/-demo'] },
    editor: true,
    cli: true,
  },
  {
    name: '214-character name',
    value: { ignoreDependencies: ['a'.repeat(214)] },
    editor: true,
    cli: true,
  },
  {
    name: '214-character scoped name',
    value: { ignoreDependencies: ['@s/' + 'a'.repeat(211)] },
    editor: true,
    cli: true,
  },
  { name: 'null root', value: null, editor: false, cli: false },
  { name: 'array root', value: [], editor: false, cli: false },
  { name: 'unknown key', value: { unknown: [] }, editor: false, cli: false },
  { name: 'schema instance key', value: { $schema: 'schema.json' }, editor: false, cli: false },
  {
    name: 'literal prototype key',
    value: JSON.parse('{"__proto__":{}}') as object,
    editor: false,
    cli: false,
  },
  { name: 'scalar paths', value: { ignorePaths: 'generated' }, editor: false, cli: false },
  { name: 'scalar dependencies', value: { ignoreDependencies: 'pkg' }, editor: false, cli: false },
  { name: 'non-string path', value: { ignorePaths: [1] }, editor: false, cli: false },
  {
    name: 'non-string dependency',
    value: { ignoreDependencies: [null] },
    editor: false,
    cli: false,
  },
  { name: 'empty path', value: { ignorePaths: [''] }, editor: false, cli: false },
  { name: 'blank path', value: { ignorePaths: [' \t\n'] }, editor: false, cli: false },
  { name: 'empty dependency', value: { ignoreDependencies: [''] }, editor: false, cli: false },
  { name: 'blank dependency', value: { ignoreDependencies: [' '] }, editor: false, cli: false },
  {
    name: 'unscoped subpath',
    value: { ignoreDependencies: ['pkg/subpath'] },
    editor: false,
    cli: false,
  },
  {
    name: 'scoped subpath',
    value: { ignoreDependencies: ['@scope/pkg/subpath'] },
    editor: false,
    cli: false,
  },
  {
    name: 'version suffix',
    value: { ignoreDependencies: ['pkg@1.0.0'] },
    editor: false,
    cli: false,
  },
  {
    name: 'leading scoped dot',
    value: { ignoreDependencies: ['@scope/.dot'] },
    editor: false,
    cli: false,
  },
  {
    name: 'leading unscoped underscore',
    value: { ignoreDependencies: ['_unscoped'] },
    editor: false,
    cli: false,
  },
  { name: 'terminal newline', value: { ignoreDependencies: ['pkg\n'] }, editor: false, cli: false },
  {
    name: '215-character name',
    value: { ignoreDependencies: ['a'.repeat(215)] },
    editor: false,
    cli: false,
  },
  {
    name: '215-character scoped name',
    value: { ignoreDependencies: ['@s/' + 'a'.repeat(212)] },
    editor: false,
    cli: false,
  },
  { name: 'parent traversal', value: { ignorePaths: ['../outside'] }, editor: true, cli: false },
  { name: 'normalized project root', value: { ignorePaths: ['./.'] }, editor: true, cli: false },
  {
    name: 'normalized leading whitespace',
    value: { ignorePaths: ['./ generated'] },
    editor: true,
    cli: false,
  },
  { name: 'absolute path', value: { ignorePaths: ['/absolute'] }, editor: true, cli: false },
  {
    name: 'drive-relative path',
    value: { ignorePaths: ['C:drive-relative'] },
    editor: true,
    cli: false,
  },
  { name: 'glob pattern', value: { ignorePaths: ['src/*.js'] }, editor: true, cli: false },
];

describe('independent editor schema and compiled CLI parity', () => {
  it.each(cases)('$name (editor=$editor, CLI=$cli)', (scenario) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'depvitals-editor-parity-')));
    try {
      const root = join(scratch, 'project');
      const raw = JSON.stringify(scenario.value);
      const instance: unknown = JSON.parse(raw);
      expect(validate(instance), JSON.stringify(validate.errors)).toBe(scenario.editor);
      expect(JSON.stringify(instance)).toBe(raw);
      mkdirSync(root);
      writeFileSync(join(root, 'package.json'), '{}');
      writeFileSync(join(root, 'depvitals.config.json'), raw);
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CI: '1',
        DEPVITALS_NO_UPDATE_CHECK: '1',
        HOME: join(scratch, 'home'),
        USERPROFILE: join(scratch, 'home'),
        XDG_CACHE_HOME: join(scratch, 'cache'),
        LOCALAPPDATA: join(scratch, 'cache'),
      };
      delete env['NODE_OPTIONS'];
      delete env['NODE_PATH'];
      const output = spawnSync(process.execPath, [cli, root, '--format', 'json'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
      expect(output.error).toBeUndefined();
      expect(output.signal).toBeNull();
      expect(output.status).toBe(scenario.cli ? 0 : 1);
      if (scenario.cli) {
        expect(output.stderr).toBe('');
        const report = JSON.parse(output.stdout) as JsonReport;
        expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
        expect(output.stdout).toBe(JSON.stringify(report, null, 2) + '\n');
        expect(report).toMatchObject({
          mode: 'scan',
          query: null,
          findings: { unusedDependencies: [], unusedDevDependencies: [], missingDependencies: [] },
          counts: { unusedDependencies: 0, unusedDevDependencies: 0, missingDependencies: 0 },
        });
        if (scenario.normalized !== undefined) {
          expect(report.scope.ignorePaths).toEqual(scenario.normalized.ignorePaths);
          expect(report.scope.ignoreDependencies).toEqual(scenario.normalized.ignoreDependencies);
        }
      } else {
        expect(output.stdout).toBe('');
        expect(output.stderr).toContain('depvitals.config.json');
      }
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(root, 'depvitals.config.json'), 'utf8')).toBe(raw);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
