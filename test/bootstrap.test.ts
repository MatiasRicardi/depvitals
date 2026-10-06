import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { packageName } from '../src/index.js';

/**
 * The repository manifest is typed as `unknown` on purpose: these tests only assert on the
 * fields that the tooling depends on.
 */
const manifest: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);

describe('project bootstrap', () => {
  it('loads the internal bootstrap module', () => {
    expect(packageName).toBe('depvitals');
  });

  describe('package manifest', () => {
    it('is an ESM package named depvitals', () => {
      expect(manifest).toMatchObject({ name: 'depvitals', type: 'module' });
    });

    it('declares a supported Node.js engine', () => {
      expect(manifest).toMatchObject({ engines: { node: '>=22.13.0' } });
    });

    it('pins pnpm as the package manager', () => {
      const { packageManager } = manifest as { packageManager?: unknown };
      expect(packageManager).toMatch(/^pnpm@/);
    });

    it('declares no programmatic entry point', () => {
      const pkg = manifest as { main?: unknown; types?: unknown; exports?: unknown };
      expect(pkg).not.toHaveProperty('main');
      expect(pkg).not.toHaveProperty('types');
      expect(pkg).not.toHaveProperty('exports');
    });
  });

  describe('cli package wiring', () => {
    it('keeps the development version placeholder', () => {
      expect(manifest).toMatchObject({ version: '0.0.0' });
    });

    it('exposes the depvitals binary pointing to the built CLI', () => {
      const pkg = manifest as {
        bin?: { depvitals?: string };
      };
      expect(pkg.bin?.depvitals).toBe('./dist/cli/index.js');
    });

    it('keeps the package public without provenance', () => {
      const pkg = manifest as {
        publishConfig?: { access?: unknown; provenance?: unknown };
      };
      expect(pkg.publishConfig?.access).toBe('public');
      expect(pkg.publishConfig).not.toHaveProperty('provenance');
    });

    it('allows only the expected package files', () => {
      const pkg = manifest as { files?: unknown };
      const files = (pkg.files ?? []) as string[];
      expect(files).toContain('dist');
      expect(files).toContain('README.md');
    });
  });
});
