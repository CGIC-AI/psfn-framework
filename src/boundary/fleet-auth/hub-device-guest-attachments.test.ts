import { describe, expect, it } from 'vitest';
import { GuestOnlyHubDeviceAttachmentStore } from './hub-device-guest-attachments.js';
import type {
  AuthenticatedHubDeviceConnection,
  HubDeviceHumanAttachmentPort,
} from './hub-device-ingress.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function attachInput(connectionId: string, assertionDigest = `digest-${connectionId}`) {
  const connection: AuthenticatedHubDeviceConnection = {
    connectionId,
    deviceId: 'office-device',
    enrollmentVersion: 1,
    enrollmentStatus: 'active',
    companionId: COMPANION_ID,
    sessionId: 'realtime:office-device:session',
  };
  return {
    assertionDigest,
    connection,
    devicePrincipal: {
      deviceId: 'office-device',
      companionId: COMPANION_ID,
      sessionId: 'realtime:office-device:session',
      enrollmentVersion: 1,
    },
    human: { kind: 'guest' as const },
  } as unknown as Parameters<HubDeviceHumanAttachmentPort['attach']>[0];
}

describe('GuestOnlyHubDeviceAttachmentStore attachment bounds', () => {
  it('sweeps attachments after the assertion window and caps the map', async () => {
    let nowMs = 0;
    const store = new GuestOnlyHubDeviceAttachmentStore({
      now: () => nowMs,
      fenceTtlMs: 70_000,
      maxFences: 3,
    });
    for (const id of ['c1', 'c2', 'c3', 'c4']) await store.attach(attachInput(id));
    expect(store.attachmentCount).toBe(3);

    // A retry inside the window is still recognized.
    await expect(store.attach(attachInput('c4'))).resolves.toMatchObject({ disposition: 'retry' });

    nowMs += 70_000;
    await store.attach(attachInput('c5'));
    expect(store.attachmentCount).toBe(1);
  });
});
