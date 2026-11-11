import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type * as nodeFsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  analyzeProjectDetailed,
  projectPackageExplanation,
  projectAnalysisResult,
} from '../../../src/core/analyzeProject.js';
import { createScanContext } from '../../../src/core/scanContext.js';
import { collectModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';
import type * as moduleSpecifiers from '../../../src/scanner/moduleSpecifiers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFsPromises>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
vi.mock('../../../src/scanner/moduleSpecifiers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof moduleSpecifiers>();
  return {
    ...actual,
    collectModuleSpecifiers: vi.fn(actual.collectModuleSpecifiers),
  };
});

async function project(
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
  run: (root: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'depvitals-scope-')));
  const inputs = { 'package.json': JSON.stringify(manifest), ...files };
  try {
    for (const [name, text] of Object.entries(inputs)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), text);
    }
    await run(root);
  } finally {
    vi.clearAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}

const files = {
  'src/a.js': '// root',
  'child/package.json': '{"dependencies":{"leaf-only":"1"}}',
  'child/empty.cjs': '',
  'child/deep/use.cjs': "require('leaf-only');",
  'child/deep/component.vue': '<unsupported>',
  'metadata-only/package.json': '{invalid',
  'node_modules/decoy/a.js': "'unterminated",
};
const workspace = { workspaces: { packages: ['child', 'child/**'] } };

describe('completed scan scope facts', () => {
  it('counts source ownership against one root inventory and resets it for a child scan', async () => {
    await project(workspace, files, async (root) => {
      const context = await createScanContext(root);
      const ordinary = await analyzeProjectDetailed(context);
      const diagnostic = await analyzeProjectDetailed(context, { diagnostics: true });
      const { diagnostics, ...rest } = diagnostic;
      expect(rest).toEqual(ordinary);
      expect(ordinary).not.toHaveProperty('diagnostics');
      expect(await analyzeProjectDetailed(context, { diagnostics: false })).toEqual(ordinary);
      expect(diagnostics).toEqual({
        sourceFilesScanned: 3,
        nestedPackageSourceFiles: 2,
        notices: ['nested-package-inputs', 'workspace-declared'],
      });
      expect(diagnostic.findings.missingDependencies).toEqual(['leaf-only']);
      expect(projectAnalysisResult(diagnostic)).toEqual(projectAnalysisResult(ordinary));
      expect(projectPackageExplanation(diagnostic, 'leaf-only')).toEqual(
        projectPackageExplanation(ordinary, 'leaf-only'),
      );
      const child = await analyzeProjectDetailed(await createScanContext(join(root, 'child')), {
        diagnostics: true,
      });
      expect(child.diagnostics).toEqual({
        sourceFilesScanned: 2,
        nestedPackageSourceFiles: 0,
        notices: [],
      });
      expect(child.findings.missingDependencies).toEqual([]);
    });
  });

  it.each([
    ['{}', 2],
    [undefined, 0],
  ])('inherits ownership with child manifest %s', async (manifest, nested) => {
    await project({}, files, async (root) => {
      const path = join(root, 'child/package.json');
      if (manifest === undefined) await rm(path);
      else await writeFile(path, manifest);
      const result = await analyzeProjectDetailed(await createScanContext(root), {
        diagnostics: true,
      });
      expect(result.diagnostics).toEqual({
        sourceFilesScanned: 3,
        nestedPackageSourceFiles: nested,
        notices: nested === 0 ? [] : ['nested-package-inputs'],
      });
    });
  });

  it('retains distinct nested owners with identical module and self-reference metadata', async () => {
    const own = {
      name: 'self',
      type: 'module',
      exports: { '.': './index.js', './sub': './index.js' },
    };
    await project(
      own,
      {
        'index.js': "import 'self';",
        'child/package.json': JSON.stringify(own),
        'child/index.js': "import 'self/sub';",
        'child/deep/package.json': JSON.stringify(own),
        'child/deep/index.js': "import 'self'; import 'external';",
      },
      async (root) => {
        const context = await createScanContext(root);
        const ordinary = await analyzeProjectDetailed(context);
        const { diagnostics, ...result } = await analyzeProjectDetailed(context, {
          diagnostics: true,
        });
        expect(result).toEqual(ordinary);
        expect(result.findings.missingDependencies).toEqual(['external']);
        expect(diagnostics).toEqual({
          sourceFilesScanned: 3,
          nestedPackageSourceFiles: 2,
          notices: ['nested-package-inputs'],
        });
      },
    );
  });

  it.each([
    [{ ignorePaths: ['child'] }, 1, 0, []],
    [{ ignoreDependencies: ['leaf-only'] }, 3, 2, []],
  ])(
    'applies path and dependency policy independently: %j',
    async (config, total, nested, missing) => {
      await project(
        workspace,
        { ...files, 'depvitals.config.json': JSON.stringify(config) },
        async (root) => {
          const result = await analyzeProjectDetailed(await createScanContext(root), {
            diagnostics: true,
          });
          expect(result.findings.missingDependencies).toEqual(missing);
          expect(result.diagnostics).toEqual({
            sourceFilesScanned: total,
            nestedPackageSourceFiles: nested,
            notices:
              nested === 0
                ? ['workspace-declared']
                : ['nested-package-inputs', 'workspace-declared'],
          });
          if (nested > 0) {
            expect(result.underlyingFindings.missingDependencies).toEqual(['leaf-only']);
            expect(result.packages[0]?.evidence).toHaveLength(1);
          }
        },
      );
    },
  );

  it('uses the same source extraction and filesystem reads with diagnostics enabled', async () => {
    await project(
      workspace,
      { ...files, 'types.d.ts': '', 'upper.JS': 'ignored', 'pnpm-workspace.yaml': 'invalid: [' },
      async (root) => {
        vi.clearAllMocks();
        await analyzeProjectDetailed(await createScanContext(root));
        const reads = vi.mocked(readFile).mock.calls.map(([path]) => path);
        const extractions = vi.mocked(collectModuleSpecifiers).mock.calls;
        vi.clearAllMocks();
        const result = await analyzeProjectDetailed(await createScanContext(root), {
          diagnostics: true,
        });
        expect(vi.mocked(readFile).mock.calls.map(([path]) => path)).toEqual(reads);
        expect(vi.mocked(collectModuleSpecifiers).mock.calls).toEqual(extractions);
        expect(result.diagnostics?.sourceFilesScanned).toBe(4);
        expect(reads).not.toContain(join(root, 'pnpm-workspace.yaml'));
        expect(reads).not.toContain(join(root, 'metadata-only/package.json'));
      },
    );
  });

  it('skips source links and linked subtrees', async () => {
    await project({}, { 'a.cjs': '', 'child/a.cjs': '' }, async (root) => {
      await symlink(join(root, 'a.cjs'), join(root, 'linked.cjs'), 'file');
      await symlink(join(root, 'child'), join(root, 'linked-dir'), 'junction');
      const result = await analyzeProjectDetailed(await createScanContext(root), {
        diagnostics: true,
      });
      expect(result.diagnostics).toEqual({
        sourceFilesScanned: 2,
        nestedPackageSourceFiles: 0,
        notices: [],
      });
    });
  });

  it('rejects a linked mandatory nested manifest and recovers with path policy', async () => {
    await project({}, { 'a.cjs': '', 'z/a.cjs': '' }, async (root) => {
      await symlink(join(root, 'package.json'), join(root, 'z/package.json'), 'file');
      const context = await createScanContext(root);
      await expect(analyzeProjectDetailed(context)).rejects.toThrow('regular file');
      await expect(analyzeProjectDetailed(context, { diagnostics: true })).rejects.toThrow(
        'regular file',
      );
      await writeFile(join(root, 'depvitals.config.json'), '{"ignorePaths":["z"]}');
      const result = await analyzeProjectDetailed(await createScanContext(root), {
        diagnostics: true,
      });
      expect(result.diagnostics?.sourceFilesScanned).toBe(1);
    });
  });

  it.each([
    ['missing', undefined, false],
    ['direct', ['child'], true],
    ['object', { packages: [' child ', 'child', 'child'], other: 1 }, true],
    ['null', null, false],
    ['scalar', 'child', false],
    ['empty', [], false],
    ['mixed', ['child', 1], false],
    ['blank', [' '], false],
    ['missing packages', {}, false],
    ['empty packages', { packages: [] }, false],
    ['scalar packages', { packages: 'child' }, false],
  ])('recognizes only the bounded root workspace shape: %s', async (_, workspaces, declared) => {
    await project(
      { workspaces },
      {
        'pnpm-workspace.yaml': 'packages: ["child"]',
        'child/package.json': '{"workspaces":["grandchild"]}',
        'child/unsupported.vue': '',
      },
      async (root) => {
        const result = await analyzeProjectDetailed(await createScanContext(root), {
          diagnostics: true,
        });
        expect(result.diagnostics).toEqual({
          sourceFilesScanned: 0,
          nestedPackageSourceFiles: 0,
          notices: declared
            ? ['no-supported-sources', 'workspace-declared']
            : ['no-supported-sources'],
        });
      },
    );
  });

  it('does not inherit a nested workspace declaration', async () => {
    await project(
      {},
      { 'child/package.json': '{"workspaces":["grandchild"]}', 'child/a.cjs': '' },
      async (root) => {
        const result = await analyzeProjectDetailed(await createScanContext(root), {
          diagnostics: true,
        });
        expect(result.diagnostics?.notices).toEqual(['nested-package-inputs']);
      },
    );
  });

  it('retains script evidence when no supported sources are present', async () => {
    await project(
      { devDependencies: { typescript: '1' }, scripts: { build: 'tsc' } },
      {},
      async (root) => {
        const result = await analyzeProjectDetailed(await createScanContext(root), {
          diagnostics: true,
        });
        expect(result.findings.unusedDevDependencies).toEqual([]);
        expect(result.packages[0]?.evidence[0]?.kind).toBe('script');
        expect(result.diagnostics).toEqual({
          sourceFilesScanned: 0,
          nestedPackageSourceFiles: 0,
          notices: ['no-supported-sources'],
        });
      },
    );
  });

  it.each([
    ['malformed manifest', { 'z/package.json': '{invalid', 'z/a.cjs': '' }],
    ['malformed source', { 'z/a.cjs': "'unterminated" }],
  ])('rejects a retained %s after readable input and recovers when excluded', async (_, bad) => {
    await project({}, { 'a.cjs': '', ...bad }, async (root) => {
      const context = await createScanContext(root);
      await expect(analyzeProjectDetailed(context)).rejects.toThrow();
      await expect(analyzeProjectDetailed(context, { diagnostics: true })).rejects.toThrow();
      await writeFile(join(root, 'depvitals.config.json'), '{"ignorePaths":["z"]}');
      const result = await analyzeProjectDetailed(await createScanContext(root), {
        diagnostics: true,
      });
      expect(result.diagnostics).toEqual({
        sourceFilesScanned: 1,
        nestedPackageSourceFiles: 0,
        notices: [],
      });
    });
  });
});
