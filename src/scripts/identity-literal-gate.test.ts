import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('identity literal gate wiring', () => {
  it('exposes scanner command and repository hygiene gate scripts', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['verify:identity-literals']).toBe('node scripts/identity-literal-scan.mjs');
    expect(scripts['verify:repository-hygiene']).toBe(
      'npm run verify:public-sanitize && npm run verify:identity-literals',
    );
  });
});
