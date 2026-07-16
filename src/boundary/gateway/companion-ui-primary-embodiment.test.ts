import { describe, expect, it, vi } from 'vitest';
import { compileCompanionUiAction } from '../fleet-auth/companion-ui-action.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { HubDeviceAttachmentSnapshot } from '../../shared/contracts/hub-device-ingress.js';
import { dispatchCompanionUiPrimaryEmbodiment } from './companion-ui-primary-embodiment.js';

const companionId = createCompanionId('11111111-1111-4111-8111-111111111111');
const attachment = {
  attachmentId: '22222222-2222-4222-8222-222222222222',
  disposition: 'created',
  deviceActor: {
    kind: 'hub_device',
    principal: {
      kind: 'hub_device', issuer: 'hub', keyId: 'key', deviceId: 'server-device',
      enrollmentVersion: 2, enrollmentAssurance: 'device_credential', placeId: 'server-place',
      audience: 'https://fleet.example.test', companionId, sessionId: 'server-session',
      issuedAt: '2026-07-16T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
      jti: '33333333-3333-4333-8333-333333333333',
    },
    connectionId: 'server-connection',
  },
  actor: {
    kind: 'human', principalId: '44444444-4444-4444-8444-444444444444', companionId,
    providerSubject: { provider: 'discord', subjectId: '123456789012345678' },
    contact: { bindingId: '55555555-5555-4555-8555-555555555555', contactId: 'contact', bindingVersion: 1 },
    operator: { grantId: '66666666-6666-4666-8666-666666666666', role: 'admin', grantVersion: 1 },
    session: { recordId: '77777777-7777-4777-8777-777777777777', authorityGeneration: 1, globalAuthEpoch: 1 },
  },
  channel: { source: 'server', id: `hub-device:${'a'.repeat(64)}`, companionId },
} as const satisfies HubDeviceAttachmentSnapshot;

function compiled(resource: 'conversation.interact' | 'embodiment.handoff', body: unknown) {
  return compileCompanionUiAction(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: 'request-1',
    action: resource === 'embodiment.handoff' ? 'embodiment.handoff' : 'companion.interact',
    resource,
    body,
  })), companionId, { capabilities: ['text'], telemetryScopes: [] });
}

describe('Companion UI primary embodiment dispatch', () => {
  it('does not infer handoff from an ordinary browser interaction', async () => {
    const handoff = vi.fn();
    await expect(dispatchCompanionUiPrimaryEmbodiment({
      compiled: compiled('conversation.interact', { content: 'hello from another display' }),
      attachment,
      authority: { read: vi.fn(), handoff },
    })).resolves.toEqual({ handled: false });
    expect(handoff).not.toHaveBeenCalled();
  });

  it('hands off only the server attachment and returns no device, place, or attachment identifier', async () => {
    const handoff = vi.fn(async () => ({
      companionId,
      generation: 1,
      version: 1,
      current: {
        attachmentId: attachment.attachmentId,
        deviceId: attachment.deviceActor.principal.deviceId,
        enrollmentVersion: 2,
        hubSessionId: attachment.deviceActor.principal.sessionId,
      },
      lastDecision: {
        decisionId: '88888888-8888-4888-8888-888888888888',
        decision: 'handoff' as const,
        reason: 'user_requested' as const,
        decidedAt: '2026-07-16T01:00:00.000Z',
      },
    }));
    const result = await dispatchCompanionUiPrimaryEmbodiment({
      compiled: compiled('embodiment.handoff', {
        expectedGeneration: 0,
        decisionId: '88888888-8888-4888-8888-888888888888',
        reason: 'user_requested',
      }),
      attachment,
      authority: { read: vi.fn(), handoff },
    });
    expect(handoff).toHaveBeenCalledWith(expect.objectContaining({
      companionId,
      attachment,
      expectedGeneration: 0,
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('server-device');
    expect(serialized).not.toContain('server-place');
    expect(serialized).not.toContain(attachment.attachmentId);
    expect(serialized).not.toContain('88888888-8888-4888-8888-888888888888');
  });
});
