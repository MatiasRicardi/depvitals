/**
 * Focused coverage for the best-effort 24-hour update-version cache (Step 65).
 *
 * Every input is injected - the cache directory, the environment map, the home-directory provider,
 * the platform and the clock - so the tests never read or write a real user cache, never touch a
 * real home folder, never need a network connection and never depend on the machine's date. Each
 * temporary tree is created outside the repository and removed again after the test.
 *
 * Two halves of the contract are asserted everywhere:
 *
 * - the positive half: a real, fresh record is a hit, and only a fresh record is a hit;
 * - the safety half: every broken cache (missing, invalid, wrong-typed, future or negative
 *   timestamp, oversized, symlinked, unreadable, inside a read-only directory) is a silent miss,
 *   and no cache location can ever point inside the analyzed project.
 */

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  readCachedLatest,
  resolveUpdateCacheFile,
  UPDATE_CACHE_FILE_NAME,
  UPDATE_CACHE_TTL_MS,
  writeCachedLatest,
} from '../../../src/cli/notifier/updateCache.js';
import { extractModuleSpecifiers } from '../../../src/scanner/moduleSpecifiers.js';

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/cli/notifier/updateCache.ts', import.meta.url)),
  'utf8',
);

/** A fixed fake "current time": 2026-10-16T13:00:00Z, in epoch milliseconds. */
const NOW = 1_792_170_000_000;

/** The same instant as text, for building raw cache documents. */
const NOW_TEXT = String(NOW);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The published version a fresh cache is expected to remember. */
const LATEST = '0.2.1';

/** Mode bits of a scratch cache directory, restored before a temporary tree is removed. */
const WRITABLE_MODE = 0o700;

/** Reading `/proc/self/uid`-style privilege checks is unavailable on Windows, hence the optional. */
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

/** POSIX mode bits are advisory on Windows and meaningless for the super-user. */
const SKIP_PERMISSION_CASES = IS_ROOT || process.platform === 'win32';

/**
 * Create a throwaway directory outside the repository, run `run` inside it and remove only that
 * freshly created directory afterwards.
 */
async function withScratch(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'depvitals-update-cache-'));

  try {
    await run(root);
  } finally {
    await chmodSafe(root);
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Restore write permission on a scratch directory (and its immediate children) so removal cannot
 * leave a read-only directory behind in the system temporary folder.
 */
async function chmodSafe(root: string): Promise<void> {
  try {
    await chmod(root, WRITABLE_MODE);
  } catch {
    // The directory may already be gone; nothing to restore.
  }
}

/** Write a raw cache record into `directory`, bypassing the module under test. */
async function seed(directory: string, contents: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, UPDATE_CACHE_FILE_NAME), contents, 'utf8');
}

/** The canonical record shape, serialized with a `checkedAt` value relative to the fake now. */
function record(checkedAt: number, latest: string = LATEST): string {
  return JSON.stringify({ latest, checkedAt });
}

/** Read the file the module is supposed to have written under an explicit cache directory. */
async function readStored(directory: string): Promise<string> {
  return readFile(join(directory, UPDATE_CACHE_FILE_NAME), 'utf8');
}

describe('Step 65: the update-version cache location is user-scoped, never project-scoped', () => {
  const POSIX_HOME = '/home/tester';
  const WINDOWS_HOME = 'C:\\Users\\tester';

  it('prefers an absolute XDG_CACHE_HOME on POSIX platforms', () => {
    const resolved = resolveUpdateCacheFile({
      env: { XDG_CACHE_HOME: '/var/cache' },
      homedir: () => POSIX_HOME,
      platform: 'linux',
    });

    expect(resolved).toBe(posix.join('/var/cache', 'depvitals', UPDATE_CACHE_FILE_NAME));
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['relative', '.cache'],
    ['relative pointing at the project', './depvitals'],
    ['parent-relative', '../somewhere'],
  ])('falls back to the home cache when XDG_CACHE_HOME is %s', (_label, value) => {
    const env = value === undefined ? {} : { XDG_CACHE_HOME: value };

    expect(resolveUpdateCacheFile({ env, homedir: () => POSIX_HOME, platform: 'linux' })).toBe(
      posix.join(POSIX_HOME, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME),
    );
  });

  it('prefers an absolute LOCALAPPDATA on Windows', () => {
    const resolved = resolveUpdateCacheFile({
      env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
      homedir: () => WINDOWS_HOME,
      platform: 'win32',
    });

    expect(resolved).toBe('C:\\Users\\tester\\AppData\\Local\\depvitals\\update-check.json');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['relative', 'AppData\\Local'],
    ['drive-relative, i.e. missing the path separator after the drive letter', 'C:AppData\\Local'],
  ])('falls back to the Windows home cache when LOCALAPPDATA is %s', (_label, value) => {
    const env = value === undefined ? {} : { LOCALAPPDATA: value };

    expect(resolveUpdateCacheFile({ env, homedir: () => WINDOWS_HOME, platform: 'win32' })).toBe(
      'C:\\Users\\tester\\.cache\\depvitals\\update-check.json',
    );
  });

  it('consults each variable only on its own platform', () => {
    // XDG_CACHE_HOME is not a Windows location, and LOCALAPPDATA is not a POSIX one.
    expect(
      resolveUpdateCacheFile({
        env: { XDG_CACHE_HOME: '/var/cache' },
        homedir: () => WINDOWS_HOME,
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\tester\\.cache\\depvitals\\update-check.json');

    expect(
      resolveUpdateCacheFile({
        env: { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
        homedir: () => POSIX_HOME,
        platform: 'darwin',
      }),
    ).toBe(posix.join(POSIX_HOME, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME));
  });

  it('ignores unrelated variables that merely mention cache or CI paths', () => {
    const env = {
      CACHE_DIR: '/tmp/elsewhere',
      XDG_CACHE_DIR: '/tmp/elsewhere',
      XDG_STATE_HOME: '/tmp/elsewhere',
      HOME: '/tmp/elsewhere',
      DEPOT_TOOLS_USER_CACHE_DIR: '/tmp/elsewhere',
    };

    expect(resolveUpdateCacheFile({ env, homedir: () => POSIX_HOME, platform: 'linux' })).toBe(
      posix.join(POSIX_HOME, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME),
    );
  });

  it('reports no location at all when the home directory is unusable', () => {
    expect(
      resolveUpdateCacheFile({ env: {}, homedir: () => '', platform: 'linux' }),
    ).toBeUndefined();

    expect(
      resolveUpdateCacheFile({ env: {}, homedir: () => 'relative/home', platform: 'linux' }),
    ).toBeUndefined();

    expect(
      resolveUpdateCacheFile({
        env: {},
        homedir: () => {
          throw new Error('home directory is not available');
        },
        platform: 'linux',
      }),
    ).toBeUndefined();
  });

  it('never resolves a location relative to the current working directory', () => {
    // Nothing here is absolute, so the only possible answers are `undefined` or an absolute path;
    // a relative answer would mean the cache could land inside the project being scanned.
    const candidates = [
      { env: {}, homedir: () => '', platform: 'linux' },
      { env: { XDG_CACHE_HOME: 'depvitals' }, homedir: () => 'rel', platform: 'linux' },
      { env: {}, homedir: () => '', platform: 'win32' },
    ];

    for (const candidate of candidates) {
      const resolved = resolveUpdateCacheFile(candidate);

      expect(resolved === undefined || isAbsolute(resolved)).toBe(true);
    }
  });

  it('uses an injected absolute cache directory verbatim, and ignores a relative one', () => {
    const override = join('/injected', 'cache');

    expect(resolveUpdateCacheFile({ cacheDir: override, env: {}, homedir: () => POSIX_HOME })).toBe(
      join(override, UPDATE_CACHE_FILE_NAME),
    );

    // A relative override is never resolved against `cwd`; resolution stays user-scoped.
    expect(resolveUpdateCacheFile({ cacheDir: '.cache', env: {}, homedir: () => POSIX_HOME })).toBe(
      join(POSIX_HOME, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME),
    );
  });
});

describe('Step 65: a fresh cached version is a hit and needs no lookup', () => {
  it('returns the cached version for an age of 30 minutes', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW - 30 * MINUTE_MS));

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
    });
  });

  it('returns the cached version for an age of 23 hours', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW - 23 * HOUR_MS));

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
    });
  });

  it('still returns a hit one millisecond below the window', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW - (UPDATE_CACHE_TTL_MS - 1)));

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
    });
  });

  it.each([
    ['exactly at the window', UPDATE_CACHE_TTL_MS],
    ['above the window', UPDATE_CACHE_TTL_MS + 1],
    ['far above the window', UPDATE_CACHE_TTL_MS + 26 * HOUR_MS],
  ])('misses when the age is %s', async (_label, age) => {
    await withScratch(async (root) => {
      await seed(root, record(NOW - age));

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
    });
  });

  it('documents the window as approximately 24 hours', () => {
    expect(UPDATE_CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('Step 65: cached data is untrusted, so anything else is a silent miss', () => {
  it.each([
    ['empty file', ''],
    ['not JSON', 'latest=0.2.1'],
    ['truncated JSON', '{"latest":"0.2.1"'],
    ['a JSON array', '[{"latest":"0.2.1","checkedAt":1}]'],
    ['a JSON string', '"0.2.1"'],
    ['a JSON number', '1792170000000'],
    ['JSON null', 'null'],
    ['a numeric latest', '{"latest":0.21,"checkedAt":1792170000000}'],
    ['a null latest', '{"latest":null,"checkedAt":1792170000000}'],
    ['an empty latest', `{"latest":"","checkedAt":${NOW_TEXT}}`],
    ['a whitespace-padded latest', `{"latest":" ${LATEST} ","checkedAt":${NOW_TEXT}}`],
    ['a path-like latest', `{"latest":"../secrets/token","checkedAt":${NOW_TEXT}}`],
    [
      'a latest longer than 64 characters',
      `{"latest":"${'9'.repeat(65)}","checkedAt":${NOW_TEXT}}`,
    ],
    ['a checkedAt that is a string', `{"latest":"${LATEST}","checkedAt":"${NOW_TEXT}"}`],
    ['a null checkedAt', `{"latest":"${LATEST}","checkedAt":null}`],
    ['a missing checkedAt', `{"latest":"${LATEST}"}`],
    ['a missing latest', `{"checkedAt":${NOW_TEXT}}`],
    ['a fractional checkedAt', `{"latest":"${LATEST}","checkedAt":${NOW_TEXT}0.5}`],
    ['a negative checkedAt', `{"latest":"${LATEST}","checkedAt":-1000}`],
    ['a checkedAt beyond a safe integer', `{"latest":"${LATEST}","checkedAt":1e309}`],
    [
      'an extra field carrying a project path',
      `{"latest":"${LATEST}","checkedAt":${NOW_TEXT},"project":"/home/user/secret-project"}`,
    ],
    [
      'an extra field carrying source paths',
      `{"checkedAt":${NOW_TEXT},"latest":"${LATEST}","sources":["/home/user/src/app.ts"]}`,
    ],
  ])('treats %s as a miss without throwing', async (_label, contents) => {
    await withScratch(async (root) => {
      await seed(root, contents);

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
    });
  });

  it('misses on a timestamp in the future', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW + 5 * MINUTE_MS));

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
      // Even a future entry that is far ahead stays a miss rather than becoming a hit.
      await expect(
        readCachedLatest({ cacheDir: root, now: NOW - 365 * 24 * HOUR_MS }),
      ).resolves.toBeUndefined();
    });
  });

  it('misses when the file is missing', async () => {
    await withScratch(async (root) => {
      await mkdir(root, { recursive: true });

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
    });
  });

  it('misses when the whole cache directory is missing', async () => {
    await withScratch(async (root) => {
      await expect(
        readCachedLatest({ cacheDir: join(root, 'does', 'not', 'exist'), now: NOW }),
      ).resolves.toBeUndefined();
    });
  });

  it('refuses an oversized file before parsing it', async () => {
    await withScratch(async (root) => {
      // Valid JSON, but far beyond the bound a real record could ever occupy.
      const oversized = `${record(NOW)}${'x'.repeat(9 * 1024)}`;
      await seed(root, oversized);

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();

      // A padded but still-valid document, kept under the bound, remains a hit: the bound is about
      // the accepted size, not about the whitespace tolerance of the parser.
      await seed(root, `${record(NOW)}\n`);
      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
    });
  });

  it('does not follow a symlink placed at the cache path', async () => {
    await withScratch(async (root) => {
      const target = join(root, 'foreign.json');
      await writeFile(target, record(NOW), 'utf8');
      await mkdir(join(root, 'cache'), { recursive: true });
      await symlink(target, join(root, 'cache', UPDATE_CACHE_FILE_NAME));

      await expect(readCachedLatest({ cacheDir: join(root, 'cache'), now: NOW })).resolves.toBe(
        undefined,
      );
    });
  });

  it('misses when the cache path is a directory', async () => {
    await withScratch(async (root) => {
      await mkdir(join(root, UPDATE_CACHE_FILE_NAME), { recursive: true });

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
    });
  });

  // POSIX mode bits do not restrict the super-user, so this case only holds for normal accounts.
  // The permission-independent equivalent (a parent that is a regular file) is covered below.
  it.skipIf(SKIP_PERMISSION_CASES)('misses when the cache file is unreadable', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW));
      await chmod(join(root, UPDATE_CACHE_FILE_NAME), 0o000);

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();

      await chmod(join(root, UPDATE_CACHE_FILE_NAME), 0o600);
    });
  });

  it('misses when the injected clock is unusable', async () => {
    await withScratch(async (root) => {
      await seed(root, record(NOW));

      for (const now of [-1, -NOW, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(readCachedLatest({ cacheDir: root, now })).resolves.toBeUndefined();
      }
    });
  });

  it('misses when no location exists, without touching the filesystem', async () => {
    await expect(
      readCachedLatest({ env: {}, homedir: () => '', now: NOW }),
    ).resolves.toBeUndefined();
  });
});

describe('Step 65: writes are atomic, minimal and completely best-effort', () => {
  it('stores only the public version and the check timestamp', async () => {
    await withScratch(async (root) => {
      await writeCachedLatest(LATEST, { cacheDir: root, now: NOW });

      const contents = await readStored(root);

      expect(JSON.parse(contents)).toEqual({ latest: LATEST, checkedAt: NOW });
      expect(Object.keys(JSON.parse(contents) as Record<string, unknown>).sort()).toEqual([
        'checkedAt',
        'latest',
      ]);
      // Privacy: the record holds no path, no project name, no credential and no machine id.
      expect(contents).not.toContain(root);
      expect(contents).not.toContain(tmpdir());
      expect(contents).not.toContain('/');
      expect(contents).not.toContain('\\');
    });
  });

  it('writes a record that reads back as fresh and expires on schedule', async () => {
    await withScratch(async (root) => {
      await writeCachedLatest(LATEST, { cacheDir: root, now: NOW });

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
      await expect(readCachedLatest({ cacheDir: root, now: NOW + 23 * HOUR_MS })).resolves.toBe(
        LATEST,
      );
      await expect(
        readCachedLatest({ cacheDir: root, now: NOW + UPDATE_CACHE_TTL_MS }),
      ).resolves.toBeUndefined();
    });
  });

  it('creates the cache directory when it does not exist yet', async () => {
    await withScratch(async (root) => {
      const cacheDir = join(root, 'depvitals-cache', 'nested');

      await writeCachedLatest(LATEST, { cacheDir, now: NOW });

      expect(await readStored(cacheDir)).toBe(JSON.stringify({ latest: LATEST, checkedAt: NOW }));
    });
  });

  it('replaces the previous entry and leaves no temporary file behind', async () => {
    await withScratch(async (root) => {
      await writeCachedLatest('0.2.0', { cacheDir: root, now: NOW - HOUR_MS });
      await writeCachedLatest(LATEST, { cacheDir: root, now: NOW });

      const entries = await readdir(root);

      expect(entries).toEqual([UPDATE_CACHE_FILE_NAME]);
      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBe(LATEST);
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace-padded', ' 0.2.1 '],
    ['newline-carrying', '0.2.1\n'],
    ['path-like', '../../etc/passwd'],
    ['longer than 64 characters', '9'.repeat(65)],
  ])('does not store an unusable version (%s)', async (_label, latest) => {
    await withScratch(async (root) => {
      await writeCachedLatest(latest, { cacheDir: root, now: NOW });

      await expect(readCachedLatest({ cacheDir: root, now: NOW })).resolves.toBeUndefined();
      expect(existsSync(join(root, UPDATE_CACHE_FILE_NAME))).toBe(false);
    });
  });

  it('does not write with an unusable clock', async () => {
    await withScratch(async (root) => {
      for (const now of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await writeCachedLatest(LATEST, { cacheDir: root, now });
      }

      expect(existsSync(join(root, UPDATE_CACHE_FILE_NAME))).toBe(false);
    });
  });

  it('silently no-ops when no location exists', async () => {
    await expect(
      writeCachedLatest(LATEST, { env: {}, homedir: () => '', now: NOW }),
    ).resolves.toBeUndefined();
  });

  it('writes nothing inside the analyzed project when no cache location exists', async () => {
    await withScratch(async (root) => {
      const project = join(root, 'depvitals');
      await mkdir(join(project, 'src'), { recursive: true });
      await writeFile(join(project, 'package.json'), '{"name":"project"}', 'utf8');
      await writeFile(join(project, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');

      await writeCachedLatest(LATEST, { env: {}, homedir: () => '', now: NOW });

      const entries = (await readdir(project, { recursive: true })).map(String);

      expect(entries.some((entry) => entry.endsWith(UPDATE_CACHE_FILE_NAME))).toBe(false);
      expect(existsSync(join(project, UPDATE_CACHE_FILE_NAME))).toBe(false);
    });
  });
});

describe('Step 65: an unwritable cache never affects the scan', () => {
  it.skipIf(SKIP_PERMISSION_CASES)(
    'fails silently on a read-only cache directory, leaving the report untouched',
    async () => {
      await withScratch(async (root) => {
        const cacheDir = join(root, 'cache', 'depvitals');
        await mkdir(join(root, 'cache'), { recursive: true });
        await mkdir(cacheDir, { recursive: true });
        await chmod(cacheDir, 0o500); // r-x: no write permission for the owner.

        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(writeCachedLatest(LATEST, { cacheDir, now: NOW })).resolves.toBeUndefined();
        await expect(readCachedLatest({ cacheDir, now: NOW })).resolves.toBeUndefined();

        expect(existsSync(join(cacheDir, UPDATE_CACHE_FILE_NAME))).toBe(false);
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();

        log.mockRestore();
        warn.mockRestore();
        error.mockRestore();

        await chmod(cacheDir, WRITABLE_MODE);
      });
    },
  );

  it('fails silently when a cache parent is a regular file (unprivileged and root alike)', async () => {
    await withScratch(async (root) => {
      const blocker = join(root, 'blocked');
      await writeFile(blocker, 'not a directory', 'utf8');

      const cacheDir = join(blocker, 'depvitals');

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(writeCachedLatest(LATEST, { cacheDir, now: NOW })).resolves.toBeUndefined();
      await expect(readCachedLatest({ cacheDir, now: NOW })).resolves.toBeUndefined();

      expect(await readFile(blocker, 'utf8')).toBe('not a directory');
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();

      log.mockRestore();
      error.mockRestore();
    });
  });

  it('never logs and never rejects for any broken cache setup', async () => {
    await withScratch(async (root) => {
      const unreadableDir = join(root, 'cache', 'depvitals');
      await mkdir(unreadableDir, { recursive: true });
      await seed(join(root, 'giant'), `${record(NOW)}${'y'.repeat(9 * 1024)}`);
      await mkdir(join(root, 'a', 'directory'), { recursive: true });

      const locations: readonly string[] = [
        join(root, 'missing'),
        unreadableDir,
        join(root, 'giant'),
        join(root, 'a', 'directory'),
      ];

      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
        throw new Error('the cache must never attempt a network lookup');
      });

      for (const cacheDir of locations) {
        await expect(readCachedLatest({ cacheDir, now: NOW })).resolves.toBeUndefined();
        await expect(writeCachedLatest(LATEST, { cacheDir, now: NOW })).resolves.toBeUndefined();
      }

      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();

      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
      fetchSpy.mockRestore();
    });
  });
});

describe('Step 65: the cache stays outside the analyzed project', () => {
  /** Create a scratch tree holding an analyzed project named like the cache plus decoy files. */
  async function seedProjectAndCache(root: string): Promise<ProjectTree> {
    const project = join(root, 'work', 'depvitals');
    const userCache = join(root, 'cache');
    const userHome = join(root, 'home');

    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, '.cache', 'depvitals'), { recursive: true });
    await writeFile(join(project, 'package.json'), '{"name":"depvitals"}', 'utf8');
    await writeFile(join(project, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
    await writeFile(join(project, UPDATE_CACHE_FILE_NAME), '{"decoy":"project-root-file"}', 'utf8');
    await writeFile(
      join(project, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME),
      '{"decoy":"in-project-cache-dir"}',
      'utf8',
    );

    return { project, userCache, userHome };
  }

  type ProjectTree = {
    readonly project: string;
    readonly userCache: string;
    readonly userHome: string;
  };

  /** Every file inside the analyzed project, POSIX-style and sorted. */
  async function projectFiles(project: string): Promise<readonly string[]> {
    const entries = await readdir(project, { recursive: true });

    return entries.map((entry) => entry.replaceAll('\\', '/')).sort();
  }

  it('resolves to the user cache and leaves the project byte-for-byte unchanged', async () => {
    await withScratch(async (root) => {
      const { project, userCache, userHome } = await seedProjectAndCache(root);
      const before = await projectFiles(project);

      // The user cache variable is platform-specific: LOCALAPPDATA on Windows, XDG_CACHE_HOME
      // elsewhere. Everything else in this test is platform-independent.
      const userCacheEnv =
        process.platform === 'win32' ? { LOCALAPPDATA: userCache } : { XDG_CACHE_HOME: userCache };

      const resolved = resolveUpdateCacheFile({
        env: userCacheEnv,
        homedir: () => userHome,
      });

      expect(resolved).toBe(join(userCache, 'depvitals', UPDATE_CACHE_FILE_NAME));
      expect(isAbsolute(resolved ?? '')).toBe(true);
      expect(resolved?.startsWith(project)).toBe(false);

      await writeCachedLatest(LATEST, {
        env: userCacheEnv,
        homedir: () => userHome,
        now: NOW,
      });

      expect(await readStored(join(userCache, 'depvitals'))).toBe(
        JSON.stringify({ latest: LATEST, checkedAt: NOW }),
      );

      // Same files, same contents: nothing was written into, or next to, the scanned project.
      expect(await projectFiles(project)).toEqual(before);
      expect(await readFile(join(project, UPDATE_CACHE_FILE_NAME), 'utf8')).toBe(
        '{"decoy":"project-root-file"}',
      );
      expect(
        await readFile(join(project, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME), 'utf8'),
      ).toBe('{"decoy":"in-project-cache-dir"}');
      await expect(
        readCachedLatest({ env: userCacheEnv, homedir: () => userHome, now: NOW }),
      ).resolves.toBe(LATEST);
    });
  });

  it.each([
    ['XDG_CACHE_HOME pointing at the project itself', 'work/depvitals'],
    ['XDG_CACHE_HOME pointing at a project subdirectory', 'work/depvitals/.cache'],
    ['XDG_CACHE_HOME as the current directory', '.'],
    ['XDG_CACHE_HOME as the bare package name', 'depvitals'],
  ])('a relative %s cannot redirect the cache into the project', async (_label, relativeValue) => {
    await withScratch(async (root) => {
      const { project, userHome } = await seedProjectAndCache(root);
      const before = await projectFiles(project);

      const resolved = resolveUpdateCacheFile({
        env: { XDG_CACHE_HOME: relativeValue },
        homedir: () => userHome,
      });

      expect(resolved).toBe(join(userHome, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME));
      expect(resolved?.startsWith(project)).toBe(false);

      await writeCachedLatest(LATEST, {
        env: { XDG_CACHE_HOME: relativeValue },
        homedir: () => userHome,
        now: NOW,
      });

      expect(await projectFiles(project)).toEqual(before);
    });
  });

  it('an injected project-relative cacheDir still resolves to the user cache', async () => {
    await withScratch(async (root) => {
      const { project, userHome } = await seedProjectAndCache(root);
      const before = await projectFiles(project);

      await writeCachedLatest(LATEST, {
        cacheDir: 'depvitals',
        env: {},
        homedir: () => userHome,
        now: NOW,
      });

      expect(await projectFiles(project)).toEqual(before);
      expect(existsSync(join(userHome, '.cache', 'depvitals', UPDATE_CACHE_FILE_NAME))).toBe(true);
    });
  });
});

describe('Step 65: the cache module has no network, clock or output capability', () => {
  it('imports only the filesystem, path and os builtins', () => {
    expect(
      [...new Set(extractModuleSpecifiers(MODULE_SOURCE).map((entry) => entry.specifier))].sort(),
    ).toEqual(['node:fs/promises', 'node:os', 'node:path']);
  });

  it('mentions no network, registry, output or dynamic-execution primitive', () => {
    const forbidden = [
      'fetch(',
      'node:http',
      'node:https',
      'node:net',
      'node:tls',
      'node:dns',
      'node:child_process',
      'node:worker_threads',
      'XMLHttpRequest',
      'WebSocket',
      'registry.npmjs.org',
      'https://',
      'http://',
      'eval(',
      'new Function(',
      'import(',
      'require(',
      'console.',
      'process.stdout',
      'process.stderr',
      'process.exit',
      'process.env',
      'process.argv',
      'process.cwd',
      'Date.now(',
      'new Date(',
      'performance.now(',
      'writeFileSync(',
      'appendFileSync(',
    ];

    const offenders: string[] = [];

    for (const token of forbidden) {
      if (MODULE_SOURCE.includes(token)) {
        offenders.push(token);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('reads exactly two process facts and no ambient clock or environment', () => {
    const used = [
      ...new Set([...MODULE_SOURCE.matchAll(/process\.([a-zA-Z]+)/g)].map((m) => m[1])),
    ];

    expect(used.sort()).toEqual(['pid', 'platform']);
  });

  it('exposes only the documented cache surface', async () => {
    const surface = await import(
      /* the module under test, resolved exactly as the static imports above resolve it */
      '../../../src/cli/notifier/updateCache.js'
    );

    expect(Object.keys(surface).sort()).toEqual([
      'UPDATE_CACHE_FILE_NAME',
      'UPDATE_CACHE_TTL_MS',
      'readCachedLatest',
      'resolveUpdateCacheFile',
      'writeCachedLatest',
    ]);
  });

  it('is not called from the CLI yet, because Step 67 performs the integration', () => {
    const cliFiles = [
      '../../../src/cli/runCli.ts',
      '../../../src/cli/index.ts',
      '../../../src/index.ts',
    ];

    for (const file of cliFiles) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

      expect(source).not.toContain('updateCache');
      expect(source).not.toContain('readCachedLatest');
      expect(source).not.toContain('writeCachedLatest');
    }
  });
});
