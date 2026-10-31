import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/cli/runCli.js';
import { analyzeProject } from '../src/core/analyzeProject.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const ENTRY = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const exact = { './feature': './feature.js' };
type Scenario = {
  name: string;
  manifest: Readonly<Record<string, unknown>>;
  files?: Readonly<Record<string, string>>;
  missing?: readonly string[];
  unused?: readonly string[];
  unusedDev?: readonly string[];
};
const cases: readonly Scenario[] = [
  {
    name: 'ownership does not inspect an excluded existing target',
    manifest: { name: 'self-pkg', exports: { './feature': './dist/target.js' } },
    // Intentionally invalid source in a pruned directory must never be scanned as a target.
    files: { 'index.js': "import 'self-pkg/feature';", 'dist/target.js': "'unterminated" },
  },
  {
    name: 'declared genuine import stays used and unrelated unused stays visible',
    manifest: {
      name: 'self-pkg',
      exports: exact,
      dependencies: { 'genuinely-missing': '*', 'unused-real': '*' },
    },
    unused: ['unused-real'],
  },
  {
    name: 'nested scoped ownership',
    manifest: { name: 'root-pkg', exports: exact },
    files: {
      'child/package.json': JSON.stringify({ name: '@scope/child-pkg', exports: exact }),
      'child/index.js': "import '@scope/child-pkg/feature'; import 'root-pkg/feature';",
    },
    missing: ['root-pkg'],
  },
  {
    name: 'child module mode and ownership share the nearest boundary',
    manifest: { name: 'self-pkg', type: 'module', exports: exact },
    files: {
      'index.js': "await /require('fake-root')/; import('self-pkg/feature');",
      'child/package.json': JSON.stringify({ name: 'child-pkg', type: 'commonjs', exports: exact }),
      'child/index.js':
        "require('child-pkg/feature'); var await = 4; await / require('real-child') / 2;",
    },
    missing: ['real-child'],
  },
  {
    name: 'nonstring nested name blocks root ownership without changing mode',
    manifest: { name: 'self-pkg', exports: exact },
    files: {
      'child/package.json': JSON.stringify({ name: 8, exports: exact }),
      'child/index.js': "import 'self-pkg/feature';",
    },
    missing: ['self-pkg'],
  },
  {
    name: 'root exact feature with a real missing import',
    manifest: { name: 'self-pkg', exports: exact },
    missing: ['genuinely-missing'],
  },
  {
    name: 'direct root exports and missing target',
    manifest: { name: 'self-pkg', exports: './absent.js' },
    files: { 'index.js': "import 'self-pkg';" },
  },
  {
    name: 'scoped exact exports',
    manifest: { name: '@scope/self-pkg', exports: exact },
    files: { 'index.js': "import '@scope/self-pkg/feature'; import 'genuinely-missing';" },
    missing: ['genuinely-missing'],
  },
  {
    name: 'require dynamic import and reexport',
    manifest: { name: 'self-pkg', exports: exact },
    files: {
      'index.ts':
        "require('self-pkg/feature'); import('self-pkg/feature'); export * from 'self-pkg/feature';",
    },
  },
  {
    name: 'self declaration is unused when only internal imports exist',
    manifest: {
      name: 'self-pkg',
      exports: exact,
      dependencies: { 'self-pkg': '*' },
      devDependencies: { 'self-pkg': '*' },
    },
    files: { 'index.js': "import 'self-pkg/feature';" },
    unused: ['self-pkg'],
    unusedDev: ['self-pkg'],
  },
  {
    name: 'unmapped subpath remains external even with a mapped self import',
    manifest: { name: 'self-pkg', exports: exact },
    files: {
      'index.js':
        "import 'self-pkg/feature'; import 'self-pkg/unmapped'; import 'self-pkg-extra/feature';",
    },
    missing: ['self-pkg', 'self-pkg-extra'],
  },
  {
    name: 'unmapped reference still uses an explicit self declaration',
    manifest: { name: 'self-pkg', exports: exact, dependencies: { 'self-pkg': '*' } },
    files: { 'index.js': "import 'self-pkg/feature'; import 'self-pkg/unmapped';" },
  },
  {
    name: 'ordinary directories inherit the root scope',
    manifest: { name: 'self-pkg', exports: exact },
    files: { 'src/deep/index.js': "import 'self-pkg/feature';" },
  },
  {
    name: 'nested named scope owns descendants',
    manifest: { name: 'root-pkg', exports: exact },
    files: {
      'child/package.json': JSON.stringify({
        name: 'child-pkg',
        exports: exact,
        dependencies: { 'child-inventory-only': '*' },
      }),
      'child/deep/index.js':
        "import 'child-pkg/feature'; import 'root-pkg/feature'; import 'child-inventory-only';",
    },
    missing: ['child-inventory-only', 'root-pkg'],
  },
  {
    name: 'nameless child blocks root ownership',
    manifest: { name: 'self-pkg', exports: exact },
    files: { 'child/package.json': '{}', 'child/index.js': "import 'self-pkg/feature';" },
    missing: ['self-pkg'],
  },
  {
    name: 'child without exports blocks root ownership',
    manifest: { name: 'self-pkg', exports: exact },
    files: {
      'child/package.json': '{"name":"self-pkg"}',
      'child/index.js': "import 'self-pkg/feature';",
    },
    missing: ['self-pkg'],
  },
  {
    name: 'nameless child with exports does not borrow root name',
    manifest: { name: 'self-pkg', exports: exact },
    files: {
      'child/package.json': JSON.stringify({ exports: exact }),
      'child/index.js': "import 'self-pkg/feature';",
    },
    missing: ['self-pkg'],
  },
  {
    name: 'a child can own the same name with its own exact mapping',
    manifest: { name: 'self-pkg', exports: { './other': './other.js' } },
    files: {
      'child/package.json': JSON.stringify({ name: 'self-pkg', exports: exact }),
      'child/index.js': "import 'self-pkg/feature';",
    },
  },
  {
    name: 'a sibling cannot borrow another child scope',
    manifest: {},
    files: {
      'a/package.json': JSON.stringify({ name: 'child-pkg', exports: exact }),
      'a/index.js': "import 'child-pkg/feature';",
      'b/index.js': "import 'child-pkg/feature';",
    },
    missing: ['child-pkg'],
  },
  {
    name: 'root inventory still supplies external references in child source',
    manifest: { name: 'self-pkg', exports: exact, dependencies: { 'self-pkg': '*' } },
    files: { 'child/package.json': '{}', 'child/index.js': "import 'self-pkg/feature';" },
  },
  ...[
    {},
    { name: 'self-pkg' },
    { name: 'other-pkg', exports: exact },
    { name: 'self-pkg', exports: null },
    { name: 'self-pkg', exports: { './feature': { import: './feature.js' } } },
    { name: 'self-pkg', exports: { './*': './*.js' } },
    { name: 'self-pkg', exports: { './feature': '../outside.js' } },
  ].map((manifest, index) => ({
    name: `unsupported metadata stays external ${String(index)}`,
    manifest,
    missing: ['genuinely-missing', 'self-pkg'],
  })),
];

function snapshot(root: string): readonly { path: string; content: string }[] {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory()
        ? [...snapshot(path)]
        : [{ path, content: readFileSync(path, 'utf8') }];
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function report(
  unused: readonly string[],
  unusedDev: readonly string[],
  missing: readonly string[],
): string {
  const sections = [
    ['Unused dependencies', unused],
    ['Unused devDependencies', unusedDev],
    ['Missing dependencies', missing],
  ] as const;
  const findings = sections
    .filter(([, names]) => names.length > 0)
    .map(
      ([title, names]) =>
        `${title} (${String(names.length)})\n${names.map((name) => `  ${name}`).join('\n')}`,
    );
  return `DepVitals\n\n${findings.length === 0 ? 'No dependency issues found.' : findings.join('\n\n')}\n`;
}

describe('nearest-scope self references through analyzer and compiled CLI', () => {
  it.each(cases)(
    '$name',
    async ({ manifest, files, missing = [], unused = [], unusedDev = [] }) => {
      const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-self-'));
      const root = join(sandbox, 'project');
      mkdirSync(root);
      // Parent metadata must never be borrowed or read, and target/lifecycle code must stay inert.
      const parent = join(sandbox, 'package.json');
      writeFileSync(parent, JSON.stringify({ name: 'self-pkg', exports: exact }));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          ...manifest,
          scripts: { postinstall: 'node -e "throw new Error(\'must not execute\')"' },
        }),
      );
      for (const [relative, source] of Object.entries(
        files ?? { 'index.js': "import 'self-pkg/feature'; import 'genuinely-missing';" },
      )) {
        const path = join(root, relative);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, source);
      }
      const before = snapshot(sandbox);
      try {
        const start = vi.mocked(fs.readFile).mock.calls.length;
        expect(await analyzeProject(root)).toEqual({
          projectRoot: root,
          unusedDependencies: unused,
          unusedDevDependencies: unusedDev,
          missingDependencies: missing,
        });
        const reads = vi
          .mocked(fs.readFile)
          .mock.calls.slice(start)
          .map(([path]) => path);
        expect(reads).not.toContain(parent);
        expect(reads).not.toContain(join(root, 'dist/target.js'));
        const expected = {
          exitCode: unused.length + unusedDev.length + missing.length > 0 ? 1 : 0,
          stdout: report(unused, unusedDev, missing),
          stderr: '',
        };
        expect(await runCli([root], { cwd: sandbox, version: '0.2.0' })).toEqual(expected);
        const result = spawnSync(process.execPath, [ENTRY, root], {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
        });
        expect(result.error).toBeUndefined();
        expect({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
          expected,
        );
        expect(snapshot(sandbox)).toEqual(before);
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
      }
    },
  );
});

it('shares cached metadata across files without rereading scopes or source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'depvitals-self-cache-'));
  try {
    const rootManifest = join(root, 'package.json');
    const child = join(root, 'child');
    mkdirSync(child);
    const childManifest = join(child, 'package.json');
    writeFileSync(rootManifest, JSON.stringify({ name: 'root-pkg', exports: exact }));
    writeFileSync(childManifest, JSON.stringify({ name: 'child-pkg', exports: exact }));
    const sources = [join(child, 'a.js'), join(child, 'b.js'), join(child, 'c.js')];
    for (const file of sources) writeFileSync(file, "import 'child-pkg/feature';");
    const start = vi.mocked(fs.readFile).mock.calls.length;
    expect(await analyzeProject(root)).toEqual({
      projectRoot: root,
      unusedDependencies: [],
      unusedDevDependencies: [],
      missingDependencies: [],
    });
    const reads = vi
      .mocked(fs.readFile)
      .mock.calls.slice(start)
      .map(([path]) => path);
    for (const path of [rootManifest, childManifest, ...sources]) {
      expect(reads.filter((read) => read === path)).toHaveLength(1);
    }
    expect(reads).toHaveLength(5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
