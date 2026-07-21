import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  PrimaryEmbodimentHandoffDeniedError,
} from '../../../boundary/fleet-auth/primary-embodiment.js';
import type { HubDeviceAttachmentSnapshot } from '../../../shared/contracts/hub-device-ingress.js';
import { PostgresPrimaryEmbodimentStore } from './primary-embodiment-store.js';

interface QueryLog {
  readonly texts: string[];
  released: number;
}

/**
 * A pool whose transaction body throws a specific Postgres error on the first
 * data query after BEGIN. BEGIN and ROLLBACK always succeed so the store's
 * rollback path runs exactly as it would in production.
 */
function throwingPool(error: unknown): { pool: Pool; log: QueryLog } {
  const log: QueryLog = { texts: [], released: 0 };
  const client = {
    query: async (text: string) => {
      log.texts.push(text.trim().split('\n')[0]!.trim());
      if (/^BEGIN/i.test(text.trim()) || /ROLLBACK/i.test(text)) {
        return { rows: [] };
      }
      throw error;
    },
    release: () => {
      log.released += 1;
    },
  } as unknown as PoolClient;
  const pool = {
    connect: async () => client,
  } as unknown as Pool;
  return { pool, log };
}

function validHandoffInput(companionId: string): Parameters<PostgresPrimaryEmbodimentStore['handoff']>[0] {
  const attachment = {
    attachmentId: randomUUID(),
    deviceActor: {
      kind: 'hub_device',
      principal: {
        deviceId: randomUUID(),
        enrollmentVersion: 1,
        companionId,
        sessionId: randomUUID(),
      },
      connectionId: 'conn-1',
    },
    actor: { kind: 'guest', companionId },
    channel: { source: 'server', id: `hub-device:${'a'.repeat(64)}`, companionId },
  } as unknown as HubDeviceAttachmentSnapshot;
  return {
    companionId,
    attachment,
    expectedGeneration: 0,
    decisionId: randomUUID(),
    reason: 'user_requested',
  };
}

describe('PostgresPrimaryEmbodimentStore.handoff serialization handling (psfn-framework-q9q0)', () => {
  it('normalizes a 40001 serialization failure into a stale_generation denial', async () => {
    const companionId = randomUUID();
    const serializationError = Object.assign(
      new Error('could not serialize access due to read/write dependencies among transactions'),
      { code: '40001' },
    );
    const { pool, log } = throwingPool(serializationError);
    const store = new PostgresPrimaryEmbodimentStore({ pool });

    await expect(store.handoff(validHandoffInput(companionId))).rejects.toMatchObject({
      name: 'PrimaryEmbodimentHandoffDeniedError',
      code: 'stale_generation',
    });
    // The transaction was rolled back and the client returned to the pool.
    expect(log.texts.some(text => /ROLLBACK/i.test(text))).toBe(true);
    expect(log.released).toBe(1);
  });

  it('does not mask a non-serialization driver error as a denial', async () => {
    const companionId = randomUUID();
    const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { pool, log } = throwingPool(uniqueViolation);
    const store = new PostgresPrimaryEmbodimentStore({ pool });

    const rejection = await store.handoff(validHandoffInput(companionId)).catch((e: unknown) => e);
    expect(rejection).toBe(uniqueViolation);
    expect(rejection).not.toBeInstanceOf(PrimaryEmbodimentHandoffDeniedError);
    expect(log.released).toBe(1);
  });
});
