import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  createPostgresBiographicalProfileStore,
  PostgresBiographicalProfileStore,
} from './postgres-store.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-09T12:00:00.000Z');

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, 90_000);

afterAll(async () => {
  await harness?.stop();
});

function contact(id: string, version = 1): BiographicalSubjectRef {
  return { kind: 'contact', contactId: id, subjectVersion: version };
}
function companion(id: string, version = 1): BiographicalSubjectRef {
  return { kind: 'companion', companionId: id, subjectVersion: version };
}
function source(overrides: Partial<BiographicalClaimSource> = {}): BiographicalClaimSource {
  return {
    ref: 'memory:m-1',
    revision: '2026-08-09T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    ...overrides,
  };
}

async function withStore<T>(
  operation: (store: PostgresBiographicalProfileStore, pool: Pool) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-biographical-integration',
    allowExitOnIdle: true,
    max: 2,
  });
  try {
    const store = await createPostgresBiographicalProfileStore(pool);
    return await operation(store, pool);
  } finally {
    await pool.end();
  }
}

describe('PostgresBiographicalProfileStore — schema and roundtrip', () => {
  it('runs the migration and persists a self nickname with computed digest + sensitivity', async () => {
    await withStore(async (store) => {
      const claim = await store.writeClaim({
        subject: companion('purrs'),
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
        basis: 'explicit',
        confidence: 0.9,
        sources: [source()],
        now: NOW,
      });
      expect(claim.status).toBe('candidate');
      expect(claim.effectiveSensitivity).toBe('personal');
      expect(claim.claimDigest).toMatch(/^[0-9a-f]{64}$/u);

      const reloaded = await store.getClaim(claim.id);
      expect(reloaded).toEqual(claim);
    });
  });

  it('rejects an unknown claim kind at the database boundary', async () => {
    await withStore(async (store) => {
      await expect(
        store.writeClaim({
          subject: companion('purrs'),
          // @ts-expect-error unknown kind must reject, not persist
          kind: 'hobby',
          value: { kind: 'hobby' },
          basis: 'explicit',
          confidence: 0.5,
          sources: [source()],
          now: NOW,
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects duplicate ids and scopes lists to the exact subject version', async () => {
    await withStore(async (store) => {
      const input = {
        id: 'claim-fixed',
        subject: contact('v', 1),
        kind: 'name' as const,
        value: { kind: 'name' as const, name: 'V', role: 'primary' as const },
        basis: 'explicit' as const,
        confidence: 1,
        sources: [source()],
        now: NOW,
      };
      await store.writeClaim(input);
      await expect(store.writeClaim({
        ...input,
        value: { kind: 'name', name: 'Someone else', role: 'primary' },
      })).rejects.toThrow();
      expect(await store.listClaims({ subject: contact('v', 2) })).toEqual([]);
      await expect(store.listClaims({ limit: 0 })).rejects.toThrow('positive integer');
    });
  });
});

describe('PostgresBiographicalProfileStore — supersession and lifecycle', () => {
  it('marks the prior claim superseded and preserves both rows', async () => {
    await withStore(async (store) => {
      const original = await store.writeClaim({
        subject: contact('v'),
        kind: 'relationship',
        relatedSubject: companion('purrs'),
        value: { kind: 'relationship', relationshipType: 'employed at Acme' },
        basis: 'observed',
        confidence: 0.8,
        sources: [source()],
        validFrom: '2026-01-01T00:00:00.000Z',
        status: 'active',
        now: new Date('2026-06-01T00:00:00.000Z'),
      });
      const result = await store.supersedeClaim({
        supersededClaimId: original.id,
        subject: contact('v'),
        relatedSubject: companion('purrs'),
        kind: 'relationship',
        value: { kind: 'relationship', relationshipType: 'employed at Globex' },
        basis: 'explicit',
        confidence: 0.9,
        sources: [source({ ref: 'memory:m-2', revision: '2026-08-01T00:00:00.000Z' })],
        validFrom: '2026-08-01T00:00:00.000Z',
        now: NOW,
      });
      expect(result.superseded.status).toBe('superseded');
      expect(result.superseding.supersedesClaimId).toBe(original.id);

      const live = await store.listClaims({ subject: contact('v') });
      expect(live.map(c => c.id)).toEqual([result.superseding.id]);
      const history = await store.listClaims({ subject: contact('v'), includeTerminal: true });
      expect(history).toHaveLength(2);
    });
  });

  it('transitions candidate -> active and rejects invalid transitions', async () => {
    await withStore(async (store) => {
      const claim = await store.writeClaim({
        subject: contact('v'),
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
        basis: 'observed',
        confidence: 0.7,
        sources: [source()],
        now: NOW,
      });
      expect((await store.transitionClaim({ claimId: claim.id, to: 'active', now: NOW })).status).toBe('active');
      await expect(
        store.transitionClaim({ claimId: claim.id, to: 'candidate', now: NOW }),
      ).rejects.toThrow();
    });
  });

  it('refuses cross-subject supersession without mutating the prior claim', async () => {
    await withStore(async (store) => {
      const original = await store.writeClaim({
        subject: contact('v'),
        kind: 'name',
        value: { kind: 'name', name: 'V', role: 'primary' },
        basis: 'explicit',
        confidence: 1,
        sources: [source()],
        status: 'active',
        now: NOW,
      });
      await expect(store.supersedeClaim({
        supersededClaimId: original.id,
        subject: contact('someone-else'),
        kind: 'name',
        value: { kind: 'name', name: 'Someone', role: 'primary' },
        basis: 'explicit',
        confidence: 1,
        sources: [source({ ref: 'memory:m-2' })],
        now: NOW,
      })).rejects.toThrow('same canonical subject');
      expect((await store.getClaim(original.id))?.status).toBe('active');
    });
  });
});

describe('PostgresBiographicalProfileStore — exact digest-bound grants', () => {
  it('lowers via an exact grant and reverts on revoke', async () => {
    await withStore(async (store) => {
      const claim = await store.writeClaim({
        subject: companion('purrs'),
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
        basis: 'explicit',
        confidence: 0.9,
        sources: [source({ sensitivityAtProjection: 'intimate' })],
        now: NOW,
      });
      expect((await store.getClaim(claim.id))?.effectiveSensitivity).toBe('intimate');

      const grant = await store.recordGrant({
        claimDigest: claim.claimDigest,
        sourceSetDigest: claim.sourceSetDigest,
        grantedSensitivity: 'public',
        authorizingActor: 'operator',
        authorityBasis: 'hitl-approval',
        reason: 'subject authorized sharing',
        now: NOW,
      });
      expect((await store.getClaim(claim.id))?.effectiveSensitivity).toBe('public');
      expect(await store.listGrantsForClaim(claim.id)).toHaveLength(1);

      await store.revokeGrant(grant.id, { reason: 'withdrawn', now: NOW });
      const reverted = await store.getClaim(claim.id);
      expect(reverted?.effectiveSensitivity).toBe('intimate');
      expect(reverted?.appliedGrantId).toBeUndefined();
    });
  });

  it('a mismatched-digest grant does not lower the claim', async () => {
    await withStore(async (store) => {
      const claim = await store.writeClaim({
        subject: companion('purrs'),
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Loaf', scope: 'self' },
        basis: 'explicit',
        confidence: 0.9,
        sources: [source({ sensitivityAtProjection: 'intimate' })],
        now: NOW,
      });
      await store.recordGrant({
        claimDigest: 'd'.repeat(64),
        sourceSetDigest: claim.sourceSetDigest,
        grantedSensitivity: 'public',
        authorizingActor: 'operator',
        authorityBasis: 'hitl-approval',
        reason: 'wrong digest',
        now: NOW,
      });
      expect((await store.getClaim(claim.id))?.effectiveSensitivity).toBe('intimate');
    });
  });
});

describe('PostgresBiographicalProfileStore — persistence across restart', () => {
  it('survives dropping the store instance and recreating on the same pool', async () => {
    await withStore(async (_store, pool) => {
      const first = await createPostgresBiographicalProfileStore(pool);
      const claim = await first.writeClaim({
        subject: companion('purrs'),
        kind: 'name',
        value: { kind: 'name', name: 'Purrsephone', role: 'primary' },
        basis: 'explicit',
        confidence: 1,
        sources: [source()],
        depthDecision: 'full',
        now: NOW,
      });
      // Simulate restart: a fresh store instance against the same database.
      const restarted = await createPostgresBiographicalProfileStore(pool);
      const reloaded = await restarted.getClaim(claim.id);
      expect(reloaded).toEqual(claim);
      expect(reloaded?.depthDecision).toBe('full');
    });
  });
});

describe('PostgresBiographicalProfileStore — parity with in-memory adapter', () => {
  it('produces identical claims, digests, and effective sensitivity for the same input', async () => {
    await withStore(async (pgStore) => {
      const memStore = new InMemoryBiographicalProfileStore();
      const input = {
        subject: contact('v'),
        kind: 'relationship' as const,
        relatedSubject: companion('purrs'),
        value: { kind: 'relationship' as const, relationshipType: 'Husband' },
        basis: 'explicit' as const,
        proposedSensitivity: 'personal' as const,
        confidence: 0.95,
        sources: [source({ sensitivityAtProjection: 'intimate' as const })],
        validFrom: '2026-01-01T00:00:00.000Z',
        depthDecision: 'developing' as const,
        now: NOW,
      };
      const pgClaim = await pgStore.writeClaim(input);
      const memClaim = await memStore.writeClaim(input);
      // IDs are random; compare everything else.
      const { id: _pgId, ...pgRest } = pgClaim;
      const { id: _memId, ...memRest } = memClaim;
      void _pgId;
      void _memId;
      expect(pgRest).toEqual(memRest);
      expect(pgClaim.claimDigest).toBe(memClaim.claimDigest);
      expect(pgClaim.sourceSetDigest).toBe(memClaim.sourceSetDigest);
      expect(pgClaim.effectiveSensitivity).toBe(memClaim.effectiveSensitivity);
    });
  });
});
