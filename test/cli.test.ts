import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runCli } from '../src/cli/runCli.js';

/**
 * The repository manifest is typed as `unknown` on purpose. Only the version field is asserted,
 * which is the single source of truth the CLI depends on.
 */
const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
const version = (manifest as { version: string }).version;

describe('runCli', () => {
  describe('no arguments', () => {
    it('exits 0 and shows the early-development message', () => {
      const result = runCli([], version);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DepVitals');
      expect(result.stdout).toContain('A simple, lightweight dependency health checker');
      expect(result.stdout).toContain('Early development release.');
    });

    it('does not claim that dependency scanning works', () => {
      const result = runCli([], version);

      expect(result.stdout).not.toContain('scan');
      expect(result.stdout).not.toContain('unused');
      expect(result.stdout).not.toContain('missing');
    });
  });

  describe('--help', () => {
    it('exits 0 and shows help to stdout', () => {
      const result = runCli(['--help'], version);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('DepVitals');
      expect(result.stdout).toContain('A simple, lightweight dependency health checker');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('-h, --help');
      expect(result.stdout).toContain('-v, --version');
      expect(result.stderr).toBe('');
    });
  });

  describe('-h', () => {
    it('is equivalent to --help', () => {
      const result = runCli(['-h'], version);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('-h, --help');
      expect(result.stdout).toContain('-v, --version');
    });
  });

  describe('--version', () => {
    it('exits 0 and prints only the version from package.json', () => {
      const result = runCli(['--version'], version);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
      expect(result.stderr).toBe('');
    });
  });

  describe('-v', () => {
    it('is equivalent to --version', () => {
      const result = runCli(['-v'], version);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`${version}\n`);
    });
  });

  describe('unsupported arguments', () => {
    const unsupportedArgs: string[][] = [
      ['--scan'],
      ['./project'],
      ['--help', 'foo'],
      ['--version', 'foo'],
      ['--help', '--version'],
      ['--scan', '--help'],
    ];

    for (const args of unsupportedArgs) {
      it(`fails with exit 1 for ${args.join(' ')}`, () => {
        const result = runCli(args, version);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain('Unknown option');
        expect(result.stderr).toContain('depvitals --help');
        expect(result.stdout).toBe('');
      });
    }
  });
});
