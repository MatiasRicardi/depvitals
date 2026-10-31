import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { analyzeProject } from '../src/core/analyzeProject.js';
import { hereDocumentCases, hereDocumentDeclaredNames } from './helpers/hereDocumentCases.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const BUILT_ENTRY = join(REPO_ROOT, 'dist', 'cli', 'index.js');

describe('Step 81 here-documents through analyzer and compiled CLI', () => {
  it.each(
    hereDocumentCases.flatMap((scenario) =>
      (['declared', 'undeclared'] as const).map((mode) => ({ ...scenario, mode })),
    ),
  )('$name ($mode)', async ({ script, expected, mode }) => {
    const project = mkdtempSync(join(tmpdir(), 'depvitals-heredoc-'));
    try {
      // This command would leave a marker if any analyzed lifecycle script were executed.
      const marker = join(project, 'SCRIPT_RAN');
      const lifecycle = `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`)}`;
      const manifest = JSON.stringify({
        scripts: { check: script, postinstall: lifecycle },
        ...(mode === 'declared'
          ? {
              devDependencies: Object.fromEntries(
                hereDocumentDeclaredNames.map((name) => [name, '*']),
              ),
            }
          : {}),
      });
      writeFileSync(join(project, 'package.json'), manifest);
      const unused =
        mode === 'declared'
          ? hereDocumentDeclaredNames.filter((name) => !expected.includes(name))
          : [];
      expect(await analyzeProject(project)).toEqual({
        projectRoot: project,
        unusedDependencies: [],
        unusedDevDependencies: unused,
        missingDependencies: [],
      });
      const result = spawnSync(process.execPath, [BUILT_ENTRY, project], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, DEPVITALS_NO_UPDATE_CHECK: '1' },
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: unused.length > 0 ? 1 : 0,
        stdout:
          unused.length > 0
            ? `DepVitals\n\nUnused devDependencies (${String(unused.length)})\n${unused.map((name) => `  ${name}\n`).join('')}`
            : 'DepVitals\n\nNo dependency issues found.\n',
        stderr: '',
      });
      expect(readdirSync(project)).toEqual(['package.json']);
      expect(readFileSync(join(project, 'package.json'), 'utf8')).toBe(manifest);
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
