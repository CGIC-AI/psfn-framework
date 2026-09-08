// ── Cross-channel biographical privacy and continuity conformance (o61vb.10) ──
//
// This feature crosses identity, memory, participant selection, trust,
// persistence, prompt assembly and egress, so its publication evidence is one
// exact-head matrix rather than per-seam unit tests. Everything here runs
// against real Postgres, with two companions sharing one database, so
// "companion A never sees companion B's silo" is proven by the storage layer
// rather than asserted by a stub.
//
// What each row proves is stated where it is asserted. The matrix deliberately
// does not re-prove kernel-level rules that already have focused coverage; it
// proves the composition: what actually reaches a prompt, in which room, for
// which audience, and what survives a restart and a whole-database restore.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';

import { createPostgresPool } from '../../../persistence/postgres.js';
import { runBackupCycle } from '../../../persistence/backups/service.js';
import { verifyPostgresDumpRestore } from '../../../persistence/backups/postgres-restore.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import {
  createDmConversationScope,
  createGroupConversationScope,
  type ConversationScope,
} from '../../../core/session/conversation-scope.js';
import type { ContextEnvelope } from '../../../system/trust/context-envelope.js';
import { AdminBiographicalReviewService } from '../../../operator/garden/services/biographical-review-service.js';
import { createBiographicalAliasResolver } from './alias-address.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import {
  createPostgresBiographicalProfileStore,
  PostgresBiographicalProfileStore,
} from './postgres-store.js';
import {
  projectBiographicalContext,
  type BiographicalProjectionResult,
  type BiographicalSourceRevalidator,
  type SourceRevalidationOutcome,
} from './projection.js';
import { recordCompanionPublicationChoice } from './publication.js';
import { createDefaultBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type {
  BiographicalClaim,
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');
const INTEGRATION_TIMEOUT_MS = 90_000;

/** Two companions and three humans, sharing one database. */
const PURRS: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'purrs',
  subjectVersion: 1,
};
const SAGE: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'sage',
  subjectVersion: 1,
};
const PARTNER: BiographicalSubjectRef = { kind: 'contact', contactId: 'v', subjectVersion: 1 };
const BYSTANDER: BiographicalSubjectRef = { kind: 'contact', contactId: 'eve', subjectVersion: 1 };

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
});

function envelope(channelPrivacy: ContextEnvelope['channelPrivacy']): ContextEnvelope {
  return { channelPrivacy, audienceScope: 'few', audienceKnowledge: 'all_known', broadcast: false };
}

function publicGroup(channelId = 'discord:group:public'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('public') });
}
function inviteOnlyGroup(channelId = 'discord:group:invite'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('invite_only') });
}
function privateGroup(channelId = 'discord:group:private'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('private') });
}
function partnerDm(channelId = 'discord:dm:v'): ConversationScope {
  return createDmConversationScope({
    channelId,
    contact: { contactId: 'v' },
    envelope: envelope('private'),
  });
}

function source(
  ref: string,
  overrides: Partial<BiographicalClaimSource> = {},
): BiographicalClaimSource {
  return {
    ref,
    revision: '2026-08-10T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'discord:dm:v',
    ...overrides,
  };
}

/**
 * A revalidator whose live view can be edited mid-test, which is how source
 * deletion, digest drift and consent change are exercised without reaching into
 * the store's own rows.
 */
class LiveSources implements BiographicalSourceRevalidator {
  private readonly live = new Map<string, BiographicalClaimSource>();

  seed(sources: readonly BiographicalClaimSource[]): this {
    for (const item of sources) this.live.set(item.ref, item);
    return this;
  }

  drift(ref: string, overrides: Partial<BiographicalClaimSource>): void {
    const current = this.live.get(ref);
    if (!current) throw new Error(`cannot drift an unseeded source: ${ref}`);
    this.live.set(ref, { ...current, ...overrides });
  }

  delete(ref: string): void {
    this.live.delete(ref);
  }

  async revalidate(
    sources: readonly BiographicalClaimSource[],
  ): Promise<SourceRevalidationOutcome> {
    const currentSources: BiographicalClaimSource[] = [];
    for (const item of sources) {
      const current = this.live.get(item.ref);
      if (current === undefined) {
        return { status: 'invalid', reason: 'missing', sourceRef: item.ref };
      }
      currentSources.push(current);
    }
    return { status: 'valid', currentSources };
  }
}

async function withDatabase<T>(
  operation: (pool: Pool, databaseUrl: string) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-biographical-conformance',
    allowExitOnIdle: true,
    max: 3,
  });
  try {
    return await operation(pool, database.databaseUrl);
  } finally {
    await pool.end();
  }
}

interface Fixture {
  readonly store: PostgresBiographicalProfileStore;
  readonly live: LiveSources;
  /** Companion self nickname, published by the companion → universal. */
  readonly published: BiographicalClaim;
  /** Relational nickname the partner uses → subject_present. */
  readonly relational: BiographicalClaim;
  /** Reviewed but never made portable → origin_only. */
  readonly originOnly: BiographicalClaim;
  /** Intimate-source claim: never portable at any scope. */
  readonly intimate: BiographicalClaim;
  /** Confidential-source claim about the partner. */
  readonly confidential: BiographicalClaim;
  /** The other companion's own private self claim. */
  readonly foreign: BiographicalClaim;
}

/**
 * The shared fixture: one canonical relationship, four sensitivities, three
 * portability scopes, and a second companion's silo in the same database.
 */
async function seedFixture(pool: Pool): Promise<Fixture> {
  const store = await createPostgresBiographicalProfileStore(pool);
  const live = new LiveSources();

  const publish = async (claim: BiographicalClaim) => {
    await recordCompanionPublicationChoice({
      store,
      choice: { claimId: claim.id, reason: 'safe recognition across rooms', now: NOW },
    });
    return (await store.getClaim(claim.id))!;
  };

  const publishedSource = source('memory:self-nickname', { sensitivityAtProjection: 'personal' });
  live.seed([publishedSource]);
  const publishedDraft = await store.writeClaim({
    subject: PURRS,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
    basis: 'explicit',
    status: 'active',
    confidence: 1,
    sources: [publishedSource],
    now: NOW,
  });
  const published = await publish(publishedDraft);

  const relationalSource = source('memory:relational-nickname');
  live.seed([relationalSource]);
  const relational = await store.writeClaim({
    subject: PURRS,
    relatedSubject: PARTNER,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: 'Kitten', scope: 'relational' },
    basis: 'explicit',
    status: 'active',
    proposedSensitivity: 'public',
    portabilityScope: 'subject_present',
    confidence: 1,
    sources: [source('memory:relational-nickname', { sensitivityAtProjection: 'public' })],
    now: NOW,
  });
  live.seed(relational.sources);

  const originOnlySource = source('memory:origin-only', { sensitivityAtProjection: 'public' });
  live.seed([originOnlySource]);
  const originOnly = await store.writeClaim({
    subject: PURRS,
    relatedSubject: PARTNER,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: 'Only here', scope: 'relational' },
    basis: 'explicit',
    status: 'active',
    proposedSensitivity: 'public',
    confidence: 1,
    sources: [originOnlySource],
    now: NOW,
  });

  const intimateSource = source('memory:intimate', { sensitivityAtProjection: 'intimate' });
  live.seed([intimateSource]);
  const intimate = await store.writeClaim({
    subject: PURRS,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: 'Only in the dark', scope: 'self' },
    basis: 'observed',
    status: 'active',
    confidence: 1,
    sources: [intimateSource],
    now: NOW,
  });

  const confidentialSource = source('memory:confidential', {
    sensitivityAtProjection: 'confidential',
  });
  live.seed([confidentialSource]);
  const confidential = await store.writeClaim({
    subject: PARTNER,
    kind: 'stable-preference',
    value: {
      kind: 'stable-preference',
      schemaVersion: 1,
      domain: 'communication',
      target: 'the thing never said out loud',
      polarity: 'avoids',
    },
    basis: 'observed',
    status: 'active',
    confidence: 1,
    sources: [confidentialSource],
    now: NOW,
  });

  const foreignSource = source('memory:sage-self', { sensitivityAtProjection: 'personal' });
  live.seed([foreignSource]);
  const foreignDraft = await store.writeClaim({
    subject: SAGE,
    kind: 'nickname',
    value: { kind: 'nickname', nickname: 'Sage only', scope: 'self' },
    basis: 'explicit',
    status: 'active',
    confidence: 1,
    sources: [foreignSource],
    now: NOW,
  });
  const foreign = await publish(foreignDraft);

  return { store, live, published, relational, originOnly, intimate, confidential, foreign };
}

async function project(input: {
  store: PostgresBiographicalProfileStore;
  live: LiveSources;
  companionSubject: Extract<BiographicalSubjectRef, { kind: 'companion' }>;
  scope: ConversationScope;
  currentAuthor?: BiographicalSubjectRef;
  tokenBudget?: number;
}): Promise<BiographicalProjectionResult> {
  return await projectBiographicalContext(
    { store: input.store, revalidator: input.live, rebuildQueueMaxPending: 16 },
    {
      companionSubject: input.companionSubject,
      conversationScope: input.scope,
      ...(input.currentAuthor
        ? {
          currentAuthor: {
            status: 'verified' as const,
            subject: input.currentAuthor,
            trustLevel: 'primary' as const,
          },
        }
        : {}),
      ...(input.tokenBudget !== undefined
        ? { tokenBudget: input.tokenBudget, estimateTokens: (text: string) => text.length }
        : {}),
      now: NOW,
    },
  );
}

function withheldReasons(result: BiographicalProjectionResult, claimId: string): string[] {
  return result.withheld.filter(entry => entry.claimId === claimId).map(entry => entry.reason);
}

describe('cross-channel biographical conformance — recognition and non-disclosure', () => {
  it('recognizes across rooms without ever carrying a private silo out of it', async () => {
    await withDatabase(async pool => {
      const fx = await seedFixture(pool);
      const base = { store: fx.store, live: fx.live, companionSubject: PURRS };

      // 1. Published baseline identity travels: the same reviewed nickname is
      //    available in a public room, an invite-only room, and the DM, without
      //    the raw memory that produced it.
      for (const scope of [publicGroup(), inviteOnlyGroup(), partnerDm()]) {
        const result = await project({ ...base, scope, currentAuthor: PARTNER });
        expect(result.admittedClaimIds).toContain(fx.published.id);
        expect(result.promptSection).toContain('Sunbeam loaf');
        expect(result.promptSection).not.toContain('memory:');
      }

      // 2. A relationship-scoped claim renders only while the bound person is
      //    part of the turn, and is simply absent otherwise — the same room,
      //    the same claim, a different author. It is `personal`, so its room is
      //    an invite-only one: portability widens the audience, it never
      //    overrides the destination sensitivity gate.
      const withPartner = await project({
        ...base,
        scope: inviteOnlyGroup(),
        currentAuthor: PARTNER,
      });
      expect(withPartner.admittedClaimIds).toContain(fx.relational.id);
      const withBystander = await project({
        ...base,
        scope: inviteOnlyGroup(),
        currentAuthor: BYSTANDER,
      });
      // Stronger than "withheld": for a different author the claim is never a
      // candidate at all, so it is absent from the prompt AND from the withheld
      // ledger. Nothing about this relationship is loaded to be refused.
      expect(withBystander.admittedClaimIds).not.toContain(fx.relational.id);
      expect(withheldReasons(withBystander, fx.relational.id)).toEqual([]);
      expect(withBystander.promptSection).not.toContain('Kitten');

      // The `subject-not-present` gate is what stops a claim that IS selected —
      // a companion-subject claim naming the partner — from rendering to
      // someone else. Prove it directly, with the partner absent.
      const absentSubject = await project({ ...base, scope: inviteOnlyGroup() });
      expect(absentSubject.admittedClaimIds).not.toContain(fx.relational.id);
      expect(absentSubject.promptSection).not.toContain('Kitten');

      // 3. No ambient loading: a claim about a present-but-unaddressed contact
      //    never enters context merely because it exists.
      expect(withPartner.admittedClaimIds).not.toContain(fx.confidential.id);

      // 4. origin_only never enters portable projection anywhere, even in the
      //    room its sources came from — raw memory already serves that room.
      for (const scope of [publicGroup(), inviteOnlyGroup(), partnerDm()]) {
        const result = await project({ ...base, scope, currentAuthor: PARTNER });
        expect(result.admittedClaimIds).not.toContain(fx.originOnly.id);
        expect(result.promptSection).not.toContain('Only here');
      }
      // Where it IS selected — a group turn with its bound person present — the
      // refusal is the portability gate itself, named as such.
      expect(withheldReasons(
        await project({ ...base, scope: inviteOnlyGroup(), currentAuthor: PARTNER }),
        fx.originOnly.id,
      )).toEqual(['portability-origin-only']);

      // 5. Intimate and confidential fixtures never cross into any destination,
      //    and never appear in any rendered text.
      for (const scope of [publicGroup(), inviteOnlyGroup(), partnerDm()]) {
        const result = await project({ ...base, scope, currentAuthor: PARTNER });
        for (const claim of [fx.intimate, fx.confidential]) {
          expect(result.admittedClaimIds).not.toContain(claim.id);
        }
        expect(result.promptSection).not.toContain('Only in the dark');
        expect(result.promptSection).not.toContain('never said out loud');
      }

      // 6. A private group is the private sink: nothing projects outward there.
      const privateResult = await project({
        ...base,
        scope: privateGroup(),
        currentAuthor: PARTNER,
      });
      expect(privateResult.admittedClaimIds).toEqual([]);
      expect(privateResult.promptSection).toBe('');

      // 7. Multi-companion isolation on one database: companion A's turn never
      //    yields companion B's claims, and vice versa.
      expect(withPartner.admittedClaimIds).not.toContain(fx.foreign.id);
      const sageTurn = await project({
        store: fx.store,
        live: fx.live,
        companionSubject: SAGE,
        scope: publicGroup(),
        currentAuthor: PARTNER,
      });
      expect(sageTurn.admittedClaimIds).toEqual([fx.foreign.id]);
      expect(sageTurn.promptSection).not.toContain('Sunbeam loaf');

      // 8. Every rendered claim carries its own CogSec disclosure contribution,
      //    produced atomically with the prompt section: 1:1, no orphan either way.
      expect(withPartner.disclosureSources.map(entry => entry.ref).sort())
        .toEqual(withPartner.admittedClaimIds.map(id => `biographical:${id}`).sort());
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('withholds atomically on source deletion, digest drift and consent change', async () => {
    await withDatabase(async pool => {
      const fx = await seedFixture(pool);
      const base = {
        store: fx.store,
        live: fx.live,
        companionSubject: PURRS,
        scope: publicGroup(),
        currentAuthor: PARTNER,
      };
      expect((await project(base)).admittedClaimIds).toContain(fx.published.id);

      // Consent change is source-set drift: the bound publication grant no
      // longer matches, so the claim reverts and is withheld immediately.
      fx.live.drift('memory:self-nickname', { consentFingerprint: 'b'.repeat(64) });
      const drifted = await project(base);
      expect(drifted.admittedClaimIds).not.toContain(fx.published.id);
      expect(withheldReasons(drifted, fx.published.id)).toEqual(['source-drift']);
      // Drift is durably queued for audited rebuild rather than silently lost.
      expect(await fx.store.listRebuilds({
        claimId: fx.published.id,
        status: 'pending',
        limit: 10,
      })).not.toHaveLength(0);

      // A source whose sensitivity rises above the portable ceiling is withheld
      // even though the claim itself was never edited.
      const inviteRoom = { ...base, scope: inviteOnlyGroup() };
      expect((await project(inviteRoom)).admittedClaimIds).toContain(fx.relational.id);
      fx.live.drift('memory:relational-nickname', { sensitivityAtProjection: 'intimate' });
      const raised = await project(inviteRoom);
      expect(raised.admittedClaimIds).not.toContain(fx.relational.id);
      expect(raised.promptSection).not.toContain('Kitten');

      // A vanished source fails closed on the very next turn.
      fx.live.delete('memory:relational-nickname');
      const deleted = await project(inviteRoom);
      expect(deleted.admittedClaimIds).not.toContain(fx.relational.id);
      expect(withheldReasons(deleted, fx.relational.id)).toEqual(['source-invalid']);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps the projection bounded and identical across a restart and a restore', async () => {
    if (!harness) throw new Error('PostgreSQL integration harness is not available');
    const root = mkdtempSync(join(tmpdir(), 'psfn-biography-conformance-'));
    try {
      await withDatabase(async (pool, databaseUrl) => {
        const fx = await seedFixture(pool);
        const base = {
          store: fx.store,
          live: fx.live,
          companionSubject: PURRS,
          scope: publicGroup(),
          currentAuthor: PARTNER,
        };
        const before = await project(base);
        expect(before.admittedClaimIds.length).toBeGreaterThan(0);

        // Prompt economy: with a budget below the rendered size, the lowest
        // priority claims are deterministically trimmed and reported, and the
        // disclosure contributions shrink with them rather than going stale.
        const budgeted = await project({ ...base, tokenBudget: 1 });
        expect(budgeted.admittedClaimIds).toEqual([]);
        expect(budgeted.withheld.some(entry => entry.reason === 'token-budget-exhausted'))
          .toBe(true);
        expect(budgeted.disclosureSources).toEqual([]);

        // Restart: a brand-new store instance over the same database projects
        // exactly the same claims, in the same order, with the same withheld
        // reasons. Continuity is durable, not in-process.
        const restarted = new PostgresBiographicalProfileStore(pool, () => NOW);
        const after = await project({ ...base, store: restarted });
        expect(after.admittedClaimIds).toEqual(before.admittedClaimIds);
        expect(after.promptSection).toEqual(before.promptSection);
        expect(after.withheld.map(entry => `${entry.claimId}:${entry.reason}`))
          .toEqual(before.withheld.map(entry => `${entry.claimId}:${entry.reason}`));

        // Whole-database backup and restore round-trips every biography table,
        // including the new stage cursors.
        const backup = await runBackupCycle({
          postgres: {
            databaseUrl,
            pgDumpBinary: harness!.clientBinaries.pgDumpBinary,
            pgRestoreBinary: harness!.clientBinaries.pgRestoreBinary,
          },
          sessionsDir: join(root, 'sessions'),
          backupRootDir: join(root, 'backups'),
          maxRotatingBackups: 1,
          maxWeeklyBackups: 0,
          maxMonthlyBackups: 0,
          now: () => NOW.getTime(),
        });
        if (backup.postgresDumpPath === undefined) throw new Error('expected Postgres dump');
        const scratch = await harness!.createDatabase();
        const scratchPool = createPostgresPool(scratch.databaseUrl, {
          applicationName: 'psfn-biographical-conformance-restore',
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
          criticalTables: ['biographical_claims', 'biographical_grants'],
          psqlBinary: harness!.clientBinaries.psqlBinary,
          pgRestoreBinary: harness!.clientBinaries.pgRestoreBinary,
        });
        expect(verified.tableCounts).toEqual([
          { table: 'biographical_claims', restored: 6, source: 6 },
          { table: 'biographical_grants', restored: 2, source: 2 },
        ]);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('gates every stage transition on a receipt and shows it in Garden', async () => {
    await withDatabase(async pool => {
      const fx = await seedFixture(pool);
      const service = new AdminBiographicalReviewService({
        store: fx.store,
        queryLimit: 50,
        now: () => NOW,
      });

      // Garden shows reviewed portability and derivation on the queue. The
      // review surface deliberately shows the structured claim an operator is
      // deciding about; what it must never republish is the raw evidence, so
      // sources appear as refs, revisions and digests only.
      const listed = await service.listClaims();
      const relationalView = listed.claims.find(claim => claim.id === fx.relational.id);
      expect(relationalView).toMatchObject({
        portabilityScope: 'subject_present',
        derivation: 'human_derived',
      });
      for (const claim of listed.claims) {
        for (const viewSource of claim.sources) {
          expect(Object.keys(viewSource).sort()).toEqual([
            'consentFingerprint',
            'evidenceDigest',
            'ref',
            'revision',
            'sensitivityContribution',
            'sourceChannelId',
            'subjectEvidenceDigest',
          ]);
        }
      }

      // Tightening a live claim withdraws its reach immediately, on the very
      // next turn, with an append-only audit.
      await service.review(fx.published.id, {
        action: 'set-portability',
        claimDigest: fx.published.claimDigest,
        sourceSetDigest: fx.published.sourceSetDigest,
        portabilityScope: 'origin_only',
      }, { kind: 'operator', authorityRef: 'garden-standalone:operator' });
      const afterRevoke = await project({
        store: fx.store,
        live: fx.live,
        companionSubject: PURRS,
        scope: publicGroup(),
        currentAuthor: PARTNER,
      });
      expect(afterRevoke.admittedClaimIds).not.toContain(fx.published.id);
      expect(await fx.store.listReviewAudits(fx.published.id, 10)).toEqual([
        expect.objectContaining({ action: 'set-portability', reason: 'portability-set' }),
      ]);

      // An intimate claim can never be granted portability, whoever asks.
      await expect(service.review(fx.intimate.id, {
        action: 'set-portability',
        claimDigest: fx.intimate.claimDigest,
        sourceSetDigest: fx.intimate.sourceSetDigest,
        portabilityScope: 'universal',
      }, { kind: 'operator', authorityRef: 'garden-standalone:operator' }))
        .rejects.toMatchObject({ reason: 'portability-refused' });

      // A staged candidate reaches the prompt only through the whole receipt
      // chain: automata → companion → human. Every shortcut fails closed.
      const operator = { kind: 'operator' as const, authorityRef: 'garden-standalone:operator' };
      const staged = await fx.store.writeCandidate({
        automataRunId: 'biography-synthesis:conformance',
        automataAuthorityRef: 'maintenance:biography-synthesis',
        policy: createDefaultBiographicalCandidatePolicy(),
        socialContext: { kind: 'companion_self', companionId: 'purrs' },
        rationale: 'new_subject_claim',
        claim: {
          subject: PURRS,
          kind: 'nickname',
          value: { kind: 'nickname', nickname: 'Staged sprout', scope: 'self' },
          basis: 'explicit',
          confidence: 1,
          sources: [source('memory:staged', {
            sensitivityAtProjection: 'public',
            sourceType: 'semantic',
            lifecycleStateAtProjection: 'active',
          })],
          now: NOW,
        },
      });
      fx.live.seed([source('memory:staged', { sensitivityAtProjection: 'public' })]);
      const stagedClaim = (await fx.store.getClaim(staged.claimId))!;
      const stagedDigests = {
        claimDigest: stagedClaim.claimDigest,
        sourceSetDigest: stagedClaim.sourceSetDigest,
      };

      // The claim-only approval cannot bypass companion review.
      await expect(service.review(stagedClaim.id, { action: 'approve', ...stagedDigests }, operator))
        .rejects.toMatchObject({ reason: 'invalid-state' });
      // Nor can a human decide a candidate the companion has not forwarded.
      await expect(service.review(stagedClaim.id, {
        action: 'stage-approve',
        ...stagedDigests,
        candidateRevision: staged.revision,
        portabilityScope: 'universal',
      }, operator)).rejects.toMatchObject({ reason: 'invalid-state' });

      const reviewed = await fx.store.transitionCandidate({
        candidateId: staged.id,
        expectedRevision: staged.revision,
        to: 'companion_review',
        receipts: [{
          authority: 'companion',
          decision: 'approved',
          actorAuthorityRef: 'companion:purrs',
          reason: 'reviewer_approved',
        }],
        now: NOW,
      });
      const forwarded = await fx.store.transitionCandidate({
        candidateId: reviewed.id,
        expectedRevision: reviewed.revision,
        to: 'human_review',
        receipts: [{
          authority: 'companion',
          decision: 'approved',
          actorAuthorityRef: 'companion:purrs',
          reason: 'reviewer_approved',
        }],
        now: NOW,
      });
      // Still not projectable: activation is the human's decision. The room is
      // invite-only because the staged claim is `personal` — scope decides how
      // far a claim travels, never whether it clears the destination gate.
      const stagedTurn = {
        store: fx.store,
        live: fx.live,
        companionSubject: PURRS,
        scope: inviteOnlyGroup(),
        currentAuthor: PARTNER,
      };
      expect((await project(stagedTurn)).promptSection).not.toContain('Staged sprout');

      await service.review(stagedClaim.id, {
        action: 'stage-approve',
        ...stagedDigests,
        candidateRevision: forwarded.revision,
        portabilityScope: 'universal',
      }, operator);
      const activated = await project(stagedTurn);
      expect(activated.promptSection).toContain('Staged sprout');
      expect(activated.disclosureSources.map(entry => entry.ref))
        .toContain(`biographical:${stagedClaim.id}`);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('offers a reviewed alias as address only to the relationship that holds it', async () => {
    await withDatabase(async pool => {
      const fx = await seedFixture(pool);
      const contacts = {
        getByChannelIdentity: async (_source: string, participantId: string) => (
          participantId === 'discord-v'
            ? { id: 'v' }
            : participantId === 'discord-eve'
              ? { id: 'eve' }
              : undefined
        ),
      } as unknown as ContactStorePort;
      const resolver = createBiographicalAliasResolver({
        store: fx.store,
        contactStore: contacts,
        revalidator: fx.live,
        companionSubject: PURRS,
        minAliasLength: 3,
        now: () => NOW,
      });

      // The partner may address the companion by both the published baseline
      // name and the nickname their own relationship established.
      expect((await resolver.resolve({
        source: 'discord',
        transportParticipantId: 'discord-v',
      })).sort()).toEqual(['Kitten', 'Sunbeam loaf']);

      // A bystander gets only the published baseline name. The private
      // nickname is not merely unmatched — it is not returned at all, so no
      // downstream code path can reveal that it exists.
      expect(await resolver.resolve({
        source: 'discord',
        transportParticipantId: 'discord-eve',
      })).toEqual(['Sunbeam loaf']);

      // Withdrawing the companion's publication choice withdraws the alias too.
      await fx.store.setClaimPortability({
        claimId: fx.published.id,
        portabilityScope: 'origin_only',
        now: NOW,
      });
      expect(await resolver.resolve({
        source: 'discord',
        transportParticipantId: 'discord-eve',
      })).toEqual([]);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
