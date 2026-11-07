#!/usr/bin/env node
/**
 * Package consumer smoke test for the DepVitals CLI, including the planned v0.3 configuration/audit behavior.
 *
 * It verifies the package exactly as an npm consumer receives it: it packs the real artifact,
 * inspects the tarball, installs the tarball into an isolated temporary project, and executes the
 * installed `depvitals` executable against independent, deterministic fixture projects so the smoke
 * test exercises the real dependency scanner end to end.
 *
 * Node.js builtins and the project's built scanner only. No dependency is added.
 *
 * Flow:
 *   create temp dir
 *     -> npm pack into temp dir
 *     -> inspect tarball contents
 *     -> create consumer temp project
 *     -> install the local tarball
 *     -> create clean and findings fixture projects
 *     -> invoke the installed CLI (help, version, clean scan, findings scan, errors)
 *     -> assert the fixtures were not mutated
 *     -> cleanup (always, even on failure)
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { findProductionImports, isExternalProductionImport } from './productionImports.mjs';
import { archiveFiles } from './measurementIdentity.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(SCRIPT_PATH, '..', '..');

const SCHEMA_FILES = [
  'schemas/report-v1.schema.json',
  'schemas/README.md',
  'schemas/examples/README.md',
  ...[
    'scan-clean',
    'scan-findings',
    'explain-missing',
    'explain-excluded',
    'explain-unknown',
    'explain-node-preload',
  ].map((name) => `schemas/examples/${name}.json`),
];

/** Required files that must be present inside the packaged `package/` tree. */
const REQUIRED_FILES = [
  ...SCHEMA_FILES.map((file) => `package/${file}`),
  'package/package.json',
  'package/README.md',
  'package/LICENSE',
  'package/dist/cli/index.js',
  'package/dist/config/readProjectConfig.js',
  'package/dist/config/ignorePaths.js',
  'package/dist/config/ignoreDependencies.js',
  'package/dist/config/projectConfigError.js',
];

/** Development-only trees that must never enter the published package. */
const FORBIDDEN_PREFIXES = [
  'src/',
  'test/',
  '.github/',
  'instructions/',
  'coverage/',
  'node_modules/',
  'scripts/',
  'docs/',
];

/**
 * Signal a verification failure by throwing, so control unwinds through the caller's finally block
 * and temporary directories are always cleaned up before the process reports a nonzero exit code.
 */
function fail(message) {
  console.error(`\n\u2716 ${message}\n`);
  throw new Error(message);
}

/**
 * Run a command and return the raw spawn result.
 *
 * On Windows npm and the installed CLI are `.cmd` shims, which need to be launched through a shell
 * with quoted paths. Everywhere else the command runs directly.
 */
function run(command, args, cwd, env = process.env) {
  if (process.platform === 'win32') {
    const shellCommand = [command, ...args].map((value) => `"${value}"`).join(' ');

    return spawnSync(shellCommand, { encoding: 'utf8', cwd, env, shell: true, timeout: 120_000 });
  }

  return spawnSync(command, args, { encoding: 'utf8', cwd, env, timeout: 120_000 });
}

let checksPassed = 0;

/**
 * Record a single assertion. Failing an assertion aborts the verifier immediately.
 */
function check(label, condition, detail) {
  if (condition) {
    checksPassed += 1;
    console.log(`  \u2713 ${label}`);
    return;
  }

  fail(`${label}${detail ? ` (${detail})` : ''}`);
}

/**
 * Resolve the installed executable path in a cross-platform way.
 */
function resolveInstalledBin(consumerDir) {
  const binName = process.platform === 'win32' ? 'depvitals.cmd' : 'depvitals';

  return join(consumerDir, 'node_modules', '.bin', binName);
}

const tempDirs = [];

/**
 * Create a tracked temporary directory that is always removed at the end.
 */
function makeTempDir(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `depvitals-${prefix}-`)));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run the installed CLI executable against the given arguments.
 */
function runInstalledCli(binPath, consumerDir, args) {
  return run(binPath, args, consumerDir, { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' });
}

async function checkProductionImports(directory, installedRoot, packedFiles) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkProductionImports(path, installedRoot, packedFiles);
    } else if (/\.(?:c|m)?js$/.test(entry.name)) {
      const packedPath = relative(installedRoot, path).split(sep).join('/');
      const bytes = readFileSync(path);
      check(
        `installed module bytes match archive: ${packedPath}`,
        packedFiles.get(packedPath)?.equals(bytes) === true,
      );
      const specifiers = await findProductionImports(bytes.toString('utf8'));
      const external = specifiers.find(isExternalProductionImport);
      check(
        `production imports are internal or Node builtins: ${packedPath}`,
        external === undefined,
        external,
      );
      for (const specifier of specifiers.filter((name) => /^\.\.?\//.test(name))) {
        const target = fileURLToPath(new URL(specifier, pathToFileURL(path)));
        const fromPackage = relative(installedRoot, target);
        check(
          `installed import target exists: ${packedPath} -> ${specifier}`,
          !isAbsolute(fromPackage) &&
            fromPackage !== '..' &&
            !fromPackage.startsWith(`..${sep}`) &&
            existsSync(target) &&
            statSync(target).isFile(),
        );
      }
    }
  }
}

/**
 * Snapshot the contents of every file inside the given fixture directories, keyed by absolute
 * path, so a scan can be asserted to leave them byte-for-byte unchanged.
 */
function snapshotFixtures(dirs) {
  const snapshot = {};

  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot[path] = 'directory';
        walk(path);
      } else if (entry.isSymbolicLink()) snapshot[path] = 'link:' + readlinkSync(path);
      else snapshot[path] = 'file:' + readFileSync(path).toString('hex');
    }
  };
  for (const dir of dirs) walk(dir);

  return snapshot;
}

/**
 * Whether two fixture snapshots are identical: they track the same set of file paths and every
 * tracked file has identical contents. Comparing the complete before-and-after snapshots (rather
 * than only the files that still exist) detects modified, deleted, and newly created files.
 */
function snapshotsEqual(before, after) {
  const beforePaths = Object.keys(before);
  const afterPaths = Object.keys(after);

  // Different path counts mean a file was added or deleted.
  if (beforePaths.length !== afterPaths.length) {
    return false;
  }

  for (const path of afterPaths) {
    // A path missing from `before` (a new file) or with different contents (a modified file) is a
    // mutation; `before[path]` is `undefined` for a path absent from `before`.
    if (before[path] !== after[path]) {
      return false;
    }
  }

  return true;
}

async function main() {
  const rootVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  console.log('DepVitals package consumer smoke test');
  console.log(`Root package version: ${rootVersion}\n`);

  const tempDir = makeTempDir('package');

  try {
    // 1. Pack the real artifact into the temporary directory.
    console.log('Packing the package...');
    const pack = run('npm', ['pack', '--json', '--pack-destination', tempDir], ROOT);

    if (pack.status !== 0) {
      fail(`npm pack failed.\n${pack.stderr || pack.stdout}`);
    }

    let packed;

    try {
      packed = JSON.parse(pack.stdout.trim())[0];
    } catch {
      fail(`Could not parse "npm pack --json" output.\n${pack.stdout || pack.stderr}`);
    }

    if (!packed || !packed.filename) {
      fail(`No tarball metadata returned by "npm pack --json".\n${pack.stdout}`);
    }

    const tarballPath = join(tempDir, packed.filename);

    if (!existsSync(tarballPath)) {
      fail(`Tarball was not created at ${tarballPath}`);
    }

    console.log(`  packed ${packed.filename} (${packed.version})`);

    // 2. Inspect the tarball contents.
    console.log('\nChecking tarball contents...');
    const archiveBytes = readFileSync(tarballPath);
    check('tarball version matches project', packed.version === rootVersion);
    check('tarball size matches metadata', archiveBytes.length === packed.size);
    check(
      'tarball SHA-1 matches metadata',
      createHash('sha1').update(archiveBytes).digest('hex') === packed.shasum,
    );
    check(
      'tarball SRI matches metadata',
      'sha512-' + createHash('sha512').update(archiveBytes).digest('base64') === packed.integrity,
    );
    console.log(
      'Artifact identity: ' +
        JSON.stringify({
          version: packed.version,
          packedBytes: packed.size,
          unpackedBytes: packed.unpackedSize,
          integrity: packed.integrity,
          shasum: packed.shasum,
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        }),
    );
    let entries;
    let packedFiles;

    try {
      packedFiles = archiveFiles(archiveBytes);
      entries = [...packedFiles.keys()].map((name) => `package/${name}`);
    } catch (error) {
      fail(`Could not read tarball entries: ${error.message}`);
    }

    for (const required of REQUIRED_FILES) {
      check(`contains ${required}`, entries.includes(required));
    }

    for (const file of SCHEMA_FILES) {
      check(
        `archive schema asset matches checkout: ${file}`,
        packedFiles.get(file)?.equals(readFileSync(join(ROOT, file))) === true,
      );
    }
    const schema = JSON.parse(packedFiles.get('schemas/report-v1.schema.json').toString('utf8'));
    check(
      'public schema is Draft 7 report version 1',
      schema.$schema === 'http://json-schema.org/draft-07/schema#' &&
        schema.properties?.schemaVersion?.const === 1,
    );
    for (const file of SCHEMA_FILES.filter(
      (file) => file.startsWith('schemas/examples/') && file.endsWith('.json'),
    )) {
      const example = JSON.parse(packedFiles.get(file).toString('utf8'));
      check(
        `normative example is parseable report v1: ${file}`,
        example.schemaVersion === 1 && ['scan', 'explain'].includes(example.mode),
      );
    }

    const forbidden = entries.find((entry) =>
      FORBIDDEN_PREFIXES.some((prefix) => entry.startsWith(`package/${prefix}`)),
    );

    check('rejects development-only content', forbidden === undefined, forbidden);

    // 3. Install the tarball into an isolated consumer project.
    console.log('\nInstalling the tarball into an isolated consumer...');
    const consumerDir = makeTempDir('consumer');

    writeFileSync(
      join(consumerDir, 'package.json'),
      `${JSON.stringify({ name: 'depvitals-consumer', version: '1.0.0' }, null, 2)}\n`,
    );

    const install = run('npm', ['install', '--no-audit', '--no-fund', tarballPath], consumerDir);

    if (install.status !== 0) {
      fail(`npm install of the tarball failed.\n${install.stderr || install.stdout}`);
    }

    check(
      'installed depvitals from the local tarball',
      existsSync(join(consumerDir, 'node_modules', 'depvitals', 'package.json')),
    );
    const installedRoot = join(consumerDir, 'node_modules', 'depvitals');
    for (const file of SCHEMA_FILES) {
      check(
        `installed schema asset matches archive: ${file}`,
        readFileSync(join(installedRoot, file)).equals(packedFiles.get(file)),
      );
    }
    const installedManifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'));
    check(
      'installed manifest has no runtime or optional dependencies',
      installedManifest.dependencies === undefined &&
        installedManifest.optionalDependencies === undefined,
    );
    check(
      'consumer did not install development dependencies',
      readdirSync(join(consumerDir, 'node_modules'))
        .filter((name) => !name.startsWith('.'))
        .every((name) => name === 'depvitals'),
    );
    check('installed package stays ESM', installedManifest.type === 'module');
    check(
      'installed executable metadata is supported',
      installedManifest.bin?.depvitals === './dist/cli/index.js',
    );
    check(
      'installed Node minimum matches project',
      installedManifest.engines?.node ===
        JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines.node,
    );
    check(
      'installed package adds no public API entrypoint',
      installedManifest.main === undefined &&
        installedManifest.types === undefined &&
        installedManifest.exports === undefined,
    );
    const installedEntry = join(installedRoot, 'dist/cli/index.js');
    check(
      'installed CLI preserves its node shebang',
      readFileSync(installedEntry, 'utf8').startsWith('#!/usr/bin/env node'),
    );
    check(
      'installed CLI is executable',
      process.platform === 'win32' || (statSync(installedEntry).mode & 0o111) !== 0,
    );
    await checkProductionImports(join(installedRoot, 'dist'), installedRoot, packedFiles);
    // An unrelated cwd/parent config must never override the selected project.
    writeFileSync(join(consumerDir, 'depvitals.config.json'), '{invalid consumer-cwd config');

    // 4. Create independent, deterministic fixture projects inside the consumer temp dir. They
    //    stand in for real scanned projects and keep the smoke test independent of the DepVitals
    //    repository fixtures or source tree.
    const cleanDir = join(consumerDir, 'smoke-clean');
    const findingsDir = join(consumerDir, 'smoke-findings');

    mkdirSync(cleanDir, { recursive: true });
    mkdirSync(findingsDir, { recursive: true });

    writeFileSync(
      join(cleanDir, 'package.json'),
      `${JSON.stringify({ name: 'smoke-clean', version: '0.0.0', dependencies: { lodash: '4.17.21' }, peerDependencies: { 'peer-only': '*' } }, null, 2)}\n`,
    );
    writeFileSync(
      join(cleanDir, 'index.js'),
      ["import { chunk } from 'lodash';", 'export const parts = chunk([1, 2], 2);', ''].join('\n'),
    );

    writeFileSync(
      join(findingsDir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'smoke-findings',
          version: '0.0.0',
          dependencies: { lodash: '4.17.21', 'unused-dep': '1.0.0' },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(findingsDir, 'index.js'),
      [
        "import { chunk } from 'lodash';",
        "import { missing } from 'missing-pkg';",
        '',
        'export const parts = chunk([1, 2], 2);',
        'export const m = missing;',
        '',
      ].join('\n'),
    );

    const structuralDirs = [
      [
        'one-shot-for-of',
        'index.cjs',
        `const of = 6;
for (const x of of / require('real') / 2 ? [] : []) {}`,
      ],
      [
        'ordinary-assertion-named-comparisons',
        'index.cjs',
        `const as = 0, satisfies = 0, x = 1;
as < x > /require('fake')/.source.length;
satisfies < x > /require('fake')/.source.length;
require('real');`,
      ],
      [
        'typed-class-heritage',
        'index.ts',
        `class Base<T> {}
interface I<T> {}
class C extends Base<{ ok: boolean }> implements I<() => object> {
  async run() { await /require('fake')/; require('real'); }
}`,
      ],
      [
        'qualified-type-assertions',
        'index.ts',
        `namespace N { export type Num<T> = number; }
const a = 1 as N.Num<string> / require('real') / 2;
const b = 1 satisfies N.Num<string> / require('real') / 2;`,
      ],
      [
        'prefixed-type-operands',
        'index.ts',
        `type Num<T> = number;
const a = 1 as Num<keyof { ok: boolean }> / require('real') / 2;
const b = 1 satisfies Num<keyof { ok: boolean }> / require('real') / 2;
async function outer() {
  const c = 1 as Num<() => number> + await /require('fake')/;
  require('real');
}`,
      ],
      [
        'html-closing-trivia',
        'index.cjs',
        `/* comment */ --> require('fake')
const x = 1; /* comment
*/ --> require('fake')
require('real');`,
      ],
      [
        'consecutive-fields',
        'index.cjs',
        `class C { a = () => 0
          b
          c
          *run() { yield /require('fake')/; require('real'); }
        }`,
      ],
      [
        'function-typed-field',
        'index.ts',
        `class C { callback!: (value: string) => void
          *run() { yield /require('fake')/; require('real'); }
        }`,
      ],
      [
        'multiplication-division',
        'index.cjs',
        `class C {
          value = (2 * require('real')) / 4;
          async run() { await /require('fake')/; require('real'); }
        }`,
      ],
      [
        'object-type-templates',
        'index.ts',
        'function f(x: { tag: `x${string}` }) {} class C { value!: { tag: `x${string}` }; } require("real");',
      ],
      [
        'special-method-names',
        'index.cjs',
        `async function outer() {
          const o = { async return() { await /require('fake')/; require('real'); },
            'run'(await) { return await / require('real') / 2; },
            *function() { yield /require('fake')/; require('real'); } };
          class C { 1(await) { return await / require('real') / 2; } }
        }`,
      ],
      [
        'nested-generics',
        'index.ts',
        `const f = async <T extends { value: number }>(x: T) => {
          await /require('fake')/; require('real'); };
          class C { async run<T = (x: { value: number }) => void>(x: T) {
            await /require('fake')/; require('real'); } }`,
      ],
      [
        'postfix-operators',
        'index.cjs',
        `let n = 1; const v = n++ / require('real') / 2;
          class C { value = n--
            async run() { await /require('fake')/; require('real'); } }`,
      ],
      [
        'word-operators',
        'index.cjs',
        `const f = async () => value
          instanceof Object ? await /require('fake')/ : require('real');
          class C { value = async () => value /*\n*/ in Object
            ? await /require('fake')/ : require('real'); }`,
      ],
      [
        'class-expression-division',
        'index.cjs',
        `const value = class {} / require('real') / 2;
          class C { handle = class Named extends Base {}
            / require('real') / 2; }
          /require('fake')/.test(value);`,
      ],
      [
        'for-of-and-asi',
        'index.cjs',
        `for (const x of /require('fake')/.source) { require('real'); }
          function f() { return
            {} /require('fake-too')/.test('');
          }`,
      ],
      [
        'typescript-expression-boundaries',
        'index.ts',
        `type Num<T> = number;
          const value = 1 as Num<Array<string>> / require('real') / 2;
          class C { value!: abstract
            new () => object
            async run() { await /require('fake')/; require('real'); }
          }`,
      ],
      [
        'module-jsx',
        'index.jsx',
        `const view = <p />;
          await /require('fake')/;
          require('real');
          export {};`,
        'module',
      ],
      [
        'module-tsx',
        'index.tsx',
        `const view = <p />;
          await /require('fake')/;
          require('real');
          export {};`,
        'module',
      ],
    ].map(([name, fileName, source, type]) => {
      const directory = join(consumerDir, name);
      mkdirSync(directory);
      writeFileSync(
        join(directory, 'package.json'),
        JSON.stringify({
          name,
          version: '0.0.0',
          ...(type === 'module' ? { type } : {}),
          dependencies: { real: '*' },
        }),
      );
      writeFileSync(join(directory, fileName), source);
      return directory;
    });
    const assertionDirs = [
      [
        'object-type-ending',
        'index.ts',
        "const n = 1 as number & {} / require('real') / 2;",
        false,
      ],
      [
        'composed-generics',
        'index.ts',
        "type Num<T> = number; const n = 1 satisfies Num<string> & Num<number> / require('real') / 2;",
        false,
      ],
      [
        'import-query',
        'index.ts',
        "declare module 'types' { export type Num<T> = number; } const n = 1 as import('types').Num<string> / require('real') / 2;",
        true,
      ],
      [
        'assertion-named-statement',
        'index.cjs',
        "const as = 0, x = 1;\nx\nas < x > /require('fake')/.source.length;\nrequire('real');",
        false,
      ],
      [
        'arrow-assertion-async-owner',
        'index.ts',
        "type Num<T> = number; async function f() { const g = () => 1 as Num<string>; await /require('fake')/; require('real'); }",
        false,
      ],
      [
        'arrow-assertion-ordinary-owner',
        'index.ts',
        "type Num<T> = number; function f(await) { const g = async () => 1 satisfies Num<string>; return await / require('real') / 2; }",
        false,
      ],
    ].flatMap(([name, fileName, source, hasTypes]) =>
      ['missing', 'clean', 'unused'].map((mode) => {
        const directory = join(consumerDir, `assertion-${name}-${mode}`);
        mkdirSync(directory);
        writeFileSync(
          join(directory, 'package.json'),
          JSON.stringify({
            name: `assertion-${name}-${mode}`,
            version: '0.0.0',
            dependencies: {
              ...(hasTypes ? { types: '*' } : {}),
              ...(mode !== 'missing' ? { real: '*' } : {}),
              ...(mode === 'unused' ? { fake: '*' } : {}),
            },
          }),
        );
        writeFileSync(join(directory, fileName), source);
        return { directory, mode };
      }),
    );
    const invalidTemplateDir = join(consumerDir, 'incomplete-type-template');
    mkdirSync(invalidTemplateDir);
    writeFileSync(
      join(invalidTemplateDir, 'package.json'),
      JSON.stringify({
        name: 'incomplete-type-template',
        version: '0.0.0',
        dependencies: { real: '*' },
      }),
    );
    writeFileSync(
      join(invalidTemplateDir, 'index.ts'),
      'require("real"); function f(x: { tag: `x${string',
    );
    const configuredDir = join(consumerDir, 'configured-project');
    mkdirSync(configuredDir);
    writeFileSync(
      join(configuredDir, 'package.json'),
      JSON.stringify({ dependencies: { selected: '*' } }),
    );
    writeFileSync(join(configuredDir, 'index.cjs'), "require('selected-missing');");
    writeFileSync(join(configuredDir, 'generated.ts'), "import 'unterminated");
    writeFileSync(
      join(configuredDir, 'depvitals.config.json'),
      JSON.stringify({
        ignorePaths: ['generated.ts'],
        ignoreDependencies: ['selected', 'selected-missing'],
      }),
    );
    const invalidConfigDir = join(consumerDir, 'invalid-config-project');
    mkdirSync(invalidConfigDir);
    writeFileSync(join(invalidConfigDir, 'package.json'), '{}');
    writeFileSync(join(invalidConfigDir, 'depvitals.config.json'), '{invalid config JSON');
    // Each variant has its own manifest/source bytes; expected findings are hand-authored.
    const auditManifest = {
      name: 'consumer-self',
      version: '0.0.0',
      exports: { './feature': './dist/absent.js' },
      dependencies: Object.fromEntries(
        [
          'consumer-self',
          'live-esm',
          'live-cjs-await',
          'live-function',
          'live-template',
          'live-dynamic',
          'kept-prefix',
          'selected-unused',
          'selected-unused-extra',
          'duplicate',
          'gulp',
          'gulp-cli',
          'payload-decoy',
          'property-decoy',
          'regex-decoy',
          'shadow-decoy',
          'source-only',
          'eslint-config-prettier',
        ].map((name) => [name, '*']),
      ),
      devDependencies: {
        duplicate: '*',
        'selected-dev': '*',
        prettier: '*',
        'ts-jest': '*',
        typescript: '*',
      },
      scripts: {
        payload: "cat <<'EOF'\npayload-decoy\nEOF\nprettier",
        opaque: 'echo $( (echo hi); payload-decoy ) && tsc',
        collision: 'gulp build',
        postinstall: `node -e "require('node:fs').writeFileSync('SCRIPT_RAN', 'ran')"`,
      },
      eslintConfig: { extends: 'prettier' },
      jest: { preset: 'ts-jest' },
    };
    const auditSource = `import 'live-esm'; import 'consumer-self/feature';
      import 'selected-missing'; import 'genuine-missing';
      await /don't require('regex-decoy')/;
      const object = { import: 1 }; const from = 1; from
      'property-decoy';
      const f = () => function() {} / require('live-function',) / 2;
      const tag = require\`\${('tag-decoy')}\${require('live-template')}\`;
      const shadow = require => require('shadow-decoy');
      import('live-dynamic', {with: {type: 'json'}, extra: require('dynamic-nested-missing')},);
      throw new Error('target code must never execute');`;
    const policy = {
      ignorePaths: ['generated', 'ignored'],
      ignoreDependencies: [
        'duplicate',
        'gulp',
        'selected-dev',
        'selected-missing',
        'selected-unused',
      ],
    };
    const auditCases = [
      'absent',
      'empty',
      'configured',
      'retained-malformed',
      'invalid-policy',
      'barriers',
      'active-rc',
      'root-manifest',
    ].map((name) => {
      const directory = join(consumerDir, `audit-${name}`);
      const files = {
        'package.json': JSON.stringify(auditManifest),
        'index.js': auditSource,
        'script-control.cjs': "var await = 4; await / require('live-cjs-await',) / 2;",
        'generated/only.ts': "require('source-only');",
        'generated-extra/neighbor.cjs': "require('kept-prefix');",
      };
      if (name === 'empty') files['depvitals.config.json'] = '{}';
      if (!['absent', 'empty'].includes(name)) {
        files['depvitals.config.json'] = JSON.stringify(policy);
        files['ignored/broken.ts'] = "import 'unterminated";
      }
      if (name === 'retained-malformed') files['retained/broken.ts'] = "import 'unterminated";
      if (name === 'invalid-policy')
        files['depvitals.config.json'] = JSON.stringify({ ignoreDependencies: ['bad/subpath'] });
      if (name === 'barriers') {
        files['depvitals.config.json'] = JSON.stringify({
          ...policy,
          ignorePaths: [...policy.ignorePaths, 'eslint.config.js', 'jest.config.js'],
        });
        files['eslint.config.js'] = "import 'unterminated";
        files['jest.config.js'] = "import 'unterminated";
      }
      if (name === 'active-rc') {
        files['depvitals.config.json'] = JSON.stringify({
          ...policy,
          ignorePaths: [...policy.ignorePaths, '.eslintrc.json', 'package.json'],
        });
        files['.eslintrc.json'] = '{invalid detector JSON';
      }
      if (name === 'root-manifest') {
        files['package.json'] = '{invalid manifest JSON';
        files['depvitals.config.json'] = JSON.stringify({
          ...policy,
          ignorePaths: ['package.json'],
        });
      }
      for (const [file, bytes] of Object.entries(files)) {
        const path = join(directory, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
      }
      return { name, directory };
    });
    const fixtureDirs = [
      ...auditCases.map(({ directory }) => directory),
      configuredDir,
      invalidConfigDir,
      cleanDir,
      findingsDir,
      ...structuralDirs,
      ...assertionDirs.map(({ directory }) => directory),
      invalidTemplateDir,
    ];
    // Development-only syntax oracles parse these new controls without executing them.
    for (const file of ['index.js', 'script-control.cjs']) {
      const syntax = run(
        process.execPath,
        ['--check', join(auditCases[0].directory, file)],
        consumerDir,
      );
      check(`audit control syntax is valid: ${file}`, syntax.status === 0, syntax.stderr);
    }
    const before = snapshotFixtures(fixtureDirs);

    // 5. Invoke the installed executable.
    const binPath = resolveInstalledBin(consumerDir);
    check('installed executable exists', existsSync(binPath));

    console.log('\nValidating the installed CLI...');

    // Help and version keep working.
    const help = runInstalledCli(binPath, consumerDir, ['--help']);
    check('--help exits 0', help.status === 0);
    check('--help identifies DepVitals', help.stdout.includes('DepVitals'));
    check('--help shows usage', help.stdout.includes('Usage:'));
    check('--help lists the project argument', help.stdout.includes('depvitals [project]'));
    check(
      '--help lists the supported flags',
      help.stdout.includes('-h, --help') && help.stdout.includes('-v, --version'),
    );

    const version = runInstalledCli(binPath, consumerDir, ['--version']);
    check('--version exits 0', version.status === 0);
    check(
      '--version matches the root package version',
      version.stdout.trim() === rootVersion,
      `${version.stdout.trim()} !== ${rootVersion}`,
    );

    // A clean project scans with exit 0 and prints no findings, passed through an explicit
    // project-path argument rather than the current working directory.
    const clean = runInstalledCli(binPath, consumerDir, [cleanDir]);
    check('clean scan exits 0', clean.status === 0, `status=${clean.status}`);
    check(
      'clean scan reports no issues',
      clean.stdout === 'DepVitals\n\nNo dependency issues found.\n',
      JSON.stringify(clean.stdout),
    );
    check('clean scan leaves stderr empty', clean.stderr === '');

    // A project with findings scans with exit 1 and prints the report to stdout, passed through
    // an explicit project-path argument.
    const findings = runInstalledCli(binPath, consumerDir, [findingsDir]);
    check('findings scan exits 1', findings.status === 1, `status=${findings.status}`);
    check(
      'findings scan prints the report to stdout',
      findings.stdout ===
        'DepVitals\n\nUnused dependencies (1)\n  unused-dep\n\nMissing dependencies (1)\n  missing-pkg\n',
      JSON.stringify(findings.stdout),
    );
    check('findings scan leaves stderr empty', findings.stderr === '');

    for (const directory of structuralDirs) {
      const result = runInstalledCli(binPath, consumerDir, [directory]);
      check(`structural consumer exits 0: ${directory}`, result.status === 0, result.stderr);
      check(
        `structural consumer reports clean: ${directory}`,
        result.stdout === 'DepVitals\n\nNo dependency issues found.\n',
        result.stdout,
      );
      check(`structural consumer leaves stderr empty: ${directory}`, result.stderr === '');
    }

    for (const { directory, mode } of assertionDirs) {
      const result = runInstalledCli(binPath, consumerDir, [directory]);
      const expected =
        mode === 'missing'
          ? 'DepVitals\n\nMissing dependencies (1)\n  real\n'
          : mode === 'unused'
            ? 'DepVitals\n\nUnused dependencies (1)\n  fake\n'
            : 'DepVitals\n\nNo dependency issues found.\n';
      check(
        `assertion consumer exit: ${directory}`,
        result.status === (mode === 'clean' ? 0 : 1),
        result.stderr,
      );
      check(
        `assertion consumer exact categories: ${directory}`,
        result.stdout === expected,
        result.stdout,
      );
      check(`assertion consumer stderr: ${directory}`, result.stderr === '');
    }

    const invalidTemplate = runInstalledCli(binPath, consumerDir, [invalidTemplateDir]);
    check('incomplete type template exits 1', invalidTemplate.status === 1);
    check('incomplete type template leaves stdout empty', invalidTemplate.stdout === '');
    check(
      'incomplete type template reports an operational error',
      invalidTemplate.stderr.includes(
        'index.ts could not be analyzed: Unterminated template literal',
      ),
      invalidTemplate.stderr,
    );

    // No-args scans the actual working directory.
    const noArgs = runInstalledCli(binPath, cleanDir, []);
    check('no-args scans cwd and exits 0', noArgs.status === 0);
    check(
      'no-args scans cwd with no issues',
      noArgs.stdout === 'DepVitals\n\nNo dependency issues found.\n',
    );

    // An invalid project path fails with exit 1 and a concise, path-identifying stderr message.
    const missingManifest = runInstalledCli(binPath, consumerDir, ['no-such-project']);
    check('invalid project path exits 1', missingManifest.status === 1);
    check(
      'invalid project path prints a concise error',
      missingManifest.stderr.includes('No package.json found at'),
    );
    check('invalid project path leaves stdout empty', missingManifest.stdout === '');

    // An unknown option still fails with a useful stderr message.
    const unknown = runInstalledCli(binPath, consumerDir, ['--scan']);
    check('unknown option exits non-zero', unknown.status !== 0);
    check(
      'unknown option prints a useful stderr message',
      unknown.stderr.includes('Unknown option') && unknown.stderr.includes('depvitals --help'),
    );

    // Both policy types work in the installed artifact, while broken config stays operational.
    const configured = runInstalledCli(binPath, consumerDir, [configuredDir]);
    check('configured installed scan exits 0', configured.status === 0);
    check(
      'configured installed scan renders the ordinary clean report',
      configured.stdout === 'DepVitals\n\nNo dependency issues found.\n',
    );
    check('configured installed scan leaves stderr empty', configured.stderr === '');
    const invalidConfig = runInstalledCli(binPath, consumerDir, [invalidConfigDir]);
    check('invalid config exits 1', invalidConfig.status === 1);
    check('invalid config leaves stdout empty', invalidConfig.stdout === '');
    check(
      'invalid config identifies the configuration file',
      invalidConfig.stderr.includes(join(invalidConfigDir, 'depvitals.config.json')) &&
        invalidConfig.stderr.includes('not valid JSON'),
    );
    check(
      'help bypasses invalid config',
      runInstalledCli(binPath, invalidConfigDir, ['--help']).status === 0,
    );
    check(
      'version bypasses invalid config',
      runInstalledCli(binPath, invalidConfigDir, ['--version']).status === 0,
    );

    const expectedAudit = (name) => {
      const unconfigured = name === 'absent' || name === 'empty';
      const unused = unconfigured
        ? [
            'consumer-self',
            'duplicate',
            'gulp-cli',
            'payload-decoy',
            'property-decoy',
            'regex-decoy',
            'selected-unused',
            'selected-unused-extra',
            'shadow-decoy',
          ]
        : [
            'consumer-self',
            'gulp-cli',
            'payload-decoy',
            'property-decoy',
            'regex-decoy',
            'selected-unused-extra',
            'shadow-decoy',
            'source-only',
          ];
      const dev = unconfigured ? ['duplicate', 'selected-dev'] : [];
      const missing = unconfigured
        ? ['dynamic-nested-missing', 'genuine-missing', 'selected-missing']
        : ['dynamic-nested-missing', 'genuine-missing'];
      if (name === 'barriers') {
        unused.push('eslint-config-prettier');
        dev.push('ts-jest');
      }
      return (
        'DepVitals\n' +
        [
          ['Unused dependencies', unused],
          ['Unused devDependencies', dev],
          ['Missing dependencies', missing],
        ]
          .filter(([, names]) => names.length)
          .map(
            ([label, names]) =>
              `\n${label} (${names.length})\n${names
                .sort()
                .map((value) => `  ${value}\n`)
                .join('')}`,
          )
          .join('')
      );
    };
    for (const { name, directory } of auditCases) {
      const result = runInstalledCli(binPath, consumerDir, [relative(consumerDir, directory)]);
      check(`audit ${name} exits 1`, result.status === 1, result.stderr);
      const errorFile = {
        'retained-malformed': 'retained/broken.ts',
        'invalid-policy': 'depvitals.config.json',
        'active-rc': '.eslintrc.json',
        'root-manifest': 'package.json',
      }[name];
      if (errorFile) {
        check(`audit ${name} has no partial report`, result.stdout === '', result.stdout);
        check(
          `audit ${name} identifies operational error`,
          result.stderr.includes(join(directory, errorFile)) &&
            result.stderr.includes(
              name === 'retained-malformed'
                ? 'could not be analyzed: Unterminated string literal'
                : name === 'invalid-policy'
                  ? 'field ignoreDependencies[0] must be an exact package root'
                  : 'not valid JSON',
            ) &&
            result.stderr.endsWith('\n'),
          result.stderr,
        );
      } else {
        check(`audit ${name} exact findings`, result.stdout === expectedAudit(name), result.stdout);
        check(`audit ${name} stderr empty`, result.stderr === '', result.stderr);
      }
    }
    for (const [directory, expectedExit] of [
      [cleanDir, 0],
      [findingsDir, 1],
    ]) {
      const result = runInstalledCli(binPath, consumerDir, ['--format', 'json', directory]);
      const document = JSON.parse(result.stdout);
      check(
        `JSON scan streams/status: ${directory}`,
        result.status === expectedExit && result.stderr === '',
      );
      check(
        `JSON scan envelope: ${directory}`,
        document.schemaVersion === 1 &&
          document.tool.version === rootVersion &&
          document.mode === 'scan' &&
          document.query === null &&
          document.project.root === directory,
      );
      check(
        `JSON scan counts and exact serialization: ${directory}`,
        Object.entries(document.findings).every(
          ([key, names]) => document.counts[key] === names.length,
        ) && result.stdout === JSON.stringify(document, null, 2) + '\n',
      );
    }
    for (const [directory, name, status, expectedExit] of [
      [findingsDir, 'lodash', 'used', 0],
      [findingsDir, 'unused-dep', 'unused', 1],
      [findingsDir, 'missing-pkg', 'missing', 1],
      [configuredDir, 'selected', 'excluded', 0],
      [cleanDir, 'peer-only', 'declared', 0],
      [cleanDir, 'absent', 'unknown', 1],
    ]) {
      for (const format of ['terminal', 'json']) {
        const result = runInstalledCli(binPath, consumerDir, [
          directory,
          '--explain',
          name,
          '--format',
          format,
        ]);
        check(
          `explain ${name}/${format} streams/status`,
          result.status === expectedExit && result.stderr === '',
        );
        if (format === 'json') {
          const document = JSON.parse(result.stdout);
          check(
            `explain ${name} package-local JSON`,
            document.mode === 'explain' &&
              document.query.packageName === name &&
              document.query.known === (status !== 'unknown') &&
              document.packages.length === 1 &&
              document.packages[0].status === status &&
              Object.values(document.findings).every((names) =>
                names.every((value) => value === name),
              ),
          );
        } else
          check(
            `explain ${name} human summary`,
            result.stdout.includes(`Package: ${name}\nStatus: ${status}\n`),
          );
      }
    }
    for (const format of ['terminal', 'json']) {
      const result = runInstalledCli(binPath, consumerDir, [
        invalidTemplateDir,
        '--format',
        format,
        '--explain',
        'real',
      ]);
      check(
        `explanation fatal-source channels ${format}`,
        result.status === 1 && result.stdout === '' && result.stderr.includes('index.ts'),
      );
    }
    const duplicateFormat = runInstalledCli(binPath, consumerDir, [
      '--format',
      'json',
      '--format',
      'json',
    ]);
    check(
      'duplicate format is an argument error',
      duplicateFormat.status === 1 &&
        duplicateFormat.stdout === '' &&
        duplicateFormat.stderr.includes('Option --format may be specified only once.'),
    );

    const configuredCwd = runInstalledCli(binPath, configuredDir, []);
    check(
      'configured no-args scan uses cwd policy',
      configuredCwd.status === 0 &&
        configuredCwd.stdout === configured.stdout &&
        configuredCwd.stderr === '',
    );
    for (const [flag, reference] of [
      ['--help', help],
      ['--version', version],
    ]) {
      const bypass = runInstalledCli(binPath, invalidConfigDir, [flag]);
      check(
        `${flag} bypasses invalid config with exact output`,
        bypass.status === 0 && bypass.stdout === reference.stdout && bypass.stderr === '',
      );
    }

    // Observe notifier I/O from outside its swallowed-error callback. Pipes must suppress it
    // independently of both CI variables and the explicit opt-out. Fetch is always intercepted.
    const observerDir = makeTempDir('notifier-observer');
    const probe = join(observerDir, 'probe.mjs');
    const marker = join(observerDir, 'requests.log');
    const cacheRoot = join(observerDir, 'cache');
    writeFileSync(
      probe,
      `import fs from 'node:fs/promises';
      import {appendFileSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const marker = process.env.DEPVITALS_SMOKE_PROBE_LOG;
      for (const method of ['lstat', 'readFile', 'mkdir', 'writeFile', 'rename']) {
        const original = fs[method];
        fs[method] = (...args) => {
          if (String(args[0]).startsWith(process.env.DEPVITALS_SMOKE_CACHE_ROOT)) appendFileSync(marker, 'cache\\n');
          return original(...args);
        };
      }
      syncBuiltinESMExports();
      globalThis.fetch = async () => { appendFileSync(marker, 'fetch\\n'); throw new Error('offline transport'); };`,
    );
    const observerEnv = { ...process.env };
    for (const variable of [
      'DEPVITALS_NO_UPDATE_CHECK',
      'CI',
      'GITHUB_ACTIONS',
      'GITLAB_CI',
      'TF_BUILD',
      'CIRCLECI',
      'TRAVIS',
      'BUILDKITE',
      'JENKINS_URL',
      'TEAMCITY_VERSION',
      'APPVEYOR',
    ])
      delete observerEnv[variable];
    Object.assign(observerEnv, {
      NODE_OPTIONS: `--import=${pathToFileURL(probe).href}`,
      XDG_CACHE_HOME: cacheRoot,
      LOCALAPPDATA: cacheRoot,
      DEPVITALS_SMOKE_PROBE_LOG: marker,
      DEPVITALS_SMOKE_CACHE_ROOT: cacheRoot,
    });
    const noninteractive = run(binPath, [configuredDir], consumerDir, observerEnv);
    check(
      'noninteractive installed scan has exact ordinary result',
      noninteractive.status === 0 &&
        noninteractive.stdout === configured.stdout &&
        noninteractive.stderr === '',
      noninteractive.stderr,
    );
    check(
      'noninteractive scan makes no notifier cache or transport requests',
      !existsSync(marker) && !existsSync(cacheRoot),
    );

    const ttyProbe = join(observerDir, 'force-tty.mjs');
    writeFileSync(ttyProbe, 'process.stdout.isTTY = true; process.stderr.isTTY = true;\n');
    const isolatedEnv = {
      ...observerEnv,
      NODE_OPTIONS: observerEnv.NODE_OPTIONS + ` --import=${pathToFileURL(ttyProbe).href}`,
    };
    for (const args of [
      [cleanDir, '--format', 'json'],
      [findingsDir, '--explain', 'lodash'],
      [findingsDir, '--format', 'json', '--explain', 'missing-pkg'],
      [invalidTemplateDir, '--format', 'json', '--explain', 'real'],
      ['--help'],
      ['--unknown'],
    ]) {
      const result = run(binPath, args, consumerDir, isolatedEnv);
      check(
        `isolated mode never emits notifier: ${args.join(' ')}`,
        !result.stderr.includes('New DepVitals version available:') &&
          !existsSync(marker) &&
          !existsSync(cacheRoot),
      );
    }

    // Capture the fixtures again after every scan, then compare the complete before-and-after
    // snapshots so added, deleted, and modified files are all detected.
    const after = snapshotFixtures(fixtureDirs);

    // The scanner must not mutate the fixtures it reads.
    check('scan does not mutate the fixtures', snapshotsEqual(before, after));

    console.log(`\nAll ${checksPassed} checks passed.`);
  } catch (error) {
    // The finally block below already removed the temporary directories; just report the failure.
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

try {
  await main();
} catch (error) {
  // Any unexpected throw still cleans up via main()'s finally and reports failure.
  console.error(error.message);
  process.exitCode = 1;
}
