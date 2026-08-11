import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('actor terminology gate wiring', () => {
  it('exposes the scanner and includes it in repository hygiene', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts['verify:actor-terminology']).toBe('node scripts/actor-terminology-scan.mjs');
    expect(scripts['verify:repository-hygiene']).toBe(
      'npm run verify:public-sanitize && npm run verify:identity-literals && npm run verify:actor-terminology && npm run verify:dependency-cycles && npm run verify:shared-type-guards && npm run verify:model-usage-capture && npm run verify:postgres-only && npm run verify:hardcoded-settings && npm run verify:duplicate-type-names && npm run verify:knip && npm run verify:todo-bead-links',
    );
  });
});
