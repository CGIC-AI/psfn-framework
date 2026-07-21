import type { Pool, PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresHubDeviceHumanAttachmentStore } from './hub-device-human-attachment-store.js';

function validAttachmentInput(): Parameters<PostgresHubDeviceHumanAttachmentStore['attach']>[0] {
  return {
    assertionDigest: 'a'.repeat(64),
    devicePrincipal: {
      kind: 'hub_device',
      issuer: 'psfn-satellite-hub',
      keyId: 'hub-key-1',
      deviceId: 'office-device',
      enrollmentVersion: 1,
      enrollmentAssurance: 'device_credential',
      audience: 'psfn-gateway',
      companionId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'hub-session-1',
      issuedAt: '2026-07-21T00:00:00.000Z',
      expiresAt: '2026-07-22T00:00:00.000Z',
      jti: 'hub-assertion-1',
    },
    connection: {
      connectionId: 'hub-connection-1',
      deviceId: 'office-device',
      enrollmentVersion: 1,
      enrollmentStatus: 'active',
      companionId: '11111111-1111-4111-8111-111111111111',
      sessionId: 'hub-session-1',
    },
    human: { kind: 'guest' },
  };
}

describe('PostgresHubDeviceHumanAttachmentStore serialization retry', () => {
  it('returns the failed client before the retry acquires another pool client', async () => {
    const serializationError = Object.assign(
      new Error('could not serialize access due to concurrent update'),
      { code: '40001' },
    );
    const stopRetry = new Error('stop after retry acquisition');
    let firstClientReleased = false;
    let requestSecondClient!: () => void;
    const secondClientRequested = new Promise<void>((resolve) => {
      requestSecondClient = resolve;
    });
    let rejectSecondClient!: (error: unknown) => void;
    const secondClient = new Promise<PoolClient>((_resolve, reject) => {
      rejectSecondClient = reject;
    });
    const firstClient = {
      query: async (text: string) => {
        if (/^BEGIN/u.test(text.trim())) throw serializationError;
        if (/ROLLBACK/u.test(text)) return { rows: [] };
        throw new Error(`Unexpected query: ${text}`);
      },
      release: () => {
        firstClientReleased = true;
      },
    } as unknown as PoolClient;
    let connectionCount = 0;
    const pool = {
      connect: async () => {
        connectionCount += 1;
        if (connectionCount === 1) return firstClient;
        requestSecondClient();
        return await secondClient;
      },
    } as unknown as Pool;
    const store = new PostgresHubDeviceHumanAttachmentStore({
      pool,
      resolveAuthorizationContext: async () => {
        throw new Error('Guest attachment must not resolve a browser session');
      },
    });

    const attachment = store.attach(validAttachmentInput());
    await secondClientRequested;
    try {
      expect(firstClientReleased).toBe(true);
    } finally {
      rejectSecondClient(stopRetry);
      await expect(attachment).rejects.toBe(stopRetry);
    }
  });
});
