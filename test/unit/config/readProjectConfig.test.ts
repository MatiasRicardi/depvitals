import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  ProjectConfigError,
  readProjectConfig,
  readRawProjectConfig,
} from '../../../src/config/readProjectConfig.js';
import { runCli } from '../../../src/cli/runCli.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  };
});
const FILENAME = 'depvitals.config.json';
const ENTRY = fileURLToPath(new URL('../../../dist/cli/index.js', import.meta.url));
const EMPTY = { ignorePaths: [], ignoreDependencies: [] };

/** Reading the uid-style privilege check is unavailable on Windows, hence the optional call. */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** POSIX mode bits are advisory on Windows and meaningless for the super-user. */
const SKIP_PERMISSION_CASES = IS_ROOT || process.platform === 'win32';

/** Modes restored before a scratch tree is removed. */
const READABLE_FILE_MODE = 0o600;
const WRITABLE_DIR_MODE = 0o700;

/** Narrow an underlying operating-system failure to its `code` field. */
function errnoCode(cause: unknown): unknown {
  expect(cause).toBeInstanceOf(Error);
  return (cause as NodeJS.ErrnoException).code;
}

async function withRoot(work: (root: string, sandbox: string) => Promise<void>): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), 'depvitals-config-shape-'));
  const root = join(sandbox, 'project');
  mkdirSync(root);
  try {
    await work(root, sandbox);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

async function expectConfigError(
  root: string,
  code: string,
  context?: string,
): Promise<ProjectConfigError> {
  let failure: unknown;
  try {
    await readProjectConfig(root);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ProjectConfigError);
  if (!(failure instanceof ProjectConfigError)) throw new Error('Expected configuration error');
  expect(failure.name).toBe('ProjectConfigError');
  expect(failure.code).toBe(code);
  expect(failure.message).toContain(join(root, FILENAME));
  if (context !== undefined) expect(failure.message).toContain(context);
  return failure;
}

describe('readRawProjectConfig shape only', () => {
  it('returns frozen empty defaults when the canonical entry is absent', async () => {
    await withRoot(async (root) => {
      const start = vi.mocked(fs.readFile).mock.calls.length;
      const result = await readRawProjectConfig(root);
      expect(result).toEqual(EMPTY);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.ignorePaths)).toBe(true);
      expect(Object.isFrozen(result.ignoreDependencies)).toBe(true);
      expect(vi.mocked(fs.readFile).mock.calls.slice(start)).toEqual([]);
      expect(readdirSync(root)).toEqual([]);
    });
  });

  for (const text of [
    '{}',
    '{"ignorePaths":[]}',
    '{"ignoreDependencies":[]}',
    '{"ignorePaths":[],"ignoreDependencies":[]}',
    '\ufeff{}',
    ' \n{}\r\n',
  ]) {
    it(`accepts empty defaults ${JSON.stringify(text)}`, async () => {
      await withRoot(async (root) => {
        writeFileSync(join(root, FILENAME), text);
        expect(await readRawProjectConfig(root)).toEqual(EMPTY);
        expect(readFileSync(join(root, FILENAME), 'utf8')).toBe(text);
      });
    });
  }

  it('preserves raw strings, order and duplicates pending semantic validation', async () => {
    await withRoot(async (root) => {
      const config = {
        ignorePaths: ['examples', ' ./src\\generated/ ', '../later-reject', 'examples'],
        ignoreDependencies: ['Some-Adapter', '@scope/plugin', 'pkg/subpath', 'Some-Adapter'],
      };
      const text = '\ufeff' + JSON.stringify(config);
      const path = join(root, FILENAME);
      writeFileSync(path, text);
      const start = vi.mocked(fs.lstat).mock.calls.length;
      const result = await readRawProjectConfig(root);
      expect(result).toEqual(config);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.ignorePaths)).toBe(true);
      expect(Object.isFrozen(result.ignoreDependencies)).toBe(true);
      expect(
        vi
          .mocked(fs.lstat)
          .mock.calls.slice(start)
          .map(([file]) => file),
      ).toEqual([root, path]);
      expect(readFileSync(path, 'utf8')).toBe(text);
    });
  });

  for (const text of [
    '',
    ' ',
    '{bad}',
    '{"ignorePaths":[],}',
    '// comment\n{}',
    '{/* comment */}',
    "{'ignorePaths':[]}",
    '\ufeff\ufeff{}',
    ' \ufeff{}',
  ]) {
    it(`rejects non-strict JSON ${JSON.stringify(text)}`, async () => {
      await withRoot(async (root) => {
        writeFileSync(join(root, FILENAME), text);
        expect((await expectConfigError(root, 'invalid-json')).cause).toBeInstanceOf(SyntaxError);
      });
    });
  }

  for (const text of ['null', '[]', '"text"', '3', 'true']) {
    it(`rejects non-object roots ${text}`, async () => {
      await withRoot(async (root) => {
        writeFileSync(join(root, FILENAME), text);
        await expectConfigError(root, 'invalid-shape', 'object');
      });
    });
  }

  for (const key of [
    'unknown',
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'IgnorePaths',
  ]) {
    it(`rejects the whole document for unsupported key ${key}`, async () => {
      await withRoot(async (root) => {
        writeFileSync(join(root, FILENAME), `{"ignorePaths":["valid"],"${key}":[]}`);
        await expectConfigError(root, 'invalid-shape', key);
      });
    });
  }

  for (const field of ['ignorePaths', 'ignoreDependencies']) {
    for (const value of [null, 'one', 1, false, {}]) {
      it(`rejects non-array ${field}=${JSON.stringify(value)}`, async () => {
        await withRoot(async (root) => {
          writeFileSync(join(root, FILENAME), JSON.stringify({ [field]: value }));
          await expectConfigError(root, 'invalid-shape', field);
        });
      });
    }
    for (const value of [null, 1, false, {}, [], '', ' ', '\t\n', '\u00a0']) {
      it(`rejects ${field}[1]=${JSON.stringify(value)} without partial application`, async () => {
        await withRoot(async (root) => {
          writeFileSync(join(root, FILENAME), JSON.stringify({ [field]: ['valid', value] }));
          await expectConfigError(root, 'invalid-shape', `${field}[1]`);
        });
      });
    }
  }

  it('uses native JSON duplicate-key behavior without an alternate parser', async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, FILENAME), '{"ignorePaths":null,"ignorePaths":["last"]}');
      expect(await readRawProjectConfig(root)).toEqual({ ...EMPTY, ignorePaths: ['last'] });
    });
  });
});

it('ignores parent, nested, alternate-format and package-field configuration', async () => {
  await withRoot(async (root, sandbox) => {
    writeFileSync(join(sandbox, FILENAME), '{invalid parent config');
    const nested = join(root, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, FILENAME), '{invalid nested config');
    writeFileSync(join(root, 'package.json'), '{"depvitals":{"ignorePaths":["index.js"]}}');
    for (const name of [
      'depvitals.config.js',
      'depvitals.config.cjs',
      'depvitals.config.yaml',
      'DEPVITALS.CONFIG.JSON',
    ]) {
      writeFileSync(join(root, name), "throw new Error('must never execute')");
    }
    const reads = vi.mocked(fs.readFile).mock.calls.length;
    const listings = vi.mocked(fs.readdir).mock.calls.length;
    expect(await readRawProjectConfig(root)).toEqual(EMPTY);
    expect(vi.mocked(fs.readFile).mock.calls.slice(reads)).toEqual([]);
    expect(
      vi
        .mocked(fs.readdir)
        .mock.calls.slice(listings)
        .map(([path]) => path),
    ).toEqual([root]);
  });
});

for (const kind of [
  'valid-link',
  'invalid-link',
  'dangling-link',
  'directory-link',
  'directory',
] as const) {
  it(`rejects present ${kind} without content reads`, async (context) => {
    await withRoot(async (root, sandbox) => {
      const path = join(root, FILENAME);
      const outside = join(sandbox, 'outside');
      if (kind === 'directory') mkdirSync(path);
      else {
        if (kind === 'directory-link') mkdirSync(outside);
        else if (kind !== 'dangling-link')
          writeFileSync(
            outside,
            kind === 'invalid-link'
              ? '{invalid outside JSON'
              : '{"ignorePaths":["outside-content"]}',
          );
        try {
          await fs.symlink(outside, path, kind === 'directory-link' ? 'junction' : 'file');
        } catch (error) {
          if (
            process.platform === 'win32' &&
            error instanceof Error &&
            'code' in error &&
            ['EPERM', 'EACCES', 'ENOTSUP'].includes(String(error.code))
          ) {
            context.skip(`Symlink creation unavailable: ${String(error.code)}`);
          }
          throw error;
        }
      }
      const start = vi.mocked(fs.readFile).mock.calls.length;
      await expectConfigError(root, 'unreadable', 'regular file');
      expect(vi.mocked(fs.readFile).mock.calls.slice(start)).toEqual([]);
    });
  });
}

it('rejects a linked selected root before listing or reading inputs', async (context) => {
  await withRoot(async (root, sandbox) => {
    writeFileSync(join(root, FILENAME), '{"ignorePaths":["outside"]}');
    const link = join(sandbox, 'linked-root');
    try {
      await fs.symlink(root, link, 'junction');
    } catch (error) {
      if (
        process.platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        error.code === 'EPERM'
      )
        context.skip('Symlink creation unavailable');
      throw error;
    }
    const reads = vi.mocked(fs.readFile).mock.calls.length;
    const listings = vi.mocked(fs.readdir).mock.calls.length;
    await expect(readRawProjectConfig(link)).rejects.toMatchObject({
      name: 'SourceFilesError',
      code: 'not-a-directory',
    });
    expect(vi.mocked(fs.readFile).mock.calls.slice(reads)).toEqual([]);
    expect(vi.mocked(fs.readdir).mock.calls.slice(listings)).toEqual([]);
  });
});

it('keeps a directory-listing failure as the operational cause', async () => {
  await withRoot(async (root) => {
    const cause = Object.assign(new Error('EACCES listing'), { code: 'EACCES' });
    vi.mocked(fs.readdir).mockRejectedValueOnce(cause);
    expect((await expectConfigError(root, 'unreadable')).cause).toBe(cause);
  });
});

for (const code of ['EACCES', 'ENOENT']) {
  it(`does not default on ${code} at lstat after the entry was observed`, async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, FILENAME), '{}');
      const rootInfo = await fs.lstat(root);
      const cause = Object.assign(new Error(`${code} metadata`), { code });
      vi.mocked(fs.lstat).mockResolvedValueOnce(rootInfo).mockRejectedValueOnce(cause);
      expect((await expectConfigError(root, 'unreadable')).cause).toBe(cause);
    });
  });
  it(`does not default on ${code} while reading a present file`, async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, FILENAME), '{}');
      const cause = Object.assign(new Error(`${code} content`), { code });
      vi.mocked(fs.readFile).mockRejectedValueOnce(cause);
      expect((await expectConfigError(root, 'unreadable')).cause).toBe(cause);
    });
  });
}

// Real denied I/O rather than an injected rejection: a present entry the process cannot read must
// stay an operational failure, exactly like the Step 83 manifest lesson.
it.skipIf(SKIP_PERMISSION_CASES)(
  'reports a real permission-denied config read as unreadable',
  async () => {
    await withRoot(async (root) => {
      const path = join(root, FILENAME);
      writeFileSync(path, '{"ignorePaths":["index.cjs"]}');
      chmodSync(path, 0o000);
      try {
        const failure = await expectConfigError(root, 'unreadable');
        expect(errnoCode(failure.cause)).toBe('EACCES');
      } finally {
        chmodSync(path, READABLE_FILE_MODE);
      }
    });
  },
);

it.skipIf(SKIP_PERMISSION_CASES)(
  'reports a real permission-denied root listing as unreadable without content reads',
  async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, FILENAME), '{"ignorePaths":["index.cjs"]}');
      chmodSync(root, 0o000);
      try {
        const reads = vi.mocked(fs.readFile).mock.calls.length;
        const failure = await expectConfigError(root, 'unreadable');
        expect(errnoCode(failure.cause)).toBe('EACCES');
        expect(vi.mocked(fs.readFile).mock.calls.slice(reads)).toEqual([]);
      } finally {
        chmodSync(root, WRITABLE_DIR_MODE);
      }
    });
  },
);

for (const config of [
  '{invalid JSON',
  '{"ignorePaths":["index.cjs"],"ignoreDependencies":["unused","real-missing"]}',
]) {
  it(`activates validated configuration during CLI scans: ${config}`, async () => {
    await withRoot(async (root) => {
      writeFileSync(join(root, 'package.json'), '{"dependencies":{"unused":"*"}}');
      writeFileSync(join(root, 'index.cjs'), "require('real-missing');");
      writeFileSync(join(root, FILENAME), config);
      const options = { cwd: root, version: '0.2.0' };
      const expected =
        config === '{invalid JSON'
          ? { exitCode: 1, stdout: '', stderr: `${join(root, FILENAME)} is not valid JSON\n` }
          : { exitCode: 0, stdout: 'DepVitals\n\nNo dependency issues found.\n', stderr: '' };
      const start = vi.mocked(fs.readFile).mock.calls.length;
      expect(await runCli([root], options)).toEqual(expected);
      expect(
        vi
          .mocked(fs.readFile)
          .mock.calls.slice(start)
          .filter(([path]) => path === join(root, FILENAME)),
      ).toHaveLength(1);
      const result = spawnSync(process.execPath, [ENTRY, root], {
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
      });
      expect(result.error).toBeUndefined();
      expect({ exitCode: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual(
        expected,
      );
      expect(readFileSync(join(root, FILENAME), 'utf8')).toBe(config);
      expect(readdirSync(root).sort()).toEqual([FILENAME, 'index.cjs', 'package.json']);
    });
  });
}

describe('readProjectConfig semantic validation', () => {
  it('returns frozen validated defaults for absent and empty configuration', async () => {
    await withRoot(async (root) => {
      for (const text of [undefined, '{}', '{"ignorePaths":[],"ignoreDependencies":[]}']) {
        if (text !== undefined) writeFileSync(join(root, FILENAME), text);
        const result = await readProjectConfig(root);
        expect(result).toEqual(EMPTY);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.ignorePaths)).toBe(true);
        expect(Object.isFrozen(result.ignoreDependencies)).toBe(true);
      }
    });
  });
  it('validates both fields after one guarded read, without reading rule destinations', async () => {
    await withRoot(async (root) => {
      const text = JSON.stringify({
        ignorePaths: ['./missing//generated/', 'missing/generated', 'A'],
        ignoreDependencies: ['foo', 'LegacyPkg', '@scope/foo', 'fs', 'foo', 'pkg_'],
      });
      const path = join(root, FILENAME);
      writeFileSync(path, text);
      const reads = vi.mocked(fs.readFile).mock.calls.length;
      const stats = vi.mocked(fs.lstat).mock.calls.length;
      expect(await readProjectConfig(root)).toEqual({
        ignorePaths: ['A', 'missing/generated'],
        ignoreDependencies: ['@scope/foo', 'LegacyPkg', 'foo', 'fs', 'pkg_'],
      });
      expect(vi.mocked(fs.readFile).mock.calls.slice(reads)).toEqual([[path, 'utf8']]);
      expect(
        vi
          .mocked(fs.lstat)
          .mock.calls.slice(stats)
          .map(([file]) => file),
      ).toEqual([root, path]);
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(readdirSync(root)).toEqual([FILENAME]);
    });
  });
  for (const [field, rule] of [
    ['ignorePaths', '../outside'],
    ['ignorePaths', './ src'],
    ['ignorePaths', 'src /'],
    ['ignoreDependencies', '@scope/pkg/subpath'],
    ['ignoreDependencies', 'pkg@1'],
    ['ignoreDependencies', '_'],
    ['ignoreDependencies', '!pkg'],
  ] as const) {
    it(`rejects ${field} semantic error at its original index: ${rule}`, async () => {
      await withRoot(async (root) => {
        writeFileSync(
          join(root, FILENAME),
          JSON.stringify({
            ignorePaths: ['valid'],
            ignoreDependencies: ['valid'],
            [field]: ['valid', 'valid', rule],
          }),
        );
        await expectConfigError(root, 'invalid-shape', `${field}[2]`);
      });
    });
  }
  it('rejects invalid paths before dependency semantics regardless of JSON key order', async () => {
    await withRoot(async (root) => {
      writeFileSync(
        join(root, FILENAME),
        JSON.stringify({
          ignoreDependencies: ['pkg/subpath'],
          ignorePaths: ['valid', '../bad'],
        }),
      );
      await expectConfigError(root, 'invalid-shape', 'ignorePaths[1]');
    });
  });
});
