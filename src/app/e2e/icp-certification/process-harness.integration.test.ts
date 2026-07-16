import { readFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { resolveChargeLedgerPath } from '../../../persistence/layout.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { derivePostgresTenantRole } from '../../../persistence/postgres/tenancy.js';
import { readRunChargeRollingWindowFromLedger } from '../../../shared/telemetry/charge-ledger.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_DM_CHANNEL,
  CERTIFICATION_PRIVATE_ROOM,
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
  startIcpSingleCompanionFeatureOffHarness,
  type IcpCertificationProcessHarness,
  type IcpSingleCompanionFeatureOffHarness,
} from './process-harness.js';

const TIMEOUT_MS = 120_000;

interface ChannelSnapshot {
  entries: Array<{
    authorId?: string;
    content: string;
    role: string;
    timestamp?: number;
  }>;
  memories: Array<{ text: string }>;
  summaries: Array<{ summary: string }>;
}

interface ProviderDispatchCount {
  companionId: string;
  conversationId: string | null;
  count: number;
}

interface TurnRecordsSnapshot {
  records: Array<{
    correlation?: {
      channelId: string;
      conversationId: string;
      fatigueDecision: string;
      fatigueReasonCode?: string;
      localCompanionId: string;
      peerCompanionId: string;
      requestId: string;
      rootInitiationId: string;
      turnId: string;
    };
    hasAssistantMessage: boolean;
    requestId: string;
    status: string;
    turnId: string;
  }>;
}

interface FreeTimeNotificationResult {
  candidateId: string;
  deliveryDisposition: string;
  postTurnStatus: string;
  rootInitiationId: string;
  senderExchange: {
    channelId: string;
    conversationId: string;
    recipientRequestId: string;
    rootInitiationId: string;
    senderRequestId: string;
    senderTurnId: string;
  };
  status: string;
}

async function readProviderDispatchCounts(databaseUrl: string): Promise<ProviderDispatchCount[]> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-icp-certification-provider-dispatch-assertions',
    max: 1,
  });
  try {
    const result = await pool.query<{
      companion_id: string;
      conversation_id: string | null;
      dispatch_count: string;
    }>(`
      SELECT companion_id::text, conversation_id::text, COUNT(*)::text AS dispatch_count
      FROM model_usage_events
      WHERE status = 'success' AND call_kind IN ('chat', 'completion')
      GROUP BY companion_id, conversation_id
      ORDER BY companion_id, conversation_id NULLS FIRST
    `);
    return result.rows.map(row => ({
      companionId: row.companion_id,
      conversationId: row.conversation_id,
      count: Number(row.dispatch_count),
    }));
  } finally {
    await pool.end();
  }
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
  channelId = CERTIFICATION_DM_CHANNEL,
): Promise<ChannelSnapshot> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const snapshot = await agent.channelSnapshot(channelId) as unknown as ChannelSnapshot;
    if (snapshot.entries.length >= minimum) return snapshot;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(`Timed out waiting for ${minimum} entries on ${channelId}`);
}

async function waitForExtractionMarker(
  agent: IcpCertificationProcessHarness['agents'][number],
  marker: 'A' | 'B',
): Promise<ChannelSnapshot> {
  const deadline = Date.now() + 20_000;
  let lastSnapshot: ChannelSnapshot | undefined;
  while (Date.now() < deadline) {
    const snapshot = await agent.channelSnapshot(CERTIFICATION_PRIVATE_ROOM) as unknown as ChannelSnapshot;
    lastSnapshot = snapshot;
    if (snapshot.memories.some(memory => memory.text.includes(`Certification ${marker} extraction marker`))) {
      return snapshot;
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error(
    `Timed out waiting for Certification ${marker} extraction marker: ${JSON.stringify(
      lastSnapshot?.memories.map(memory => memory.text) ?? [],
    )}`,
  );
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
  let singleProcess: IcpSingleCompanionFeatureOffHarness | null = null;

  beforeAll(async () => {
    postgres = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  }, TIMEOUT_MS);

  afterEach(async () => {
    await processes?.stop();
    processes = null;
    await singleProcess?.stop();
    singleProcess = null;
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
      const tenantBoundaries = await pool.query<{
        extension_schema: string | null;
        login_is_member: boolean;
        role_name: string;
        schema_name: string;
        schema_owner: string;
      }>(`
        SELECT namespace.nspname AS schema_name,
          owner.rolname AS schema_owner,
          expected.role_name,
          pg_has_role(current_user, expected.role_name, 'MEMBER') AS login_is_member,
          extension_namespace.nspname AS extension_schema
        FROM (VALUES ($1::text, $2::text), ($3::text, $4::text))
          AS expected(schema_name, role_name)
        JOIN pg_namespace namespace ON namespace.nspname = expected.schema_name
        JOIN pg_roles owner ON owner.oid = namespace.nspowner
        LEFT JOIN pg_extension extension ON extension.extname = 'vector'
        LEFT JOIN pg_namespace extension_namespace ON extension_namespace.oid = extension.extnamespace
        ORDER BY namespace.nspname
      `, [
        CERTIFICATION_SCHEMA_A,
        derivePostgresTenantRole(CERTIFICATION_SCHEMA_A),
        CERTIFICATION_SCHEMA_B,
        derivePostgresTenantRole(CERTIFICATION_SCHEMA_B),
      ]);
      expect(tenantBoundaries.rows).toEqual([
        {
          extension_schema: 'extensions',
          login_is_member: true,
          role_name: derivePostgresTenantRole(CERTIFICATION_SCHEMA_A),
          schema_name: CERTIFICATION_SCHEMA_A,
          schema_owner: derivePostgresTenantRole(CERTIFICATION_SCHEMA_A),
        },
        {
          extension_schema: 'extensions',
          login_is_member: true,
          role_name: derivePostgresTenantRole(CERTIFICATION_SCHEMA_B),
          schema_name: CERTIFICATION_SCHEMA_B,
          schema_owner: derivePostgresTenantRole(CERTIFICATION_SCHEMA_B),
        },
      ]);
    } finally {
      await pool.end();
    }

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.runFreeTimeNotification()).resolves.toMatchObject({
      status: 'consumed',
      deliveryDisposition: 'delivered',
      postTurnStatus: 'succeeded',
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

  it('enforces private-room windows and schema-local extraction across restarts', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'room_continuity' });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    let [agentA, agentB] = processes.agents;
    await agentA.enterPrivateRoom();
    await expect(agentA.sendRoomProbe('pre_entry')).resolves.toMatchObject({ deliveredTo: [] });
    await expect(agentB.channelSnapshot(CERTIFICATION_PRIVATE_ROOM)).resolves.toMatchObject({
      entries: [],
      memories: [],
    });

    await agentB.enterPrivateRoom();
    await agentB.publishAvailability('open_to_chat');
    await expect(agentA.runRoomWeightedThoughtScheduler()).resolves.toMatchObject({
      preferredChannel: 'current_room',
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    const [firstSender, firstRecipient] = await Promise.all([
      waitForChannelEntries(agentA, 1, CERTIFICATION_PRIVATE_ROOM),
      waitForChannelEntries(agentB, 3, CERTIFICATION_PRIVATE_ROOM),
    ]);
    const persistedSenderMessage = firstSender.entries.find(entry => entry.role === 'assistant');
    const deliveredRecipientMessage = firstRecipient.entries.find(entry => (
      entry.role === 'user' && entry.authorId === CERTIFICATION_COMPANION_A
    ));
    expect(persistedSenderMessage?.timestamp).toEqual(expect.any(Number));
    expect(deliveredRecipientMessage?.timestamp).toEqual(expect.any(Number));
    expect(persistedSenderMessage!.timestamp!).toBeLessThanOrEqual(
      deliveredRecipientMessage!.timestamp!,
    );
    expect(firstRecipient.entries.some(entry => entry.role === 'assistant')).toBe(true);

    const [memoryA, memoryB] = await Promise.all([
      waitForExtractionMarker(agentA, 'A'),
      waitForExtractionMarker(agentB, 'B'),
    ]);
    expect(memoryA.memories.some(memory => memory.text.includes('Certification B extraction marker')))
      .toBe(false);
    expect(memoryB.memories.some(memory => memory.text.includes('Certification A extraction marker')))
      .toBe(false);

    agentB = await processes.restartAgent(1);
    await expect(agentA.sendRoomProbe('post_exit')).resolves.toMatchObject({ deliveredTo: [] });
    await agentB.enterPrivateRoom();
    await agentB.publishAvailability('open_to_chat');
    const rejoinedWindow = await agentB.servedChannelSnapshot(CERTIFICATION_PRIVATE_ROOM) as {
      recentEntries: Array<{ content: string; role: string }>;
      roomWindowFilteredEntryCount: number;
      roomWindowFloorMs: number;
      sourceEntryCount: number;
    };
    expect(rejoinedWindow.roomWindowFloorMs).toEqual(expect.any(Number));
    expect(rejoinedWindow.roomWindowFilteredEntryCount).toBeGreaterThan(0);
    expect(rejoinedWindow.recentEntries.filter(entry => (
      entry.role === 'user' || entry.role === 'assistant'
    ))).toEqual([]);
    const rejoinedRaw = await agentB.channelSnapshot(CERTIFICATION_PRIVATE_ROOM) as unknown as ChannelSnapshot;
    expect(JSON.stringify(rejoinedRaw)).not.toContain('pre-entry room probe');
    expect(JSON.stringify(rejoinedRaw)).not.toContain('post-exit room probe');

    await expect(agentA.sendRoomProbe('rejoined')).resolves.toMatchObject({
      deliveredTo: [CERTIFICATION_COMPANION_B],
    });
    await waitForChannelEntries(agentB, rejoinedRaw.entries.length + 2, CERTIFICATION_PRIVATE_ROOM);

    for (let index = 0; index < 20; index += 1) {
      await Promise.all([
        agentA.appendCompactionMarker(CERTIFICATION_PRIVATE_ROOM),
        agentB.appendCompactionMarker(CERTIFICATION_PRIVATE_ROOM),
      ]);
    }
    const roomCompactions = await Promise.all([
      agentA.forceCompaction(CERTIFICATION_PRIVATE_ROOM),
      agentB.forceCompaction(CERTIFICATION_PRIVATE_ROOM),
    ]);
    expect(roomCompactions).toEqual([
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
    ]);

    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-room-schema-assertions',
      max: 1,
    });
    try {
      const trust = await pool.query<{
        companion_user_id: string;
        is_machine_intelligence: boolean;
        relationship_type: string;
        schema_name: string;
        trust_level: string;
      }>(`
        SELECT $1::text AS schema_name, identity.channel_user_id AS companion_user_id,
          contact.trust_level, contact.relationship_type, contact.is_machine_intelligence
        FROM ${CERTIFICATION_SCHEMA_A}.contacts AS contact
        INNER JOIN ${CERTIFICATION_SCHEMA_A}.contact_channel_ids AS identity
          ON identity.contact_id = contact.id AND identity.channel = 'companion'
        UNION ALL
        SELECT $2::text AS schema_name, identity.channel_user_id AS companion_user_id,
          contact.trust_level, contact.relationship_type, contact.is_machine_intelligence
        FROM ${CERTIFICATION_SCHEMA_B}.contacts AS contact
        INNER JOIN ${CERTIFICATION_SCHEMA_B}.contact_channel_ids AS identity
          ON identity.contact_id = contact.id AND identity.channel = 'companion'
        ORDER BY schema_name
      `, [CERTIFICATION_SCHEMA_A, CERTIFICATION_SCHEMA_B]);
      expect(trust.rows).toEqual([
        {
          schema_name: CERTIFICATION_SCHEMA_A,
          companion_user_id: CERTIFICATION_COMPANION_B,
          trust_level: 'trusted',
          relationship_type: 'ai_companion',
          is_machine_intelligence: true,
        },
        {
          schema_name: CERTIFICATION_SCHEMA_B,
          companion_user_id: CERTIFICATION_COMPANION_A,
          trust_level: 'trusted',
          relationship_type: 'ai_companion',
          is_machine_intelligence: true,
        },
      ]);
      const schemaMemories = await pool.query<{ schema_name: string; text: string }>(`
        SELECT $1::text AS schema_name, text
        FROM ${CERTIFICATION_SCHEMA_A}.l2_memories
        WHERE text LIKE 'Certification % extraction marker is schema-private.'
        UNION ALL
        SELECT $2::text AS schema_name, text
        FROM ${CERTIFICATION_SCHEMA_B}.l2_memories
        WHERE text LIKE 'Certification % extraction marker is schema-private.'
        ORDER BY schema_name, text
      `, [CERTIFICATION_SCHEMA_A, CERTIFICATION_SCHEMA_B]);
      expect(schemaMemories.rows.filter(row => row.schema_name === CERTIFICATION_SCHEMA_A))
        .toEqual(expect.arrayContaining([
          { schema_name: CERTIFICATION_SCHEMA_A, text: 'Certification A extraction marker is schema-private.' },
        ]));
      expect(schemaMemories.rows.filter(row => row.schema_name === CERTIFICATION_SCHEMA_A)
        .some(row => row.text.includes('Certification B'))).toBe(false);
      expect(schemaMemories.rows.filter(row => row.schema_name === CERTIFICATION_SCHEMA_B))
        .toEqual(expect.arrayContaining([
          { schema_name: CERTIFICATION_SCHEMA_B, text: 'Certification B extraction marker is schema-private.' },
        ]));
      expect(schemaMemories.rows.filter(row => row.schema_name === CERTIFICATION_SCHEMA_B)
        .some(row => row.text.includes('Certification A'))).toBe(false);
    } finally {
      await pool.end();
    }

    [agentA, agentB] = await processes.restartAgents();
    await Promise.all([agentA.enterPrivateRoom(), agentB.enterPrivateRoom()]);
    const [restartedA, restartedB] = await Promise.all([
      agentA.channelSnapshot(CERTIFICATION_PRIVATE_ROOM) as Promise<unknown> as Promise<ChannelSnapshot>,
      agentB.channelSnapshot(CERTIFICATION_PRIVATE_ROOM) as Promise<unknown> as Promise<ChannelSnapshot>,
    ]);
    expect(restartedA.summaries.length).toBeGreaterThan(0);
    expect(restartedB.summaries.length).toBeGreaterThan(0);
    expect(restartedA.memories.some(memory => (
      memory.text.includes('Certification A extraction marker')
    ))).toBe(true);
    expect(restartedB.memories.some(memory => (
      memory.text.includes('Certification B extraction marker')
    ))).toBe(true);
    expect(JSON.stringify({ restartedA, restartedB })).not.toContain('pre-entry room probe');
    expect(JSON.stringify({ restartedA, restartedB })).not.toContain('post-exit room probe');
  }, TIMEOUT_MS);

  it('continues an ordinary ICP exchange after compaction and both-agent restart', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'room_continuity' });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    let [agentA, agentB] = processes.agents;
    for (let index = 0; index < 20; index += 1) {
      await Promise.all([
        agentA.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
        agentB.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
      ]);
    }
    const compactions = await Promise.all([
      agentA.forceCompaction(CERTIFICATION_DM_CHANNEL),
      agentB.forceCompaction(CERTIFICATION_DM_CHANNEL),
    ]);
    expect(compactions).toEqual([
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
      expect.objectContaining({ compaction: expect.objectContaining({ compacted: true }) }),
    ]);

    [agentA, agentB] = await processes.restartAgents();
    const [senderBefore, recipientBefore] = await Promise.all([
      agentA.channelSnapshot(CERTIFICATION_DM_CHANNEL) as Promise<unknown> as Promise<ChannelSnapshot>,
      agentB.channelSnapshot(CERTIFICATION_DM_CHANNEL) as Promise<unknown> as Promise<ChannelSnapshot>,
    ]);
    expect(senderBefore.summaries.length).toBeGreaterThan(0);
    expect(recipientBefore.summaries.length).toBeGreaterThan(0);

    const recipientTurnsBefore = await agentB.turnRecordsSnapshot(
      CERTIFICATION_DM_CHANNEL,
    ) as unknown as TurnRecordsSnapshot;
    await agentB.publishAvailability('open_to_chat');
    const notification = await agentA.runFreeTimeNotification() as unknown as
      FreeTimeNotificationResult;
    expect(notification).toMatchObject({
      status: 'consumed',
      deliveryDisposition: 'delivered',
      postTurnStatus: 'succeeded',
      rootInitiationId: expect.any(String),
      senderExchange: {
        channelId: CERTIFICATION_DM_CHANNEL,
        conversationId: expect.any(String),
        recipientRequestId: `companion-initiation-${notification.candidateId}`,
        rootInitiationId: notification.rootInitiationId,
        senderRequestId: `icp-initiation:${notification.candidateId}`,
        senderTurnId: expect.any(String),
      },
    });
    const [senderAfter, recipientAfter] = await Promise.all([
      waitForChannelEntries(agentA, senderBefore.entries.length + 1),
      waitForChannelEntries(agentB, recipientBefore.entries.length + 2),
    ]);
    const senderNewEntries = senderAfter.entries.slice(senderBefore.entries.length);
    const recipientNewEntries = recipientAfter.entries.slice(recipientBefore.entries.length);
    const persistedSenderMessage = senderNewEntries.find(entry => entry.role === 'assistant');
    const deliveredRecipientMessage = recipientNewEntries.find(entry => (
      entry.role === 'user' && entry.authorId === CERTIFICATION_COMPANION_A
    ));
    const recipientReply = recipientNewEntries.find(entry => entry.role === 'assistant');
    expect(persistedSenderMessage?.timestamp).toEqual(expect.any(Number));
    expect(deliveredRecipientMessage?.timestamp).toEqual(expect.any(Number));
    expect(persistedSenderMessage!.timestamp!).toBeLessThanOrEqual(
      deliveredRecipientMessage!.timestamp!,
    );
    expect(recipientReply?.timestamp).toEqual(expect.any(Number));

    const recipientTurns = await agentB.turnRecordsSnapshot(
      CERTIFICATION_DM_CHANNEL,
    ) as unknown as TurnRecordsSnapshot;
    expect(recipientTurns.records.slice(0, recipientTurnsBefore.records.length)).toEqual(
      recipientTurnsBefore.records,
    );
    const newRecipientTurns = recipientTurns.records.slice(recipientTurnsBefore.records.length);
    expect(newRecipientTurns).toHaveLength(1);
    const [completedRecipientTurn] = newRecipientTurns;
    expect(completedRecipientTurn).toMatchObject({
      status: 'completed',
      hasAssistantMessage: true,
      requestId: notification.senderExchange.recipientRequestId,
      turnId: expect.any(String),
      correlation: {
        channelId: notification.senderExchange.channelId,
        conversationId: notification.senderExchange.conversationId,
        fatigueDecision: 'allow',
        localCompanionId: CERTIFICATION_COMPANION_B,
        peerCompanionId: CERTIFICATION_COMPANION_A,
        requestId: notification.senderExchange.recipientRequestId,
        rootInitiationId: notification.rootInitiationId,
        turnId: completedRecipientTurn.turnId,
      },
    });
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
      await expect(agentA.runFreeTimeNotification()).resolves
        .toMatchObject({ status: 'consumed' });

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
      const providerRequestCount = await waitForModelRequestQuiescence(processes);
      const dispatchCounts = await readProviderDispatchCounts(databaseUrl);
      expect(dispatchCounts.reduce((sum, row) => sum + row.count, 0)).toBe(providerRequestCount);
      expect(dispatchCounts.some(row => row.companionId === CERTIFICATION_COMPANION_B)).toBe(false);
      expect(dispatchCounts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          companionId: CERTIFICATION_COMPANION_A,
          conversationId: blocked.conversationId,
          count: expect.any(Number),
        }),
      ]));
      expect(dispatchCounts.find(row => (
        row.companionId === CERTIFICATION_COMPANION_A
        && row.conversationId === blocked.conversationId
      ))!.count).toBeGreaterThan(0);
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
    await expect(agentA.runFreeTimeNotification()).resolves.toMatchObject({
      status: 'permitted',
      postTurnStatus: 'retry_scheduled',
    });
    const blocked = await waitForBlockedCostDecision(processes, 'missing_cost_metadata');
    expect(blocked).toMatchObject({
      localCompanionId: CERTIFICATION_COMPANION_A,
      outcome: 'blocked',
      reason: 'missing_cost_metadata',
    });
    const providerRequestCount = await waitForModelRequestQuiescence(processes);
    const dispatchCounts = await readProviderDispatchCounts(databaseUrl);
    expect(dispatchCounts.reduce((sum, row) => sum + row.count, 0)).toBe(providerRequestCount);
    expect(dispatchCounts.some(row => row.companionId === CERTIFICATION_COMPANION_B)).toBe(false);
    expect(dispatchCounts.some(row => row.conversationId === blocked.conversationId)).toBe(false);
    expect(providerRequestCount).toBe(1);
  }, TIMEOUT_MS);

  it('closes deterministic gates before the LLM and resists replay after weighted-thought consent', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, fatigueProfile: 'final_reserve' });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    const [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('do_not_disturb');
    await expect(agentA.runFreeTimeNotification()).resolves.toMatchObject({
      status: 'rejected',
      reasonCode: 'peer_do_not_disturb',
    });
    expect(processes.modelRequestCount).toBe(0);

    await agentB.publishAvailability('open_to_chat');
    processes.queueConsentDecision('defer');
    await expect(agentA.runWeightedThoughtScheduler()).resolves
      .toMatchObject({
        status: 'deferred',
        reasonCode: 'candidate_deferred',
      });
    processes.queueConsentDecision('decline');
    await expect(agentA.runWeightedThoughtScheduler()).resolves
      .toMatchObject({
        status: 'declined',
        reasonCode: 'candidate_declined',
      });

    await Promise.all([
      agentA.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
      agentB.appendCompactionMarker(CERTIFICATION_DM_CHANNEL),
    ]);
    const sent = await agentA.runWeightedThoughtScheduler();
    expect(sent).toMatchObject({
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    const providerRequestsAfterConversation = await waitForModelRequestQuiescence(processes);
    const rootInitiationId = String(sent.rootInitiationId);
    const reservationPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-icp-certification-fatigue-exhaustion-assertions',
      max: 1,
    });
    const exhaustedCompanion = await (async () => {
      try {
        return await reservationPool.query<{ local_companion_id: string }>(`
          SELECT local_companion_id::text
          FROM shared.icp_fatigue_turn_reservations
          WHERE outcome IN ('delivered', 'no_reply')
            AND root_initiation_id = $1
          GROUP BY local_companion_id
          HAVING COUNT(*) FILTER (WHERE decision = 'charged') > 0
            AND COUNT(*) FILTER (WHERE decision = 'overcharge') > 0
          ORDER BY local_companion_id
          LIMIT 1
        `, [rootInitiationId]);
      } finally {
        await reservationPool.end();
      }
    })();
    const exhaustedCompanionId = exhaustedCompanion.rows.at(0)?.local_companion_id;
    expect(exhaustedCompanionId).toBeTruthy();
    const exhaustedAgent = exhaustedCompanionId === CERTIFICATION_COMPANION_A ? agentA : agentB;
    const exhaustedTurns = await exhaustedAgent.turnRecordsSnapshot(
      CERTIFICATION_DM_CHANNEL,
    ) as unknown as TurnRecordsSnapshot;
    const suppressedTurns = exhaustedTurns.records.filter(record => (
      record.correlation?.rootInitiationId === rootInitiationId
      && record.correlation.fatigueDecision === 'suppress'
    ));
    expect(suppressedTurns, JSON.stringify(exhaustedTurns.records)).not.toHaveLength(0);
    expect(suppressedTurns.every(record => record.status === 'completed')).toBe(true);

    await expect(exhaustedAgent.runRecursiveWeightedThoughtScheduler(rootInitiationId)).resolves
      .toMatchObject({ status: 'rejected', reasonCode: 'recursive_trigger' });
    await Promise.all([agentA.enterPrivateRoom(), agentB.enterPrivateRoom()]);
    const roomEvasion = await exhaustedAgent.runRoomWeightedThoughtScheduler();
    expect(['deferred', 'rejected']).toContain(roomEvasion.status);
    expect(['charge_pressure', 'fatigue_exhausted']).toContain(roomEvasion.reasonCode);
    expect(await waitForModelRequestQuiescence(processes)).toBe(providerRequestsAfterConversation);

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
      expect(fatigue.rows.some(row => row.decision === 'charged')).toBe(true);
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
    expect(artifactText).not.toContain('Private recursive weighted-thought certification probe');
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
    await expect(agentA.activateGardenEmergencyDisable()).resolves.toMatchObject({
      enabled: false,
      lease: { state: 'do_not_disturb' },
    });
    await expect(agentA.runFreeTimeNotification()).rejects
      .toThrow(/not capability\/tool-policy authorized/i);
    expect(processes.modelRequestCount).toBe(0);

    let [restartedA, restartedB] = await processes.restartAgents();
    await restartedB.publishAvailability('open_to_chat');
    await expect(restartedA.runFreeTimeNotification()).rejects
      .toThrow(/autonomy is disabled by scheduler\.json/i);
    expect(processes.modelRequestCount).toBe(0);

    setIcpCertificationAutonomyEnabled(fixture, true);
    [restartedA, restartedB] = await processes.restartAgents();
    await restartedB.publishAvailability('open_to_chat');
    await expect(restartedA.runFreeTimeNotification()).resolves
      .toMatchObject({
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
    expect(processes.modelRequestCount).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('reports real recipient failure, retries once after restart, and collapses the duplicate frame', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl });
    processes = await startIcpCertificationProcessHarness({ databaseUrl, fixture });

    let [agentA, agentB] = processes.agents;
    await agentB.publishAvailability('open_to_chat');
    await agentB.armNextCompanionTurnFailure();
    const initial = await agentA.runFreeTimeNotification();
    expect(initial).toMatchObject({
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    const candidateId = String(initial.candidateId);
    const failureDeadline = Date.now() + 20_000;
    while (await agentA.failureObservationCount() < 1) {
      if (Date.now() >= failureDeadline) {
        throw new Error('Timed out waiting for the sender delivery-failure observation');
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    expect(await agentB.channelSnapshot(CERTIFICATION_DM_CHANNEL)).toMatchObject({ entries: [] });

    [agentA, agentB] = await processes.restartGatewayAndAgents();
    const beforeRetry = await agentB.channelSnapshot(CERTIFICATION_DM_CHANNEL) as unknown as ChannelSnapshot;
    await expect(agentA.retryCandidateDelivery(candidateId)).resolves.toMatchObject({
      disposition: 'delivered',
    });
    await waitForChannelEntries(
      agentB,
      beforeRetry.entries.length + 2,
      CERTIFICATION_DM_CHANNEL,
    );
    const requestsAfterRetry = await waitForModelRequestQuiescence(processes);
    const settledAfterRetry = await agentB.channelSnapshot(
      CERTIFICATION_DM_CHANNEL,
    ) as unknown as ChannelSnapshot;
    await expect(agentA.retryCandidateDelivery(candidateId)).resolves.toMatchObject({
      disposition: 'delivered',
    });
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    const afterDuplicate = await agentB.channelSnapshot(
      CERTIFICATION_DM_CHANNEL,
    ) as unknown as ChannelSnapshot;
    expect(afterDuplicate.entries).toHaveLength(settledAfterRetry.entries.length);
    expect(await waitForModelRequestQuiescence(processes)).toBe(requestsAfterRetry);

    await processes.rejectMalformedFrame();
    await processes.stopAgent(0);
    await processes.rejectAuthenticatedSpoof(0);
    agentA = await processes.restartAgent(0);
    await expect(agentA.ready()).resolves.toMatchObject({
      companionId: CERTIFICATION_COMPANION_A,
      multiCompanion: true,
    });
  }, TIMEOUT_MS);

  it('boots one genuine single-companion feature-off agent without ICP stores or LLM calls', async () => {
    if (!postgres) throw new Error('Postgres certification harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({
      databaseUrl,
      autonomyEnabled: false,
      topology: 'single_companion',
    });
    singleProcess = await startIcpSingleCompanionFeatureOffHarness({ fixture });

    await expect(singleProcess.agent.ready()).resolves.toMatchObject({
      companionId: CERTIFICATION_COMPANION_A,
      multiCompanion: false,
      runtimeClass: 'SubstrateAgent',
    });
    await expect(singleProcess.agent.runFreeTimeNotification()).rejects
      .toThrow(/autonomy is disabled by scheduler\.json/i);
    expect(singleProcess.modelRequestCount).toBe(0);
    await expect(singleProcess.agent.channelSnapshot(CERTIFICATION_DM_CHANNEL)).resolves.toMatchObject({
      entries: [],
      summaries: [],
    });
  }, TIMEOUT_MS);
});
