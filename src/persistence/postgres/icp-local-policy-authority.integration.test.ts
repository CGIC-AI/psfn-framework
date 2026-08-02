import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { deriveIcpLocalPolicyAcquirePayloadDigest } from '../../core/icp/local-policy-contract.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresIcpLocalPolicyAuthority } from './icp-local-policy-authority.js';

const TIMEOUT_MS = 120_000;
const SENDER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const ROOT_ID = '44444444-4444-4444-8444-444444444444';
const HOLD_ID = '55555555-5555-4555-8555-555555555555';
const NONCE = '66666666-6666-4666-8666-666666666666';
const SCHEMA = 'tenant_a';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

describe('companion-local ICP retained lock integration', () => {
  it('holds the exact contact mutation behind acquire until release', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const databaseUrl = (await harness.createDatabase()).databaseUrl;
    const adminPool = createPostgresPool(databaseUrl);
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-icp-local-policy-'));
    let authority: PostgresIcpLocalPolicyAuthority | null = null;
    const tenantPool = createPostgresPool(databaseUrl, { schema: SCHEMA, max: 2 });
    try {
      await adminPool.query(`CREATE SCHEMA ${SCHEMA}`);
      await adminPool.query(`
        CREATE TABLE ${SCHEMA}.contacts (
          id TEXT PRIMARY KEY,
          trust_level TEXT NOT NULL,
          relationship_type TEXT NOT NULL,
          is_machine_intelligence BOOLEAN NOT NULL
        );
        CREATE TABLE ${SCHEMA}.contact_channel_ids (
          contact_id TEXT NOT NULL REFERENCES ${SCHEMA}.contacts(id),
          channel TEXT NOT NULL,
          channel_user_id TEXT NOT NULL,
          PRIMARY KEY (contact_id, channel, channel_user_id)
        );
        CREATE TABLE ${SCHEMA}.icp_initiation_candidates (
          candidate_id UUID PRIMARY KEY,
          root_initiation_id UUID NOT NULL,
          local_companion_id UUID NOT NULL,
          peer_contact_id TEXT NOT NULL REFERENCES ${SCHEMA}.contacts(id),
          peer_companion_id UUID NOT NULL,
          preferred_channel TEXT NOT NULL,
          source TEXT NOT NULL,
          provenance_ref TEXT NOT NULL,
          created_at_ms BIGINT NOT NULL,
          expires_at_ms BIGINT NOT NULL,
          status TEXT NOT NULL,
          reason_code TEXT,
          initiation_permit_id UUID,
          revision BIGINT NOT NULL
        )
      `);
      await adminPool.query(`
        INSERT INTO ${SCHEMA}.contacts
          (id, trust_level, relationship_type, is_machine_intelligence)
        VALUES ('private-contact-id', 'regular', 'friend', TRUE);
        INSERT INTO ${SCHEMA}.contact_channel_ids
          (contact_id, channel, channel_user_id)
        VALUES ('private-contact-id', 'companion', '${RECIPIENT_ID}');
        INSERT INTO ${SCHEMA}.icp_initiation_candidates
          (candidate_id, root_initiation_id, local_companion_id, peer_contact_id,
           peer_companion_id, preferred_channel, source, provenance_ref,
           created_at_ms, expires_at_ms, status, revision)
        VALUES ('${CANDIDATE_ID}', '${ROOT_ID}', '${SENDER_ID}', 'private-contact-id',
          '${RECIPIENT_ID}', 'dm', 'intention', 'icp-prov:${ROOT_ID}',
          1000, 20000, 'pending', 1)
      `);

      let nowMs = 2_000;
      authority = new PostgresIcpLocalPolicyAuthority(databaseUrl, {
        companionId: SENDER_ID,
        postgresSchema: SCHEMA,
        companionDataDir: dataDir,
        quietHours: {
          enabled: false,
          startLocalTime: '22:00',
          endLocalTime: '07:00',
          timeZone: 'UTC',
        },
        policyHolds: { ttlMs: 10_000, maxOutstanding: 2 },
        capacityAuthority: {
          resolve: async () => ({
            socialPressureAllows: true,
            chargeAllows: true,
            fatigueAllows: true,
            costAllows: true,
          }),
        },
        pool: tenantPool,
        now: () => nowMs,
        randomUuid: () => HOLD_ID,
      });
      await authority.assertReady();
      const candidate = {
        candidateId: CANDIDATE_ID,
        rootInitiationId: ROOT_ID,
        localCompanionId: SENDER_ID,
        peerCompanionId: RECIPIENT_ID,
        preferredChannel: 'dm',
        source: 'intention',
        provenanceRef: `icp-prov:${ROOT_ID}`,
        createdAtMs: 1_000,
        expiresAtMs: 20_000,
        status: 'pending',
        revision: 1,
      } as const;
      const binding = {
        role: 'sender',
        phase: 'issue',
        senderCompanionId: SENDER_ID,
        recipientCompanionId: RECIPIENT_ID,
        candidate,
        channelId: `companion-dm:${SENDER_ID}:${RECIPIENT_ID}`,
        nonce: NONCE,
        nowMs,
        expiresAtMs: 12_000,
        relationshipPressure: 0,
      } as const;
      const payloadDigest = deriveIcpLocalPolicyAcquirePayloadDigest(binding);
      await expect(authority.acquire({ ...binding, payloadDigest })).resolves.toEqual({
        acquired: true,
        holdId: HOLD_ID,
        expiresAtMs: 12_000,
      });

      const mutation = adminPool.query(`
        UPDATE ${SCHEMA}.contacts
        SET trust_level = 'high'
        WHERE id = 'private-contact-id'
        RETURNING trust_level
      `);
      const stateWhileHeld = await Promise.race([
        mutation.then(() => 'mutated' as const),
        delay(200).then(() => 'waiting' as const),
      ]);
      expect(stateWhileHeld).toBe('waiting');

      nowMs = 2_100;
      await authority.release({ holdId: HOLD_ID, payloadDigest, nonce: NONCE });
      await expect(mutation).resolves.toMatchObject({ rows: [{ trust_level: 'high' }] });
    } finally {
      try {
        await authority?.close();
      } finally {
        try {
          await tenantPool.end();
        } finally {
          await adminPool.end();
          rmSync(dataDir, { recursive: true, force: true });
        }
      }
    }
  }, TIMEOUT_MS);
});
