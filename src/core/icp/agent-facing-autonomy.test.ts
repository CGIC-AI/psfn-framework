import { describe, expect, it, vi } from 'vitest';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type { Contact } from '../contacts/types.js';
import type { IcpInitiationPermit } from '../../shared/contracts/icp-autonomy.js';
import { createAgentFacingIcpAutonomyRuntime } from './agent-facing-autonomy.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'peer-contact-b',
    displayName: 'Peer B',
    trustLevel: 'regular',
    relationshipType: 'peer',
    isMachineIntelligence: true,
    channelIdentities: [{ channel: 'companion', userId: B }],
    firstSeen: '2026-07-01T00:00:00.000Z',
    lastSeen: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

function permit(overrides: Partial<IcpInitiationPermit> = {}): IcpInitiationPermit {
  return {
    permitId: PERMIT_ID,
    candidateId: '11111111-1111-4111-8111-111111111111',
    conversationId: '33333333-3333-4333-8333-333333333333',
    senderCompanionId: A,
    recipientCompanionId: B,
    channelId: `companion-dm:${A}:${B}`,
    provenanceRef: 'icp-prov:11111111-1111-4111-8111-111111111111',
    issuedAtMs: 1_000,
    expiresAtMs: 10_000,
    status: 'issued',
    revision: 1,
    ...overrides,
  };
}

function setup(contacts: Contact[] = [contact()]) {
  const byId = new Map(contacts.map(entry => [entry.id, entry]));
  const store = {
    getById: vi.fn((id: string) => byId.get(id)),
    getByChannelIdentity: vi.fn((channel: string, userId: string) => (
      contacts.find(entry => entry.channelIdentities?.some(identity => (
        identity.channel === channel && identity.userId === userId
      )))
    )),
    listAll: vi.fn(() => contacts),
  } as unknown as ContactStorePort;
  const gateway = {
    companionReadOwnAvailability: vi.fn(),
    companionPublishAvailability: vi.fn(),
    companionClearAvailability: vi.fn(),
    companionReadPeerAvailability: vi.fn().mockResolvedValue({
      peerCompanionId: B,
      connectionState: 'online',
      eligible: true,
      lease: {
        companionId: B,
        state: 'open_to_chat',
        issuedAtMs: 1_000,
        expiresAtMs: 10_000,
        source: 'companion',
        revision: 1,
      },
    }),
    companionPrepareInitiationHandoff: vi.fn().mockResolvedValue({
      authorized: true,
      permit: permit(),
      rootInitiationId: '22222222-2222-4222-8222-222222222222',
    }),
  };
  const command = { execute: vi.fn().mockResolvedValue({ disposition: 'delivered' }) };
  const runtime = createAgentFacingIcpAutonomyRuntime({ contactStore: store, gateway, command });
  return { runtime, store, gateway, command };
}

describe('agent-facing ICP autonomy runtime', () => {
  it('exposes coarse availability only for an exact reverse-resolved MI contact', async () => {
    const { runtime, gateway } = setup();
    await expect(runtime.readKnownPeerAvailability(contact())).resolves.toMatchObject({
      contactId: 'peer-contact-b',
      peerCompanionId: B,
      availability: { eligible: true, connectionState: 'online' },
    });
    expect(gateway.companionReadPeerAvailability).toHaveBeenCalledWith({ peerCompanionId: B });
  });

  it.each([
    contact({ isMachineIntelligence: false }),
    contact({ channelIdentities: [] }),
    contact({ channelIdentities: [{ channel: 'companion', userId: 'not-a-uuid' }] }),
    contact({ channelIdentities: [
      { channel: 'companion', userId: B },
      { channel: 'companion', userId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
    ] }),
  ])('omits invalid or ambiguous peer mappings without probing the fleet', async invalidContact => {
    const { runtime, gateway } = setup([invalidContact]);
    await expect(runtime.listKnownPeerAvailability()).resolves.toEqual([]);
    expect(gateway.companionReadPeerAvailability).not.toHaveBeenCalled();
  });

  it('omits a mapping that reverse-resolves to a different canonical contact', async () => {
    const { runtime, store, gateway } = setup();
    vi.mocked(store.getByChannelIdentity).mockReturnValue(contact({ id: 'different-contact' }));
    await expect(runtime.listKnownPeerAvailability()).resolves.toEqual([]);
    expect(gateway.companionReadPeerAvailability).not.toHaveBeenCalled();
  });

  it.each(['lookup', 'list'])('propagates contact-store infrastructure failures during %s', async mode => {
    const { runtime, store, gateway } = setup();
    vi.mocked(store.getByChannelIdentity).mockRejectedValue(new Error('postgres connection lost'));
    const operation = mode === 'lookup'
      ? runtime.readKnownPeerAvailability(contact())
      : runtime.listKnownPeerAvailability();
    await expect(operation).rejects.toThrow('postgres connection lost');
    expect(gateway.companionReadPeerAvailability).not.toHaveBeenCalled();
  });

  it('prepares and executes the exact permit/contact binding through the target command', async () => {
    const { runtime, gateway, command } = setup();
    await runtime.executeCompanionOutreach('peer-contact-b', PERMIT_ID, 'research');
    expect(gateway.companionPrepareInitiationHandoff).toHaveBeenCalledWith({
      permitId: PERMIT_ID,
      peerContactId: 'peer-contact-b',
    });
    expect(command.execute).toHaveBeenCalledWith({
      permit: permit(),
      rootInitiationId: '22222222-2222-4222-8222-222222222222',
      peerContactId: 'peer-contact-b',
      continuationTaskKind: 'research',
    });
  });

  it('rejects recipient substitution before the target-channel command', async () => {
    const { runtime, gateway, command } = setup();
    gateway.companionPrepareInitiationHandoff.mockResolvedValue({
      authorized: true,
      permit: permit({ recipientCompanionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
      rootInitiationId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(runtime.executeCompanionOutreach('peer-contact-b', PERMIT_ID))
      .rejects.toThrow(/recipient does not match/i);
    expect(command.execute).not.toHaveBeenCalled();
  });

  it('rechecks capability and tool-overlay authorization after broker preparation', async () => {
    const { runtime, gateway, command } = setup();
    const authorized = vi.fn().mockReturnValue(false);
    await expect(runtime.executeCompanionOutreach('peer-contact-b', PERMIT_ID, undefined, authorized))
      .rejects.toThrow(/authorization changed/i);
    expect(gateway.companionPrepareInitiationHandoff).toHaveBeenCalledOnce();
    expect(authorized).toHaveBeenCalledOnce();
    expect(command.execute).not.toHaveBeenCalled();
  });
});
