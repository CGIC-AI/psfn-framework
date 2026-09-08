// Real-Postgres proof of the egress delivery lane (psfn-framework-ccgdz.6):
// a delivered reply is joinable to its custody snapshot AND to the inbound
// event that triggered it, a retried attempt is idempotent rather than
// rewritten, a held egress is durable with its typed reason, and no body byte
// can reach a column.

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
import {
  buildCustodySnapshot,
  custodySha256,
  custodySnapshotRefForTurn,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import { EgressDeliveryRecorder } from '../../core/cogsec/disclosure/egress-delivery-recorder.js';
import {
  egressContentSha256,
  turnEgressCustodyProof,
} from '../../core/cogsec/disclosure/egress-delivery-record.js';
import type {
  DisclosureLineage,
  DisclosureSourceContribution,
} from '../../core/cogsec/disclosure/contracts.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresCustodySnapshotStore } from './custody-snapshot-store.js';
import { PostgresEgressDeliveryRecordStore } from './egress-delivery-record-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_egress_delivery';
const RETENTION_DAYS = 90;
const NOW_MS = 1_800_000_000_000;
const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const COMPANION_A = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const COMPANION_B = '9a8b7c66-1d2e-4f3a-8b9c-0d1e2f3a4b5c';
const ROOM_CHANNEL = 'discord:guild-1:general';
const SOURCE_EVENT_ID = 'discord-message-1195551234567890';
const REPLY_TEXT = 'That trip to the coast was in March, I think.';
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

/** The memory- and episode-derived sources behind a recalled reply. */
const memoryDerivedSources: readonly DisclosureSourceContribution[] = [
  {
    ref: 'session:room:discord:guild-1:general',
    sensitivity: 'public',
    permittedDestinations: [{ kind: 'public_room', channelIds: [ROOM_CHANNEL] }],
    sourceChannelId: ROOM_CHANNEL,
    classified: true,
  },
  {
    ref: 'memory:mem-coast-trip',
    sensitivity: 'public',
    permittedDestinations: [{ kind: 'public_room', channelIds: [ROOM_CHANNEL] }],
    provenanceRefs: ['intake-envelope:8b70243e'],
    classified: true,
  },
  {
    ref: 'memory:episode-2026-03-coast',
    sensitivity: 'public',
    permittedDestinations: [{ kind: 'public_room', channelIds: [ROOM_CHANNEL] }],
    classified: true,
  },
];

function lineageOf(
  turnId: string,
  sources: readonly DisclosureSourceContribution[],
): DisclosureLineage {
  let lineage = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(turnId),
    classifierVersion: DISCLOSURE_CLASSIFIER_VERSION,
    classifiedAt: new Date(NOW_MS).toISOString(),
  });
  for (const source of sources) lineage = accumulateDisclosureSource(lineage, source);
  return lineage;
}

async function makeStores(databaseUrl: string) {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'egress-delivery-test', allowExitOnIdle: true, schema: SCHEMA,
  });
  return {
    pool,
    custody: await PostgresCustodySnapshotStore.fromPool(pool, RETENTION_DAYS, { now: () => NOW_MS }),
    deliveries: await PostgresEgressDeliveryRecordStore.fromPool(pool, RETENTION_DAYS, {
      now: () => NOW_MS,
    }),
  };
}

describe('PostgresEgressDeliveryRecordStore', () => {
  it('joins a delivered reply to its custody snapshot and its trigger event', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'egress-delivery-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const stores = await makeStores(databaseUrl);
    try {
      // The turn's memory/episode-derived context is recorded first...
      const lineage = lineageOf(TURN_ID, memoryDerivedSources);
      expect(await stores.custody.record(buildCustodySnapshot({
        lineage, turnId: TURN_ID, requestId: `egress-reply:${SOURCE_EVENT_ID}`,
      }))).toBe('recorded');

      // ...then the reply that was released on the strength of it.
      const recorder = new EgressDeliveryRecorder({
        store: stores.deliveries,
        companionId: COMPANION_A,
        getCogSecMode: () => 'boundary',
        now: () => NOW_MS,
      });
      const written = await recorder.record({
        surface: 'social_reply',
        disposition: 'released',
        turnId: TURN_ID,
        attemptRef: SOURCE_EVENT_ID,
        contentSha256: egressContentSha256(REPLY_TEXT),
        destination: { kind: 'public_room', channelId: ROOM_CHANNEL },
        proof: turnEgressCustodyProof(lineage, custodySnapshotRefForTurn(TURN_ID)),
        triggerEventRef: SOURCE_EVENT_ID,
        decisionAllowed: true,
      });
      expect(written.written).toBe(true);

      // Egress -> sources: the delivery names a snapshot that resolves, and the
      // snapshot names the memory and episode that contributed.
      const [delivery] = await stores.deliveries.listByGenerationContextRef(
        custodySnapshotRefForTurn(TURN_ID),
      );
      expect(delivery?.contentSha256).toBe(egressContentSha256(REPLY_TEXT));
      expect(delivery?.custodySnapshotRef).toBe(custodySnapshotRefForTurn(TURN_ID));
      const snapshot = await stores.custody.getByGenerationContextRef(
        delivery?.custodySnapshotRef ?? '',
      );
      expect(snapshot?.sources.map(source => source.kind))
        .toEqual(['session', 'memory', 'memory']);
      expect(snapshot?.sourceCount).toBe(3);

      // Egress -> inbound event: the trigger digest is the durable join back to
      // the room message that caused the reply.
      expect(delivery?.triggerEventRef?.digest).toBe(custodySha256(SOURCE_EVENT_ID));
      // ...and the same digest is the request identity the turn ran under.
      expect(snapshot?.requestId.digest)
        .toBe(custodySha256(`egress-reply:${SOURCE_EVENT_ID}`));
    } finally {
      await stores.deliveries.close();
      await stores.custody.close();
      await stores.pool.end();
    }
  }, TIMEOUT_MS);

  it('keeps a retried attempt idempotent and separates a turn\'s several egresses', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'egress-delivery-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const stores = await makeStores(databaseUrl);
    try {
      const lineage = lineageOf(TURN_ID, memoryDerivedSources);
      const proof = turnEgressCustodyProof(lineage, custodySnapshotRefForTurn(TURN_ID));
      const request = {
        surface: 'tool_egress' as const,
        disposition: 'released' as const,
        turnId: TURN_ID,
        attemptRef: 'tool-call-1',
        contentSha256: egressContentSha256(REPLY_TEXT),
        destination: { kind: 'public_room' as const, channelId: ROOM_CHANNEL },
        proof,
        decisionAllowed: true,
      };
      const recorder = new EgressDeliveryRecorder({
        store: stores.deliveries, getCogSecMode: () => 'boundary', now: () => NOW_MS,
      });
      const built = (await recorder.record(request)).record;
      if (!built) throw new Error('expected the first attempt to build a record');
      expect(await stores.deliveries.record(built)).toBe('duplicate');

      // Re-recording the same attempt at a LATER instant is still a duplicate,
      // not a divergence: the decision the bytes left under is unchanged, and
      // the stored row is not rewritten by the retry.
      const laterRecorder = new EgressDeliveryRecorder({
        store: stores.deliveries, getCogSecMode: () => 'boundary', now: () => NOW_MS + 60_000,
      });
      const retried = (await laterRecorder.record(request)).record;
      if (!retried) throw new Error('expected the retry to build a record');
      expect(await stores.deliveries.record(retried)).toBe('duplicate');
      expect((await stores.deliveries.getByDeliveryRef(built.deliveryRef))?.recordedAtMs)
        .toBe(NOW_MS);

      // A second tool call in the same turn is a separate row under one turn.
      expect((await laterRecorder.record({ ...request, attemptRef: 'tool-call-2' })).written)
        .toBe(true);
      const rows = await stores.deliveries.listByGenerationContextRef(
        custodySnapshotRefForTurn(TURN_ID),
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map(row => row.attempt.digest)).size).toBe(2);
      expect(rows.every(row => row.generationContextRef === custodySnapshotRefForTurn(TURN_ID)))
        .toBe(true);
    } finally {
      await stores.deliveries.close();
      await stores.custody.close();
      await stores.pool.end();
    }
  }, TIMEOUT_MS);

  it('stores a hold durably, scopes rows by companion, and admits no body text', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'egress-delivery-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const stores = await makeStores(databaseUrl);
    try {
      // A turn whose fold admitted nothing: held, with the reason durable.
      const empty = lineageOf(TURN_ID, []);
      const recorderA = new EgressDeliveryRecorder({
        store: stores.deliveries,
        companionId: COMPANION_A,
        getCogSecMode: () => 'boundary',
        now: () => NOW_MS,
      });
      await recorderA.record({
        surface: 'social_reply',
        disposition: 'held',
        turnId: TURN_ID,
        // The attempt reference and the destination both carry a secret here on
        // purpose: nothing about them may survive into a column in the clear.
        attemptRef: SECRET_BODY,
        contentSha256: egressContentSha256(SECRET_BODY),
        destination: { kind: 'contact_dm', contactId: SECRET_BODY },
        proof: turnEgressCustodyProof(empty, custodySnapshotRefForTurn(TURN_ID)),
        holdReason: 'no_admitted_source',
        decisionAllowed: false,
      });

      // The same turn id and attempt for a DIFFERENT companion is a distinct
      // ledger; ownership is what separates them.
      const recorderB = new EgressDeliveryRecorder({
        store: stores.deliveries,
        companionId: COMPANION_B,
        getCogSecMode: () => 'boundary',
        now: () => NOW_MS,
      });
      const collision = await recorderB.record({
        surface: 'social_reply',
        disposition: 'held',
        turnId: TURN_ID,
        attemptRef: SECRET_BODY,
        contentSha256: egressContentSha256(SECRET_BODY),
        destination: { kind: 'contact_dm', contactId: SECRET_BODY },
        proof: turnEgressCustodyProof(empty, custodySnapshotRefForTurn(TURN_ID)),
        holdReason: 'no_admitted_source',
        decisionAllowed: false,
      });
      // The delivery key is the turn plus the attempt, so a second owner writing
      // the same key does NOT overwrite the first companion's record: the store
      // keeps the standing row and the recorder surfaces the divergence.
      expect(collision.written).toBe(true);
      const stored = await stores.deliveries.listByGenerationContextRef(
        custodySnapshotRefForTurn(TURN_ID),
      );
      expect(stored).toHaveLength(1);
      expect(stored[0]?.owner).toEqual({ kind: 'companion', companionId: COMPANION_A });
      expect(stored[0]?.disposition).toBe('held');
      expect(stored[0]?.holdReason).toBe('no_admitted_source');

      // Content-free floor: not a fragment of the secret reaches any column.
      const dump = await stores.pool.query<{ row: string }>(
        `SELECT to_jsonb(t)::text AS row FROM ${SCHEMA}.egress_delivery_records t`,
      );
      const serialized = dump.rows.map(row => row.row).join('\n');
      for (const fragment of ['bank', 'PIN', '4417', 'notes.md', '/home/vega']) {
        expect(serialized).not.toContain(fragment);
      }
      expect(serialized).toContain(custodySha256(SECRET_BODY));
    } finally {
      await stores.deliveries.close();
      await stores.custody.close();
      await stores.pool.end();
    }
  }, TIMEOUT_MS);

  it('prunes on the operator-owned horizon it shares with custody snapshots', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'egress-delivery-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    const stores = await makeStores(databaseUrl);
    try {
      const lineage = lineageOf(TURN_ID, memoryDerivedSources);
      const proof = turnEgressCustodyProof(lineage, custodySnapshotRefForTurn(TURN_ID));
      const aged = new EgressDeliveryRecorder({
        store: stores.deliveries,
        getCogSecMode: () => 'boundary',
        now: () => NOW_MS - (RETENTION_DAYS + 1) * MILLISECONDS_PER_DAY,
      });
      await aged.record({
        surface: 'social_reply',
        disposition: 'released',
        turnId: TURN_ID,
        attemptRef: 'old-event',
        contentSha256: egressContentSha256(REPLY_TEXT),
        destination: { kind: 'public_room', channelId: ROOM_CHANNEL },
        proof,
        decisionAllowed: true,
      });
      expect(await stores.deliveries.listByGenerationContextRef(
        custodySnapshotRefForTurn(TURN_ID),
      )).toHaveLength(1);

      expect(await stores.deliveries.pruneExpired()).toBe(1);
      expect(await stores.deliveries.listByGenerationContextRef(
        custodySnapshotRefForTurn(TURN_ID),
      )).toHaveLength(0);
    } finally {
      await stores.deliveries.close();
      await stores.custody.close();
      await stores.pool.end();
    }
  }, TIMEOUT_MS);
});
