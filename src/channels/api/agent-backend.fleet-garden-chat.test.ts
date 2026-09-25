// psfn-framework-upwko: a fleet Garden chat turn for an SSO principal carries
// its gateway-verified canonical contact as a server-derived RPC field. The
// agent honors it without the browser identity-claim ceremony, and fails closed
// on any mismatch.
import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { EventBus } from '../../shared/event-bus.js';
import type { Contact } from '../../core/contacts/contact-store-port.js';
import { AgentApiBackend } from './agent-backend.js';
import type { ApiChatCompletionRpcParams } from './types.js';

const PRINCIPAL_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT: Contact = fromAny({
  id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  displayName: 'Fleet Owner',
  trustLevel: 'primary',
  relationshipType: 'partner',
  firstSeen: '2026-09-24T00:00:00.000Z',
  lastSeen: '2026-09-24T00:00:00.000Z',
});

function backend(options: {
  contacts?: Contact[];
  apiIdentity?: Contact | null;
} = {}) {
  const handleMessage = vi.fn(async (message: { channelId: string }) => ({
    content: 'hello operator',
    channelId: message.channelId,
    metadata: { inputTokens: 1, outputTokens: 1 },
  }));
  const contacts = options.contacts ?? [CONTACT];
  const instance = new AgentApiBackend({
    agentLoop: fromAny({ handleMessage, abort: vi.fn() }),
    eventBus: new EventBus(),
    sessionManager: fromAny({
      getMessageCount: () => 0,
      recordUserMessage: vi.fn(),
      recordAssistantMessage: vi.fn(),
      resolveConversationScope: vi.fn(),
    }),
    contactStore: fromAny({
      getByChannelIdentity: vi.fn(async () => options.apiIdentity ?? undefined),
      getById: vi.fn(async (id: string) => contacts.find(contact => contact.id === id)),
    }),
  });
  return { instance, handleMessage };
}

function params(overrides: Partial<ApiChatCompletionRpcParams> = {}): ApiChatCompletionRpcParams {
  return {
    requestId: 'fleet-garden-chat-1',
    request: { model: 'companion', messages: [{ role: 'user', content: 'hello' }] },
    principal: { id: PRINCIPAL_ID, mode: 'api_key' },
    headers: {
      'content-type': 'application/json',
      'x-user-id': PRINCIPAL_ID,
      'x-user-name': 'Fleet operator',
    },
    ...overrides,
  };
}

const BINDING = { principalId: PRINCIPAL_ID, contactId: CONTACT.id };

describe('AgentApiBackend fleet Garden chat contact binding', () => {
  it('rejected the pre-fix header claim shape with invalid_identity_claim (regression evidence)', async () => {
    const { instance } = backend();
    const result = await instance.handleChatCompletion(params({
      headers: { ...params().headers, 'x-canonical-contact-id': CONTACT.id },
    }));
    expect(result).toMatchObject({ ok: false, error: { status: 400, type: 'invalid_identity_claim' } });
  });

  it('runs an SSO principal turn as its verified canonical contact', async () => {
    const { instance, handleMessage } = backend();
    const result = await instance.handleChatCompletion(params({ fleetGardenContact: BINDING }));
    expect(result).toMatchObject({ ok: true, response: { content: 'hello operator' } });
    expect(handleMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(handleMessage.mock.calls[0]?.[0])).toContain(CONTACT.id);
  });

  it('runs an ADMIN_TOKEN principal turn as a key principal with no contact claim', async () => {
    const { instance, handleMessage } = backend();
    const result = await instance.handleChatCompletion(params({
      principal: { id: 'admin-token-operator', mode: 'api_key' },
      headers: { ...params().headers, 'x-user-id': 'admin-token-operator' },
    }));
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(handleMessage.mock.calls[0]?.[0])).not.toContain(CONTACT.id);
  });

  it.each([
    ['a different RPC principal', params({
      principal: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', mode: 'api_key' },
      fleetGardenContact: BINDING,
    }), 403, 'fleet_contact_principal_mismatch'],
    ['a competing identity claim header', params({
      headers: { ...params().headers, 'x-canonical-contact-id': 'contact-forged' },
      fleetGardenContact: BINDING,
    }), 400, 'fleet_contact_claim_conflict'],
    ['an unknown contact', params({
      fleetGardenContact: { principalId: PRINCIPAL_ID, contactId: 'contact-missing' },
    }), 404, 'identity_claim_contact_not_found'],
  ] as const)('fails closed on %s', async (_label, input, status, type) => {
    const { instance, handleMessage } = backend();
    const result = await instance.handleChatCompletion(input);
    expect(result).toMatchObject({ ok: false, error: { status, type } });
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('fails closed when the api identity is already linked to another contact', async () => {
    const other: Contact = fromAny({ ...CONTACT, id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
    const { instance, handleMessage } = backend({ contacts: [CONTACT, other], apiIdentity: other });
    const result = await instance.handleChatCompletion(params({ fleetGardenContact: BINDING }));
    expect(result).toMatchObject({ ok: false, error: { status: 409, type: 'identity_claim_conflict' } });
    expect(handleMessage).not.toHaveBeenCalled();
  });
});
