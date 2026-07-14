import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  CERTIFICATION_COMPANION_A,
  CERTIFICATION_COMPANION_B,
  CERTIFICATION_DM_CHANNEL,
  CERTIFICATION_SCHEMA_A,
  CERTIFICATION_SCHEMA_B,
} from './constants.js';
import { createIcpCertificationFixture, type IcpCertificationFixture } from './fixture.js';
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
});
