import { readFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { resolveChargeLedgerPath } from '../../../persistence/layout.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { readRunChargeRollingWindowFromLedger } from '../../../shared/telemetry/charge-ledger.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_DM_CHANNEL,
  CERTIFICATION_SCHEMA_A,
  CERTIFICATION_SCHEMA_B,
} from './constants.js';
import {
  createIcpCertificationFixture,
  setIcpCertificationAutonomyEnabled,
  type IcpCertificationFixture,
} from './fixture.js';
import {
  startIcpCertificationProcessHarness,
  type IcpCertificationProcessHarness,
} from './process-harness.js';

const TIMEOUT_MS = 120_000;

interface ChannelSnapshot {
  entries: Array<{
    authorId?: string;
    content: string;
    role: string;
  }>;
  memories: Array<{ text: string }>;
  summaries: Array<{ summary: string }>;
}

async function waitForBlockedCostDecision(
  harness: IcpCertificationProcessHarness,
  reason: string,
): Promise<IcpCertificationProcessHarness['costDecisions'][number]> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const decision = harness.costDecisions.find(candidate => (
      candidate.outcome === 'blocked' && candidate.reason === reason
    ));
    if (decision) return decision;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(
    `Timed out waiting for ICP cost decision ${reason}: ${JSON.stringify(harness.costDecisions)}`,
  );
}

async function waitForChannelEntries(
  agent: IcpCertificationProcessHarness['agents'][number],
  minimum: number,
): Promise<ChannelSnapshot> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = await agent.channelSnapshot(CERTIFICATION_DM_CHANNEL) as unknown as ChannelSnapshot;
    if (snapshot.entries.length >= minimum) return snapshot;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${minimum} entries on ${CERTIFICATION_DM_CHANNEL}`);
}

async function waitForModelRequestQuiescence(
  harness: IcpCertificationProcessHarness,
): Promise<number> {
  const deadline = Date.now() + 20_000;
  let previousCount = harness.modelRequestCount;
  let unchangedSinceMs = Date.now();
  while (Date.now() < deadline) {
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
    const currentCount = harness.modelRequestCount;
    if (currentCount !== previousCount) {
      previousCount = currentCount;
      unchangedSinceMs = Date.now();
      continue;
    }
    if (Date.now() - unchangedSinceMs >= 750) return currentCount;
  }
  throw new Error(`Model fixture did not quiesce after ${harness.modelRequestCount} requests`);
}

describe('ICP certification real process harness', () => {
  let postgres: PostgresTestHarness | null = null;
  let fixture: IcpCertificationFixture | null = null;
  let processes: IcpCertificationProcessHarness | null = null;

  beforeAll(async () => {
    postgres = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  }, TIMEOUT_MS);

  afterEach(async () => {
    await processes?.stop();
    processes = null;
    fixture?.cleanup();
    fixture = null;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await postgres?.stop();
    postgres = null;
  }, TIMEOUT_MS);

  it('boots one real socket gateway and two schema-isolated SubstrateAgent child processes', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [readyA, readyB] = await Promise.all(processes.agents.map(agent => agent.ready()));
    expect(readyA).toMatchObject({
      companionId: CERTIFICATION_COMPANION_A,
      postgresSchema: CERTIFICATION_SCHEMA_A,
      runtimeClass: 'SubstrateAgent',
    });
    expect(readyB).toMatchObject({
      companionId: CERTIFICATION_COMPANION_B,
      postgresSchema: CERTIFICATION_SCHEMA_B,
      runtimeClass: 'SubstrateAgent',
    });
    expect(readyA.peerContactId).not.toBe(readyB.peerContactId);

    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-certification-assertions',
      max: 1,
    });
    try {
      const schemas = await pool.query<{ schema_name: string }>(`
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = ANY($1::text[])
        ORDER BY schema_name
      `, [[CERTIFICATION_SCHEMA_A, CERTIFICATION_SCHEMA_B, 'shared']]);
      expect(schemas.rows.map(row => row.schema_name)).toEqual([
        CERTIFICATION_SCHEMA_A,
        CERTIFICATION_SCHEMA_B,
        'shared',
      ]);
      const isolatedContacts = await pool.query<{ schema_name: string; peer_count: string }>(`
        SELECT $1::text AS schema_name, COUNT(*)::text AS peer_count
        FROM ${CERTIFICATION_SCHEMA_A}.contacts
        UNION ALL
        SELECT $2::text AS schema_name, COUNT(*)::text AS peer_count
        FROM ${CERTIFICATION_SCHEMA_B}.contacts
        ORDER BY schema_name
      `, [CERTIFICATION_SCHEMA_A, CERTIFICATION_SCHEMA_B]);
      expect(isolatedContacts.rows).toEqual([
        { schema_name: CERTIFICATION_SCHEMA_A, peer_count: '1' },
        { schema_name: CERTIFICATION_SCHEMA_B, peer_count: '1' },
      ]);
    } finally {
      await pool.end();
    }

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.submitInitiation('free_time', 'free-time:first')).resolves.toMatchObject({
      outcome: 'sent',
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    for (let index = 0; index < 20; index += 1) {
      await Promise.all([
        agentA.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
        agentB.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
      ]);
    }
    const [sender, recipient] = await Promise.all([
      waitForChannelEntries(agentA, 22),
      waitForChannelEntries(agentB, 22),
    ]);
    expect(sender.entries.some(entry => entry.role === 'assistant')).toBe(true);
    expect(recipient.entries.some(entry => (
      entry.role === 'user' && entry.authorId === CERTIFICATION_COMPANION_A
    ))).toBe(true);
    expect(JSON.stringify({ sender, recipient })).not.toContain('Private free_time certification motivation');

    const compactions = await Promise.all([
      agentA.forceCompaction(CERTIFICATION_DM_CHANNEL),
      agentB.forceCompaction(CERTIFICATION_DM_CHANNEL),
    ]);
    expect(compactions).toEqual([
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
    ]);
    const restarted = await processes.restartAgents();
    const [restartedA, restartedB] = await Promise.all([
      waitForChannelEntries(restarted[0], 22),
      waitForChannelEntries(restarted[1], 22),
    ]);
    expect(restartedA.summaries.length).toBeGreaterThan(0);
    expect(restartedB.summaries.length).toBeGreaterThan(0);
    expect(restartedA.entries.some(entry => entry.role === 'assistant')).toBe(true);
    expect(restartedB.entries.some(entry => entry.authorId === CERTIFICATION_COMPANION_A)).toBe(true);
  }, TIMEOUT_MS);

  it.each([
    ['lowered_warning', 'warning_closeout_reserve_only', 0.0001],
    ['lowered_hard', 'hard_limit_exceeded', 0.00015],
  ] as const)(
    'stops the second companion at the fleet-scoped %s cost boundary',
    async (costProfile, expectedReason, expectedActualCostUsd) => {
      if (!postgres) throw new Error('Postgres certification harness is unavailable');
      const { databaseUrl } = await postgres.createDatabase();
      fixture = createIcpCertificationFixture({ databaseUrl, costProfile });
      processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

      const [agentA, agentB] = processes.agents;
      await agentB.publishAvailability('open_to_chat');
      await expect(agentA.submitInitiation('free_time', `cost:${costProfile}`)).resolves
        .toMatchObject({ outcome: 'sent', status: 'consumed' });

      const blocked = await waitForBlockedCostDecision(processes, expectedReason);
      expect(blocked).toMatchObject({
        localCompanionId: CERTIFICATION_COMPANION_B,
        outcome: 'blocked',
        reason: expectedReason,
        projection: {
          actualCostUsd: expectedActualCostUsd,
          attributedCompanionCount: 1,
        },
      });
      expect(processes.costDecisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          localCompanionId: CERTIFICATION_COMPANION_A,
          outcome: 'reserved',
          reason: 'below_warning',
        }),
      ]));
      expect(processes.costDecisions.some(decision => (
        decision.localCompanionId === CERTIFICATION_COMPANION_B
        && (decision.outcome === 'reserved' || decision.outcome === 'warning')
      ))).toBe(false);
      expect(processes.modelRequestCount).toBeGreaterThanOrEqual(2);
    },
    TIMEOUT_MS,
  );

  it('fails closed before provider dispatch when canonical ICP pricing is missing', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, costProfile: 'missing' });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.submitInitiation('free_time', 'cost:missing')).rejects
      .toThrow(/missing_cost_metadata|cost breaker/i);
    const blocked = await waitForBlockedCostDecision(processes, 'missing_cost_metadata');
    expect(blocked).toMatchObject({
      localCompanionId: CERTIFICATION_COMPANION_A,
      outcome: 'blocked',
      reason: 'missing_cost_metadata',
    });
    expect(processes.modelRequestCount).toBe(1);
  }, TIMEOUT_MS);

  it('closes deterministic gates before the LLM and resists replay after weighted-thought consent', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'final_reserve' });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('do_not_disturb');
    await expect(agentA.submitInitiation('free_time', 'adversarial:dnd')).resolves.toMatchObject({
      outcome: 'rejected',
      status: 'rejected',
      reasonCode: 'peer_do_not_disturb',
    });
    expect(processes.modelRequestCount).toBe(0);

    await agentB.publishAvailability('open_to_chat');
    processes.queueConsentDecision('defer');
    await expect(agentA.submitInitiation('weighted_thought', 'consent:defer')).resolves
      .toMatchObject({
        outcome: 'deferred',
        status: 'deferred',
        reasonCode: 'candidate_deferred',
      });
    processes.queueConsentDecision('decline');
    await expect(agentA.submitInitiation('weighted_thought', 'consent:decline')).resolves
      .toMatchObject({
        outcome: 'declined',
        status: 'declined',
        reasonCode: 'candidate_declined',
      });

    await Promise.all([
      agentA.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
      agentB.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
    ]);
    const sent = await agentA.submitInitiation('weighted_thought', 'replay:weighted-thought');
    expect(sent).toMatchObject({
      outcome: 'sent',
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    const settledRequestCount = await waitForModelRequestQuiescence(processes);
    await expect(agentA.submitInitiation('weighted_thought', 'replay:weighted-thought')).resolves
      .toMatchObject({
        candidateId: sent.candidateId,
        outcome: 'deduped',
        status: 'consumed',
      });
    expect(await waitForModelRequestQuiescence(processes)).toBe(settledRequestCount);

    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-certification-fatigue-assertions',
      max: 1,
    });
    try {
      const fatigue = await pool.query<{
        decision: 'charged' | 'overcharge';
        local_companion_id: string;
        reservation_count: string;
      }>(`
        SELECT local_companion_id::text, decision, COUNT(*)::text AS reservation_count
        FROM shared.icp_fatigue_turn_reservations
        WHERE outcome IN ('delivered', 'no_reply')
        GROUP BY local_companion_id, decision
      `);
      const reservationCount = fatigue.rows.reduce(
        (sum, row) => sum + Number(row.reservation_count),
        0,
      );
      expect(reservationCount).toBeGreaterThan(0);
      expect(reservationCount).toBeLessThanOrEqual(10);
      expect(
        fatigue.rows.some(row => row.decision === 'overcharge'),
        JSON.stringify(fatigue.rows),
      ).toBe(true);
      for (const companionId of [CERTIFICATION_COMPANION_A, CERTIFICATION_COMPANION_B]) {
        const companionReservations = fatigue.rows
          .filter(row => row.local_companion_id === companionId)
          .reduce((sum, row) => sum + Number(row.reservation_count), 0);
        expect(companionReservations).toBeLessThanOrEqual(5);
      }
    } finally {
      await pool.end();
    }

    const socialCharge = fixture.companions.reduce((sum, companion) => {
      const rolling = readRunChargeRollingWindowFromLedger(
        resolveChargeLedgerPath(companion.companionDataDir),
      );
      return sum + (rolling.spentByLane.companion_social ?? 0);
    }, 0);
    expect(socialCharge).toBeGreaterThan(0);
    expect(socialCharge).toBeLessThanOrEqual(8);

    await processes.stop();
    const artifactText = readFileSync(fixture.artifactsPath, 'utf8');
    expect(artifactText).toContain('runtimeClass');
    expect(artifactText).toContain('peer_do_not_disturb');
    expect(artifactText).toContain('weighted_thought');
    expect(artifactText).not.toContain('Private weighted_thought certification motivation');
    expect(artifactText).not.toContain('replay:weighted-thought');
    expect(artifactText).not.toContain('fixture_defer');
  }, TIMEOUT_MS);

  it('fails closed under the one-way runtime emergency fence and resumes only after restart', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.activateRuntimeEmergencyDisable()).resolves.toMatchObject({
      enabled: false,
      lease: { state: 'do_not_disturb' },
    });
    setIcpCertificationAutonomyEnabled(fixture, false);
    await expect(agentA.submitInitiation('free_time', 'emergency:blocked')).resolves.toMatchObject({
      outcome: 'rejected',
      status: 'rejected',
      reasonCode: 'policy_denied',
    });
    expect(processes.modelRequestCount).toBe(0);

    let [restartedA, restartedB] = await processes.restartAgents();
    await restartedB.publishAvailability('open_to_chat');
    await expect(restartedA.submitInitiation('free_time', 'emergency:owner-disabled')).rejects
      .toThrow(/autonomy is disabled by scheduler\.json/i);
    expect(processes.modelRequestCount).toBe(0);

    setIcpCertificationAutonomyEnabled(fixture, true);
    [restartedA, restartedB] = await processes.restartAgents();
    await restartedB.publishAvailability('open_to_chat');
    await expect(restartedA.submitInitiation('free_time', 'emergency:rollback')).resolves
      .toMatchObject({
        outcome: 'sent',
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
    expect(processes.modelRequestCount).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('boots both real agents with feature-off parity and rejects initiation without an LLM call', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, autonomyEnabled: false });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [agentA, agentB] = processes.agents;
    await expect(Promise.all([agentA.ready(), agentB.ready()])).resolves.toEqual([
      expect.objectContaining({ runtimeClass: 'SubstrateAgent' }),
      expect.objectContaining({ runtimeClass: 'SubstrateAgent' }),
    ]);
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.submitInitiation('free_time', 'feature-off')).rejects
      .toThrow(/autonomy is disabled by scheduler\.json/i);
    expect(processes.modelRequestCount).toBe(0);
    await expect(agentA.channelSnapshot(CERTIFICATION_DM_CHANNEL)).resolves.toMatchObject({
      entries: [],
      summaries: [],
    });
  }, TIMEOUT_MS);
});
