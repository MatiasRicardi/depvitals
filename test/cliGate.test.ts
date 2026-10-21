/**
 * Step 62: CLI and analysis contract gate.
 *
 * The product surface is frozen between the detection work (Steps 23-61) and the update-notifier
 * work (Steps 63-68). This file pins the Step 19 CLI baseline byte for byte, pins the options that
 * must keep being rejected, and proves a scan behaves identically in a working directory outside any
 * repository and in a process where every network and process/eval primitive is unavailable.
 *
 * Everything asserted here is static and offline: no analyzed project code, script, configuration
 * module or lifecycle hook is executed, nothing is installed or resolved, and no network access
 * happens. The lifecycle-marker and capability-lockdown assertions exist to prove exactly that.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, relative, resolve } from 'node:path';
import childProcess from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { ParsedCommand } from '../src/cli/parseCliArgs.js';
import { parseCliArgs } from '../src/cli/parseCliArgs.js';
import { runCli } from '../src/cli/runCli.js';
import { analyzeProject } from '../src/core/analyzeProject.js';
import { formatTerminalReport } from '../src/reporters/terminalReporter.js';

/**
 * The repository root, anchored to this file so the gate never depends on the invocation directory.
 */
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ANALYSIS_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'analysis');
const MANIFEST_FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'manifest');

const VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
).version;

/** The invocation directory, used as the parsing base for the command-shape probes. */
const PWD = process.cwd();

/**
 * The packaged CLI entry point (`package.json#bin`).
 *
 * CI runs the test job before the build job, so these few process-level assertions only apply once
 * `pnpm run build` has produced `dist/`; the packed tarball is validated separately by
 * `pnpm run verify:package`.
 */
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');
const itBuilt = existsSync(BUILT_ENTRY) ? it : it.skip;

/** The Step 19 help text, reproduced verbatim from `src/cli/runCli.ts`. */
const HELP =
  [
    'DepVitals',
    '',
    'A simple, lightweight dependency health checker for Node.js projects.',
    '',
    'Usage:',
    '  depvitals [project]',
    '',
    'Arguments:',
    '  project          Project directory to analyze (default: current directory)',
    '',
    'Options:',
    '  -h, --help       Show help',
    '  -v, --version    Show version',
  ].join('\n') + '\n';

const CLEAN = 'DepVitals\n\nNo dependency issues found.\n';
const BASIC_FINDINGS =
  'DepVitals\n\nUnused devDependencies (1)\n  moment\n\nMissing dependencies (1)\n  zod\n';

/** Snapshot of every file path and content under a directory tree. */
function snapshotTree(root: string): readonly { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      files.push({
        path: relative(root, absolute).split(/[\\/]/).join('/'),
        content: readFileSync(absolute, 'utf8'),
      });
    }
  };

  walk(root);
  return files.toSorted((left, right) => left.path.localeCompare(right.path));
}

/**
 * A prohibited capability: replaced for the duration of a test with something that throws loudly, so
 * a regression cannot pass silently by simply never reaching the call site.
 */
type Prohibited = {
  readonly label: string;
  calls(): number;
  restore(): void;
};

function prohibit(target: Record<string, unknown>, key: string, label: string): Prohibited {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  let count = 0;

  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: () => {
      count += 1;
      throw new Error(`DepVitals attempted to use ${label} during a scan`);
    },
  });

  return {
    label,
    calls: () => count,
    restore: () => {
      // Restoring must not leave an own `undefined` property behind when the target never had one.
      if (descriptor === undefined) {
        Reflect.deleteProperty(target, key);
        return;
      }

      Object.defineProperty(target, key, {
        configurable: true,
        writable: true,
        value: descriptor.value,
      });
    },
  };
}

/** Every primitive that could reach a registry, a name resolver, a shell or analyzed project code. */
function prohibitAllCapabilities(): readonly Prohibited[] {
  const globalScope = globalThis as unknown as Record<string, unknown>;

  return [
    prohibit(globalScope, 'fetch', 'globalThis.fetch'),
    prohibit(http, 'request', 'http.request'),
    prohibit(http, 'get', 'http.get'),
    prohibit(https, 'request', 'https.request'),
    prohibit(https, 'get', 'https.get'),
    prohibit(net, 'connect', 'net.connect'),
    prohibit(net, 'createConnection', 'net.createConnection'),
    prohibit(
      net.Socket.prototype as unknown as Record<string, unknown>,
      'connect',
      'net.Socket#connect',
    ),
    prohibit(dns, 'lookup', 'dns.lookup'),
    prohibit(dns, 'resolve', 'dns.resolve'),
    prohibit(childProcess, 'spawn', 'child_process.spawn'),
    prohibit(childProcess, 'exec', 'child_process.exec'),
    prohibit(childProcess, 'execFile', 'child_process.execFile'),
    prohibit(childProcess, 'fork', 'child_process.fork'),
    prohibit(childProcess, 'spawnSync', 'child_process.spawnSync'),
    prohibit(childProcess, 'execFileSync', 'child_process.execFileSync'),
  ];
}

const activeLockdowns: Prohibited[] = [];

afterEach(() => {
  for (const prohibited of activeLockdowns.splice(0)) {
    prohibited.restore();
  }
});

/** Run one scan in a process where no network or process/eval primitive is reachable. */
function lockDown(): void {
  activeLockdowns.push(...prohibitAllCapabilities());
}

/** A minimal project outside the working repository, used for the boundary and lockdown tests. */
const OUTSIDE_ROOT = mkdtempSync(join(tmpdir(), 'depvitals-step62-outside-'));
const OUTSIDE_PROJECT = join(OUTSIDE_ROOT, 'packages', 'nested', 'service');
const OUTSIDE_CWD = join(OUTSIDE_ROOT, 'nowhere');
const OUTSIDE_MANIFEST = `${JSON.stringify({ name: 'outside-service', version: '1.0.0', dependencies: { zod: '^3.0.0' } }, null, 2)}\n`;
const OUTSIDE_SOURCE = "import { z } from 'zod';\nconsole.log(z);\n";

beforeAll(() => {
  mkdirSync(OUTSIDE_PROJECT, { recursive: true });
  mkdirSync(OUTSIDE_CWD, { recursive: true });
  writeFileSync(join(OUTSIDE_PROJECT, 'package.json'), OUTSIDE_MANIFEST);
  writeFileSync(join(OUTSIDE_PROJECT, 'index.ts'), OUTSIDE_SOURCE);
  writeFileSync(join(OUTSIDE_CWD, 'stray.txt'), 'outside\n');
});

afterAll(() => {
  rmSync(OUTSIDE_ROOT, { force: true, recursive: true });
});

/** Whether `child` lies inside `parent` (also correct when the two are on different Windows drives). */
function isWithin(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);

  return fromParent !== '' && !isAbsolute(fromParent) && !fromParent.startsWith('..');
}

/** A shell command that records, on disk, that an analyzed lifecycle script really executed. */
function markerCommand(marker: string): string {
  return `node -e "require('fs').writeFileSync('${marker}', 'x')"`;
}

const markerRoots: string[] = [];

function makeMarkerProject(name: string, scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), `depvitals-step62-${name}-`));

  expect(existsSync(root)).toBe(true);
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'marker-project', version: '1.0.0', scripts }, null, 2)}\n`,
  );
  writeFileSync(join(root, 'index.ts'), 'export const value = 1;\n');
  markerRoots.push(root);

  return root;
}

afterAll(() => {
  for (const root of markerRoots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe('Step 62: the Step 19 CLI baseline is unchanged byte for byte', () => {
  const invocations = [
    { name: '--help', argv: ['--help'], exitCode: 0, stdout: HELP, stderr: '' },
    { name: '-h', argv: ['-h'], exitCode: 0, stdout: HELP, stderr: '' },
    {
      name: '--version',
      argv: ['--version'],
      exitCode: 0,
      stdout: `${VERSION}\n`,
      stderr: '',
    },
    {
      name: '-v',
      argv: ['-v'],
      exitCode: 0,
      stdout: `${VERSION}\n`,
      stderr: '',
    },
    {
      name: 'a clean project',
      argv: [join(ANALYSIS_FIXTURES, 'clean')],
      exitCode: 0,
      stdout: CLEAN,
      stderr: '',
    },
    {
      name: 'a project with findings',
      argv: [join(ANALYSIS_FIXTURES, 'basic')],
      exitCode: 1,
      stdout: BASIC_FINDINGS,
      stderr: '',
    },
    {
      name: 'a missing manifest',
      argv: [MANIFEST_FIXTURES],
      exitCode: 1,
      stdout: '',
      stderr: `No package.json found at ${join(MANIFEST_FIXTURES, 'package.json')}\n`,
    },
    {
      name: 'an invalid JSON manifest',
      argv: [join(MANIFEST_FIXTURES, 'invalid-json')],
      exitCode: 1,
      stdout: '',
      stderr: `${join(join(MANIFEST_FIXTURES, 'invalid-json'), 'package.json')} is not valid JSON\n`,
    },
    {
      name: 'a structurally invalid manifest',
      argv: [join(MANIFEST_FIXTURES, 'invalid-shape')],
      exitCode: 1,
      stdout: '',
      stderr: `${join(join(MANIFEST_FIXTURES, 'invalid-shape'), 'package.json')} field "dependencies" must be an object of string values\n`,
    },
    {
      name: 'an unanalyzable source file',
      argv: [join(ANALYSIS_FIXTURES, 'invalid-source')],
      exitCode: 1,
      stdout: '',
      stderr:
        `Source file ${join(join(ANALYSIS_FIXTURES, 'invalid-source'), 'src', 'broken.ts')} ` +
        'could not be analyzed: Unterminated string literal\n',
    },
  ] as const;

  it.each(invocations)('$name keeps its exact output and exit code', async (entry) => {
    const result = await runCli(entry.argv, { version: VERSION, cwd: tmpdir() });

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ exitCode: entry.exitCode, stdout: entry.stdout, stderr: entry.stderr });
  });

  it('renders stdout from the structured result alone', async () => {
    // The reporter stays the only presentation layer: for a project without configuration evidence,
    // the CLI stdout is exactly `formatReport` of the analyzer result for that project root.
    const root = join(ANALYSIS_FIXTURES, 'integration-gate', 'composed-negatives');
    const result = await runCli([root], { version: VERSION, cwd: tmpdir() });

    expect(result.stdout).toBe(formatTerminalReport(await analyzeProject(root)));
    expect(result.exitCode).toBe(1);

    // No new output channel, no evidence field, no exit code beyond the documented pair.
    expect(Object.keys(result).sort()).toEqual(['exitCode', 'stderr', 'stdout']);
  });

  it('accepts no command kind beyond help, version and a scan', () => {
    const hint = "Run 'depvitals --help' for available commands.";
    const probes: readonly { argv: readonly string[]; command: ParsedCommand }[] = [
      { argv: [], command: { kind: 'scan', projectPath: PWD } },
      { argv: ['.'], command: { kind: 'scan', projectPath: PWD } },
      { argv: ['--help'], command: { kind: 'help' } },
      { argv: ['-h'], command: { kind: 'help' } },
      { argv: ['--version'], command: { kind: 'version' } },
      { argv: ['-v'], command: { kind: 'version' } },
      // Every bare word stays a project path; none of them is a subcommand.
      { argv: ['scan'], command: { kind: 'scan', projectPath: resolve(PWD, 'scan') } },
      { argv: ['init'], command: { kind: 'scan', projectPath: resolve(PWD, 'init') } },
      { argv: ['fix'], command: { kind: 'scan', projectPath: resolve(PWD, 'fix') } },
      { argv: ['update'], command: { kind: 'scan', projectPath: resolve(PWD, 'update') } },
      { argv: ['notify'], command: { kind: 'scan', projectPath: resolve(PWD, 'notify') } },
      {
        argv: ['--fix'],
        command: {
          kind: 'error',
          message: `Unknown option: --fix\n${hint}`,
        },
      },
      {
        argv: ['--dry-run'],
        command: {
          kind: 'error',
          message: `Unknown option: --dry-run\n${hint}`,
        },
      },
      {
        argv: ['--help', '.'],
        command: {
          kind: 'error',
          message: `Option --help must be used alone.\n${hint}`,
        },
      },
      {
        argv: ['a', 'b'],
        command: {
          kind: 'error',
          message: `Too many arguments: expected at most one project path.\n${hint}`,
        },
      },
      {
        argv: [''],
        command: {
          kind: 'error',
          message: `Invalid project path: project path must not be empty.\n${hint}`,
        },
      },
    ];

    const kinds = new Set<string>();

    for (const { argv, command } of probes) {
      const parsed = parseCliArgs(argv, PWD);

      expect(parsed).toEqual(command);
      kinds.add(parsed.kind);
    }

    expect([...kinds].sort()).toEqual(['error', 'help', 'scan', 'version']);
  });
});

describe('Step 62: every unimplemented option is still rejected explicitly', () => {
  const rejected = [
    '--config',
    '--why',
    '--json',
    '--format',
    '--format=json',
    '--format=text',
    '--output',
    '--strict',
    '--fix',
    '--fix-dry-run',
    '--dry-run',
    '--quiet',
    '--silent',
    '--verbose',
    '--debug',
    '--no-color',
    '--color',
    '--cache',
    '--no-cache',
    '--clear-cache',
    '--cache-dir',
    '--offline',
    '--online',
    '--registry',
    '--ignore-scripts',
    '--install',
    '--no-install',
    '--update-notifier',
    '--no-update-notifier',
    '--check-updates',
    '--no-check-updates',
    '--latest',
  ];

  it.each(rejected)('rejects %s with the exact error, exit 1 and empty stdout', async (flag) => {
    const result = await runCli([flag], { version: VERSION, cwd: tmpdir() });

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: `Unknown option: ${flag}\nRun 'depvitals --help' for available commands.\n`,
    });
  });

  it('does not let a rejected option consume a following value', async () => {
    // The bare `--format` form is already pinned by the table above; the value form proves the
    // rejected option is never treated as an option that takes an argument.
    const result = await runCli(['--format', 'json'], { version: VERSION, cwd: tmpdir() });

    expect({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
      exitCode: 1,
      stdout: '',
      stderr: "Unknown option: --format\nRun 'depvitals --help' for available commands.\n",
    });
  });

  it('does not expose cache, install, fix or update commands', async () => {
    for (const argv of [['fix'], ['install'], ['update'], ['init'], ['notify'], ['cache']]) {
      const result = await runCli(argv, { version: VERSION, cwd: tmpdir() });

      // Bare words stay positions, so they fail as a missing manifest, never as a new command.
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('No package.json found at');
    }
  });

  itBuilt(
    'runs the built entry point with a rejected option and gets the same explicit failure',
    () => {
      const result = spawnSync(process.execPath, [BUILT_ENTRY, '--fix'], {
        cwd: tmpdir(),
        encoding: 'utf8',
      });

      expect({
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      }).toEqual({
        status: 1,
        stdout: '',
        stderr: "Unknown option: --fix\nRun 'depvitals --help' for available commands.\n",
      });
    },
  );
});

describe('Step 62: a scan outside the working repository behaves like any other scan', () => {
  it('is genuinely outside the repository', () => {
    // Anchored to the repository, not to the invocation directory, and compared through
    // `realpathSync` so a symlinked temporary directory cannot make the boundary depend on a cwd.
    expect(isWithin(realpathSync(REPO_ROOT), realpathSync(OUTSIDE_ROOT))).toBe(false);
    expect(existsSync(join(OUTSIDE_PROJECT, 'package.json'))).toBe(true);
    expect(existsSync(join(OUTSIDE_CWD, 'package.json'))).toBe(false);
  });

  it('finds exactly what the same project would find anywhere else', async () => {
    const result = await runCli([OUTSIDE_PROJECT], { version: VERSION, cwd: OUTSIDE_CWD });

    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ exitCode: 0, stdout: CLEAN, stderr: '' });
  });

  it('reads and writes nothing outside the scanned project', async () => {
    const expected = [
      { path: 'nowhere/stray.txt', content: 'outside\n' },
      { path: 'packages/nested/service/index.ts', content: OUTSIDE_SOURCE },
      { path: 'packages/nested/service/package.json', content: OUTSIDE_MANIFEST },
    ];

    expect(snapshotTree(OUTSIDE_ROOT)).toEqual(expected);

    await runCli([OUTSIDE_PROJECT], { version: VERSION, cwd: OUTSIDE_CWD });
    await runCli([], { version: VERSION, cwd: OUTSIDE_PROJECT });

    expect(snapshotTree(OUTSIDE_ROOT)).toEqual(expected);
    expect(existsSync(join(OUTSIDE_ROOT, 'node_modules'))).toBe(false);
    expect(existsSync(join(OUTSIDE_ROOT, 'pnpm-lock.yaml'))).toBe(false);
  });

  it('produces the identical result when every network and process primitive is unavailable', async () => {
    const unlocked = await runCli([OUTSIDE_PROJECT], { version: VERSION, cwd: OUTSIDE_CWD });

    lockDown();

    expect(await runCli([OUTSIDE_PROJECT], { version: VERSION, cwd: OUTSIDE_CWD })).toEqual(
      unlocked,
    );
  });

  itBuilt('installs nothing and touches no lockfile when run as the built entry point', () => {
    const result = spawnSync(process.execPath, [BUILT_ENTRY, OUTSIDE_PROJECT], {
      cwd: OUTSIDE_CWD,
      encoding: 'utf8',
    });

    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: CLEAN,
      stderr: '',
    });
    expect(existsSync(join(OUTSIDE_PROJECT, 'node_modules'))).toBe(false);
    expect(existsSync(join(OUTSIDE_ROOT, 'package-lock.json'))).toBe(false);
  });
});

describe('Step 62: no analyzed script, configuration module or lifecycle hook is executed', () => {
  const lifecycleSets = [
    {
      name: 'the full lifecycle set',
      scripts: {
        preinstall: markerCommand('lifecycle-ran-preinstall'),
        postinstall: markerCommand('lifecycle-ran-postinstall'),
        prepare: markerCommand('lifecycle-ran-prepare'),
        prepublish: markerCommand('lifecycle-ran-prepublish'),
        preprepare: markerCommand('lifecycle-ran-preprepare'),
        postprepare: markerCommand('lifecycle-ran-postprepare'),
      },
    },
    {
      name: 'a misleading test script',
      scripts: { test: markerCommand('lifecycle-ran-test') },
    },
  ];

  itBuilt.each(lifecycleSets)('$name never runs during a scan', ({ scripts }) => {
    const root = makeMarkerProject('lifecycle', scripts);
    const result = spawnSync(process.execPath, [BUILT_ENTRY, root], {
      cwd: tmpdir(),
      encoding: 'utf8',
    });

    expect({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      markers: readdirSync(root)
        .filter((entry) => entry.startsWith('lifecycle-ran-'))
        .sort(),
    }).toEqual({ status: 0, stdout: CLEAN, stderr: '', markers: [] });
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('still classifies a project whose test script names an undeclared tool', async () => {
    const root = makeMarkerProject('script-undeclared', { test: 'mocha --reporter spec' });
    const result = await runCli([root], { version: VERSION, cwd: tmpdir() });

    // The `mocha` command is a usage record, not a missing dependency.
    expect({
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ exitCode: 0, stdout: CLEAN, stderr: '' });
  });
});

describe('Step 62: the whole CLI matrix runs offline', () => {
  type OfflineCase = {
    readonly label: string;
    readonly argv: readonly string[];
    /**
     * The project directory behind the arguments, or `null` for the two meta commands. Every entry
     * is pinned to exist, because a missing fixture makes both runs fail in the same way and would
     * turn the comparison below into a vacuous one.
     */
    readonly project: string | null;
  };

  const clean = join(ANALYSIS_FIXTURES, 'clean');
  const basic = join(ANALYSIS_FIXTURES, 'basic');
  const scriptUsage = join(ANALYSIS_FIXTURES, 'scripts-only-devtools');
  const workspaceParent = join(ANALYSIS_FIXTURES, 'integration-gate', 'project-boundary');
  const invalidSource = join(ANALYSIS_FIXTURES, 'invalid-source');
  const invalidJson = join(MANIFEST_FIXTURES, 'invalid-json');

  const matrix: readonly OfflineCase[] = [
    { label: 'help', argv: ['--help'], project: null },
    { label: 'version', argv: ['--version'], project: null },
    { label: 'a clean project', argv: [clean], project: clean },
    { label: 'a project with findings', argv: [basic], project: basic },
    { label: 'script usage', argv: [scriptUsage], project: scriptUsage },
    { label: 'a workspace parent', argv: [workspaceParent], project: workspaceParent },
    { label: 'an unanalyzable source', argv: [invalidSource], project: invalidSource },
    { label: 'a missing manifest', argv: [MANIFEST_FIXTURES], project: MANIFEST_FIXTURES },
    { label: 'an invalid JSON manifest', argv: [invalidJson], project: invalidJson },
    {
      label: 'a project outside the repository',
      argv: [OUTSIDE_PROJECT],
      project: OUTSIDE_PROJECT,
    },
  ];

  it.each(matrix)(
    'produces the unlocked result for $label with all capabilities disabled',
    async ({ argv, project }) => {
      if (project !== null) {
        expect(existsSync(project)).toBe(true);
      }

      const unlocked = await runCli(argv, { version: VERSION, cwd: tmpdir() });

      lockDown();

      const locked = await runCli(argv, { version: VERSION, cwd: tmpdir() });

      expect({
        exitCode: locked.exitCode,
        stdout: locked.stdout,
        stderr: locked.stderr,
      }).toEqual({
        exitCode: unlocked.exitCode,
        stdout: unlocked.stdout,
        stderr: unlocked.stderr,
      });

      for (const prohibited of activeLockdowns) {
        expect(prohibited.calls()).toBe(0);
      }
    },
  );

  it('leaves the whole Step 62 fixture set unchanged under the same lockdown', async () => {
    const gate = join(ANALYSIS_FIXTURES, 'integration-gate');
    const before = snapshotTree(gate);

    lockDown();

    for (const entry of readdirSync(gate)) {
      await runCli([join(gate, entry)], { version: VERSION, cwd: tmpdir() });
    }

    expect(snapshotTree(gate)).toEqual(before);

    for (const prohibited of activeLockdowns) {
      expect(prohibited.calls()).toBe(0);
    }
  });
});
