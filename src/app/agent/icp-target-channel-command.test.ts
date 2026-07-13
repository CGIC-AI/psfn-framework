import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  icpTargetChannelInitiationCommand,
  registerIcpTargetChannelInitiationCommand,
} from './icp-target-channel-command.js';
import type {
  IcpTargetChannelInitiationRequest,
  IcpTargetChannelInitiator,
} from './icp-target-channel-initiation.js';

const unregisterCallbacks: Array<() => void> = [];

afterEach(() => {
  for (const unregister of unregisterCallbacks.splice(0).reverse()) unregister();
});

function makeRequest(): IcpTargetChannelInitiationRequest {
  return {
    permit: {
      permitId: 'permit-command-1',
      candidateId: 'candidate-command-1',
      conversationId: 'conversation-command-1',
      senderCompanionId: 'companion-a',
      recipientCompanionId: 'companion-b',
      channelId: 'companion-dm:companion-a:companion-b',
      issuedAtMs: 1_800_000_000_000,
      expiresAtMs: 1_800_000_060_000,
      status: 'issued',
      revision: 1,
    },
    rootInitiationId: 'root-command-1',
    peerContactId: 'contact-companion-b',
  };
}

describe('icpTargetChannelInitiationCommand', () => {
  it('fails closed before the authenticated agent runtime registers an initiator', async () => {
    await expect(icpTargetChannelInitiationCommand.execute(makeRequest()))
      .rejects.toThrow('not registered');
  });

  it('delegates through the registered internal port and unregisters on shutdown', async () => {
    const request = makeRequest();
    const initiate = vi.fn(async () => ({
      disposition: 'suppressed' as const,
      recoveredTurn: false,
      correlation: {
        conversationId: 'conversation-command-1',
      },
    })) as IcpTargetChannelInitiator['initiate'];
    const unregister = registerIcpTargetChannelInitiationCommand({ initiate });
    unregisterCallbacks.push(unregister);

    await icpTargetChannelInitiationCommand.execute(request);

    expect(initiate).toHaveBeenCalledWith(request);
    unregister();
    await expect(icpTargetChannelInitiationCommand.execute(request))
      .rejects.toThrow('not registered');
  });

  it('rejects competing production registrations', () => {
    const first: IcpTargetChannelInitiator = { initiate: vi.fn() };
    const unregister = registerIcpTargetChannelInitiationCommand(first);
    unregisterCallbacks.push(unregister);

    expect(() => registerIcpTargetChannelInitiationCommand({ initiate: vi.fn() }))
      .toThrow('already registered');
  });
});
