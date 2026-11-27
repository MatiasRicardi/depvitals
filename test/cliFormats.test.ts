import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCliEntry } from '../src/cli/entry.js';
import { parseCliArgs } from '../src/cli/parseCliArgs.js';
import { runCli } from '../src/cli/runCli.js';
import { collectUpdateNotice } from '../src/cli/notifier/updateCheck.js';
import { UPDATE_CACHE_FILE_NAME } from '../src/cli/notifier/updateCache.js';
import type { JsonReport } from '../src/reporters/jsonReporter.js';

const hint = "Run 'depvitals --help' for available commands.";
const cwd = resolve('/workspace');
const version = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const probe = fileURLToPath(new URL('./helpers/notifierFetchProbe.mjs', import.meta.url));

describe('format/explain argument grammar', () => {
  const parts = [['project'], ['--format', 'json'], ['--explain', '@Scope/Pkg']];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  it.each(orders)('accepts token ordering %j', (...order) => {
    const args = order.flatMap((index) => parts[index] ?? []);
    expect(parseCliArgs(args, cwd)).toEqual({
      kind: 'scan',
      projectPath: resolve(cwd, 'project'),
      format: 'json',
      explain: '@Scope/Pkg',
    });
  });
  it.each([
    [['--format', 'terminal'], { format: 'terminal' }],
    [['--format', 'json'], { format: 'json' }],
    [['--explain', 'fs'], { explain: 'fs' }],
    [['--explain', 'CasePkg'], { explain: 'CasePkg' }],
    [['--explain', 'a'.repeat(214)], { explain: 'a'.repeat(214) }],
  ] as const)('accepts exact values %j', (args, extra) => {
    expect(parseCliArgs(args, cwd)).toEqual({ kind: 'scan', projectPath: cwd, ...extra });
  });
  it.each([
    [['--format'], 'Option --format requires a value.'],
    [['--format', ''], 'Option --format requires a value.'],
    [['--format', '--explain', 'pkg'], 'Option --format requires a value.'],
    [['--explain'], 'Option --explain requires a value.'],
    [['--explain', ''], 'Option --explain requires a value.'],
    [['--explain', '-pkg'], 'Option --explain requires a value.'],
    [['--format', 'JSON'], 'Invalid value for --format: JSON. Expected terminal or json.'],
    [['--format', 'json', '--format', 'json'], 'Option --format may be specified only once.'],
    [['--explain', 'pkg', '--explain'], 'Option --explain may be specified only once.'],
    [['--format=json'], 'Unknown option: --format=json'],
    [['--explain=pkg'], 'Unknown option: --explain=pkg'],
    [['--json'], 'Unknown option: --json'],
    [['--why'], 'Unknown option: --why'],
    [['--'], 'Unknown option: --'],
    [
      ['--format', 'bad', '--unknown'],
      'Invalid value for --format: bad. Expected terminal or json.',
    ],
    [['--unknown', '--format', 'bad'], 'Unknown option: --unknown'],
    [['', 'other', '--format', 'json'], 'Too many arguments: expected at most one project path.'],
    [['--format', 'json', ''], 'Invalid project path: project path must not be empty.'],
    [['--format', 'json', '--help'], 'Option --help must be used alone.'],
    [['--explain', '--version'], 'Option --version must be used alone.'],
  ] as const)('rejects %j with the accepted precedence', (args, body) => {
    expect(parseCliArgs(args, cwd)).toEqual({ kind: 'error', message: body + '\n' + hint });
  });
  it.each(['pkg/sub', '@s/p/sub', 'pkg@1', '*', 'pkg\n', ' pkg', 'a'.repeat(215)])(
    'rejects non-root query %j',
    (name) => {
      expect(parseCliArgs(['--explain', name], cwd)).toEqual({
        kind: 'error',
        message:
          'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.\n' +
          hint,
      });
    },
  );
  it('escapes interpolated control characters in argument diagnostics', () => {
    expect(parseCliArgs(['--format', '\u001b[2J\n'], cwd)).toEqual({
      kind: 'error',
      message:
        String.raw`Invalid value for --format: \u001b[2J\u000a. Expected terminal or json.` +
        '\n' +
        hint,
    });
    expect(parseCliArgs(['--bad\r'], cwd)).toEqual({
      kind: 'error',
      message: String.raw`Unknown option: --bad\u000d` + '\n' + hint,
    });
  });
});

let scratch = '';
let root: string;
let broken: string;
let invalid: string;
const inputs = {
  'package.json': JSON.stringify({
    dependencies: { used: '1', prod: '1', dual: '1', excluded: '1' },
    devDependencies: { dev: '1', dual: '1' },
    peerDependencies: { peer: '1' },
    optionalDependencies: { optional: '1' },
  }),
  'index.cjs': "require('used'); require('missing');",
  'depvitals.config.json': '{"ignoreDependencies":["excluded","ignore-only"]}',
};
beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-cli-formats-')));
  root = join(scratch, 'why');
  broken = join(scratch, 'broken');
  invalid = join(scratch, 'invalid');
  for (const dir of [root, broken, invalid]) await mkdir(dir);
  for (const name of ['diagnostics', '--diagnostics', 'true']) {
    await mkdir(join(scratch, name));
    await writeFile(join(scratch, name, 'package.json'), '{}');
  }
  await mkdir(join(scratch, 'invalid-manifest'));
  await writeFile(join(scratch, 'invalid-manifest', 'package.json'), '{ invalid');
  for (const [name, text] of Object.entries(inputs)) await writeFile(join(root, name), text);
  await writeFile(join(broken, 'package.json'), inputs['package.json']);
  await writeFile(join(broken, 'a.cjs'), "require('used');");
  await writeFile(join(broken, 'z.cjs'), '"unfinished');
  await writeFile(join(invalid, 'package.json'), '{}');
  await writeFile(join(invalid, 'depvitals.config.json'), '{ invalid');
});
afterAll(async () => {
  if (scratch === '') return;
  try {
    for (const [name, text] of Object.entries(inputs))
      expect(await readFile(join(root, name), 'utf8')).toBe(text);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
function child(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
  workingDirectory = scratch,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1', ...extraEnv },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('compiled format/query outcomes', () => {
  it('scans a regex after a semicolon-free TypeScript import assignment', async () => {
    const project = await mkdtemp(join(scratch, 'import-assignment-'));
    const manifest = '{"dependencies":{"assignment":"1","adjacent":"1"}}';
    const source = [
      "import alias = require('assignment')",
      `/['"]|require('decoy')/g.test('x');`,
      "import 'adjacent';",
      '',
    ].join('\n');
    await writeFile(join(project, 'package.json'), manifest);
    await writeFile(join(project, 'index.cts'), source);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual(
      [
        { name: 'adjacent', reference: 'import', line: 3, column: 8 },
        { name: 'assignment', reference: 'require', line: 1, column: 24 },
      ].map(({ name, reference, line, column }) => ({
        name,
        status: 'used',
        declaredIn: ['dependencies'],
        excluded: false,
        underlyingFindings: [],
        findings: [],
        evidence: [
          {
            kind: 'source',
            file: 'index.cts',
            reference,
            specifier: name,
            position: { offset: source.indexOf(`'${name}'`), line, column },
          },
        ],
      })),
    );
    expect(await readFile(join(project, 'index.cts'), 'utf8')).toBe(source);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
  });

  it('preserves real evidence after keyword member division and a labeled break', async () => {
    const project = await mkdtemp(join(scratch, 'statement-regex-'));
    const manifest = '{"dependencies":{"real-pkg":"1"}}';
    const division =
      "const counters = { break: 12 };\nconst result = counters.break\n  / require('real-pkg') / 2;\n";
    const statement = [
      'outer: for (;;) {',
      '  break outer',
      `  /['"]/g.test('x');`,
      `  /require('decoy')/.test('x');`,
      '}',
      "import 'real-pkg';",
      '',
    ].join('\n');

    await writeFile(join(project, 'package.json'), manifest);
    await writeFile(join(project, 'division.cjs'), division);
    await writeFile(join(project, 'statement.mjs'), statement);
    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file: 'division.cjs',
            reference: 'require',
            specifier: 'real-pkg',
            position: { offset: division.indexOf("'real-pkg'"), line: 3, column: 13 },
          },
          {
            kind: 'source',
            file: 'statement.mjs',
            reference: 'import',
            specifier: 'real-pkg',
            position: { offset: statement.indexOf("'real-pkg'"), line: 6, column: 8 },
          },
        ],
      }),
    ]);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(project, 'division.cjs'), 'utf8')).toBe(division);
    expect(await readFile(join(project, 'statement.mjs'), 'utf8')).toBe(statement);
  });

  it.each([
    ['private return field', '#return = 8;', 'this.#return', 70, 35],
    ['private if method', '#if() { return 8; }', 'this.#if()', 75, 33],
  ])(
    'retains the require position after division by a %s',
    async (_name, member, operand, offset, column) => {
      const project = await mkdtemp(join(scratch, 'private-member-division-'));
      const manifest = '{"dependencies":{"demo-pkg":"1","adjacent-pkg":"1"}}';
      const source = [
        'class C {',
        `  ${member}`,
        '  read() {',
        `    return ${operand} / require('demo-pkg') / 2;`,
        '  }',
        '}',
        'function matcher(flag) {',
        "  if (flag) /require('if-decoy')/.test('x');",
        "  return /require('return-decoy')/;",
        '}',
        "require('adjacent-pkg');",
        '',
      ].join('\n');
      await writeFile(join(project, 'package.json'), manifest);
      await writeFile(join(project, 'index.cjs'), source);

      const result = child([project, '--format', 'json']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.packages).toEqual([
        {
          name: 'adjacent-pkg',
          status: 'used',
          declaredIn: ['dependencies'],
          excluded: false,
          underlyingFindings: [],
          findings: [],
          evidence: [
            {
              kind: 'source',
              file: 'index.cjs',
              reference: 'require',
              specifier: 'adjacent-pkg',
              position: { offset: source.indexOf("'adjacent-pkg'"), line: 11, column: 9 },
            },
          ],
        },
        {
          name: 'demo-pkg',
          status: 'used',
          declaredIn: ['dependencies'],
          excluded: false,
          underlyingFindings: [],
          findings: [],
          evidence: [
            {
              kind: 'source',
              file: 'index.cjs',
              reference: 'require',
              specifier: 'demo-pkg',
              position: { offset, line: 4, column },
            },
          ],
        },
      ]);
      expect(await readFile(join(project, 'index.cjs'), 'utf8')).toBe(source);
      expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
    },
  );

  it.each([
    ['index.mjs', 'export let value'],
    ['index.ts', 'export let value: string'],
  ])('scans a regex after an uninitialized declaration in %s', async (file, declaration) => {
    const project = await mkdtemp(join(scratch, 'uninitialized-declaration-'));
    const manifest = '{"dependencies":{"real-pkg":"1"}}';
    const source = [
      declaration,
      `/['"]|require('decoy')/g.test('x');`,
      "import 'real-pkg';",
      '',
    ].join('\n');
    await writeFile(join(project, 'package.json'), manifest);
    await writeFile(join(project, file), source);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file,
            reference: 'import',
            specifier: 'real-pkg',
            position: { offset: source.indexOf("'real-pkg'"), line: 3, column: 8 },
          },
        ],
      }),
    ]);
    expect(await readFile(join(project, file), 'utf8')).toBe(source);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
  });

  it('preserves division in new expressions following annotated bindings', async () => {
    const project = await mkdtemp(join(scratch, 'typed-declaration-boundaries-'));
    const source = [
      'let unused: number',
      '`text`, value',
      "/ require('real-pkg') / 2;",
      'let other: number',
      '[]',
      "/ require('real-pkg') / 2;",
      'let plus: number',
      '+value, other',
      "/ require('real-pkg') / 2;",
      'let minus: number',
      '-value, other',
      "/ require('real-pkg') / 2;",
      'let generic: Array<number>',
      'value, other',
      "/ require('real-pkg') / 2;",
      '',
    ].join('\n');
    await writeFile(join(project, 'package.json'), '{"dependencies":{"real-pkg":"1"}}');
    await writeFile(join(project, 'index.ts'), source);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [...source.matchAll(/'real-pkg'/g)].map(({ index }, occurrence) => ({
          kind: 'source',
          file: 'index.ts',
          reference: 'require',
          specifier: 'real-pkg',
          position: { offset: index, line: (occurrence + 1) * 3, column: 11 },
        })),
      }),
    ]);
    expect(await readFile(join(project, 'index.ts'), 'utf8')).toBe(source);
  });

  it('preserves real evidence at generator and template boundaries', async () => {
    const project = await mkdtemp(join(scratch, 'generator-template-boundaries-'));
    const generator = [
      'function* generate() {',
      '  yield',
      '  let value',
      "  /require('decoy')/.test('x');",
      '}',
      "import 'real-pkg';",
      '',
    ].join('\n');
    const interpolation = [
      'var let = [12], value = 4;',
      'const output = `${let[0], value',
      "/ require('real-pkg') / 2}`;",
      '',
    ].join('\n');
    const manifest = '{"dependencies":{"real-pkg":"1"}}';
    await writeFile(join(project, 'package.json'), manifest);
    await writeFile(join(project, 'generator.mjs'), generator);
    await writeFile(join(project, 'template.cjs'), interpolation);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file: 'generator.mjs',
            reference: 'import',
            specifier: 'real-pkg',
            position: { offset: generator.indexOf("'real-pkg'"), line: 6, column: 8 },
          },
          {
            kind: 'source',
            file: 'template.cjs',
            reference: 'require',
            specifier: 'real-pkg',
            position: { offset: interpolation.indexOf("'real-pkg'"), line: 3, column: 11 },
          },
        ],
      }),
    ]);
    expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(project, 'generator.mjs'), 'utf8')).toBe(generator);
    expect(await readFile(join(project, 'template.cjs'), 'utf8')).toBe(interpolation);
  });

  it.each(['debugger', 'let value'])(
    'reports an incomplete regex after %s without emitting a partial report',
    async (statement) => {
      const project = await mkdtemp(join(scratch, 'incomplete-statement-regex-'));
      await writeFile(join(project, 'package.json'), '{}');
      await writeFile(join(project, 'index.mjs'), `${statement}\n/unterminated\n`);
      const result = child([project, '--format', 'json']);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('could not be analyzed: Unterminated regex literal\n');
    },
  );

  it('skips TS declaration regex decoys and reports the real adjacent references', async () => {
    const project = await mkdtemp(join(scratch, 'ts-statement-regex-'));
    const manifest = '{"dependencies":{"real-pkg":"1"}}';
    const source = [
      'export type Text = string',
      "/require('alias-decoy')/.test('x');",
      'declare const value: string',
      "/require('ambient-decoy')/.test('x');",
      "import 'real-pkg';",
      "const ratio: number = 12 / require('real-pkg') / 2;",
      '',
    ].join('\n');

    await writeFile(join(project, 'package.json'), manifest);
    await writeFile(join(project, 'index.ts'), source);
    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file: 'index.ts',
            reference: 'import',
            specifier: 'real-pkg',
            position: { offset: source.indexOf("'real-pkg'"), line: 5, column: 8 },
          },
          {
            kind: 'source',
            file: 'index.ts',
            reference: 'require',
            specifier: 'real-pkg',
            position: { offset: source.lastIndexOf("'real-pkg'"), line: 6, column: 36 },
          },
        ],
      }),
    ]);
    expect(await readFile(join(project, 'index.ts'), 'utf8')).toBe(source);
  });

  it('preserves multiline function and import type boundaries through the CLI', async () => {
    const project = await mkdtemp(join(scratch, 'ts-multiline-type-'));
    const source = [
      'type F = ()',
      '  => string',
      "/require('arrow-decoy')/.test('x');",
      'type T = import',
      "  ('real-pkg').T",
      "/require('import-decoy')/.test('x');",
      '',
    ].join('\n');
    await writeFile(join(project, 'package.json'), '{"dependencies":{"real-pkg":"1"}}');
    await writeFile(join(project, 'index.ts'), source);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file: 'index.ts',
            reference: 'dynamic-import',
            specifier: 'real-pkg',
            position: { offset: source.indexOf("'real-pkg'"), line: 5, column: 4 },
          },
        ],
      }),
    ]);
  });

  it('keeps malformed regex input fatal after a TypeScript alias', async () => {
    const project = await mkdtemp(join(scratch, 'incomplete-ts-statement-regex-'));
    await writeFile(join(project, 'package.json'), '{}');
    await writeFile(join(project, 'index.mts'), 'type Text = string\n/unterminated\n');
    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('could not be analyzed: Unterminated regex literal\n');
  });

  it.each(['js', 'jsx'])(
    'preserves Unicode JSX evidence in a compiled .%s scan',
    async (extension) => {
      const project = await mkdtemp(join(scratch, 'unicode-jsx-'));
      const file = `index.${extension}`;
      const statement =
        "const view = <Élément>require('decoy'){require('expression-pkg')}</Élément>;";
      const source = `import 'real-pkg';\n${statement}\n`;
      const manifest = '{"dependencies":{"real-pkg":"1","expression-pkg":"1"}}';
      await writeFile(join(project, 'package.json'), manifest);
      await writeFile(join(project, file), source);

      const result = child([project, '--format', 'json']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      const report = JSON.parse(result.stdout) as JsonReport;
      expect(report.findings).toEqual({
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
      expect(report.packages).toEqual([
        expect.objectContaining({
          name: 'expression-pkg',
          status: 'used',
          evidence: [
            {
              kind: 'source',
              file,
              reference: 'require',
              specifier: 'expression-pkg',
              position: {
                offset: source.indexOf("'expression-pkg'"),
                line: 2,
                column: statement.indexOf("'expression-pkg'") + 1,
              },
            },
          ],
        }),
        expect.objectContaining({
          name: 'real-pkg',
          status: 'used',
          evidence: [
            {
              kind: 'source',
              file,
              reference: 'import',
              specifier: 'real-pkg',
              position: { offset: 7, line: 1, column: 8 },
            },
          ],
        }),
      ]);
      expect(await readFile(join(project, file), 'utf8')).toBe(source);
      expect(await readFile(join(project, 'package.json'), 'utf8')).toBe(manifest);
    },
  );

  it('keeps left shifts as operators when a string enables JSX discovery', async () => {
    const project = await mkdtemp(join(scratch, 'jsx-left-shifts-'));
    const source = [
      "const hint = '</Élément>';",
      'const result = 1 <<count;',
      'let target = 1;',
      'target <<=count;',
      "const fn = (require = 1 <<count) => require('shadowed');",
      "require('real-pkg');",
      '',
    ].join('\n');
    await writeFile(join(project, 'package.json'), '{"dependencies":{"real-pkg":"1"}}');
    await writeFile(join(project, 'index.js'), source);

    const result = child([project, '--format', 'json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as JsonReport;
    expect(report.findings).toEqual({
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    expect(report.packages).toEqual([
      expect.objectContaining({
        name: 'real-pkg',
        status: 'used',
        evidence: [
          {
            kind: 'source',
            file: 'index.js',
            reference: 'require',
            specifier: 'real-pkg',
            position: { offset: source.indexOf("'real-pkg'"), line: 6, column: 9 },
          },
        ],
      }),
    ]);
  });

  it('keeps why a project path and explicit terminal scan byte-compatible', () => {
    const legacy = child(['why']);
    expect(legacy.status).toBe(1);
    expect(legacy.stderr).toBe('');
    expect(child(['--format', 'terminal', 'why'])).toEqual(legacy);
    const json = child(['why', '--format', 'json']);
    const doc = JSON.parse(json.stdout) as JsonReport;
    expect(json.status).toBe(1);
    expect(json.stderr).toBe('');
    expect(doc.mode).toBe('scan');
    expect(doc.project.root).toBe(root);
    expect(doc.tool.version).toBe(version);
    expect(doc.findings).toEqual({
      unusedDependencies: ['dual', 'prod'],
      unusedDevDependencies: ['dev', 'dual'],
      missingDependencies: ['missing'],
    });
    expect(doc.counts).toEqual({
      unusedDependencies: 2,
      unusedDevDependencies: 2,
      missingDependencies: 1,
    });
    expect(doc.query).toBeNull();
    expect(doc.scope.ignoreDependencies).toEqual(['excluded', 'ignore-only']);
    expect(json.stdout).toBe(JSON.stringify(doc, null, 2) + '\n');
  });
  it.each([
    ['used', 'used', 0],
    ['prod', 'unused', 1],
    ['dev', 'unused', 1],
    ['dual', 'unused', 1],
    ['missing', 'missing', 1],
    ['excluded', 'excluded', 0],
    ['ignore-only', 'excluded', 0],
    ['peer', 'declared', 0],
    ['optional', 'declared', 0],
    ['absent', 'unknown', 1],
  ] as const)('projects %s as %s with exit %s in both formats', (name, status, exit) => {
    const human = child([root, '--explain', name]);
    expect(human.status).toBe(exit);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain(`Package: ${name}\nStatus: ${status}\n`);
    const json = child(['--explain', name, '--format', 'json', root]);
    expect(json.status).toBe(exit);
    expect(json.stderr).toBe('');
    const doc = JSON.parse(json.stdout) as JsonReport;
    expect(doc.mode).toBe('explain');
    expect(doc.packages).toHaveLength(1);
    expect(doc.packages[0]?.status).toBe(status);
    expect(doc.query).toEqual({ packageName: name, known: status !== 'unknown' });
    for (const values of Object.values(doc.findings))
      expect(values.every((value) => value === name)).toBe(true);
    expect(doc.counts).toEqual({
      unusedDependencies: doc.findings.unusedDependencies.length,
      unusedDevDependencies: doc.findings.unusedDevDependencies.length,
      missingDependencies: doc.findings.missingDependencies.length,
    });
    if (name === 'used')
      expect(doc.findings).toEqual({
        unusedDependencies: [],
        unusedDevDependencies: [],
        missingDependencies: [],
      });
  });
  it.each(['terminal', 'json'])(
    'preserves operational failure channels for %s scans/queries',
    (format) => {
      for (const path of [broken, invalid, join(scratch, 'missing')])
        for (const query of [[], ['--explain', 'used']]) {
          const result = child([path, '--format', format, ...query]);
          expect(result.status).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).not.toBe('');
        }
    },
  );
  it('handles no-path JSON clean scan and standalone meta without reading invalid config', async () => {
    const clean = join(scratch, 'clean');
    await mkdir(clean);
    await writeFile(join(clean, 'package.json'), '{}');
    const result = await runCli(['--format', 'json'], { cwd: clean, version: '7.8.9' });
    expect(result.exitCode).toBe(0);
    expect((JSON.parse(result.stdout) as JsonReport).tool.version).toBe('7.8.9');
    for (const args of [['--help'], ['--version']]) {
      const meta = await runCli(args, { cwd: invalid, version });
      expect(meta.exitCode).toBe(0);
      expect(meta.stderr).toBe('');
    }
  });
});

describe('entry suppresses the notifier before collaborator invocation', () => {
  it.each(['throw', 'stall', 'fresh-cache'] as const)(
    'makes zero collector/cache/transport calls with %s',
    async (behavior) => {
      const cache = join(scratch, 'cache-' + behavior);
      await mkdir(cache);
      const cachePath = join(cache, UPDATE_CACHE_FILE_NAME);
      const text = JSON.stringify({ latest: '999.0.0', checkedAt: 1234 });
      await writeFile(cachePath, text);
      const now = vi.fn(() => 1234);
      const fetchImpl = vi.fn(() => Promise.reject(new Error('No transport allowed')));
      const collector = vi.fn((request: Parameters<typeof collectUpdateNotice>[0]) => {
        if (behavior === 'throw') throw new Error('No collector allowed');
        if (behavior === 'stall')
          return new Promise<string | undefined>(() => {
            /* A deliberately stalled collaborator must never be invoked. */
          });
        return collectUpdateNotice(request, { cacheDir: cache, now, fetchImpl });
      });
      const cases = [
        ['--help'],
        ['--version'],
        ['--unknown'],
        ['--format'],
        [broken],
        [invalid],
        [root, '--format', 'json'],
        [root, '--format', 'json', '--explain', 'used'],
        [root, '--explain', 'prod'],
        [root, '--explain', 'absent'],
        [broken, '--format', 'json', '--explain', 'used'],
      ];
      for (const args of cases) {
        const out: string[] = [];
        const err: string[] = [];
        const baseline = await runCli(args, { cwd: root, version });
        const code = await runCliEntry(args, {
          cwd: root,
          version,
          env: {},
          stdout: { isTTY: true, write: (value) => out.push(value) },
          stderr: { isTTY: true, write: (value) => err.push(value) },
          updateNotice: collector,
        });
        expect(code).toBe(baseline.exitCode);
        expect(out.join('')).toBe(baseline.stdout);
        expect(err.join('')).toBe(baseline.stderr);
      }
      expect(collector).not.toHaveBeenCalled();
      expect(now).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(await readFile(cachePath, 'utf8')).toBe(text);
    },
  );
  it('preserves the optional notice for completed explicit terminal scans', async () => {
    const collect = vi.fn(() => Promise.resolve('notice\n'));
    const err: string[] = [];
    const code = await runCliEntry([root, '--format', 'terminal'], {
      cwd: root,
      version,
      env: {},
      stdout: { isTTY: true, write: () => undefined },
      stderr: { isTTY: true, write: (s) => err.push(s) },
      updateNotice: collect,
    });
    expect(code).toBe(1);
    expect(err).toEqual(['notice\n']);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]).toEqual([
      { commandKind: 'scan', currentVersion: version, env: {}, stdoutTTY: true, stderrTTY: true },
    ]);
  });
  it('leaves compiled forced-TTY JSON/query runs free of cache/transport work', () => {
    const marker = join(scratch, 'network.log');
    const cache = join(scratch, 'isolated-cache');
    for (const args of [
      [root, '--format', 'json'],
      [root, '--explain', 'used'],
      [root, '--format', 'json', '--explain', 'absent'],
      [broken, '--format', 'json'],
    ]) {
      const result = child(args, {
        NODE_OPTIONS: '--import=' + pathToFileURL(probe).href,
        DEPVITALS_NO_UPDATE_CHECK: '0',
        DEPVITALS_TEST_FORCE_TTY: '1',
        DEPVITALS_TEST_REQUEST_FILE: marker,
        XDG_CACHE_HOME: cache,
        LOCALAPPDATA: cache,
      });
      expect(result.stderr).not.toContain('New DepVitals');
    }
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(cache)).toBe(false);
  });
});

describe('diagnostics argument grammar', () => {
  it.each([
    [['--diagnostics'], cwd, undefined],
    [['project', '--diagnostics'], resolve(cwd, 'project'), undefined],
    [['--diagnostics', 'project', '--format', 'json'], resolve(cwd, 'project'), 'json'],
    [['--format', 'json', 'project', '--diagnostics'], resolve(cwd, 'project'), 'json'],
    [['--diagnostics', '--format', 'terminal'], cwd, 'terminal'],
    [['--diagnostics', 'true'], resolve(cwd, 'true'), undefined],
  ] as const)('accepts %j', (args, projectPath, format) => {
    expect(parseCliArgs(args, cwd)).toEqual({
      kind: 'scan',
      projectPath,
      ...(format === undefined ? {} : { format }),
      diagnostics: true,
    });
  });

  it.each(['diagnostics', './--diagnostics'])('preserves literal path %s', (path) => {
    expect(parseCliArgs([path], cwd)).toEqual({ kind: 'scan', projectPath: resolve(cwd, path) });
  });

  it.each([
    [['--diagnostics', '--diagnostics'], 'Option --diagnostics may be specified only once.'],
    [
      ['--diagnostics', '--explain', 'dep'],
      'Option --diagnostics cannot be combined with --explain.',
    ],
    [
      ['--explain', 'dep', '--diagnostics'],
      'Option --diagnostics cannot be combined with --explain.',
    ],
    [['--help', '--diagnostics'], 'Option --help must be used alone.'],
    [['--diagnostics', '--version'], 'Option --version must be used alone.'],
    [['--diagnostics', '--format', '--diagnostics'], 'Option --format requires a value.'],
    [['--explain', '--diagnostics'], 'Option --explain requires a value.'],
    [
      ['--diagnostics', '--diagnostics', '--explain', 'dep'],
      'Option --diagnostics may be specified only once.',
    ],
    [
      ['--diagnostics', '--explain', 'dep', 'one', 'two'],
      'Too many arguments: expected at most one project path.',
    ],
    [
      ['--diagnostics', '--explain', 'dep', ''],
      'Invalid project path: project path must not be empty.',
    ],
    [
      ['--diagnostics', '--explain', 'dep/sub'],
      'Invalid value for --explain: expected an exact package root (name or @scope/name), at most 214 characters.',
    ],
    ...['--diagnostics=true', '--diagnostics=', '--no-diagnostics', '-d', '--Diagnostics'].map(
      (arg) => [[arg], 'Unknown option: ' + arg] as const,
    ),
  ] as const)('rejects %j before project access', async (args, message) => {
    expect(parseCliArgs(args, cwd)).toEqual({ kind: 'error', message: message + '\n' + hint });
    expect(await runCli(args, { cwd: join(scratch, 'invalid-manifest'), version })).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: message + '\n' + hint + '\n',
    });
  });
});

describe('compiled diagnostic scans', () => {
  it.each([
    ['--diagnostics', 'why'],
    ['why', '--diagnostics'],
    ['--format', 'terminal', 'why', '--diagnostics'],
  ])('adds exact terminal diagnostics for %j', (...args) => {
    const ordinary = child(['why']);
    expect(child(args)).toEqual({
      ...ordinary,
      stdout:
        ordinary.stdout +
        '\nScan diagnostics\n  Source files scanned: 1\n  Nested-package source files: 0\n',
    });
  });

  it.each([
    ['--diagnostics', 'why', '--format', 'json'],
    ['--format', 'json', 'why', '--diagnostics'],
  ])('preserves ordinary JSON fields for %j', (...args) => {
    const ordinary = child(['why', '--format', 'json']);
    const observed = child(args);
    const report = JSON.parse(observed.stdout) as JsonReport;
    const { diagnostics, ...rest } = report;
    expect(observed.status).toBe(ordinary.status);
    expect(observed.stderr).toBe('');
    expect(JSON.stringify(rest, null, 2) + '\n').toBe(ordinary.stdout);
    expect(diagnostics).toEqual({
      sourceFilesScanned: 1,
      nestedPackageSourceFiles: 0,
      notices: [],
    });
    expect(Object.keys(report).slice(-1)).toEqual(['diagnostics']);
  });

  it('reports zero sources cleanly with an implicit cwd or a literal path', () => {
    const cleanRoot = join(scratch, 'diagnostics');
    const diagnostic = child(['--diagnostics'], {}, cleanRoot);
    expect(diagnostic).toEqual({
      status: 0,
      stdout:
        'DepVitals\n\nNo dependency issues found.\n\nScan diagnostics\n  Source files scanned: 0\n  Nested-package source files: 0\n  No supported source files were scanned.\n',
      stderr: '',
    });
    expect(child(['diagnostics']).stdout).toBe('DepVitals\n\nNo dependency issues found.\n');
    expect(child(['./--diagnostics'])).toEqual(child(['diagnostics']));
    expect(child(['--diagnostics', 'true'])).toEqual(diagnostic);
  });

  it.each(['invalid-manifest', 'invalid', 'broken'])('returns no partial report for %s', (path) => {
    const ordinary = child([path]);
    expect(ordinary.status).toBe(1);
    expect(ordinary.stdout).toBe('');
    expect(ordinary.stderr).not.toBe('');
    expect(child([path, '--diagnostics'])).toEqual(ordinary);
    expect(child([path, '--format', 'json', '--diagnostics'])).toEqual(ordinary);
  });

  it('lists the accepted diagnostics usage and option text', () => {
    const help = child(['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain(
      '  depvitals [project] [--format terminal|json] [--explain <package>] [--diagnostics]\n',
    );
    expect(help.stdout).toContain(
      '  --diagnostics        Include scan scope diagnostics (full scans only)\n',
    );
  });
});
