import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('CI action integrity', () => {
  it('pins every external action to an immutable full commit SHA', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const actions = [...workflow.matchAll(/^\s*uses:\s*(\S+)/gm)].map((match) => match[1]);

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
    }
  });

  it('runs the latest published npx smoke in the full verify matrix and keeps failures required', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );
    const verify = workflow.split('  verify:')[1]?.split('  package-smoke:')[0] ?? '';
    expect(verify).toContain('runs-on: ${{ matrix.os }}');
    for (const os of ['ubuntu-latest', 'macos-latest', 'windows-latest']) {
      expect(verify).toContain(`- os: ${os}`);
    }
    const npxStep = verify
      .split('      - name: Verify latest published CLI with npx')[1]
      ?.split('      - name:')[0];
    expect(npxStep).toContain('run: node scripts/verify-published-npx.mjs');
    expect(npxStep).not.toMatch(/^\s*(?:if|continue-on-error):/m);
    expect(workflow).toContain('needs: [verify, package-smoke]');
    expect(workflow).toContain('name: CI');
  });
});
