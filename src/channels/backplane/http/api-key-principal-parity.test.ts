import { describe, expect, it } from 'vitest';

// The Compose smoke stack seeds its satellite registry from inside the runtime
// image, where the framework build output is not available, so it reimplements
// the principal derivation in plain Node. That reimplementation is only correct
// while it stays byte-identical to the canonical one; nothing pinned that
// before (psfn-framework-p2jr0 (3)). Importing the seed script is side-effect
// free: its `main()` runs only under the `import.meta.url === argv[1]` guard.
import { deriveApiKeyPrincipalId as deriveSmokeApiKeyPrincipalId } from '../../../../scripts/ops/psfn-compose-smoke-satellites.mjs';
import { deriveApiKeyPrincipalId } from './auth.js';

// Invented test material only. A real satellite key never appears in the repo.
const FIXED_TOKEN = 'smoke-satellite-parity-token-0000';

describe('api-key principal derivation parity with the Compose smoke seed', () => {
  it('derives the identical principal id for a fixed token', () => {
    const canonical = deriveApiKeyPrincipalId(FIXED_TOKEN);
    expect(canonical).toBe(deriveSmokeApiKeyPrincipalId(FIXED_TOKEN));
    // Pin the shape too, so a change to the prefix or the digest slice length
    // fails here rather than silently desyncing the smoke stack's registry
    // from the gateway that has to admit it.
    expect(canonical).toMatch(/^api-key-[0-9a-f]{24}$/);
  });

  it('normalizes surrounding whitespace the same way on both sides', () => {
    // The canonical derivation trims before hashing; a seed script that did not
    // would produce an id the gateway never admits.
    const padded = `  ${FIXED_TOKEN}\n`;
    expect(deriveSmokeApiKeyPrincipalId(padded)).toBe(deriveApiKeyPrincipalId(padded));
    expect(deriveSmokeApiKeyPrincipalId(padded)).toBe(deriveApiKeyPrincipalId(FIXED_TOKEN));
  });

  it('separates distinct tokens on both sides', () => {
    const other = `${FIXED_TOKEN}-b`;
    expect(deriveSmokeApiKeyPrincipalId(other)).not.toBe(deriveSmokeApiKeyPrincipalId(FIXED_TOKEN));
    expect(deriveSmokeApiKeyPrincipalId(other)).toBe(deriveApiKeyPrincipalId(other));
  });
});
