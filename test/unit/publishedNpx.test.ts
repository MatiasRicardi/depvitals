import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Result = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};
type Options = { cwd: string; env: NodeJS.ProcessEnv };
type Runner = (args: readonly string[], options: Options) => Result;
const { verifyPublishedNpx } = (await import(
  new URL('../../scripts/verify-published-npx.mjs', import.meta.url).href
)) as { verifyPublishedNpx: (execute: Runner) => { version: string; checks: number } };

function response(args: readonly string[]): Result {
  const last = args.at(-1) ?? '';
  let stdout = '';
  let stderr = '';
  let status = 0;
  if (last === '--version') stdout = '0.3.0\n';
  else if (last === '--help') stdout = 'DepVitals\n\nUsage:\n  depvitals [project]\n';
  else if (last.endsWith('clean')) stdout = 'DepVitals\n\nNo dependency issues found.\n';
  else if (last.endsWith('findings')) {
    status = 1;
    stdout =
      'DepVitals\n\nUnused dependencies (1)\n  smoke-unused\n\n' +
      'Unused devDependencies (1)\n  smoke-unused-tool\n\n' +
      'Missing dependencies (1)\n  smoke-missing\n';
  } else {
    status = 1;
    stderr = `${join(last, 'package.json')} is not valid JSON\n`;
  }
  return { stdout, stderr, status, signal: null };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('published npx smoke (offline verifier controls)', () => {
  it('uses latest in an isolated consumer/cache and verifies all exit paths without target installs', () => {
    const calls: { args: readonly string[]; options: Options }[] = [];
    const result = verifyPublishedNpx((args, options) => {
      calls.push({ args, options });
      expect(args.slice(0, 3)).toEqual(['--yes', '--package=depvitals@latest', 'depvitals']);
      expect(options.env['npm_config_registry']).toBe('https://registry.npmjs.org/');
      expect(options.env['CI']).toBe('1');
      expect(options.env['DEPVITALS_NO_UPDATE_CHECK']).toBe('1');
      expect(options.env['npm_config_ignore_scripts']).toBe('true');
      expect(options.env['npm_config_cache']).toBe(join(dirname(options.cwd), 'npm-cache'));
      expect(options.env['PATH']?.split(delimiter)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/[\\/]node_modules[\\/]\.bin[\\/]?$/i)]),
      );
      expect(
        JSON.parse(readFileSync(join(options.cwd, 'package.json'), 'utf8')) as unknown,
      ).toEqual({
        name: 'npx-consumer',
        private: true,
      });
      expect(existsSync(join(options.cwd, 'node_modules'))).toBe(false);
      return response(args);
    });
    expect(result).toEqual({ version: '0.3.0', checks: 5 });
    expect(calls).toHaveLength(5);
    expect(calls.map(({ args }) => args.at(-1))).toEqual([
      '--version',
      '--help',
      expect.stringMatching(/clean$/),
      expect.stringMatching(/findings$/),
      expect.stringMatching(/invalid$/),
    ]);
    expect(console.log).toHaveBeenCalledWith(
      'Published npx smoke: depvitals@latest resolved to 0.3.0',
    );
    expect(existsSync(dirname(calls[0]?.options.cwd ?? ''))).toBe(false);
  });

  it('logs the version actually resolved by latest rather than the checkout version', () => {
    expect(
      verifyPublishedNpx((args) =>
        args.at(-1) === '--version' ? { ...response(args), stdout: '0.8.2\n' } : response(args),
      ).version,
    ).toBe('0.8.2');
    expect(console.log).toHaveBeenCalledWith(
      'Published npx smoke: depvitals@latest resolved to 0.8.2',
    );
  });

  it.each(['version', 'help', 'clean', 'findings', 'invalid'])(
    'rejects a broken %s outcome and cleans its task-owned directories',
    (mode) => {
      let root = '';
      expect(() =>
        verifyPublishedNpx((args, { cwd }) => {
          root = dirname(cwd);
          const last = args.at(-1) ?? '';
          const result = response(args);
          if (mode === 'version' && last === '--version') return { ...result, stdout: 'latest\n' };
          if (mode === 'help' && last === '--help') return { ...result, stdout: '' };
          if (last.endsWith(mode)) {
            if (mode === 'findings') return { ...result, status: 0 };
            return { ...result, stdout: 'unexpected output\n' };
          }
          return result;
        }),
      ).toThrow();
      expect(root).not.toBe('');
      expect(existsSync(root)).toBe(false);
    },
  );

  it.each(['added', 'changed', 'deleted'])(
    'rejects a target mutation (%s), including lifecycle markers',
    (mutation) => {
      expect(() =>
        verifyPublishedNpx((args, { cwd }) => {
          if ((args.at(-1) ?? '').endsWith('invalid')) {
            if (mutation === 'added') writeFileSync(join(cwd, 'TARGET_CODE_WAS_EXECUTED'), 'bad');
            else if (mutation === 'changed') writeFileSync(join(cwd, 'clean', 'index.cjs'), 'bad');
            else rmSync(join(cwd, 'clean', 'lifecycle.cjs'));
          }
          return response(args);
        }),
      ).toThrow('must not mutate');
    },
  );

  it.each(['error', 'signal', 'status'])(
    'rejects launcher failure (%s) instead of accepting a partial scan',
    (failure) => {
      expect(() =>
        verifyPublishedNpx((args) => ({
          ...response(args),
          ...(failure === 'error' ? { error: new Error('spawn timeout') } : {}),
          ...(failure === 'signal' ? { signal: 'SIGTERM' as const } : {}),
          ...(failure === 'status' ? { status: null } : {}),
        })),
      ).toThrow();
    },
  );
});
