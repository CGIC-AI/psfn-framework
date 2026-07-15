import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('CompanionId type gate wiring', () => {
  it('runs the negative type fixture as part of every production build', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['verify:companion-id-types']).toBe(
      'tsc --noEmit -p tsconfig.companion-id-types.json',
    );
    expect(scripts.build).toBe('npm run verify:companion-id-types && tsup');
  });
});
