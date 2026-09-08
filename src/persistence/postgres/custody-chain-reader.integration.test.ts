// Real-Postgres proof of the custody query seam (psfn-framework-ccgdz.7) over a
// FULL chain: a real ingress admission receipt (ccgdz.2) → the turn's custody
// snapshot (ccgdz.1) → its prompt source manifest (ccgdz.4) → a tool-result
// custody edge (ccgdz.5) → the egress delivery record (ccgdz.6). Both AC-3
// questions are answered from the persisted rows alone, the companion boundary
// holds in SQL, and a tampered row reports `malformed` rather than fabricating.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import { buildContextSourceManifest } from '../../core/cogsec/disclosure/context-source-manifest.js';
import { custodyIdentity, custodySha256 } from '../../core/cogsec/disclosure/custody-identity.js';
import {
  buildCustodySnapshot,
  custodySnapshotRefForTurn,
} from '../../core/cogsec/disclosure/custody-snapshot.js';
import {
  egressContentSha256,
  egressDeliveryDestination,
  egressDeliveryRef,
  validateEgressDeliveryRecord,
  type EgressDeliveryRecord,
} from '../../core/cogsec/disclosure/egress-delivery-record.js';
import { toolResultLineageRef } from '../../shared/contracts/tool-result-custody.js';
import { COGSEC_INTAKE_FIREWALL_ISSUER_ID } from '../../shared/contracts/cogsec-receipt.js';
import { createIntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { createIntakeL1Scanner } from '../../core/cogsec/intake/scanners/index.js';
import { validateIntakePolicy } from '../../system/config/intake-policy-config.js';
import { GardenCustodyQueryService } from '../../operator/garden/services/custody-query-service.js';
import type { DisclosureLineage } from '../../core/cogsec/disclosure/contracts.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresCogSecReceiptStore } from './cogsec-receipt-store.js';
import { PostgresCustodyChainReader } from './custody-chain-reader.js';
import { PostgresCustodySnapshotStore } from './custody-snapshot-store.js';
import { PostgresEgressDeliveryRecordStore } from './egress-delivery-record-store.js';

const TIMEOUT_MS = 120_000;
const SCHEMA = 'companion_custody_chain';
const RETENTION_DAYS = 90;
const NOW_MS = 1_800_000_000_000;
const ISSUED_AT_MS = 1_700_000_000_000;
const TTL_MS = 3_600_000;
const RULES_PATH = join(process.cwd(), 'config', 'intake-l1-rules.json');
const POLICY_SEED_PATH = join(process.cwd(), 'config', 'intake-policy.seed.json');

const TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e5f';
const OLDER_TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e60';
const OTHER_COMPANION_TURN_ID = '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4e61';
const COMPANION_ID = '3f2a1c88-5d4e-4a7b-9c3d-1e2f3a4b5c6d';
const OTHER_COMPANION_ID = '9b8a7c66-1d2e-4f3a-8b7c-6d5e4f3a2b1c';

const INBOUND_TEXT = 'The weather in Lisbon is sunny today and the tram was on time.';
const TOOL_RESULT_TEXT = 'wiki: Lisbon tram 28 runs from Martim Moniz to Campo Ourique.';
const REPLY_TEXT = 'Tram 28 runs from Martim Moniz, and today it was on time.';
const MEMORY_REF = 'memory:mem-7';
const TOOL_REF = toolResultLineageRef('wiki_read', 'call_1');

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

function lineageOf(turnId: string, classifiedAtMs: number): DisclosureLineage {
  let lineage = beginDisclosureAccumulation({
    generationContextRef: custodySnapshotRefForTurn(turnId),
    classifierVersion: 'disclosure/v1',
    classifiedAt: new Date(classifiedAtMs).toISOString(),
  });
  for (const source of [
    {
      ref: MEMORY_REF,
      sensitivity: 'personal' as const,
      permittedDestinations: [{ kind: 'public_room' as const, channelIds: ['discord:room-1'] }],
      classified: true,
    },
    {
      ref: TOOL_REF,
      sensitivity: 'public' as const,
      permittedDestinations: [],
      classified: true,
    },
  ]) {
    lineage = accumulateDisclosureSource(lineage, source);
  }
  return lineage;
}

function deliveryFor(input: {
  turnId: string;
  companionId: string;
  attemptRef: string;
  recordedAtMs: number;
  disposition?: 'released' | 'held';
}): EgressDeliveryRecord {
  const attempt = custodyIdentity(input.attemptRef);
  const generationContextRef = custodySnapshotRefForTurn(input.turnId);
  const held = input.disposition === 'held';
  return validateEgressDeliveryRecord({
    schemaVersion: 1,
    deliveryRef: egressDeliveryRef(generationContextRef, attempt),
    generationContextRef,
    turnId: input.turnId,
    owner: { kind: 'companion', companionId: input.companionId },
    surface: 'social_reply',
    disposition: held ? 'held' : 'released',
    enforcementPosture: 'enforce',
    attempt,
    contentSha256: egressContentSha256(REPLY_TEXT),
    destination: egressDeliveryDestination({
      kind: 'public_room',
      channelId: 'discord:room-1',
    }),
    outcome: held ? 'non_shareable' : 'auto_shareable',
    decisionAllowed: !held,
    ...(held ? { holdReason: 'unclassified_source' as const } : {}),
    custodySnapshotRef: generationContextRef,
    sourceCount: 2,
    hasUnclassifiedSource: held,
    effectiveSensitivity: 'personal',
    recordedAtMs: input.recordedAtMs,
  });
}

describe('PostgresCustodyChainReader', () => {
  it('answers both custody questions over a full ingress-to-egress chain', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    const bootstrap = createPostgresPool(databaseUrl, {
      applicationName: 'custody-chain-bootstrap', allowExitOnIdle: true,
    });
    await bootstrap.query(`CREATE SCHEMA ${SCHEMA}`);
    await bootstrap.end();

    // ── Hop 1: a real ingress admission receipt for the inbound bytes ──
    const receiptStore = await PostgresCogSecReceiptStore.connect(databaseUrl, {
      schema: SCHEMA,
    });
    const screening = createIntakeScreeningService({
      policy: validateIntakePolicy(
        {
          ...(JSON.parse(readFileSync(POLICY_SEED_PATH, 'utf8')) as Record<string, unknown>),
          mode: 'strict',
        },
        'intake-policy.custody-chain-integration',
      ),
      l1: createIntakeL1Scanner({ rulesPath: RULES_PATH, reloadCheckIntervalMs: -1 }),
      actor: 'agent:intake-screening',
      receipts: {
        store: receiptStore,
        issuerId: COGSEC_INTAKE_FIREWALL_ISSUER_ID,
        ttlMs: TTL_MS,
      },
      now: () => ISSUED_AT_MS,
    });
    const admitted = await screening.screen(INBOUND_TEXT, {
      sourceClass: 'document',
      origin: { ref: 'file:///tmp/report.md' },
      scope: 'context',
    });
    expect(admitted.action).toBe('pass');
    const receipt = admitted.receipt;
    if (!receipt) throw new Error('admitted screening must carry a receipt');
    const envelopeId = admitted.envelope.id;

    const snapshotStore = await PostgresCustodySnapshotStore.connect(
      databaseUrl, RETENTION_DAYS, { schema: SCHEMA, now: () => NOW_MS },
    );
    const deliveryStore = await PostgresEgressDeliveryRecordStore.connect(
      databaseUrl, RETENTION_DAYS, { schema: SCHEMA, now: () => NOW_MS },
    );
    const reader = await PostgresCustodyChainReader.connect(databaseUrl, { schema: SCHEMA });
    const service = new GardenCustodyQueryService({
      snapshots: reader, deliveries: reader, companionId: COMPANION_ID,
    });

    try {
      // ── Hop 2: the turn's custody snapshot, carrying the tool-result edge ──
      for (const [turnId, classifiedAtMs] of [
        [TURN_ID, NOW_MS],
        [OLDER_TURN_ID, NOW_MS - 60_000],
        [OTHER_COMPANION_TURN_ID, NOW_MS - 120_000],
      ] as const) {
        expect(await snapshotStore.record(buildCustodySnapshot({
          lineage: lineageOf(turnId, classifiedAtMs),
          turnId,
          requestId: 'msg-01936f2c4a1b',
          toolResultEdges: new Map([[TOOL_REF, {
            envelopeId,
            contentSha256: custodySha256(TOOL_RESULT_TEXT),
          }]]),
        }))).toBe('recorded');
      }

      // ── Hop 3: the prompt source manifest, carrying admission identity ──
      expect(await snapshotStore.recordContextManifest(buildContextSourceManifest({
        turnId: TURN_ID,
        blocks: [
          {
            id: 'memory-recall',
            layer: 'runtime',
            volatility: 'turn',
            producer: 'memory.activeContext',
            tokensEst: 64,
            renderedText: 'rendered memory text',
            sources: [{
              kind: 'memory',
              refId: MEMORY_REF,
              receiptId: receipt.receiptId,
              contentSha256: receipt.contentSha256,
              envelopeId,
            }],
          },
          {
            id: 'tool-results',
            layer: 'session',
            volatility: 'turn',
            producer: 'tools.results',
            tokensEst: 30,
            renderedText: TOOL_RESULT_TEXT,
            sources: [{
              kind: 'tool',
              refId: TOOL_REF,
              envelopeId,
              contentSha256: custodySha256(TOOL_RESULT_TEXT),
            }],
          },
        ],
      }))).toBe('recorded');

      // ── Hop 4: what actually left, and what was held ──
      for (const delivery of [
        deliveryFor({
          turnId: TURN_ID, companionId: COMPANION_ID,
          attemptRef: 'event-1', recordedAtMs: NOW_MS,
        }),
        deliveryFor({
          turnId: TURN_ID, companionId: COMPANION_ID,
          attemptRef: 'event-2', recordedAtMs: NOW_MS + 1, disposition: 'held',
        }),
        deliveryFor({
          turnId: OLDER_TURN_ID, companionId: COMPANION_ID,
          attemptRef: 'event-3', recordedAtMs: NOW_MS - 60_000,
        }),
        // Another companion's egress on its own turn — must stay invisible.
        deliveryFor({
          turnId: OTHER_COMPANION_TURN_ID, companionId: OTHER_COMPANION_ID,
          attemptRef: 'event-4', recordedAtMs: NOW_MS - 120_000,
        }),
      ]) {
        expect(await deliveryStore.record(delivery)).toBe('recorded');
      }

      // ── AC-3 question one: which admitted context caused this egress? ──
      const chain = await service.queryEgressChain(new URLSearchParams({ turnId: TURN_ID }));
      expect(chain.snapshotStatus).toBe('present');
      expect(chain.manifestStatus).toBe('present');
      expect(chain.deliveryStatus).toBe('present');
      expect(chain.chainComplete).toBe(true);
      expect(chain.unknownDimensions).toEqual([]);
      expect(chain.deliveryCount).toBe(2);
      expect(chain.heldDeliveryCount).toBe(1);

      const memory = chain.sources.find(entry => entry.source.kind === 'memory');
      // The ingress receipt reaches the egress question: the bytes admitted at
      // the firewall are the bytes the prompt rendered.
      expect(memory?.admission).toEqual({
        status: 'present',
        receiptId: receipt.receiptId,
        contentSha256: receipt.contentSha256,
        envelopeId,
      });
      expect(memory?.renderedBlockCount).toBe(1);
      expect(await receiptStore.getById(receipt.receiptId)).not.toBeNull();

      const tool = chain.sources.find(entry => entry.source.kind === 'tool');
      expect(tool?.source.toolResult).toEqual({
        envelopeId,
        contentSha256: custodySha256(TOOL_RESULT_TEXT),
      });
      expect(tool?.admission.envelopeId).toBe(envelopeId);

      // Addressing the same chain by one delivery attempt resolves identically.
      const byDelivery = await service.queryEgressChain(new URLSearchParams({
        deliveryRef: egressDeliveryRef(
          custodySnapshotRefForTurn(TURN_ID), custodyIdentity('event-1'),
        ),
      }));
      expect(byDelivery.generationContextRef).toBe(chain.generationContextRef);
      expect(byDelivery.deliveryCount).toBe(2);

      // ── AC-3 question two: where did this source's bytes end up? ──
      const first = await service.querySourceEgresses(new URLSearchParams({
        sourceRef: MEMORY_REF, limit: '1',
      }));
      expect(first.generationCount).toBe(1);
      expect(first.generations[0]?.turnId).toBe(TURN_ID);
      expect(first.deliveryCount).toBe(2);
      expect(first.page.hasMore).toBe(true);
      const cursor = first.page.nextCursor;
      if (cursor === undefined) throw new Error('a further page must carry a cursor');

      const second = await service.querySourceEgresses(new URLSearchParams({
        sourceRef: MEMORY_REF, limit: '5', cursor,
      }));
      // The other companion's generation is reachable by source (one schema),
      // but nothing it delivered is: the owner predicate is in the SQL.
      expect(second.generations.map(generation => generation.turnId))
        .toEqual([OLDER_TURN_ID, OTHER_COMPANION_TURN_ID]);
      const foreign = second.generations.find(
        generation => generation.turnId === OTHER_COMPANION_TURN_ID,
      );
      expect(foreign?.deliveries).toEqual([]);
      expect(second.unknownDimensions).toContain('egress_delivery');
      expect(second.deliveryCount).toBe(1);

      // A digest addresses the same source as its reference.
      const byDigest = await service.querySourceEgresses(new URLSearchParams({
        sourceDigest: custodySha256(MEMORY_REF),
      }));
      expect(byDigest.generationCount).toBe(3);

      // A source nothing ever admitted is an empty, explicit answer.
      const absent = await service.querySourceEgresses(new URLSearchParams({
        sourceRef: 'memory:never-admitted',
      }));
      expect(absent.generationCount).toBe(0);
      expect(absent.deliveryCount).toBe(0);

      // Another companion's delivery ref is refused, not resolved.
      await expect(service.queryEgressChain(new URLSearchParams({
        deliveryRef: egressDeliveryRef(
          custodySnapshotRefForTurn(OTHER_COMPANION_TURN_ID), custodyIdentity('event-4'),
        ),
      }))).rejects.toThrow(/not owned by this companion/u);

      // A turn with no custody row at all reports unknown, never an empty proof.
      const missing = await service.queryEgressChain(new URLSearchParams({
        turnId: '01936f2c-4a1b-7c3d-8e5f-0a1b2c3d4eff',
      }));
      expect(missing.sourceCount).toBe('unknown');
      expect(missing.chainComplete).toBe(false);
      expect(missing.unknownDimensions).toEqual([
        'custody_snapshot', 'context_manifest', 'egress_delivery',
      ]);

      // ── A row edited in the database reports malformed, never a claim ──
      const tamper = createPostgresPool(databaseUrl, {
        applicationName: 'custody-chain-tamper', allowExitOnIdle: true, schema: SCHEMA,
      });
      await tamper.query(
        `UPDATE custody_snapshots
         SET snapshot_json = jsonb_set(snapshot_json, '{classifierVersion}', '"has spaces"')
         WHERE generation_context_ref = $1`,
        [custodySnapshotRefForTurn(TURN_ID)],
      );
      await tamper.end();
      const tampered = await service.queryEgressChain(new URLSearchParams({ turnId: TURN_ID }));
      expect(tampered.snapshotStatus).toBe('malformed');
      expect(tampered.sourceCount).toBe('unknown');
      expect(tampered.chainComplete).toBe(false);
      // The delivery records still stand — one broken row does not erase the
      // record of what left.
      expect(tampered.deliveryCount).toBe(2);
    } finally {
      await reader.close();
      await deliveryStore.close();
      await snapshotStore.close();
      await receiptStore.close();
    }
  }, TIMEOUT_MS);
});
