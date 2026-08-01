import { describe, expect, it } from 'vitest';
import {
  buildShardGrantDigestPayload,
  canonicalizeCapabilityTokens,
  computeCapabilityOwnerVersion,
  computeShardGrantDigest,
  createShardParentGrantSnapshot,
  deriveShardCapabilityGrant,
  SHARD_CAPABILITY_DENIAL_MASK,
  SHARD_GRANT_DERIVATION_VERSION,
  SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS,
  type ShardDenialMaskToken,
} from './shard-derivation.js';
import { CAPABILITY_TIER_DEFAULTS } from './tiers.js';
import { CAPABILITY_TOKENS, type CapabilityToken } from './tokens.js';

const PARENT_ID = 'companion-parent-1';

const ALL_TOKENS: readonly CapabilityToken[] = CAPABILITY_TOKENS;
const MASK_SET = new Set<CapabilityToken>(SHARD_CAPABILITY_DENIAL_MASK);

describe('canonicalizeCapabilityTokens', () => {
  it('deduplicates and returns canonical CAPABILITY_TOKENS order', () => {
    const canonical = canonicalizeCapabilityTokens(
      ['world.read', 'identity.read', 'world.read', 'memory.write', 'identity.read'],
      'test',
    );
    expect(canonical).toEqual(['identity.read', 'memory.write', 'world.read']);
  });

  it('fails closed on unknown tokens', () => {
    expect(() => canonicalizeCapabilityTokens(['identity.read', 'not.a.token'], 'test'))
      .toThrow('unknown capability token "not.a.token"');
  });

  it('fails closed on malformed entries and non-array input', () => {
    expect(() => canonicalizeCapabilityTokens([42 as unknown as string], 'test'))
      .toThrow('unknown capability token');
    expect(() => canonicalizeCapabilityTokens('identity.read' as unknown as string[], 'test'))
      .toThrow('must be an array');
  });

  it('returns a frozen array', () => {
    const canonical = canonicalizeCapabilityTokens(['identity.read'], 'test');
    expect(Object.isFrozen(canonical)).toBe(true);
  });
});

describe('SHARD_CAPABILITY_DENIAL_MASK', () => {
  it('bumps the derivation contract for the expanded denial mask', () => {
    expect(SHARD_GRANT_DERIVATION_VERSION).toBe('psfn.shard-grant.v2');
  });

  it('contains exactly the eleven approved tokens in canonical order', () => {
    expect(SHARD_CAPABILITY_DENIAL_MASK).toEqual([
      'identity.write.base',
      'identity.write.operator',
      'memory.delete',
      'external.discord',
      'external.email',
      'external.web',
      'external.companion',
      'external.mcp',
      'lifecycle.restart',
      'lifecycle.rebuild',
      'world.control',
    ]);
  });

  it('is immutable', () => {
    expect(Object.isFrozen(SHARD_CAPABILITY_DENIAL_MASK)).toBe(true);
  });

  it('has an explicit temporary-grant eligibility disposition for every masked token', () => {
    const dispositionTokens = Object.keys(SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS).sort();
    expect(dispositionTokens).toEqual([...SHARD_CAPABILITY_DENIAL_MASK].sort());
  });

  it('marks only world.control eligible for approval-bound request-scoped authority with policy-gated TTL', () => {
    expect(SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS['world.control']).toEqual({
      requestScoped: 'human-approval-required',
      ttl: 'policy-gated-disabled',
    });
    const nondelegable: ShardDenialMaskToken[] = [
      'identity.write.base',
      'identity.write.operator',
      'memory.delete',
      'external.discord',
      'external.email',
      'external.web',
      'external.companion',
      'external.mcp',
      'lifecycle.restart',
      'lifecycle.rebuild',
    ];
    for (const token of nondelegable) {
      expect(SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS[token]).toEqual({
        requestScoped: 'never',
        ttl: 'never',
      });
    }
  });

  it('keeps the disposition table immutable', () => {
    expect(Object.isFrozen(SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS)).toBe(true);
    expect(Object.isFrozen(SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS['world.control'])).toBe(true);
  });
});

describe('createShardParentGrantSnapshot', () => {
  it('resolves a custom parent from its authoritative customTokens, never tier-name defaults', () => {
    const snapshot = createShardParentGrantSnapshot({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['world.read', 'identity.read', 'shard.spawn'],
    });
    expect(snapshot.tier).toBe('custom');
    expect(snapshot.tokens).toEqual(['identity.read', 'shard.spawn', 'world.read']);
  });

  it('fails closed on a custom parent without authoritative customTokens', () => {
    expect(() => createShardParentGrantSnapshot({
      companionId: PARENT_ID,
      tier: 'custom',
    })).toThrow('refusing to resolve a custom grant from the tier name alone');
  });

  it('resolves default tiers from the canonical tier definitions', () => {
    for (const tier of ['nursery', 'apprentice', 'autonomous'] as const) {
      const snapshot = createShardParentGrantSnapshot({
        companionId: PARENT_ID,
        tier,
        customTokens: [],
      });
      expect([...snapshot.tokens].sort()).toEqual([...CAPABILITY_TIER_DEFAULTS[tier]].sort());
    }
  });

  it('fails closed on unknown tokens, unknown tiers, and blank companion IDs', () => {
    expect(() => createShardParentGrantSnapshot({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read', 'evil.token'],
    })).toThrow('unknown capability token "evil.token"');
    expect(() => createShardParentGrantSnapshot({
      companionId: PARENT_ID,
      tier: 'shard' as unknown as 'custom',
      customTokens: [],
    })).toThrow('unknown capability tier "shard"');
    expect(() => createShardParentGrantSnapshot({
      companionId: '   ',
      tier: 'autonomous',
      customTokens: [],
    })).toThrow('companionId must be a non-empty string');
  });

  it('returns a frozen snapshot', () => {
    const snapshot = createShardParentGrantSnapshot({
      companionId: PARENT_ID,
      tier: 'nursery',
      customTokens: [],
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tokens)).toBe(true);
  });
});

describe('computeCapabilityOwnerVersion', () => {
  it('is content-stable: equal canonical content yields equal versions', () => {
    const a = computeCapabilityOwnerVersion({ tier: 'custom', customTokens: ['world.read', 'identity.read'] });
    const b = computeCapabilityOwnerVersion({ tier: 'custom', customTokens: ['identity.read', 'world.read', 'identity.read'] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes for any owner content change, including inert customTokens on a default tier', () => {
    const base = computeCapabilityOwnerVersion({ tier: 'autonomous', customTokens: [] });
    expect(computeCapabilityOwnerVersion({ tier: 'apprentice', customTokens: [] })).not.toBe(base);
    expect(computeCapabilityOwnerVersion({ tier: 'autonomous', customTokens: ['identity.read'] })).not.toBe(base);
  });

  it('fails closed on unknown tiers and tokens', () => {
    expect(() => computeCapabilityOwnerVersion({ tier: 'root' as unknown as 'custom', customTokens: [] }))
      .toThrow('unknown capability tier "root"');
    expect(() => computeCapabilityOwnerVersion({ tier: 'custom', customTokens: ['nope'] }))
      .toThrow('unknown capability token "nope"');
  });
});

describe('deriveShardCapabilityGrant', () => {
  it('derives the all-token parent to exactly the parent set minus the full mask, in canonical order', () => {
    const grant = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: [...ALL_TOKENS],
    });
    const expected = ALL_TOKENS.filter(token => !MASK_SET.has(token));
    expect(grant.tokens).toEqual(expected);
    expect(grant.tokens).toHaveLength(ALL_TOKENS.length - SHARD_CAPABILITY_DENIAL_MASK.length);
    for (const masked of SHARD_CAPABILITY_DENIAL_MASK) {
      expect(grant.tokens).not.toContain(masked);
      expect(grant.access.has(masked)).toBe(false);
    }
    // Egress backstop (psfn-framework-tu0mw): no external-send capability
    // survives derivation, so even a re-injected or renamed external tool is
    // capability-denied for a shard regardless of parent authority.
    for (const egress of [
      'external.discord',
      'external.email',
      'external.web',
      'external.companion',
      'external.mcp',
    ] as const) {
      expect(grant.access.has(egress)).toBe(false);
    }
  });

  it('derives an autonomous parent to the autonomous set minus the mask, keeping unmasked write tokens', () => {
    const grant = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'autonomous',
      customTokens: [],
    });
    const expected = ALL_TOKENS.filter(token => (
      CAPABILITY_TIER_DEFAULTS.autonomous.includes(token) && !MASK_SET.has(token)
    ));
    expect(grant.tokens).toEqual(expected);
    // identity.write.runtime and memory.write survive so a task can produce
    // runtime-persona and memory candidates (fold policy still governs them).
    expect(grant.access.has('identity.write.runtime')).toBe(true);
    expect(grant.access.has('memory.write')).toBe(true);
    expect(grant.access.has('world.control')).toBe(false);
    expect(grant.access.has('memory.delete')).toBe(false);
  });

  it('never lets default-tier or custom parents gain tokens through derivation', () => {
    for (const tier of ['nursery', 'apprentice'] as const) {
      const parentTokens = new Set<CapabilityToken>(CAPABILITY_TIER_DEFAULTS[tier]);
      const grant = deriveShardCapabilityGrant({ companionId: PARENT_ID, tier, customTokens: [] });
      for (const token of grant.tokens) {
        expect(parentTokens.has(token)).toBe(true);
      }
    }
    const partial = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read', 'world.control', 'memory.delete', 'shard.spawn'],
    });
    expect(partial.tokens).toEqual(['identity.read', 'shard.spawn']);
  });

  it('derives a default (nursery) parent with no masked tokens to exactly its own set', () => {
    const grant = deriveShardCapabilityGrant({ companionId: PARENT_ID, tier: 'nursery', customTokens: [] });
    expect([...grant.tokens].sort()).toEqual([...CAPABILITY_TIER_DEFAULTS.nursery].sort());
  });

  it('produces a stable digest and owner version for equal grants regardless of input ordering', () => {
    const a = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['world.read', 'identity.read', 'shard.spawn'],
    });
    const b = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['shard.spawn', 'identity.read', 'world.read', 'identity.read'],
    });
    expect(a.grantDigest).toBe(b.grantDigest);
    expect(a.ownerVersion).toBe(b.ownerVersion);
    expect(a.grantDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the digest for any authority change: companion, tier, tokens, or derivation contract', () => {
    const base = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read', 'world.read'],
    });

    const otherCompanion = deriveShardCapabilityGrant({
      companionId: 'companion-parent-2',
      tier: 'custom',
      customTokens: ['identity.read', 'world.read'],
    });
    expect(otherCompanion.grantDigest).not.toBe(base.grantDigest);

    const otherTokens = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read'],
    });
    expect(otherTokens.grantDigest).not.toBe(base.grantDigest);

    // Same effective token list but a different tier is a different authority.
    const autonomousParent = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'autonomous',
      customTokens: [],
    });
    const customTwin = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: [...CAPABILITY_TIER_DEFAULTS.autonomous],
    });
    expect(customTwin.tokens).toEqual(autonomousParent.tokens);
    expect(customTwin.grantDigest).not.toBe(autonomousParent.grantDigest);

    // A derivation-contract version change must change the digest.
    const payload = buildShardGrantDigestPayload({
      parent: base.parent,
      denialMask: base.denialMask,
      shardTokens: base.tokens,
      derivationVersion: 'psfn.shard-grant.v999-test',
    });
    expect(computeShardGrantDigest(payload)).not.toBe(base.grantDigest);
  });

  it('recomputes identically across independent call sites for equal canonical owner content', () => {
    // Simulates the manager and gateway independently deriving from their own
    // atomic snapshots of the same owner content: exact equality is required.
    const managerSide = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'apprentice',
      customTokens: [],
    });
    const gatewaySide = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'apprentice',
      customTokens: [],
    });
    expect(gatewaySide.ownerVersion).toBe(managerSide.ownerVersion);
    expect(gatewaySide.grantDigest).toBe(managerSide.grantDigest);
    expect(gatewaySide.tokens).toEqual(managerSide.tokens);
  });

  it('returns an immutable custom access advertising exactly the derived tokens', () => {
    const grant = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read', 'world.read', 'shard.spawn', 'world.control'],
    });
    expect(grant.access.getTier()).toBe('custom');
    expect([...grant.access.getGrantedTokens()]).toEqual([...grant.tokens]);
    for (const token of grant.tokens) {
      expect(grant.access.has(token)).toBe(true);
    }
    expect(grant.access.derivationVersion).toBe(SHARD_GRANT_DERIVATION_VERSION);
    expect(grant.access.ownerVersion).toBe(grant.ownerVersion);
    expect(grant.access.grantDigest).toBe(grant.grantDigest);
  });

  it('rejects mutation of the derived grant and its access token set', () => {
    const grant = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read'],
    });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.tokens)).toBe(true);
    expect(Object.isFrozen(grant.access)).toBe(true);
    expect(Object.isFrozen(grant.parent)).toBe(true);

    const tokens = grant.access.getGrantedTokens() as Set<CapabilityToken>;
    expect(() => tokens.add('world.control')).toThrow('Shard capability access is immutable');
    expect(() => tokens.delete('identity.read')).toThrow('Shard capability access is immutable');
    expect(() => tokens.clear()).toThrow('Shard capability access is immutable');
    expect(grant.access.has('identity.read')).toBe(true);
    expect(grant.access.has('world.control')).toBe(false);
  });

  it('binds the exposed digest payload contract to the canonical inputs', () => {
    const grant = deriveShardCapabilityGrant({
      companionId: PARENT_ID,
      tier: 'custom',
      customTokens: ['identity.read', 'shard.spawn'],
    });
    const payload = buildShardGrantDigestPayload({
      parent: grant.parent,
      denialMask: grant.denialMask,
      shardTokens: grant.tokens,
    });
    expect(Object.isFrozen(payload)).toBe(true);
    expect(payload.contract).toBe(SHARD_GRANT_DERIVATION_VERSION);
    expect(payload.parentCompanionId).toBe(PARENT_ID);
    expect(payload.ownerVersion).toBe(grant.ownerVersion);
    expect(payload.denialMask).toEqual([...SHARD_CAPABILITY_DENIAL_MASK]);
    expect(computeShardGrantDigest(payload)).toBe(grant.grantDigest);
  });
});
