import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/core/analyzeProject.js';
import { findEslintManifestUsage } from '../src/detectors/eslintManifestConfig.js';
import { findJestManifestUsage } from '../src/detectors/jestManifestConfig.js';

type BuildFile = { path: string; sha256: string };
type InputIdentity = {
  sha256: string;
  rootEntries: readonly string[];
  files: readonly BuildFile[];
};
const { identifyBuild, identifyInputs, verifyMeasuredArchive } = (await import(
  new URL('../scripts/measurementIdentity.mjs', import.meta.url).href
)) as {
  identifyBuild: (root: string) => readonly BuildFile[];
  identifyInputs: (root: string, sources: readonly string[]) => InputIdentity;
  verifyMeasuredArchive: (
    packPath: string,
    root: string,
    build: readonly BuildFile[],
  ) => { matchedBuildSha256: string; fileCount: number; archiveSha256: string };
};
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

function fixture(work: (root: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'depvitals-measure-identity-'));
  mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fixture","version":"0.2.0"}');
  writeFileSync(join(root, 'README.md'), 'Current readme\n');
  writeFileSync(join(root, 'LICENSE'), 'Test license\n');
  writeFileSync(join(root, 'dist/cli/index.js'), 'export const current = 1;\n');
  writeFileSync(join(root, 'index.cjs'), '');
  return Promise.resolve()
    .then(() => work(root))
    .finally(() => {
      rmSync(root, { recursive: true, force: true });
    });
}
function currentFiles(root: string): Map<string, Buffer> {
  return new Map(
    ['package.json', 'README.md', 'LICENSE', 'dist/cli/index.js'].map((path) => [
      path,
      readFileSync(join(root, path)),
    ]),
  );
}
function build(root: string): readonly BuildFile[] {
  return identifyBuild(root);
}

const schemaAssets = [
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
function addSchemaAssets(root: string): Map<string, Buffer> {
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '0.2.0', files: ['dist', 'schemas'] }),
  );
  const files = currentFiles(root);
  for (const path of schemaAssets) {
    const bytes = readFileSync(new URL('../' + path, import.meta.url));
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    files.set(path, bytes);
  }
  return files;
}

/** Test-owned ustar writer. Buffers are inspected as data, never extracted/executed. */
function tar(files: ReadonlyMap<string, Buffer>, type = '0'): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, bytes] of files) {
    const header = Buffer.alloc(512);
    const name = 'package/' + path;
    const split = name.length > 100 ? name.lastIndexOf('/') : -1;
    header.write(split < 0 ? name : name.slice(split + 1), 0, 100, 'utf8');
    if (split >= 0) header.write(name.slice(0, split), 345, 155, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.fill(32, 148, 156);
    header.write(type, 156, 'ascii');
    header.write('ustar\0', 257, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function archive(root: string, files = currentFiles(root), tarBytes = tar(files)): string {
  const bytes = gzipSync(tarBytes);
  const pack = {
    name: 'fixture',
    version: '0.2.0',
    filename: 'fixture-0.2.0.tgz',
    size: bytes.length,
    unpackedSize: [...files.values()].reduce((sum, value) => sum + value.length, 0),
    shasum: createHash('sha1').update(bytes).digest('hex'),
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    files: [...files].map(([path, value]) => ({ path, size: value.length })),
  };
  const path = join(root, 'pack.json');
  writeFileSync(path, JSON.stringify([pack]));
  writeFileSync(join(root, pack.filename), bytes);
  return path;
}

describe('measurement input identity', () => {
  it.each([
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    '.eslintrc.json',
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    'jest.config.js',
    'jest.config.mjs',
    'jest.config.cjs',
    'jest.config.ts',
    'jest.config.json',
    'JEST.CONFIG.JSON',
  ])('changes when a detector root entry appears or disappears: %s', async (name) => {
    await fixture((root) => {
      const sources = [join(root, 'index.cjs')];
      const before = identifyInputs(root, sources);
      // An opaque directory entry is enough for detector presence; no content read is needed.
      mkdirSync(join(root, name));
      const after = identifyInputs(root, sources);
      expect(after.rootEntries).toContain(name);
      expect(after.sha256).not.toBe(before.sha256);
      rmSync(join(root, name), { recursive: true });
      expect(identifyInputs(root, sources)).toEqual(before);
    });
  });
  it.each(['eslint', 'jest'] as const)(
    'tracks changed %s hints even when source masks the finding difference',
    async (kind) => {
      await fixture(async (root) => {
        const provider = kind === 'eslint' ? 'eslint-config-prettier' : 'ts-jest';
        const manifest = {
          dependencies: { [provider]: '*' },
          ...(kind === 'eslint'
            ? { eslintConfig: { extends: 'prettier' } }
            : { jest: { preset: 'ts-jest' } }),
        };
        writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
        writeFileSync(join(root, 'index.cjs'), `require('${provider}');`);
        const detector = kind === 'eslint' ? findEslintManifestUsage : findJestManifestUsage;
        expect([...(await detector(root))]).toEqual([provider]);
        const result = await analyzeProject(root);
        const before = identifyInputs(root, [join(root, 'index.cjs')]);
        writeFileSync(
          join(root, kind === 'eslint' ? '.eslintrc.yml' : 'jest.config.json'),
          'opaque',
        );
        expect([...(await detector(root))]).toEqual([]);
        expect(await analyzeProject(root)).toEqual(result);
        expect(identifyInputs(root, [join(root, 'index.cjs')]).sha256).not.toBe(before.sha256);
      });
    },
  );
  it('hashes the actual casing of legacy JSON content', async () => {
    await fixture((root) => {
      const path = join(root, '.ESLINTRC.JSON');
      writeFileSync(path, '{"plugins":[]}');
      const before = identifyInputs(root, []);
      writeFileSync(path, '{"plugins":["react"]}');
      expect(identifyInputs(root, []).sha256).not.toBe(before.sha256);
    });
  });
});

describe('measurement archive binding', () => {
  it('accepts the complete packaged schema shape alongside dist and root files', async () => {
    await fixture((root) => {
      const files = addSchemaAssets(root);
      const result = verifyMeasuredArchive(archive(root, files), root, build(root));
      expect(result.fileCount).toBe(13);
      expect(build(root).map((file) => file.path)).toEqual(
        ['dist/cli/index.js', ...schemaAssets].sort(),
      );
    });
  });
  it.each(schemaAssets)('rejects stale archive bytes for schema asset %s', async (path) => {
    await fixture((root) => {
      const files = addSchemaAssets(root);
      files.set(path, Buffer.from('stale asset'));
      expect(() => verifyMeasuredArchive(archive(root, files), root, build(root))).toThrow(
        `Archive file differs from measured build: ${path}`,
      );
    });
  });
  it.each(['missing', 'extra'])(
    'rejects %s schema assets despite valid pack metadata',
    async (kind) => {
      await fixture((root) => {
        const files = addSchemaAssets(root);
        if (kind === 'missing') files.delete('schemas/examples/scan-clean.json');
        else files.set('schemas/stale.json', Buffer.from('{}'));
        expect(() => verifyMeasuredArchive(archive(root, files), root, build(root))).toThrow(
          'Archive file set differs from measured build',
        );
      });
    },
  );
  it('observes schema changes during measurement instead of accepting a stale identity', async () => {
    await fixture((root) => {
      const files = addSchemaAssets(root);
      const before = build(root);
      writeFileSync(join(root, 'schemas/README.md'), 'Changed after measurement');
      expect(build(root)).not.toEqual(before);
      expect(() => verifyMeasuredArchive(archive(root, files), root, build(root))).toThrow(
        'Archive file differs from measured build: schemas/README.md',
      );
    });
  });

  it('rejects a missing schema directory when the package declares it', async () => {
    await fixture((root) => {
      addSchemaAssets(root);
      rmSync(join(root, 'schemas'), { recursive: true });
      expect(() => build(root)).toThrow();
    });
  });
  it('accepts an adjacent archive matching metadata, the build and all packaged root files', async () => {
    await fixture((root) => {
      const path = archive(root);
      const result = verifyMeasuredArchive(path, root, build(root));
      expect(result.fileCount).toBe(4);
      expect(result.matchedBuildSha256).toBe(digest(JSON.stringify(build(root))));
      expect(result.archiveSha256).toBe(digest(readFileSync(join(root, 'fixture-0.2.0.tgz'))));
    });
  });
  it.each(['dist/cli/index.js', 'README.md', 'package.json'])(
    'rejects a valid same-version archive with stale %s bytes',
    async (path) => {
      await fixture((root) => {
        const files = currentFiles(root);
        files.set(
          path,
          Buffer.from(
            path === 'package.json'
              ? '{"name":"fixture","version":"0.2.0","description":"old"}'
              : 'old build contents',
          ),
        );
        expect(() => verifyMeasuredArchive(archive(root, files), root, build(root))).toThrow(
          `Archive file differs from measured build: ${path}`,
        );
      });
    },
  );
  it.each(['missing', 'extra'])(
    'rejects %s packaged build files despite consistent archive hashes',
    async (kind) => {
      await fixture((root) => {
        const files = currentFiles(root);
        if (kind === 'missing') files.delete('dist/cli/index.js');
        else files.set('dist/stale.js', Buffer.from('old'));
        expect(() => verifyMeasuredArchive(archive(root, files), root, build(root))).toThrow(
          'Archive file set differs from measured build',
        );
      });
    },
  );
  it('rejects metadata without its adjacent archive', async () => {
    await fixture((root) => {
      const path = archive(root);
      rmSync(join(root, 'fixture-0.2.0.tgz'));
      expect(() => verifyMeasuredArchive(path, root, build(root))).toThrow();
    });
  });
  it.each(['size', 'shasum', 'integrity', 'unpackedSize', 'files', 'filename'])(
    'rejects altered %s metadata',
    async (field) => {
      await fixture((root) => {
        const path = archive(root);
        const metadata = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>[];
        const pack = metadata[0];
        if (pack === undefined) throw new Error('Expected metadata');
        if (field === 'size' || field === 'unpackedSize') pack[field] = Number(pack[field]) + 1;
        else if (field === 'files') pack[field] = [];
        else pack[field] = field === 'filename' ? '../outside.tgz' : 'wrong';
        writeFileSync(path, JSON.stringify(metadata));
        expect(() => verifyMeasuredArchive(path, root, build(root))).toThrow();
      });
    },
  );
  it('rejects corrupted archive bytes even when their length is unchanged', async () => {
    await fixture((root) => {
      const path = archive(root);
      const archivePath = join(root, 'fixture-0.2.0.tgz');
      const bytes = readFileSync(archivePath);
      bytes[9] = (bytes[9] ?? 0) ^ 1;
      writeFileSync(archivePath, bytes);
      expect(() => verifyMeasuredArchive(path, root, build(root))).toThrow('Archive SHA-1 differs');
    });
  });
  it('rejects bad tar headers even with consistent gzip size and integrity', async () => {
    await fixture((root) => {
      const files = currentFiles(root);
      const bytes = tar(files);
      bytes[0] = 88;
      expect(() => verifyMeasuredArchive(archive(root, files, bytes), root, build(root))).toThrow(
        'Invalid tar header checksum',
      );
    });
  });
  it('rejects unsupported linked entries instead of extracting or following them', async () => {
    await fixture((root) => {
      const files = currentFiles(root);
      expect(() =>
        verifyMeasuredArchive(archive(root, files, tar(files, '2')), root, build(root)),
      ).toThrow('Unsupported tar entry type');
    });
  });
  it('reads ustar prefix names for long build paths', async () => {
    await fixture((root) => {
      const path = 'dist/' + 'long-directory/'.repeat(6) + 'output.js';
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), 'long path');
      const files = currentFiles(root);
      files.set(path, Buffer.from('long path'));
      const measured = build(root);
      expect(verifyMeasuredArchive(archive(root, files), root, measured).fileCount).toBe(5);
    });
  });
});
