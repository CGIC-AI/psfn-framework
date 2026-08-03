import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  createPostgresPool,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { PostgresModelUsageStore } from './model-usage-store.js';
import { PostgresIcpAdminProjectionStore } from './icp-admin-projection-store.js';
import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';

// Regression coverage for psfn-framework-vzh0u. The ICP admin cost projection
// pool used to open with no schema, so its unqualified
// icp_conversation_cost_decisions read resolved through the libpq default
// `"$user", public` search_path. Operator ruling 2026-07-28: aggregation across
// companions is intentional (a conversation charges both participating
// companions against one shared budget pool). This proves the read still
// aggregates across companions under the now-explicit canonical fleet ledger
// scope — same totals as before — while the accidental-default path is gone.

const TIMEOUT_MS = 120_000;
const COMPANION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const COMPANION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const ROOT_INITIATION_ID = '99999999-9999-4999-8999-999999999999';
const CHANNEL_ID = `companion-dm:${COMPANION_A}:${COMPANION_B}`;
const PROVENANCE_REF = 'icp-prov:11111111-1111-4111-8111-111111111111';
const PRIMARY_SCHEMA = 'companion_primary';

const POLICY = {
  enabled: true as const,
  warningThresholdUsd: 0.8,
  hardLimitUsd: 1,
  finalCloseoutReserveUsd: 0.2,
  pendingReservationStaleAfterMs: 60_000,
  includedCostPurposes: {
    conversation_turn: true,
    tool: true,
    summary: true,
    extraction: true,
    sidecar: true,
  },
};

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  harness = null;
}, TIMEOUT_MS);

function correlation(localCompanionId: string): IcpConversationCorrelation {
  const peerCompanionId = localCompanionId === COMPANION_A ? COMPANION_B : COMPANION_A;
  return {
    conversationId: CONVERSATION_ID,
    rootInitiationId: ROOT_INITIATION_ID,
    initiatedByCompanionId: COMPANION_A,
    localCompanionId,
    peerCompanionId,
    peerContactId: `contact-${peerCompanionId}`,
    channelId: CHANNEL_ID,
    turnId: localCompanionId === COMPANION_A
      ? '018f22a2-52b8-7a3a-8c16-25b7b14f7082'
      : '018f22a2-52b8-7a3a-8c16-25b7b14f7083',
    messageId: `message-${localCompanionId}`,
    requestId: `request-${localCompanionId}`,
    chargeLane: 'companion_social',
    surface: 'companion_dm',
    costPurpose: 'conversation_turn',
    costOriginStage: 'reply',
    fatigueDecision: 'allow',
  };
}

describe('ICP admin cost projection fleet-ledger scope', () => {
  it('reads the shared cost ledger aggregated across both companions under the canonical scope', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    await bootstrapSharedSchema(databaseUrl);

    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'icp-admin-cost-scope-bootstrap',
      allowExitOnIdle: true,
      max: 1,
    });
    const roleResult = await bootstrapPool.query<{ current_user: string }>(
      'SELECT current_user',
    );
    const currentRole = roleResult.rows.at(0)?.current_user;
    if (!currentRole) throw new Error('ICP cost scope test could not resolve PostgreSQL role');
    await bootstrapPool.query(
      `CREATE SCHEMA ${quotePostgresSchemaName(PRIMARY_SCHEMA)} `
      + `AUTHORIZATION ${quotePostgresRoleName(currentRole)}`,
    );
    const fleetPool = createPostgresPool(databaseUrl, {
      applicationName: 'icp-admin-cost-scope-fleet',
      allowExitOnIdle: true,
      schema: PRIMARY_SCHEMA,
      role: currentRole,
      max: 2,
    });
    const pools: Pool[] = [bootstrapPool, fleetPool];
    const fleetUsage = new PostgresModelUsageStore(fleetPool, { fleetAggregation: true });
    const episodes = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [COMPANION_A, COMPANION_B],
    });
    let projectionStore: PostgresIcpAdminProjectionStore | null = null;

    try {
      await episodes.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL_ID,
        participantCompanionIds: [COMPANION_A, COMPANION_B],
        rootInitiationId: ROOT_INITIATION_ID,
        initiatedByCompanionId: COMPANION_A,
        initiationSource: 'foreground',
        provenanceRef: PROVENANCE_REF,
        openedAtMs: 1_752_500_000_000,
        lastActivityAtMs: 1_752_500_000_000,
        status: 'invited',
        revision: 1,
      });

      // Both companions reserve against the same conversation. The fleet pool is
      // one shared budget, so B's reservation must see A's pending charge and
      // roll it into the projected total — the aggregation-across-companions the
      // operator ruled intentional.
      const firstReservation = await fleetUsage.reserveIcpConversationCost({
        logicalCallId: 'cost-scope-a',
        attempt: 1,
        projectedCostUsd: 0.3,
        correlation: correlation(COMPANION_A),
        policy: POLICY,
        requestedAtMs: 1_752_500_000_000,
      });
      expect(firstReservation.allowed).toBe(true);

      const secondReservation = await fleetUsage.reserveIcpConversationCost({
        logicalCallId: 'cost-scope-b',
        attempt: 1,
        projectedCostUsd: 0.3,
        correlation: correlation(COMPANION_B),
        policy: POLICY,
        requestedAtMs: 1_752_500_000_100,
      });
      expect(secondReservation.allowed).toBe(true);
      // Fleet aggregation: the second reservation's projected total spans both
      // companions' pending charges (0.3 + 0.3), not just its own.
      expect(secondReservation.projection.projectedTotalCostUsd).toBeCloseTo(0.6, 6);

      projectionStore = await PostgresIcpAdminProjectionStore.connect(databaseUrl, {
        localCompanionId: COMPANION_A,
        knownCompanionIds: [COMPANION_A, COMPANION_B],
        config: {
          multiCompanion: true,
          companionFleet: { companions: [{ postgresSchema: PRIMARY_SCHEMA }] },
          postgresRole: currentRole,
        },
      });

      const projection = await projectionStore.readProjection(50);
      expect(projection.costProjection).toEqual({ available: true, unavailableReason: null });
      expect(projection.costs).toHaveLength(1);
      const cost = projection.costs[0]!;
      expect(cost.conversationId).toBe(CONVERSATION_ID);
      expect(cost.rootInitiationId).toBe(ROOT_INITIATION_ID);
      expect([...cost.participantCompanionIds].sort()).toEqual(
        [COMPANION_A, COMPANION_B].sort(),
      );
      // The latest decision is B's; its projected total already aggregates both
      // companions, proving the cost pool read reaches the canonical fleet
      // ledger rather than a single companion's tenant slice.
      expect(cost.projectedTotalCostUsd).toBeCloseTo(0.6, 6);
      expect(cost.pendingProjectedCostUsd).toBeCloseTo(0.6, 6);
      expect(cost.hardLimitUsd).toBeCloseTo(1, 6);
      expect(cost.warningThresholdUsd).toBeCloseTo(0.8, 6);
    } finally {
      await projectionStore?.close();
      await episodes.close();
      await Promise.all(pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('keeps the shared projection available and hot-restores costs after optional provisioning', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    await bootstrapSharedSchema(databaseUrl);
    const probePool = createPostgresPool(databaseUrl, {
      applicationName: 'icp-admin-optional-cost-probe',
      allowExitOnIdle: true,
      max: 1,
    });
    const roleResult = await probePool.query<{ current_user: string }>(
      'SELECT current_user',
    );
    const currentRole = roleResult.rows.at(0)?.current_user;
    if (!currentRole) throw new Error('ICP optional cost test could not resolve PostgreSQL role');
    await probePool.query(
      `CREATE SCHEMA ${quotePostgresSchemaName(PRIMARY_SCHEMA)} `
      + `AUTHORIZATION ${quotePostgresRoleName(currentRole)}`,
    );
    const fleetPool = createPostgresPool(databaseUrl, {
      applicationName: 'icp-admin-optional-cost-fleet',
      allowExitOnIdle: true,
      schema: PRIMARY_SCHEMA,
      role: currentRole,
      max: 1,
    });
    const pools: Pool[] = [probePool, fleetPool];
    let projectionStore: PostgresIcpAdminProjectionStore | null = null;

    try {
      const relationBefore = await probePool.query<{ relation: string | null }>(
        `SELECT to_regclass('${PRIMARY_SCHEMA}.icp_conversation_cost_decisions')::text AS relation`,
      );
      expect(relationBefore.rows[0]?.relation).toBeNull();

      projectionStore = await PostgresIcpAdminProjectionStore.connect(databaseUrl, {
        localCompanionId: COMPANION_A,
        knownCompanionIds: [COMPANION_A, COMPANION_B],
        config: {
          multiCompanion: true,
          companionFleet: { companions: [{ postgresSchema: PRIMARY_SCHEMA }] },
          postgresRole: currentRole,
        },
      });
      const withoutCosts = await projectionStore.readProjection(50);
      expect(withoutCosts.costs).toEqual([]);
      expect(withoutCosts.costProjection).toEqual({
        available: false,
        unavailableReason: 'relation_contract_unavailable',
      });
      expect(withoutCosts.availability).toEqual([]);
      expect(withoutCosts.episodes).toEqual([]);
      expect(withoutCosts.permits).toEqual([]);
      expect(withoutCosts.fatigue).toEqual([]);

      const fleetUsage = new PostgresModelUsageStore(fleetPool, { fleetAggregation: true });
      await fleetUsage.waitUntilReady();

      const afterProvisioning = await projectionStore.readProjection(50);
      expect(afterProvisioning.costProjection).toEqual({
        available: true,
        unavailableReason: null,
      });
      expect(afterProvisioning.costs).toEqual([]);
    } finally {
      await projectionStore?.close();
      await Promise.all(pools.map(pool => pool.end()));
    }
  }, TIMEOUT_MS);

  it('rejects construction when a mandatory shared projection relation is missing', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const { databaseUrl } = await harness.createDatabase();
    await bootstrapSharedSchema(databaseUrl);
    const mutationPool = createPostgresPool(databaseUrl, {
      applicationName: 'icp-admin-required-relation-fixture',
      allowExitOnIdle: true,
      schema: 'shared',
      max: 1,
    });
    try {
      const roleResult = await mutationPool.query<{ current_user: string }>(
        'SELECT current_user',
      );
      const currentRole = roleResult.rows.at(0)?.current_user;
      if (!currentRole) throw new Error('ICP mandatory relation test could not resolve PostgreSQL role');
      await mutationPool.query('DROP TABLE icp_fatigue_turn_reservations');

      await expect(PostgresIcpAdminProjectionStore.connect(databaseUrl, {
        localCompanionId: COMPANION_A,
        knownCompanionIds: [COMPANION_A, COMPANION_B],
        config: {
          multiCompanion: true,
          companionFleet: { companions: [{ postgresSchema: 'public' }] },
          postgresRole: currentRole,
        },
      })).rejects.toThrow('PostgreSQL relation shared.icp_fatigue_turn_reservations is missing');
    } finally {
      await mutationPool.end();
    }
  }, TIMEOUT_MS);
});
