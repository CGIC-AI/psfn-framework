import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPostgresPool } from '../../../persistence/postgres.js';
import { runBackupCycle } from '../../../persistence/backups/service.js';
import { verifyPostgresDumpRestore } from '../../../persistence/backups/postgres-restore.js';
import { createDefaultBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import { InMemoryMemoryStore } from '../../../test-support/in-memory-memory-store.js';
import type { PurrMemory } from '../types.js';
import { BiographySynthesisService } from './synthesis-service.js';
import { BiographyCompanionReviewService } from './companion-review-service.js';
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
const INTEGRATION_TIMEOUT_MS = 90_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

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

  it('preserves exact-revision candidate review across a store restart and activates only with receipts', async () => {
    await withStore(async (store, pool) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const created = await store.writeCandidate({
        automataRunId: 'automata-run-invented-postgres',
        automataAuthorityRef: 'automata:biography-synthesis',
        policy,
        claim: {
          id: 'claim-invented-postgres-candidate',
          subject: contact('contact-invented-postgres'),
          kind: 'role',
          value: {
            kind: 'role',
            schemaVersion: 1,
            roleType: 'creative',
            title: 'Illustrator',
          },
          basis: 'explicit',
          confidence: 0.9,
          sources: [source({
            sourceType: 'semantic',
            lifecycleStateAtProjection: 'active',
          })],
          validFrom: '2026-01-01T00:00:00.000Z',
          now: NOW,
        },
      });
      await store.transitionCandidate({
        candidateId: created.id,
        expectedRevision: 1,
        to: 'companion_review',
        receipts: [{
          authority: 'automata',
          decision: 'approved',
          actorAuthorityRef: 'automata:biography-synthesis',
        }],
        now: NOW,
      });

      const restarted = new PostgresBiographicalProfileStore(pool, () => NOW);
      const durable = await restarted.getCandidate(created.id);
      expect(durable).toMatchObject({ revision: 2, stage: 'companion_review' });
      expect((await restarted.getClaim(created.claimId))?.status).toBe('candidate');
      const humanReview = await restarted.transitionCandidate({
        candidateId: created.id,
        expectedRevision: 2,
        to: 'human_review',
        receipts: [{
          authority: 'companion',
          decision: 'approved',
          actorAuthorityRef: 'companion:invented-reviewer',
        }],
        now: NOW,
      });
      await restarted.transitionCandidate({
        candidateId: created.id,
        expectedRevision: humanReview.revision,
        to: 'active',
        receipts: [{
          authority: 'human',
          decision: 'approved',
          actorAuthorityRef: 'human:invented-reviewer',
        }],
        now: NOW,
      });
      expect((await restarted.getClaim(created.claimId))?.status).toBe('active');
    });
  });

  it('lists staged candidates by exact stage and digest, and survives a restart', async () => {
    await withStore(async (store, pool) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const socialContext = {
        kind: 'companion_contact_dyad',
        companionId: 'companion-invented-listing',
        contactId: 'contact-invented-listing',
      } as const;
      const stage = async (title: string, ref: string) => await store.writeCandidate({
        automataRunId: 'automata-run-invented-listing',
        automataAuthorityRef: 'maintenance:biography-synthesis',
        policy,
        socialContext,
        rationale: 'new_subject_claim',
        claim: {
          subject: contact('contact-invented-listing'),
          kind: 'role',
          value: { kind: 'role', schemaVersion: 1, roleType: 'creative', title },
          basis: 'explicit',
          confidence: 0.9,
          sources: [source({
            ref,
            sourceType: 'semantic',
            lifecycleStateAtProjection: 'active',
          })],
          validFrom: '2026-01-01T00:00:00.000Z',
          now: NOW,
        },
      });
      const first = await stage('Illustrator', 'memory:invented-listing-1');
      const second = await stage('Sound designer', 'memory:invented-listing-2');
      await store.transitionCandidate({
        candidateId: second.id,
        expectedRevision: 1,
        to: 'companion_review',
        receipts: [{
          authority: 'automata',
          decision: 'approved',
          actorAuthorityRef: 'automata:biography-synthesis',
          reason: 'synthesized',
        }],
        now: NOW,
      });

      // A fresh store instance proves the listing reads durable rows, not
      // process state, so a restarted synthesis pass sees its own prior work.
      const restarted = new PostgresBiographicalProfileStore(pool, () => NOW);
      const synthesisStage = await restarted.listCandidates({
        stages: ['automata_synthesis'],
        limit: 10,
      });
      expect(synthesisStage.map(record => record.id)).toEqual([first.id]);
      expect(synthesisStage[0]?.socialContext).toEqual(socialContext);
      expect(synthesisStage[0]?.rationale).toBe('new_subject_claim');
      expect(synthesisStage[0]?.receipts[0]?.reason).toBe('synthesized');

      const byDigest = await restarted.listCandidates({
        claimDigest: second.claimDigest,
        limit: 10,
      });
      expect(byDigest.map(record => record.stage)).toEqual(['companion_review']);
      expect(
        (await restarted.listCandidates({
          automataRunId: 'automata-run-invented-listing',
          limit: 10,
        })).length,
      ).toBe(2);
      await expect(
        restarted.listCandidates({ limit: 0 }),
      ).rejects.toThrow('positive safe integer');
      await expect(
        // @ts-expect-error an unknown stage filter must reject, not widen
        restarted.listCandidates({ stages: ['invented_stage'], limit: 10 }),
      ).rejects.toThrow('unknown biography candidate stage');
    });
  });

  it('refuses to stage a candidate whose source exceeds the owner privacy policy', async () => {
    await withStore(async (store) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const stageWith = async (overrides: Partial<BiographicalClaimSource>) =>
        await store.writeCandidate({
          automataRunId: 'automata-run-invented-privacy',
          automataAuthorityRef: 'maintenance:biography-synthesis',
          policy,
          claim: {
            subject: contact('contact-invented-privacy'),
            kind: 'role',
            value: {
              kind: 'role',
              schemaVersion: 1,
              roleType: 'creative',
              title: 'Illustrator',
            },
            basis: 'explicit',
            confidence: 0.9,
            sources: [source({
              sourceType: 'semantic',
              lifecycleStateAtProjection: 'active',
              ...overrides,
            })],
            validFrom: '2026-01-01T00:00:00.000Z',
            now: NOW,
          },
        });

      // A private silo's content can never become a portable candidate: the
      // persistence boundary re-applies owner policy even if a caller skipped
      // the pre-model filter, and nothing is written on refusal.
      await expect(stageWith({ sensitivityAtProjection: 'intimate' }))
        .rejects.toThrow('sensitivity exceeds owner policy');
      await expect(stageWith({ sourceType: 'emotional' }))
        .rejects.toThrow('source type is unknown or excluded');
      await expect(stageWith({ lifecycleStateAtProjection: 'quarantined' }))
        .rejects.toThrow('lifecycle is unknown or excluded');
      expect(await store.listCandidates({ limit: 10 })).toHaveLength(0);
      expect(await store.listClaims({ subject: contact('contact-invented-privacy') }))
        .toHaveLength(0);
    });
  });

  it('survives a restart mid companion review without duplicating a decision', async () => {
    await withStore(async (store, pool) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const companionId = 'companion-invented-review';
      const contactId = 'contact-invented-review';
      const staged = await store.writeCandidate({
        automataRunId: 'biography-synthesis:invented-review',
        automataAuthorityRef: 'maintenance:biography-synthesis',
        policy,
        socialContext: {
          kind: 'companion_contact_dyad',
          companionId,
          contactId,
        },
        rationale: 'new_subject_claim',
        claim: {
          subject: contact(contactId),
          kind: 'stable-preference',
          value: {
            kind: 'stable-preference',
            schemaVersion: 1,
            domain: 'communication',
            target: 'concise explanations',
            polarity: 'prefers',
          },
          basis: 'explicit',
          confidence: 0.9,
          sources: [source({
            ref: 'memory:invented-review-1',
            sourceType: 'semantic',
            lifecycleStateAtProjection: 'active',
          })],
          now: NOW,
        },
      });

      const review = (restarted: PostgresBiographicalProfileStore) =>
        new BiographyCompanionReviewService({
          profileStore: restarted,
          llmClient: {
            complete: async () => ({
              content: JSON.stringify({
                action: 'approve',
                reason: 'evidence_supports_claim',
              }),
              model: 'test-model',
              usage: { inputTokens: 0, outputTokens: 0 },
            }),
          } as unknown as LLMProviderPort,
          companionId,
          candidatePolicy: () => policy,
          now: () => NOW,
          newRunId: () => 'biography-review:invented-run',
        });

      const first = await review(store).run();
      expect(first).toMatchObject({ approved: 1, escalatedToHumanReview: 1, autoactivated: 0 });

      // A fresh store instance is a restart: the decision is already durable,
      // so the retried pass must neither re-decide nor append a second receipt.
      const restarted = new PostgresBiographicalProfileStore(pool, () => NOW);
      const durable = await restarted.getCandidate(staged.id);
      expect(durable?.stage).toBe('human_review');
      expect((await restarted.getClaim(staged.claimId))?.status).toBe('candidate');
      const receiptCount = durable?.receipts.length ?? 0;

      const retry = await review(restarted).run();
      // The candidate has left the companion-review stages entirely, so the
      // retried pass has nothing to consider and writes nothing.
      expect(retry).toMatchObject({ candidatesConsidered: 0, approved: 0 });
      const after = await restarted.getCandidate(staged.id);
      expect(after?.stage).toBe('human_review');
      expect(after?.revision).toBe(durable?.revision);
      expect(after?.receipts).toHaveLength(receiptCount);
      expect(after?.receipts.filter(receipt => receipt.authority === 'companion')).toHaveLength(2);
      expect(after?.socialContext).toMatchObject({ kind: 'companion_contact_dyad', contactId });
    });
  });

  it('rejects a wrong-companion review attempt against durable candidates', async () => {
    await withStore(async (store) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const staged = await store.writeCandidate({
        automataRunId: 'biography-synthesis:invented-wrong-companion',
        automataAuthorityRef: 'maintenance:biography-synthesis',
        policy,
        socialContext: {
          kind: 'companion_self',
          companionId: 'companion-invented-owner',
        },
        claim: {
          subject: companion('companion-invented-owner'),
          kind: 'nickname',
          value: { kind: 'nickname', nickname: 'Sparrow', scope: 'self' },
          basis: 'explicit',
          confidence: 0.9,
          sources: [source({
            ref: 'memory:invented-wrong-companion',
            sourceType: 'reflection',
            lifecycleStateAtProjection: 'active',
          })],
          now: NOW,
        },
      });

      const complete = vi.fn();
      const telemetry = await new BiographyCompanionReviewService({
        profileStore: store,
        llmClient: { complete } as unknown as LLMProviderPort,
        companionId: 'companion-invented-intruder',
        candidatePolicy: () => policy,
        now: () => NOW,
        newRunId: () => 'biography-review:invented-intruder',
      }).run();

      expect(telemetry).toMatchObject({ candidatesOutsideAuthority: 1, approved: 0 });
      // The other companion's proposal never reaches a prompt at all.
      expect(complete).not.toHaveBeenCalled();
      expect((await store.getCandidate(staged.id))?.stage).toBe('automata_synthesis');
    });
  });

  it('runs the whole synthesis pass against Postgres idempotently across a restart', async () => {
    await withStore(async (store, pool) => {
      const policy = createDefaultBiographicalCandidatePolicy();
      const contactId = 'contact-invented-service';
      const companionId = 'companion-invented-service';
      const memories = new InMemoryMemoryStore();
      const sourceMemory = (id: string, overrides: Partial<PurrMemory> = {}): PurrMemory => ({
        id,
        text: `Memory ${id}`,
        type: 'semantic',
        importance: 0.6,
        confidence: 0.9,
        emotionalValence: 0.1,
        salience: 0.4,
        sourceRef: 'test:biography-synthesis',
        extractedAt: 1_700_000_000_000,
        lastAccessed: 1_700_000_000_000,
        accessCount: 0,
        tags: [],
        sensitivity: 'personal',
        consentFlags: {},
        provenance: { subjectContactId: contactId },
        ...overrides,
      });
      memories.insertMemory(sourceMemory('memory-invented-service-1'));
      // An above-ceiling source in the same silo must never be staged.
      memories.insertMemory(sourceMemory('memory-invented-service-2', {
        sensitivity: 'intimate',
        text: 'SECRET-INTIMATE-BODY',
      }));

      const candidateJson = (sourceMemoryIds: readonly string[]) => JSON.stringify([{
        kind: 'stable-preference',
        value: {
          kind: 'stable-preference',
          schemaVersion: 1,
          domain: 'communication',
          target: 'concise explanations',
          polarity: 'prefers',
        },
        basis: 'explicit',
        confidence: 0.9,
        sourceMemoryIds: [...sourceMemoryIds],
      }]);
      const prompts: string[] = [];
      const synthesis = (
        current: PostgresBiographicalProfileStore,
        sourceMemoryIds: readonly string[],
        runId: string,
      ) => new BiographySynthesisService({
        memoryStore: memories.asPort(),
        profileStore: current,
        llmClient: {
          complete: async (request: { systemPrompt?: string }) => {
            prompts.push(request.systemPrompt ?? '');
            return {
              content:
                `<biographical_candidates>${candidateJson(sourceMemoryIds)}</biographical_candidates>`,
              model: 'test-model',
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        } as unknown as LLMProviderPort,
        promptRegistry: null,
        targets: {
          listTargets: async () => [{
            subject: contact(contactId) as Extract<BiographicalSubjectRef, { kind: 'contact' }>,
            socialContext: { kind: 'companion_contact_dyad', companionId, contactId },
            depth: 'full',
          }],
        },
        companionSubject: {
          kind: 'companion',
          companionId,
          subjectVersion: 1,
        },
        candidatePolicy: () => policy,
        depthPolicy: () => createDefaultBiographicalDepthPolicy(),
        now: () => NOW,
        newRunId: () => runId,
      });

      const first = await synthesis(store, ['memory-invented-service-1'], 'run-1').run();
      expect(first).toMatchObject({ candidatesStaged: 1, sourcesWithheldByPolicy: 1 });

      // A restart is a fresh store instance and a fresh run id. The durable row
      // written through the nested claim transaction must be found again, so
      // the identical proposal writes nothing the second time.
      const restarted = new PostgresBiographicalProfileStore(pool, () => NOW);
      const second = await synthesis(restarted, ['memory-invented-service-1'], 'run-2').run();
      expect(second).toMatchObject({ candidatesStaged: 0, candidatesDuplicate: 1 });
      expect(await restarted.listCandidates({ limit: 10 })).toHaveLength(1);

      // Drifted evidence for the same claim supersedes rather than accumulates.
      memories.insertMemory(sourceMemory('memory-invented-service-3'));
      const third = await synthesis(
        restarted,
        ['memory-invented-service-1', 'memory-invented-service-3'],
        'run-3',
      ).run();
      expect(third).toMatchObject({ candidatesStaged: 1, candidatesSuperseded: 1 });
      const durable = await restarted.listCandidates({ limit: 10 });
      expect(durable).toHaveLength(2);
      const open = durable.find(record => record.stage === 'automata_synthesis');
      const closed = durable.find(record => record.stage === 'superseded');
      expect(open?.supersedesCandidateId).toBe(closed?.id);
      expect(open?.socialContext).toMatchObject({ kind: 'companion_contact_dyad', contactId });

      // The private silo never entered a prompt or a persisted candidate.
      expect(prompts.join('\n')).not.toContain('SECRET-INTIMATE-BODY');
      for (const record of durable) {
        const claim = await restarted.getClaim(record.claimId);
        expect(claim?.sources.map(claimSource => claimSource.ref))
          .not.toContain('memory:memory-invented-service-2');
      }
      // Nothing this pass wrote is active: staging has no activation authority.
      expect(await restarted.listClaims({ status: 'active' })).toHaveLength(0);
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
        value: { kind: 'name' as const, name: 'Morgan', role: 'primary' as const },
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
      expect(await store.listClaims({ offset: 1, limit: 1 })).toEqual([]);
      await expect(store.listClaims({ limit: 0 })).rejects.toThrow('positive integer');
      await expect(store.listClaims({ offset: -1 })).rejects.toThrow('non-negative integer');
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
        value: { kind: 'name', name: 'Morgan', role: 'primary' },
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
        value: { kind: 'name' as const, name: 'Morgan', role: 'primary' as const },
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
          value: { kind: 'name', name: 'Morgan', role: 'primary' },
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
        await store.writeCandidate({
          automataRunId: 'automata-run-invented-backup',
          automataAuthorityRef: 'automata:biography-synthesis',
          policy: createDefaultBiographicalCandidatePolicy(),
          claim: {
            id: 'claim-invented-backup-candidate',
            subject: contact('contact-invented-backup'),
            kind: 'role',
            value: {
              kind: 'role',
              schemaVersion: 1,
              roleType: 'creative',
              title: 'Ceramicist',
            },
            basis: 'explicit',
            confidence: 0.9,
            sources: [source({
              ref: 'memory:invented-backup-candidate',
              sourceType: 'semantic',
              lifecycleStateAtProjection: 'active',
            })],
            validFrom: '2026-01-01T00:00:00.000Z',
            now: NOW,
          },
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
            'biographical_candidates',
            'biographical_grants',
            'biographical_rebuild_queue',
            'biographical_review_audits',
          ],
          psqlBinary: harness.clientBinaries.psqlBinary,
          pgRestoreBinary: harness.clientBinaries.pgRestoreBinary,
        });
        expect(verified.tableCounts).toEqual([
          { table: 'biographical_claims', restored: 2, source: 2 },
          { table: 'biographical_candidates', restored: 1, source: 1 },
          { table: 'biographical_grants', restored: 1, source: 1 },
          { table: 'biographical_rebuild_queue', restored: 1, source: 1 },
          { table: 'biographical_review_audits', restored: 1, source: 1 },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }, INTEGRATION_TIMEOUT_MS);
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
