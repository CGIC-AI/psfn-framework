import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPostgresPool } from '../../../persistence/postgres.js';
import { runBackupCycle } from '../../../persistence/backups/service.js';
import { verifyPostgresDumpRestore } from '../../../persistence/backups/postgres-restore.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import { admitBiographicalCandidate } from './conflict-policy.js';
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
  operation: (
    store: PostgresBiographicalProfileStore,
    pool: Pool,
    databaseUrl: string,
  ) => Promise<T>,
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
    return await operation(store, pool, database.databaseUrl);
  } finally {
    await pool.end();
  }
}

describe('PostgresBiographicalProfileStore — schema and roundtrip', () => {
  it('serializes concurrent eager migrations with the advisory lock', async () => {
    await withStore(async (_store, pool) => {
      const stores = await Promise.all([
        createPostgresBiographicalProfileStore(pool),
        createPostgresBiographicalProfileStore(pool),
      ]);
      expect(stores).toHaveLength(2);
    });
  });

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
  it('re-tightens an expired grant when a claim is read', async () => {
    await withStore(async (_store, pool) => {
      let readAt = NOW;
      const store = new PostgresBiographicalProfileStore(pool, () => readAt);
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
        claimDigest: claim.claimDigest,
        sourceSetDigest: claim.sourceSetDigest,
        grantedSensitivity: 'public',
        authorizingActor: 'operator',
        authorityBasis: 'hitl-approval',
        reason: 'bounded approval',
        expiresAt: '2026-08-09T12:30:00.000Z',
        now: NOW,
      });
      expect((await store.getClaim(claim.id))?.effectiveSensitivity).toBe('public');

      readAt = new Date('2026-08-09T13:00:00.000Z');
      const expired = await store.getClaim(claim.id);
      expect(expired?.effectiveSensitivity).toBe('intimate');
      expect(expired?.appliedGrantId).toBeUndefined();
    });
  });

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
  it('preserves claim, grant, rebuild queue, and completion history across restarts', async () => {
    await withStore(async (_store, pool) => {
      const first = await createPostgresBiographicalProfileStore(pool);
      const claim = await first.writeClaim({
        subject: companion('purrs'),
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
        basis: 'explicit',
        status: 'active',
        confidence: 1,
        sources: [source({ sensitivityAtProjection: 'intimate' })],
        depthDecision: 'full',
        now: NOW,
      });
      const grant = await first.recordGrant({
        claimDigest: claim.claimDigest,
        sourceSetDigest: claim.sourceSetDigest,
        grantedSensitivity: 'public',
        authorizingActor: 'operator',
        authorityBasis: 'subject-choice',
        reason: 'portable publication choice',
        now: NOW,
      });
      const queued = await first.enqueueRebuild({
        claim,
        reason: 'consent-drift',
        sourceRef: 'memory:m-1',
        maxPending: 4,
        now: NOW,
      });
      if (queued.request === undefined) throw new Error('expected queued rebuild');
      const audit = await first.recordReviewAudit({
        claimId: claim.id,
        claimDigest: claim.claimDigest,
        sourceSetDigest: claim.sourceSetDigest,
        action: 'regrant',
        decision: 'allowed',
        reason: 'grant-recorded',
        actorAuthorityRef: 'garden-fleet:event-1',
        grantId: grant.id,
        grantedSensitivity: 'public',
        now: NOW,
      });
      // Simulate restart: a fresh store instance against the same database.
      const restarted = await createPostgresBiographicalProfileStore(pool);
      const reloaded = await restarted.getClaim(claim.id);
      expect(reloaded?.effectiveSensitivity).toBe('public');
      expect(await restarted.getGrant(grant.id)).toMatchObject({ id: grant.id });
      expect(await restarted.listRebuilds({ status: 'pending', limit: 4 })).toMatchObject([
        { id: queued.request.id, reason: 'consent-drift' },
      ]);
      expect(await restarted.listReviewAudits(claim.id, 4)).toMatchObject([{ id: audit.id }]);
      expect(reloaded?.depthDecision).toBe('full');

      await restarted.revokeGrant(grant.id, { reason: 'consent revoked', now: NOW });
      await restarted.completeRebuild(queued.request.id, 'invalidated', NOW);
      const restartedAgain = await createPostgresBiographicalProfileStore(pool);
      expect((await restartedAgain.getClaim(claim.id))?.effectiveSensitivity).toBe('intimate');
      expect(await restartedAgain.getGrant(grant.id)).toMatchObject({
        id: grant.id,
        revokedReason: 'consent revoked',
      });
      expect(await restartedAgain.listRebuilds({ status: 'completed', limit: 4 })).toMatchObject([
        { id: queued.request.id, completion: 'invalidated' },
      ]);
    });
  });
});

describe('PostgresBiographicalProfileStore — transactional conflict admission', () => {
  it('rolls callback writes back on interruption before a retry', async () => {
    await withStore(async store => {
      const subject = contact('rollback-v');
      const claimInput = {
        id: 'interrupted-claim',
        subject,
        kind: 'name' as const,
        value: { kind: 'name' as const, name: 'V', role: 'primary' as const },
        basis: 'explicit' as const,
        status: 'active' as const,
        confidence: 1,
        sources: [source({ ref: 'contact:rollback-v' })],
        now: NOW,
      };

      await expect(store.runClaimTransaction(subject, 'name', async transactionStore => {
        await transactionStore.writeClaim(claimInput);
        throw new Error('simulated interruption');
      })).rejects.toThrow('simulated interruption');
      expect(await store.listClaims({ subject, includeTerminal: true })).toEqual([]);

      await expect(store.runClaimTransaction(subject, 'name', async transactionStore =>
        await transactionStore.writeClaim(claimInput))).resolves.toMatchObject({
        id: 'interrupted-claim',
        status: 'active',
      });
    });
  });

  it('serializes simultaneous first admissions for the same empty conflict key', async () => {
    await withStore(async store => {
      const candidate = (polarity: 'likes' | 'dislikes', ref: string) => ({
        subject: contact('v'),
        kind: 'stable-preference' as const,
        value: {
          kind: 'stable-preference' as const,
          schemaVersion: 1 as const,
          domain: 'food' as const,
          target: 'tea',
          polarity,
        },
        basis: 'inferred' as const,
        confidence: 0.9,
        sources: [source({ ref })],
        now: NOW,
      });

      const results = await Promise.all([
        admitBiographicalCandidate({
          store,
          candidate: candidate('likes', 'memory:likes-tea'),
        }),
        admitBiographicalCandidate({
          store,
          candidate: candidate('dislikes', 'memory:dislikes-tea'),
        }),
      ]);

      expect(results.map(result => result.disposition).sort())
        .toEqual(['coexisting', 'contested']);
      expect(await store.listClaims({
        subject: contact('v'), kind: 'stable-preference', status: 'active',
      })).toEqual([]);
      expect(await store.listClaims({
        subject: contact('v'), kind: 'stable-preference', status: 'contested',
      })).toHaveLength(2);
    });
  });
});

describe('PostgresBiographicalProfileStore — canonical backup and restore', () => {
  it('restores claim, grant, and lifecycle queue rows through the whole-database backup path', async () => {
    await withStore(async (store, _pool, databaseUrl) => {
      if (harness === null) throw new Error('PostgreSQL integration harness is not available');
      const root = mkdtempSync(join(tmpdir(), 'psfn-biographical-backup-'));
      try {
        const claim = await store.writeClaim({
          subject: contact('v'),
          kind: 'name',
          value: { kind: 'name', name: 'V', role: 'primary' },
          basis: 'explicit',
          status: 'active',
          confidence: 1,
          sources: [source()],
          now: NOW,
        });
        await store.recordGrant({
          claimDigest: claim.claimDigest,
          sourceSetDigest: claim.sourceSetDigest,
          grantedSensitivity: 'public',
          authorizingActor: 'operator',
          authorityBasis: 'subject-choice',
          reason: 'portable publication choice',
          now: NOW,
        });
        await store.enqueueRebuild({
          claim,
          reason: 'revision-drift',
          sourceRef: 'memory:m-1',
          maxPending: 4,
          now: NOW,
        });
        await store.recordReviewAudit({
          claimId: claim.id,
          claimDigest: claim.claimDigest,
          sourceSetDigest: claim.sourceSetDigest,
          action: 'regrant',
          decision: 'allowed',
          reason: 'grant-recorded',
          actorAuthorityRef: 'garden-fleet:event-1',
          grantedSensitivity: 'public',
          now: NOW,
        });
        const backup = await runBackupCycle({
          postgres: {
            databaseUrl,
            pgDumpBinary: harness.clientBinaries.pgDumpBinary,
            pgRestoreBinary: harness.clientBinaries.pgRestoreBinary,
          },
          sessionsDir: join(root, 'sessions'),
          backupRootDir: join(root, 'backups'),
          maxRotatingBackups: 1,
          maxWeeklyBackups: 0,
          maxMonthlyBackups: 0,
          now: () => NOW.getTime(),
        });
        if (backup.postgresDumpPath === undefined) throw new Error('expected Postgres dump');
        const scratch = await harness.createDatabase();
        const scratchPool = createPostgresPool(scratch.databaseUrl, {
          applicationName: 'psfn-biographical-restore-verification',
          max: 1,
        });
        try {
          await scratchPool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
        } finally {
          await scratchPool.end();
        }
        const verified = await verifyPostgresDumpRestore({
          dumpPath: backup.postgresDumpPath,
          scratchDatabaseUrl: scratch.databaseUrl,
          sourceDatabaseUrl: databaseUrl,
          criticalTables: [
            'biographical_claims',
            'biographical_grants',
            'biographical_rebuild_queue',
            'biographical_review_audits',
          ],
          psqlBinary: harness.clientBinaries.psqlBinary,
          pgRestoreBinary: harness.clientBinaries.pgRestoreBinary,
        });
        expect(verified.tableCounts).toEqual([
          { table: 'biographical_claims', restored: 1, source: 1 },
          { table: 'biographical_grants', restored: 1, source: 1 },
          { table: 'biographical_rebuild_queue', restored: 1, source: 1 },
          { table: 'biographical_review_audits', restored: 1, source: 1 },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
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
