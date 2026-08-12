import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { EventBus } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { ApiServerRuntime } from '../types.js';
import type { IntakeScreeningService } from '../../../core/cogsec/intake/screening.js';
import { resolveConversationScopeFromMetadata } from '../../../core/session/conversation-scope.js';
import {
  ApiChatCompletionsHandler,
  type ApiChatCompletionsHandlerConfig,
} from './chat-completions.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const COMPANION_C = '33333333-3333-4333-8333-333333333333';

interface CapturedResponse {
  statusCode: number;
  headers: Map<string, string | number | readonly string[]>;
  body: string;
  writableEnded: boolean;
  destroyed: boolean;
}

function response(): ServerResponse & CapturedResponse {
  const emitter = new EventEmitter();
  const captured = Object.assign(emitter, {
    statusCode: 200,
    headers: new Map(),
    body: '',
    writableEnded: false,
    destroyed: false,
  });
  return Object.assign(captured, {
    setHeader(name: string, value: string | number | readonly string[]) {
      this.headers.set(name.toLowerCase(), value);
      return this;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) {
        this.headers.set(name.toLowerCase(), value);
      }
      return this;
    },
    write(chunk: string | Buffer) {
      this.body += chunk.toString();
      return true;
    },
    end(chunk?: string | Buffer) {
      if (chunk) this.body += chunk.toString();
      this.writableEnded = true;
      return this;
    },
  }) as unknown as ServerResponse & CapturedResponse;
}

function request(body: unknown, headers: IncomingMessage['headers'] = {}): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    socket: {},
  }) as unknown as IncomingMessage;
}

function runtime(): ApiServerRuntime {
  return {
    handleHealth: vi.fn(),
    handleTelemetryIngest: vi.fn(),
    handleChatCompletion: vi.fn(async () => ({
      ok: true,
      response: {
        content: 'response from companion B',
        channelId: 'api:principal:session',
        inputTokens: 4,
        outputTokens: 5,
      },
    })),
  };
}

function handler(
  apiRuntime: ApiServerRuntime | null,
  bearerCompanionRouting?: {
    pinnedCompanionId: string;
    knownCompanionIds: string[];
    selectableCompanionIds?: string[];
  },
  overrides: Partial<ApiChatCompletionsHandlerConfig> = {},
): ApiChatCompletionsHandler {
  return new ApiChatCompletionsHandler({
    agentLoop: {} as SubstrateAgent,
    eventBus: {} as EventBus,
    sessionManager: {} as SessionManager,
    contactStore: null,
    runtime: apiRuntime,
    modelName: COMPANION_A,
    requestTimeoutMs: 5_000,
    externalChannelProfiles: {},
    satelliteRegistry: undefined,
    satelliteRegistryProvider: undefined,
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    documentIngest: null,
    ...(bearerCompanionRouting ? { bearerCompanionRouting } : {}),
    ...overrides,
  });
}

describe('ApiChatCompletionsHandler response identity', () => {
  it('threads canonical private 1:1 Agent API context through monolith screening', async () => {
    const res = response();
    const handleMessage = vi.fn(async () => ({
      content: 'monolith response',
      channelId: 'api:principal:private-direct',
      metadata: { inputTokens: 1, outputTokens: 1 },
    }));
    const primaryContact = {
      id: 'contact-primary',
      displayName: 'Primary Operator',
      trustLevel: 'primary' as const,
      relationshipType: 'partner' as const,
      firstSeen: '2026-08-12T00:00:00.000Z',
      lastSeen: '2026-08-12T00:00:00.000Z',
    };
    const screen = vi.fn(async (content: string) => ({
      effectiveText: content,
      snapshot: {
        envelopeId: 'env-monolith-private-direct',
        sourceClass: 'primary_user' as const,
        sourceRiskTier: 'trusted' as const,
        state: 'released' as const,
        riskLabels: [],
        subject: { kind: 'body' as const },
      },
    }));
    const contactStore = fromAny({
      getByChannelIdentity: vi.fn(async () => primaryContact),
      getById: vi.fn(async () => primaryContact),
    });
    const chatHandler = handler(null, undefined, {
      agentLoop: fromAny({ handleMessage, abort: vi.fn() }),
      eventBus: new EventBus(),
      sessionManager: fromAny({
        getMessageCount: vi.fn(() => 0),
        recordUserMessage: vi.fn(),
        recordAssistantMessage: vi.fn(),
        resolveConversationScope: vi.fn((
          input: Parameters<SessionManager['resolveConversationScope']>[0],
        ) => resolveConversationScopeFromMetadata({
          channelId: input.channelId,
          isDirectMessage: input.channelMeta?.isDirectMessage,
          ...(input.channelMeta ? { channelMeta: input.channelMeta } : {}),
          ...(input.contact ? { contact: input.contact } : {}),
          ...(input.recentSpeakers ? { recentSpeakers: input.recentSpeakers } : {}),
          ...(input.resolvedSpeakerContactCount !== undefined
            ? { resolvedSpeakerContactCount: input.resolvedSpeakerContactCount }
            : {}),
        })),
      }),
      contactStore,
      documentIngest: {
        personalFilesDir: process.cwd(),
        intakeScreening: { mode: 'strict', screen } as unknown as IntakeScreeningService,
      },
    });

    await chatHandler.handle(
      request(
        {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'private direct message' }],
        },
        {
          'x-session-id': 'private-direct',
          'x-channel-privacy': 'private',
          'x-canonical-contact-id': primaryContact.id,
          'x-identity-claim-channel': 'discord',
          'x-identity-claim-user-id': 'operator-1',
        },
      ),
      res,
      { id: 'principal', mode: 'api_key' },
    );

    expect(res.statusCode).toBe(200);
    expect(screen).toHaveBeenCalledWith(
      'private direct message',
      expect.objectContaining({
        sourceClass: 'primary_user',
        sourceChannelId: 'api:principal:private-direct',
        channelPrivacy: 'private',
        chatBodyContext: expect.objectContaining({
          channelClass: 'api_direct',
          contactTrust: expect.objectContaining({
            contactId: primaryContact.id,
            trustLevel: 'primary',
          }),
          conversationScope: expect.objectContaining({
            kind: 'dm',
            contact: { contactId: primaryContact.id },
          }),
        }),
      }),
    );
    expect(handleMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: 'private direct message',
      isDirectMessage: true,
      routing: expect.objectContaining({
        canonicalContactId: primaryContact.id,
        intakeEnvelopes: [expect.objectContaining({ envelopeId: 'env-monolith-private-direct' })],
      }),
    }));
  });

  it('reports the fleet-routed responding companion in a non-streaming response', async () => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime).handle(
      request({
        model: 'openai-compatible-placeholder',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      res,
      { id: 'principal', mode: 'api_key' },
      undefined,
      undefined,
      { companionId: COMPANION_B },
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      model: COMPANION_B,
      choices: [{ message: { content: 'response from companion B' } }],
    });
  });

  it('reports the fleet-routed responding companion in every streaming chunk', async () => {
    const apiRuntime = runtime();
    vi.mocked(apiRuntime.handleChatCompletion).mockImplementation(async ({ onDelta }) => {
      onDelta?.('response from companion B');
      return {
        ok: true,
        response: {
          content: 'response from companion B',
          channelId: 'api:principal:session',
          inputTokens: 4,
          outputTokens: 5,
        },
      };
    });
    const res = response();

    await handler(apiRuntime).handle(
      request({
        model: 'openai-compatible-placeholder',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      res,
      { id: 'principal', mode: 'api_key' },
      undefined,
      undefined,
      { companionId: COMPANION_B },
    );

    expect(res.statusCode).toBe(200);
    const chunks = res.body
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice('data: '.length)));
    expect(chunks).toHaveLength(3);
    expect(chunks.map(chunk => chunk.model)).toEqual([
      COMPANION_B,
      COMPANION_B,
      COMPANION_B,
    ]);
  });

  it('routes an allowlisted Bearer selector to the selected companion', async () => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request(
        {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { 'x-psfn-companion-id': COMPANION_B },
      ),
      res,
      { id: 'principal', mode: 'api_key' },
    );

    expect(apiRuntime.handleChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ companionId: COMPANION_B }),
    );
    expect(JSON.parse(res.body).model).toBe(COMPANION_B);
  });

  it('keeps Bearer requests pinned when the selector header is absent', async () => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request({
        model: 'existing-client-model-value',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      res,
      { id: 'principal', mode: 'api_key' },
    );

    expect(apiRuntime.handleChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ companionId: COMPANION_A }),
    );
    expect(JSON.parse(res.body).model).toBe(COMPANION_A);
  });

  it.each([
    {
      name: 'unknown companion',
      selected: COMPANION_C,
      selectableCompanionIds: [COMPANION_B],
      status: 404,
      type: 'bearer_companion_not_found',
      message: 'Bearer/OpenAI-compatible companion selector',
    },
    {
      name: 'unauthorized companion',
      selected: COMPANION_B,
      selectableCompanionIds: [COMPANION_A],
      status: 403,
      type: 'bearer_companion_unauthorized',
      message: 'not entitled',
    },
    {
      name: 'disabled selector',
      selected: COMPANION_B,
      selectableCompanionIds: undefined,
      status: 403,
      type: 'bearer_companion_selector_disabled',
      message: 'selection is disabled',
    },
  ])('rejects $name explicitly', async ({
    selected,
    selectableCompanionIds,
    status,
    type,
    message,
  }) => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      ...(selectableCompanionIds ? { selectableCompanionIds } : {}),
    }).handle(
      request(
        {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { 'x-psfn-companion-id': selected },
      ),
      res,
      { id: 'principal', mode: 'api_key' },
    );

    expect(res.statusCode).toBe(status);
    expect(JSON.parse(res.body)).toMatchObject({
      error: { type, message: expect.stringContaining(message) },
    });
    expect(apiRuntime.handleChatCompletion).not.toHaveBeenCalled();
  });

  it('does not let a scoped Bearer principal use the companion selector', async () => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request(
        {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { 'x-psfn-companion-id': COMPANION_B },
      ),
      res,
      { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' },
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.type).toBe('bearer_companion_unauthorized');
    expect(apiRuntime.handleChatCompletion).not.toHaveBeenCalled();
  });

  it('rejects an explicitly blank selector instead of falling back to pinned routing', async () => {
    const apiRuntime = runtime();
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request(
        {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'hello' }],
        },
        { 'x-psfn-companion-id': '   ' },
      ),
      res,
      { id: 'principal', mode: 'api_key' },
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.type).toBe('invalid_bearer_companion_selector');
    expect(apiRuntime.handleChatCompletion).not.toHaveBeenCalled();
  });

  it('uses the runtime-authenticated responder for an arbitrated non-streaming turn', async () => {
    const apiRuntime = runtime();
    vi.mocked(apiRuntime.handleChatCompletion).mockResolvedValue({
      ok: true,
      response: {
        content: 'arbitrated response from companion B',
        channelId: 'satellite:session',
        companionId: COMPANION_B,
        inputTokens: 4,
        outputTokens: 5,
      },
    });
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request({
        model: 'openai-compatible-placeholder',
        messages: [{ role: 'user', content: 'hello' }],
      }),
      res,
      { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' },
    );

    expect(apiRuntime.handleChatCompletion).toHaveBeenCalledWith(
      expect.not.objectContaining({ companionId: expect.anything() }),
    );
    expect(JSON.parse(res.body).model).toBe(COMPANION_B);
  });

  it('uses the runtime-authenticated responder in every arbitrated streaming chunk', async () => {
    const apiRuntime = runtime();
    vi.mocked(apiRuntime.handleChatCompletion).mockImplementation(async ({ onDelta }) => {
      onDelta?.('arbitrated response from companion B', COMPANION_B);
      return {
        ok: true,
        response: {
          content: 'arbitrated response from companion B',
          channelId: 'satellite:session',
          companionId: COMPANION_B,
          inputTokens: 4,
          outputTokens: 5,
        },
      };
    });
    const res = response();

    await handler(apiRuntime, {
      pinnedCompanionId: COMPANION_A,
      knownCompanionIds: [COMPANION_A, COMPANION_B],
      selectableCompanionIds: [COMPANION_B],
    }).handle(
      request({
        model: 'openai-compatible-placeholder',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
      res,
      { id: 'satellite-principal', mode: 'api_key', scope: 'satellite' },
    );

    const chunks = res.body
      .split('\n')
      .filter(line => line.startsWith('data: {'))
      .map(line => JSON.parse(line.slice('data: '.length)));
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => chunk.model === COMPANION_B)).toBe(true);
  });
});
