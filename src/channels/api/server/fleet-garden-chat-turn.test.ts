// psfn-framework-upwko: fleet Garden chat through the unified origin must work
// for both an SSO principal (as its verified canonical contact) and the
// ADMIN_TOKEN operator (as a key principal), end to end from the gateway's
// admitted request through the gateway-agent RPC contract to the agent.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { EventBus } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { FleetAuthorizationContext } from '../../../boundary/gateway/fleet-authorization-context.js';
import { agentMethodParamDecoders } from '../../../boundary/gateway/methods/params/agent.js';
import { AgentApiBackend } from '../agent-backend.js';
import type { ApiChatCompletionRpcParams, ApiServerRuntime } from '../types.js';
import { ApiChatCompletionsHandler } from './chat-completions.js';
import { buildFleetGardenChatTurn } from './fleet-garden-chat-turn.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const SSO_PRINCIPAL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SSO_CONTACT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function authorization(kind: 'sso' | 'admin_token'): FleetAuthorizationContext {
  const sso = kind === 'sso';
  return fromAny({
    principalId: sso ? SSO_PRINCIPAL : 'admin-token-operator',
    companionId: COMPANION_ID,
    contact: {
      bindingId: 'binding',
      contactId: sso ? SSO_CONTACT : `admin-token-contact-${COMPANION_ID}`,
      bindingVersion: 1,
    },
    authorization: { action: 'companion.interact', decision: 'allow' },
    provenance: {
      source: sso ? 'gateway_fleet_authorization_snapshot' : 'gateway_admin_token',
      authorizationEventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      resolvedAt: '2026-09-24T00:00:00.000Z',
    },
  });
}

function browserRequest(): IncomingMessage {
  return fromAny({
    headers: {
      accept: 'application/json',
      'x-session-id': 'garden-chat',
      // A browser cannot smuggle an identity claim through the fleet door.
      'x-canonical-contact-id': 'contact-forged',
      'x-identity-claim-channel': 'discord',
      'x-identity-claim-user-id': '123456789012345678',
      authorization: 'Bearer should-not-pass',
    },
  });
}

function captureResponse(): ServerResponse & { statusCode: number; body: string } {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: 200,
    body: '',
    writableEnded: false,
    destroyed: false,
    setHeader() { return this; },
    writeHead(status: number) { this.statusCode = status; return this; },
    write(chunk: string | Buffer) { this.body += chunk.toString(); return true; },
    end(chunk?: string | Buffer) {
      if (chunk) this.body += chunk.toString();
      this.writableEnded = true;
      return this;
    },
  }) as unknown as ServerResponse & { statusCode: number; body: string };
}

function agent() {
  const handleMessage = vi.fn(async (message: { channelId: string }) => ({
    content: 'hello from the companion',
    channelId: message.channelId,
    metadata: { inputTokens: 1, outputTokens: 1 },
  }));
  const contact = { id: SSO_CONTACT, displayName: 'Fleet Owner', trustLevel: 'primary', relationshipType: 'partner' };
  return {
    handleMessage,
    backend: new AgentApiBackend({
      agentLoop: fromAny({ handleMessage, abort: vi.fn() }),
      eventBus: new EventBus(),
      sessionManager: fromAny({
        getMessageCount: () => 0,
        recordUserMessage: vi.fn(),
        recordAssistantMessage: vi.fn(),
        resolveConversationScope: vi.fn(),
      }),
      contactStore: fromAny({
        getByChannelIdentity: vi.fn(async () => undefined),
        getById: vi.fn(async (id: string) => (id === SSO_CONTACT ? contact : undefined)),
      }),
    }),
  };
}

/** Gateway runtime stub that forwards through the real RPC param decoder. */
function forwardingRuntime(backend: AgentApiBackend, sent: ApiChatCompletionRpcParams[]): ApiServerRuntime {
  return fromAny({
    handleHealth: vi.fn(),
    handleTelemetryIngest: vi.fn(),
    handleChatCompletion: vi.fn(async (input: ApiChatCompletionRpcParams & { companionId?: string }) => {
      const rpc = agentMethodParamDecoders['api.chat.completion']({
        requestId: 'rpc-1',
        request: input.request,
        principal: input.principal,
        headers: Object.fromEntries(Object.entries(input.headers).filter(([, value]) => value !== undefined)),
        ...(input.fleetGardenContact ? { fleetGardenContact: input.fleetGardenContact } : {}),
      }) as ApiChatCompletionRpcParams;
      sent.push(rpc);
      return await backend.handleChatCompletion(rpc);
    }),
  });
}

async function chat(kind: 'sso' | 'admin_token') {
  const { backend, handleMessage } = agent();
  const sent: ApiChatCompletionRpcParams[] = [];
  const handler = new ApiChatCompletionsHandler({
    agentLoop: {} as SubstrateAgent,
    eventBus: {} as EventBus,
    sessionManager: {} as SessionManager,
    contactStore: null,
    runtime: forwardingRuntime(backend, sent),
    modelName: COMPANION_ID,
    requestTimeoutMs: 5_000,
    externalChannelProfiles: {},
    satelliteRegistry: undefined,
    satelliteRegistryProvider: undefined,
    logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    documentIngest: null,
  });
  const body = Buffer.from(JSON.stringify({ model: COMPANION_ID, messages: [{ role: 'user', content: 'hello' }] }));
  const turn = buildFleetGardenChatTurn({
    request: browserRequest(),
    body,
    companionId: COMPANION_ID as never,
    authorization: authorization(kind),
  });
  const admitted = Object.assign(Readable.from([body]), {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: turn.headers,
    socket: {},
  }) as unknown as IncomingMessage;
  const res = captureResponse();
  await handler.handle(admitted, res, turn.principal, undefined, undefined, turn.routing);
  return { res, sent, handleMessage, turn };
}

describe('fleet Garden chat for SSO and ADMIN_TOKEN principals', () => {
  it('drops browser identity claims and credentials from the admitted turn', () => {
    const turn = buildFleetGardenChatTurn({
      request: browserRequest(),
      body: Buffer.from('{}'),
      companionId: COMPANION_ID as never,
      authorization: authorization('sso'),
    });
    expect(turn.headers).not.toHaveProperty('x-canonical-contact-id');
    expect(turn.headers).not.toHaveProperty('x-identity-claim-channel');
    expect(turn.headers).not.toHaveProperty('x-identity-claim-user-id');
    expect(turn.headers).not.toHaveProperty('authorization');
    expect(turn.headers['x-session-id']).toBe('garden-chat');
  });

  it('answers an SSO principal as its verified canonical contact', async () => {
    const { res, sent, handleMessage } = await chat('sso');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).choices[0].message.content).toBe('hello from the companion');
    expect(sent[0]?.fleetGardenContact).toEqual({ principalId: SSO_PRINCIPAL, contactId: SSO_CONTACT });
    expect(sent[0]?.headers).not.toHaveProperty('x-canonical-contact-id');
    expect(JSON.stringify(handleMessage.mock.calls[0]?.[0])).toContain(SSO_CONTACT);
  });

  it('answers the ADMIN_TOKEN operator as a key principal without a contact claim', async () => {
    const { res, sent, handleMessage } = await chat('admin_token');
    expect(res.statusCode).toBe(200);
    expect(sent[0]).not.toHaveProperty('fleetGardenContact');
    expect(sent[0]?.headers).not.toHaveProperty('x-canonical-contact-id');
    expect(JSON.stringify(handleMessage.mock.calls[0]?.[0])).not.toContain('admin-token-contact');
  });

  it('fails closed when a verified contact reaches the in-process path without the agent runtime', async () => {
    const handler = new ApiChatCompletionsHandler({
      agentLoop: {} as SubstrateAgent,
      eventBus: {} as EventBus,
      sessionManager: {} as SessionManager,
      contactStore: null,
      runtime: null,
      modelName: COMPANION_ID,
      requestTimeoutMs: 5_000,
      externalChannelProfiles: {},
      satelliteRegistry: undefined,
      satelliteRegistryProvider: undefined,
      logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
      documentIngest: null,
    });
    const body = Buffer.from(JSON.stringify({ model: COMPANION_ID, messages: [{ role: 'user', content: 'hello' }] }));
    const turn = buildFleetGardenChatTurn({
      request: browserRequest(),
      body,
      companionId: COMPANION_ID as never,
      authorization: authorization('sso'),
    });
    const res = captureResponse();
    await handler.handle(
      Object.assign(Readable.from([body]), { method: 'POST', url: '/v1/chat/completions', headers: turn.headers, socket: {} }) as unknown as IncomingMessage,
      res,
      turn.principal,
      undefined,
      undefined,
      turn.routing,
    );
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain('fleet_garden_chat_unavailable');
  });
});
