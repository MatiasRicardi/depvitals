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
});
