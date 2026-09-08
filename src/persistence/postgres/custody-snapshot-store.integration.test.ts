// Real-Postgres proof of the custody lane (psfn-framework-ccgdz.1): one folded
// disclosure lineage per turn is written record-first, survives a restart, is
// idempotent on its generation context, and never lets a body byte into a row.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
} from '../../core/cogsec/disclosure/decision.js';
import { DISCLOSURE_CLASSIFIER_VERSION } from '../../core/cogsec/disclosure/generation-lineage.js';
import { buildContextSourceManifest } from '../../core/cogsec/disclosure/context-source-manifest.js';
import { custodySha256 } from '../../core/cogsec/disclosure/custody-identity.js';
import {
  buildCustodySnapshot,
  custodySnapshotRefForTurn,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import type {
  DisclosureLineage,
  DisclosureSourceContribution,
} from '../../core/cogsec/disclosure/contracts.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresCustodySnapshotStore } from './custody-snapshot-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_custody_snapshots';
const RETENTION_DAYS = 90;
const NOW_MS = 1_800_000_000_000;
const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const OTHER_TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e60';
const REQUEST_ID = 'msg-01936f2c4a1b';
const SECRET_BODY = "my bank PIN is 4417\nsee /home/vega/private/notes.md";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

function lineageOf(
  turnId: string,
  sources: readonly DisclosureSourceContribution[],
  classifiedAtMs = NOW_MS,
): DisclosureLineage {
  let lineage = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(turnId),
    classifierVersion: DISCLOSURE_CLASSIFIER_VERSION,
    classifiedAt: new Date(classifiedAtMs).toISOString(),
  });
  for (const source of sources) lineage = accumulateDisclosureSource(lineage, source);
  return lineage;
}

const sessionSource: DisclosureSourceContribution = {
  ref: 'session:dm:contact-42',
  sensitivity: 'personal',
  permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-42'] }],
  subjectContactIds: ['contact-42'],
  sourceChannelId: 'discord:1234567890',
  classified: true,
};

const memorySource: DisclosureSourceContribution = {
  ref: 'memory:mem-7',
  sensitivity: 'intimate',
  permittedDestinations: [],
  classified: true,
};

describe('PostgresCustodySnapshotStore', () => {
  it('records one snapshot per generation context, idempotently, across a restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'custody-snapshot-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const snapshot = buildCustodySnapshot({
      lineage: lineageOf(TURN_ID, [sessionSource, memorySource]),
      turnId: TURN_ID,
      requestId: REQUEST_ID,
      toolResultEdges: new Map([['tool:wiki_read:call_1', {
        toolName: 'wiki_read',
        toolCallId: 'call_1',
        contentSha256: custodySha256('result bytes'),
      }]]),
    });

    let store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      schema: SCHEMA, now: () => NOW_MS,
    });
    try {
      expect(await store.record(snapshot)).toBe('recorded');
      // Re-recording the same fold is a no-op, not a second row.
      expect(await store.record(snapshot)).toBe('duplicate');
      expect(await store.getByGenerationContextRef(snapshot.generationContextRef))
        .toEqual(snapshot);

      // A turn with zero admitted sources still writes a snapshot recording
      // exactly that: the fail-closed fact is durable, not an absent row.
      const empty = buildCustodySnapshot({
        lineage: lineageOf(OTHER_TURN_ID, []),
        turnId: OTHER_TURN_ID,
        requestId: REQUEST_ID,
      });
      expect(await store.record(empty)).toBe('recorded');
      expect(await store.getByGenerationContextRef(empty.generationContextRef))
        .toMatchObject({ sourceCount: 0, sources: [] });
    } finally {
      await store.close();
    }

    // Restart: a new process, a new pool, the same durable custody record.
    store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      schema: SCHEMA, now: () => NOW_MS,
    });
    try {
      expect(await store.getByGenerationContextRef(`turn:${TURN_ID}`)).toEqual(snapshot);
      expect(await store.getByGenerationContextRef('turn:not-a-recorded-turn')).toBeNull();

      // A second, DIFFERENT fold of the same generation context (a recovered
      // turn that reconstructed a different admitted-source set) never
      // overwrites the fold that produced the delivered reply.
      const reFolded = buildCustodySnapshot({
        lineage: lineageOf(TURN_ID, [sessionSource], NOW_MS + 60_000),
        turnId: TURN_ID,
        requestId: REQUEST_ID,
      });
      expect(await store.record(reFolded)).toBe('diverged');
      expect(await store.getByGenerationContextRef(`turn:${TURN_ID}`)).toEqual(snapshot);

      // The same fold at a later instant is recognized as a replay, not a
      // divergence: only the source set is identity.
      const replayed = buildCustodySnapshot({
        lineage: lineageOf(TURN_ID, [sessionSource, memorySource], NOW_MS + 120_000),
        turnId: TURN_ID,
        requestId: REQUEST_ID,
        toolResultEdges: new Map([['tool:wiki_read:call_1', {
          toolName: 'wiki_read',
          toolCallId: 'call_1',
          contentSha256: custodySha256('result bytes'),
        }]]),
      });
      expect(await store.record(replayed)).toBe('duplicate');
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('keeps message bytes out of every column and refuses a tampered row', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      const snapshot = buildCustodySnapshot({
        lineage: lineageOf(TURN_ID, [{
          ref: `wiki:${SECRET_BODY}`,
          sensitivity: 'confidential',
          permittedDestinations: [],
          sourceChannelId: SECRET_BODY,
          classified: false,
        }]),
        turnId: TURN_ID,
        requestId: SECRET_BODY,
      });
      expect(await store.record(snapshot)).toBe('recorded');

      const readerPool = createPostgresPool(databaseUrl, {
        applicationName: 'custody-snapshot-reader', allowExitOnIdle: true,
      });
      const dump = await readerPool.query<{ row: string }>(
        'SELECT to_jsonb(custody_snapshots)::text AS row FROM custody_snapshots',
      );
      for (const { row } of dump.rows) {
        for (const fragment of ['bank PIN', '4417', '/home/vega/private']) {
          expect(row).not.toContain(fragment);
        }
      }

      // A row edited in the database is a load failure, not a quiet custody
      // claim: writing a body back into a ref id fails the read outright.
      await readerPool.query(
        `UPDATE custody_snapshots
         SET snapshot_json = jsonb_set(snapshot_json, '{sources,0,ref,id}', to_jsonb($2::text))
         WHERE generation_context_ref = $1`,
        [snapshot.generationContextRef, SECRET_BODY],
      );
      await readerPool.end();
      await expect(store.getByGenerationContextRef(snapshot.generationContextRef))
        .rejects.toThrow(/must be a bounded safe identifier/);
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('applies the operator-owned retention bound and refuses an undeclared one', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    await expect(PostgresCustodySnapshotStore.connect(databaseUrl, undefined))
      .rejects.toThrow(/custodySnapshotRetentionDays/);

    const store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      const stale = buildCustodySnapshot({
        lineage: lineageOf(
          TURN_ID,
          [sessionSource],
          NOW_MS - (RETENTION_DAYS + 1) * MILLISECONDS_PER_DAY,
        ),
        turnId: TURN_ID,
        requestId: REQUEST_ID,
      });
      const fresh = buildCustodySnapshot({
        lineage: lineageOf(OTHER_TURN_ID, [sessionSource]),
        turnId: OTHER_TURN_ID,
        requestId: REQUEST_ID,
      });
      // Retention runs before a write, never after it: a fresh row is never at
      // risk from the sweep that its own insert triggered.
      expect(await store.record(stale)).toBe('recorded');
      expect(await store.record(fresh)).toBe('recorded');

      expect(await store.pruneExpired()).toBe(1);
      expect(await store.getByGenerationContextRef(stale.generationContextRef)).toBeNull();
      expect(await store.getByGenerationContextRef(fresh.generationContextRef))
        .toEqual(fresh);
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);
}, TIMEOUT_MS);

// ── Context source manifest lane (psfn-framework-ccgdz.4) ──

describe('PostgresCustodySnapshotStore context source manifest', () => {
  function manifestFor(turnId: string, renderedText: string) {
    return buildContextSourceManifest({
      turnId,
      blocks: [
        {
          id: 'static_prefix',
          layer: 'prompt_stack',
          volatility: 'static',
          producer: 'identity.prompt-composer',
          tokensEst: 12,
          renderedText: 'You are a companion.',
        },
        {
          id: 'memory.retrieval',
          layer: 'session',
          volatility: 'turn',
          producer: 'session.context-builder',
          scopeKey: 'dm:contact-1',
          tokensEst: 34,
          renderedText,
          sources: [
            { kind: 'memory', refId: 'mem-1' },
            {
              kind: 'intake_envelope',
              refId: 'env_01JZ0000000000000000000001',
              envelopeId: 'env_01JZ0000000000000000000001',
              receiptId: 'rcpt_01JZ0000000000000000000001',
            },
          ],
        },
        {
          id: 'wiki.retrieval',
          layer: 'session',
          volatility: 'turn',
          producer: 'wiki.retrieval-service',
          tokensEst: 21,
          renderedText: 'wiki text',
          sources: [{ kind: 'wiki', refId: 'doc-1', contentSha256: custodySha256('admitted bytes') }],
        },
      ],
    });
  }

  it('records one manifest per generation context, idempotently, across a restart', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const manifest = manifestFor(TURN_ID, SECRET_BODY);

    let store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      expect(await store.recordContextManifest(manifest)).toBe('recorded');
      expect(await store.recordContextManifest(manifest)).toBe('duplicate');
      expect(await store.getContextManifestByGenerationContextRef(manifest.generationContextRef))
        .toEqual(manifest);
    } finally {
      await store.close();
    }

    store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      // The manifest ref on a TurnRecord resolves after a restart, which is
      // the whole point of replacing the synthesized display string.
      expect(await store.getContextManifestByGenerationContextRef(`turn:${TURN_ID}`))
        .toEqual(manifest);
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('keeps the first manifest and reports a different one as diverged', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const first = manifestFor(TURN_ID, 'first assembly');
    const second = manifestFor(TURN_ID, 'a re-assembly with different text');

    const store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      expect(await store.recordContextManifest(first)).toBe('recorded');
      expect(await store.recordContextManifest(second)).toBe('diverged');
      expect(await store.getContextManifestByGenerationContextRef(first.generationContextRef))
        .toEqual(first);
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('lets no body byte into the stored row', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => NOW_MS,
    });
    try {
      await store.recordContextManifest(manifestFor(TURN_ID, SECRET_BODY));
      const pool = createPostgresPool(databaseUrl, {
        applicationName: 'custody-manifest-assert', allowExitOnIdle: true,
      });
      try {
        const { rows } = await pool.query<{ row_text: string }>(
          'SELECT custody_context_manifests::text AS row_text FROM custody_context_manifests',
        );
        const rowText = rows.map(row => row.row_text).join('\n');
        expect(rowText).not.toContain('bank PIN');
        expect(rowText).not.toContain('4417');
        expect(rowText).not.toContain('/home/vega');
        expect(rowText).toContain(custodySha256(SECRET_BODY));
      } finally {
        await pool.end();
      }
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);

  it('expires the manifest on the same horizon as the snapshot beside it', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const staleNowMs = NOW_MS - (RETENTION_DAYS + 1) * MILLISECONDS_PER_DAY;
    let currentNowMs = staleNowMs;
    const store = await PostgresCustodySnapshotStore.connect(databaseUrl, RETENTION_DAYS, {
      now: () => currentNowMs,
    });
    try {
      await store.recordContextManifest(manifestFor(TURN_ID, 'stale assembly'));
      currentNowMs = NOW_MS;
      await store.recordContextManifest(manifestFor(OTHER_TURN_ID, 'fresh assembly'));
      await store.pruneExpired();
      expect(await store.getContextManifestByGenerationContextRef(`turn:${TURN_ID}`)).toBeNull();
      expect(await store.getContextManifestByGenerationContextRef(`turn:${OTHER_TURN_ID}`))
        .not.toBeNull();
    } finally {
      await store.close();
    }
  }, TIMEOUT_MS);
}, TIMEOUT_MS);
