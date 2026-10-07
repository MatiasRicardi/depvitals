import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  loadProjectManifest,
  ProjectManifestError,
  type ProjectManifestErrorCode,
} from '../../../src/scanner/projectManifest.js';

/**
 * Fixture directory. Every scenario is a real directory with its own `package.json`, except the
 * "no manifest" scenarios, which are directories that intentionally have none.
 */
const MANIFEST_FIXTURES = fileURLToPath(new URL('../../fixtures/manifest/', import.meta.url));

function fixture(projectRoot: string): string {
  return join(MANIFEST_FIXTURES, projectRoot);
}

/**
 * Run the loader and return the rejection instead of throwing, so tests assert on the error object.
 */
async function captureLoadFailure(projectRoot: string): Promise<unknown> {
  try {
    await loadProjectManifest(projectRoot);
  } catch (error) {
    return error;
  }

  return undefined;
}

/**
 * Assert that a caught value is the expected operational error. `messageParts` keeps the message
 * check useful to users (it must name the path or field that failed) without locking the exact
 * wording.
 */
function expectManifestError(
  error: unknown,
  code: ProjectManifestErrorCode,
  messageParts: readonly string[] = [],
): void {
  if (!(error instanceof ProjectManifestError)) {
    throw new Error(`Expected a ProjectManifestError with code "${code}".`, { cause: error });
  }

  expect(error.code).toBe(code);

  for (const part of messageParts) {
    expect(error.message).toContain(part);
  }
}

function causeOf(error: unknown): unknown {
  return error instanceof ProjectManifestError ? error.cause : undefined;
}

describe('loadProjectManifest', () => {
  describe('declared dependencies', () => {
    it('loads dependencies and devDependencies separately', async () => {
      const manifest = await loadProjectManifest(fixture('basic'));

      expect(manifest.dependencies).toEqual({
        '@fastify/cors': '^9.0.1',
        express: '^4.19.2',
        zod: '^3.23.8',
      });
      expect(manifest.devDependencies).toEqual({
        typescript: '5.9.3',
        vitest: '^5.0.3',
      });
    });

    it('includes optional and peer names only in declaredDependencyNames', async () => {
      const manifest = await loadProjectManifest(fixture('basic'));

      // The union is deterministic: sorted names, never JSON insertion order.
      expect([...manifest.declaredDependencyNames]).toEqual([
        '@fastify/cors',
        'express',
        'fsevents',
        'react',
        'typescript',
        'vitest',
        'zod',
      ]);

      // `unused` analysis later reads only dependencies/devDependencies, so peer/optional names
      // must not leak into those maps.
      expect(manifest.dependencies).not.toHaveProperty('react');
      expect(manifest.devDependencies).not.toHaveProperty('fsevents');
    });

    it('orders dependency keys deterministically instead of using JSON order', async () => {
      const manifest = await loadProjectManifest(fixture('basic'));

      expect(Object.keys(manifest.dependencies)).toEqual(['@fastify/cors', 'express', 'zod']);
      expect(Object.keys(manifest.devDependencies)).toEqual(['typescript', 'vitest']);
    });
  });

  describe('scripts', () => {
    it('loads scripts as static strings ordered by name', async () => {
      const manifest = await loadProjectManifest(fixture('basic'));

      expect(Object.keys(manifest.scripts)).toEqual(['build', 'format', 'test']);
      expect(manifest.scripts['build']).toBe('tsc -p tsconfig.json');
    });
  });

  describe('package name', () => {
    it('preserves a string name', async () => {
      const manifest = await loadProjectManifest(fixture('basic'));

      expect(manifest.name).toBe('manifest-basic');
    });

    it('omits the name property when the manifest declares none', async () => {
      const manifest = await loadProjectManifest(fixture('minimal'));

      expect('name' in manifest).toBe(false);
    });

    it('fails when the name is present but not a string', async () => {
      const failure = await captureLoadFailure(fixture('invalid-name-type'));

      expectManifestError(failure, 'invalid-shape', ['"name"', 'invalid-name-type']);
    });
  });

  describe('missing sections', () => {
    it('treats every absent section as empty', async () => {
      const manifest = await loadProjectManifest(fixture('minimal'));

      expect(manifest.dependencies).toEqual({});
      expect(manifest.devDependencies).toEqual({});
      expect(manifest.scripts).toEqual({});
      expect(manifest.declaredDependencyNames).toBeInstanceOf(Set);
      expect(manifest.declaredDependencyNames.size).toBe(0);
    });
  });

  describe('project root', () => {
    it('normalizes an absolute root and reports the manifest path', async () => {
      const manifest = await loadProjectManifest(join(fixture('basic'), '.'));

      expect(manifest.root).toBe(fixture('basic'));
      expect(manifest.packageJsonPath).toBe(join(fixture('basic'), 'package.json'));
    });

    it('strips a trailing path separator from the root', async () => {
      const manifest = await loadProjectManifest(`${fixture('minimal')}${sep}`);

      expect(manifest.root).toBe(fixture('minimal'));
    });

    it('resolves a relative project root against the current working directory', async () => {
      const manifest = await loadProjectManifest(relative(process.cwd(), fixture('minimal')));

      expect(manifest.root).toBe(fixture('minimal'));
      expect(manifest.packageJsonPath).toBe(join(fixture('minimal'), 'package.json'));
    });
  });

  describe('operational errors', () => {
    it('fails when package.json does not exist', async () => {
      const projectRoot = fixture('does-not-exist');
      const failure = await captureLoadFailure(projectRoot);

      expectManifestError(failure, 'missing', ['package.json', projectRoot]);
    });

    it('does not walk up to a parent manifest', async () => {
      // This directory exists and has no package.json, while the repository root above it does.
      const failure = await captureLoadFailure(MANIFEST_FIXTURES);

      expectManifestError(failure, 'missing', ['package.json']);
    });

    it('fails when package.json is not valid JSON', async () => {
      const failure = await captureLoadFailure(fixture('invalid-json'));

      expectManifestError(failure, 'invalid-json', ['package.json', 'invalid-json']);
    });

    it('keeps the JSON failure as the error cause', async () => {
      const failure = await captureLoadFailure(fixture('invalid-json'));

      expectManifestError(failure, 'invalid-json');
      expect(causeOf(failure)).toBeInstanceOf(SyntaxError);
    });

    describe.each([
      ['array', 'invalid-root-array'],
      ['null', 'invalid-root-null'],
      ['number', 'invalid-root-number'],
      ['string', 'invalid-root-string'],
    ])('a JSON root that is %s', (_label, directory) => {
      it('fails with invalid-shape', async () => {
        const failure = await captureLoadFailure(fixture(directory));

        expectManifestError(failure, 'invalid-shape', ['must contain a JSON object']);
      });
    });

    it('fails when a dependency section is not an object', async () => {
      const failure = await captureLoadFailure(fixture('invalid-shape'));

      expectManifestError(failure, 'invalid-shape', ['"dependencies"', 'invalid-shape']);
    });

    it('fails when the scripts section is not an object', async () => {
      const failure = await captureLoadFailure(fixture('invalid-scripts-shape'));

      expectManifestError(failure, 'invalid-shape', ['"scripts"', 'invalid-scripts-shape']);
    });

    it('fails when a dependency value is not a string', async () => {
      const failure = await captureLoadFailure(fixture('non-string-dependency-value'));

      expectManifestError(failure, 'invalid-shape', [
        '"devDependencies"',
        'typescript',
        'non-string-dependency-value',
      ]);
    });
  });

  describe('static analysis guarantee', () => {
    it('reads package scripts as strings without executing them', async () => {
      const projectRoot = fixture('scripts-not-executed');
      const marker = join(projectRoot, 'marker.txt');

      expect(existsSync(marker)).toBe(false);

      const manifest = await loadProjectManifest(projectRoot);

      expect(manifest.scripts['postinstall']).toBe('touch marker.txt');
      expect(Object.keys(manifest.scripts)).toEqual(['build', 'postinstall']);

      // The script must stay inert data: DepVitals parses, it never runs project code.
      expect(existsSync(marker)).toBe(false);
    });
  });
});
