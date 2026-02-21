// ── OpenAI-compatible API Server ──
// Exposes GET /v1/models and POST /v1/chat/completions.
// Uses Node.js built-in http module — no framework dependency.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { SubstrateMessage } from '../../types.js';
import type { AgentLoop } from '../../agent-loop.js';
import type { EventBus, ExternalTelemetryEvent } from '../../event-bus.js';
import type { SessionManager } from '../../session/manager.js';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  OutboundContext,
} from '../types.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  TelemetryIngestRequest,
  TelemetryIngestResponse,
} from './types.js';
import { createComponentLogger } from '../../logger.js';
import { hasBearerToken } from '../http/auth.js';
import {
  ApiVoiceWebSocketAdapter,
  type VoiceWebSocketRuntime,
  type VoiceWebSocketRuntimeHooks,
} from './voice-websocket.js';
import {
  readBodyWithLimit,
  sendEmpty,
  sendJson,
} from '../http/primitives.js';

const log = createComponentLogger('ApiServer');
const MAX_BODY_SIZE = 1_048_576; // 1MB
const DEFAULT_CHAT_REQUEST_TIMEOUT_MS = 90_000;
const TELEMETRY_MAX_SKEW_MS = 5 * 60_000;
const TELEMETRY_NONCE_TTL_MS = 10 * 60_000;
const TELEMETRY_EVENT_TYPE_ALLOWLIST = new Set([
  'external.telemetry.heartbeat',
  'external.telemetry.status',
  'external.telemetry.incident',
]);

type LifecycleInterrupt = 'timeout' | 'client_disconnected';

class RequestLifecycleError extends Error {
  readonly reason: LifecycleInterrupt;

  constructor(reason: LifecycleInterrupt) {
    super(reason);
    this.reason = reason;
  }
}

const telemetryIngestSchema = Type.Object({
  source: Type.String({ minLength: 1, maxLength: 128 }),
  eventType: Type.String({ minLength: 1, maxLength: 128 }),
  timestamp: Type.String({ minLength: 1, maxLength: 64 }),
  nonce: Type.String({ minLength: 8, maxLength: 128 }),
  payload: Type.Object({}, { additionalProperties: true }),
  channelId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  scope: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false });

type TelemetryIngestInput = Static<typeof telemetryIngestSchema>;
type AgentTurnResult = Awaited<ReturnType<AgentLoop['handleMessage']>>;

interface PendingTurn {
  channelId: string;
  claimToken: symbol;
  substrateMsg: SubstrateMessage;
}

interface PreparedTurn {
  channelId: string;
  turnPromise: Promise<AgentTurnResult>;
}

export interface ApiServerConfig {
  port: number;
  host?: string;
  agentLoop: AgentLoop;
  eventBus: EventBus;
  sessionManager: SessionManager;
  apiKey?: string;
  modelName?: string;
  requestTimeoutMs?: number;
  voiceWebSocketPath?: string;
  voiceWebSocketRuntime?: VoiceWebSocketRuntime;
  voiceWebSocketHooks?: VoiceWebSocketRuntimeHooks;
}

export class ApiServer implements ChannelAdapter {
  readonly id = 'api';
  readonly name = this.id;
  readonly meta = {
    label: 'API Server',
    emoji: ':globe_with_meridians:',
  };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct'],
    media: false,
    reactions: false,
    threads: false,
    streaming: true,
    promptChannelType: 'api',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly prompt: ChannelPromptAdapter;

  private server: Server;
  private port: number;
  private host: string;
  private agentLoop: AgentLoop;
  private eventBus: EventBus;
  private sessionManager: SessionManager;
  private apiKey?: string;
  private modelName: string;
  private requestTimeoutMs: number;
  private seenTelemetryNonces = new Map<string, number>();
  private inFlightByChannel = new Map<string, symbol>();
  private voiceWebSocket: ApiVoiceWebSocketAdapter;

  constructor(config: ApiServerConfig) {
    this.port = config.port;
    this.host = config.host ?? '127.0.0.1';
    this.agentLoop = config.agentLoop;
    this.eventBus = config.eventBus;
    this.sessionManager = config.sessionManager;
    this.apiKey = config.apiKey;
    this.modelName = config.modelName ?? 'purrsephone';
    this.requestTimeoutMs = this.parseTimeoutMs(config.requestTimeoutMs);
    this.voiceWebSocket = new ApiVoiceWebSocketAdapter({
      apiKey: this.apiKey,
      path: config.voiceWebSocketPath,
      runtime: config.voiceWebSocketRuntime,
      runtimeHooks: config.voiceWebSocketHooks,
    });
    this.config = {
      enabled: true,
      connectionLabel: `${this.host}:${this.port}`,
    };
    this.outbound = {
      textChunkLimit: Number.MAX_SAFE_INTEGER,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        const normalized = text.trim();
        if (!normalized) return;
        this.sessionManager.recordAssistantMessage(ctx.channelId, normalized);
      },
    };
    this.gateway = this;
    this.prompt = {
      resolveChannelType: (): string => 'api',
    };
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  async init(): Promise<void> {}

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, () => {
        log.info(`Listening on ${this.host}:${this.port}`);
        if (!this.apiKey) {
          log.warn('API server started WITHOUT authentication — set API_KEY to secure');
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await this.voiceWebSocket.stop();
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const handled = this.voiceWebSocket.handleUpgrade(req, socket, head);
    if (!handled) {
      this.voiceWebSocket.rejectUnknownUpgrade(socket);
    }
  }

  private parseTimeoutMs(value: number | undefined): number {
    if (value === undefined) return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(value) || value <= 0) {
      return DEFAULT_CHAT_REQUEST_TIMEOUT_MS;
    }
    return Math.floor(value);
  }

  private claimChannel(channelId: string): symbol | null {
    if (this.inFlightByChannel.has(channelId)) return null;
    const token = Symbol(channelId);
    this.inFlightByChannel.set(channelId, token);
    return token;
  }

  private releaseChannel(channelId: string, token: symbol): void {
    if (this.inFlightByChannel.get(channelId) === token) {
      this.inFlightByChannel.delete(channelId);
    }
  }

  private attachTurnCleanup(
    channelId: string,
    token: symbol,
    turnPromise: Promise<unknown>,
  ): void {
    turnPromise
      .catch(() => {})
      .finally(() => {
        this.releaseChannel(channelId, token);
      });
  }

  private sendBusyError(res: ServerResponse, channelId: string): void {
    res.setHeader('Retry-After', '1');
    this.sendError(
      res,
      429,
      'channel_busy',
      `A turn is already in progress for ${channelId}. Retry shortly.`,
    );
  }

  private isAgentBusyError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.message.toLowerCase().includes('already processing');
  }

  private abortActiveTurn(channelId: string, reason: LifecycleInterrupt): void {
    const maybeAbortable = this.agentLoop as unknown as { abort?: () => void };
    if (typeof maybeAbortable.abort !== 'function') return;
    try {
      maybeAbortable.abort();
      log.warn('Aborted active turn due to request lifecycle interruption', {
        channelId,
        reason,
      });
    } catch (err) {
      log.error('Failed to abort active turn', {
        channelId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private canWriteResponse(res: ServerResponse): boolean {
    return !res.writableEnded && !res.destroyed;
  }

  private async awaitTurnOrInterrupt<T>(
    channelId: string,
    req: IncomingMessage,
    res: ServerResponse,
    turnPromise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        this.abortActiveTurn(channelId, reason);
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const result = await Promise.race([turnPromise, interruptionPromise]);
      settled = true;
      return result;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // CORS headers on every response
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Session-ID, X-User-ID, X-User-Name',
    );

    // Preflight
    if (req.method === 'OPTIONS') {
      sendEmpty(res, 204);
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const isTelemetryIngest = req.method === 'POST' && path === '/v1/telemetry/ingest';

    if (isTelemetryIngest && !this.apiKey) {
      this.sendError(
        res,
        503,
        'telemetry_auth_unconfigured',
        'Telemetry ingestion requires API authentication to be configured',
      );
      return;
    }

    // Auth check
    if ((this.apiKey || isTelemetryIngest) && !this.checkAuth(req, res)) return;

    if (req.method === 'GET' && path === '/v1/models') {
      this.handleModels(res);
    } else if (req.method === 'POST' && path === '/v1/chat/completions') {
      void this.handleChatCompletions(req, res);
    } else if (isTelemetryIngest) {
      void this.handleTelemetryIngest(req, res);
    } else {
      this.sendError(res, 404, 'not_found', `No route for ${req.method} ${path}`);
    }
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiKey || !hasBearerToken(req, this.apiKey)) {
      this.sendError(res, 401, 'invalid_api_key', 'Invalid or missing API key');
      return false;
    }
    return true;
  }

  private handleModels(res: ServerResponse): void {
    const body = {
      object: 'list',
      data: [{
        id: this.modelName,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'psfn',
      }],
    };
    sendJson(res, 200, body);
  }

  private async handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string | null;
    try {
      body = await readBodyWithLimit(req, res, {
        maxBytes: MAX_BODY_SIZE,
        logger: log,
      });
    } catch (err) {
      log.error('Failed reading request body', {
        path: req.url ?? '/v1/chat/completions',
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.canWriteResponse(res)) {
        this.sendError(res, 500, 'internal_error', 'Internal server error');
      }
      return;
    }

    if (body === null) return;

    let parsed: ChatCompletionRequest;
    try {
      parsed = JSON.parse(body) as ChatCompletionRequest;
    } catch (err) {
      log.warn('Rejected request with invalid JSON body', {
        path: req.url ?? '/v1/chat/completions',
        bodySize: Buffer.byteLength(body),
        contentType: req.headers['content-type'],
        remoteAddress: req.socket.remoteAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      this.sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }

    if (!parsed.messages || !Array.isArray(parsed.messages) || parsed.messages.length === 0) {
      this.sendError(res, 400, 'invalid_request', 'messages field is required and must be a non-empty array');
      return;
    }

    if (parsed.stream) {
      await this.handleStreaming(parsed, req, res);
    } else {
      await this.handleNonStreaming(parsed, req, res);
    }
  }

  private async handleTelemetryIngest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string | null;
    try {
      body = await readBodyWithLimit(req, res, {
        maxBytes: MAX_BODY_SIZE,
        logger: log,
      });
    } catch (err) {
      log.error('Failed reading telemetry body', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.canWriteResponse(res)) {
        this.sendError(res, 500, 'internal_error', 'Internal server error');
      }
      return;
    }

    if (body === null) return;
    await this.ingestTelemetryBody(body, res);
  }

  private async ingestTelemetryBody(body: string, res: ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      this.sendError(res, 400, 'invalid_json', 'Request body is not valid JSON');
      return;
    }

    if (!Value.Check(telemetryIngestSchema, parsed)) {
      this.sendError(
        res,
        400,
        'invalid_request',
        'Telemetry payload failed schema validation',
      );
      return;
    }

    const telemetry: TelemetryIngestRequest = parsed as TelemetryIngestInput;

    if (!TELEMETRY_EVENT_TYPE_ALLOWLIST.has(telemetry.eventType)) {
      this.sendError(
        res,
        403,
        'event_type_not_allowed',
        `eventType must be one of: ${Array.from(TELEMETRY_EVENT_TYPE_ALLOWLIST).join(', ')}`,
      );
      return;
    }

    const occurredAtMs = Date.parse(telemetry.timestamp);
    if (!Number.isFinite(occurredAtMs)) {
      this.sendError(res, 400, 'invalid_request', 'timestamp must be a valid ISO-8601 string');
      return;
    }

    const now = Date.now();
    if (Math.abs(now - occurredAtMs) > TELEMETRY_MAX_SKEW_MS) {
      this.sendError(
        res,
        400,
        'stale_request',
        `timestamp must be within ${TELEMETRY_MAX_SKEW_MS / 1000} seconds of server time`,
      );
      return;
    }

    this.pruneTelemetryNonces(now);
    const nonceKey = `${telemetry.source}:${telemetry.nonce}`;
    if (this.seenTelemetryNonces.has(nonceKey)) {
      this.sendError(res, 409, 'replay_detected', 'Duplicate nonce detected');
      return;
    }
    this.seenTelemetryNonces.set(nonceKey, now);

    const normalizedEvent: ExternalTelemetryEvent = {
      id: `ext-${randomUUID()}`,
      source: telemetry.source,
      eventType: telemetry.eventType,
      payload: telemetry.payload,
      occurredAt: new Date(occurredAtMs).toISOString(),
      receivedAt: new Date(now).toISOString(),
      nonce: telemetry.nonce,
      channelId: telemetry.channelId,
      scope: telemetry.scope,
    };

    await this.eventBus.emit('external.telemetry.ingested', { event: normalizedEvent });

    const response: TelemetryIngestResponse = {
      ok: true,
      id: normalizedEvent.id,
      acceptedEventType: normalizedEvent.eventType,
    };
    sendJson(res, 202, response);
  }

  private pruneTelemetryNonces(now: number): void {
    for (const [nonceKey, seenAt] of this.seenTelemetryNonces.entries()) {
      if (now - seenAt > TELEMETRY_NONCE_TTL_MS) {
        this.seenTelemetryNonces.delete(nonceKey);
      }
    }
  }

  private buildSubstrateMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
  ): SubstrateMessage {
    return {
      id: `api-${randomUUID()}`,
      channelId,
      channelType: 'api',
      authorId,
      authorName,
      content,
      timestamp: new Date(),
    };
  }

  private deriveChannelId(req: IncomingMessage): string {
    const sessionId = req.headers['x-session-id'] as string | undefined;
    return sessionId ? `api:${sessionId}` : `api:${randomUUID()}`;
  }

  private seedSession(
    channelId: string,
    messages: ChatCompletionRequest['messages'],
    authorId: string,
    authorName: string,
  ): void {
    // Only seed if this session has no prior messages
    const count = this.sessionManager.getMessageCount(channelId);
    if (count > 0) return;

    // Seed all messages except the last user message (which handleMessage will record)
    const prior = messages.slice(0, -1);
    for (const msg of prior) {
      if (msg.role === 'user') {
        this.sessionManager.recordUserMessage(channelId, msg.content, authorId, msg.name ?? authorName);
      } else if (msg.role === 'assistant') {
        this.sessionManager.recordAssistantMessage(channelId, msg.content);
      }
      // system messages are handled via systemPrompt, skip
    }
  }

  private deriveAuthor(req: IncomingMessage): { authorId: string; authorName: string } {
    const rawUserId = this.singleHeader(req.headers['x-user-id']);
    const rawUserName = this.singleHeader(req.headers['x-user-name']);

    const authorId = this.clampHeader(rawUserId, 128) || 'api-user';
    const authorName = this.clampHeader(rawUserName, 80) || 'User';

    return { authorId, authorName };
  }

  private singleHeader(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
  }

  private clampHeader(value: string | undefined, maxLength: number): string | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }

  private getLastUserMessage(messages: ChatCompletionRequest['messages']): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content;
    }
    return messages[messages.length - 1].content;
  }

  private prepareTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): PendingTurn | null {
    const channelId = this.deriveChannelId(req);
    const claimToken = this.claimChannel(channelId);
    if (!claimToken) {
      this.sendBusyError(res, channelId);
      return null;
    }

    const { authorId, authorName } = this.deriveAuthor(req);
    this.seedSession(channelId, request.messages, authorId, authorName);

    const lastUserMsg = this.getLastUserMessage(request.messages);
    const substrateMsg = this.buildSubstrateMessage(channelId, lastUserMsg, authorId, authorName);
    return { channelId, claimToken, substrateMsg };
  }

  private beginPreparedTurn(turn: PendingTurn): PreparedTurn {
    const turnPromise = this.agentLoop.handleMessage(turn.substrateMsg);
    this.attachTurnCleanup(turn.channelId, turn.claimToken, turnPromise);
    return {
      channelId: turn.channelId,
      turnPromise,
    };
  }

  private startTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): PreparedTurn | null {
    const pending = this.prepareTurn(request, req, res);
    if (!pending) return null;
    return this.beginPreparedTurn(pending);
  }

  private handleNonStreamingTurnError(res: ServerResponse, err: unknown): void {
    if (!this.canWriteResponse(res)) return;
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout') {
        this.sendError(res, 504, 'request_timeout', 'Request timed out before turn completed');
      }
      return;
    }
    if (this.isAgentBusyError(err)) {
      res.setHeader('Retry-After', '1');
      this.sendError(res, 503, 'agent_busy', 'Agent is already processing another prompt');
      return;
    }
    log.error('Non-streaming completion error', { error: String(err) });
    this.sendError(res, 500, 'internal_error', 'Internal server error');
  }

  private writeStreamingChunk(res: ServerResponse, chunk: ChatCompletionChunk): void {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  private writeStreamingDone(res: ServerResponse): void {
    res.write('data: [DONE]\n\n');
  }

  private writeStreamingErrorAndDone(
    res: ServerResponse,
    completionId: string,
    created: number,
    content: string,
  ): void {
    const errorChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: this.modelName,
      choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
    };
    this.writeStreamingChunk(res, errorChunk);
    this.writeStreamingDone(res);
  }

  private handleStreamingTurnError(
    res: ServerResponse,
    err: unknown,
    completionId: string,
    created: number,
  ): void {
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout' && this.canWriteResponse(res)) {
        this.writeStreamingErrorAndDone(
          res,
          completionId,
          created,
          '\n[Error: Request timed out]',
        );
      }
      return;
    }

    if (this.isAgentBusyError(err)) {
      if (this.canWriteResponse(res)) {
        this.writeStreamingErrorAndDone(res, completionId, created, '\n[Error: Agent busy]');
      }
      return;
    }

    log.error('Streaming completion error', { error: String(err) });
    if (this.canWriteResponse(res)) {
      this.writeStreamingErrorAndDone(
        res,
        completionId,
        created,
        '\n[Error: Internal server error]',
      );
    }
  }

  private async handleNonStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const turn = this.startTurn(request, req, res);
    if (!turn) return;

    try {
      const agentResponse = await this.awaitTurnOrInterrupt(
        turn.channelId,
        req,
        res,
        turn.turnPromise,
      );
      if (!this.canWriteResponse(res)) return;

      const response: ChatCompletionResponse = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: this.modelName,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: agentResponse.content },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: agentResponse.metadata.inputTokens,
          completion_tokens: agentResponse.metadata.outputTokens,
          total_tokens: agentResponse.metadata.inputTokens + agentResponse.metadata.outputTokens,
        },
      };

      sendJson(res, 200, response);
    } catch (err) {
      this.handleNonStreamingTurnError(res, err);
    }
  }

  private async handleStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const pendingTurn = this.prepareTurn(request, req, res);
    if (!pendingTurn) return;

    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial role chunk
    const roleChunk: ChatCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: this.modelName,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    this.writeStreamingChunk(res, roleChunk);

    // Subscribe to stream deltas for this channelId
    const unsubscribe = this.eventBus.on('agent.stream.delta', (data) => {
      if (data.channelId !== pendingTurn.channelId) return;
      const chunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: this.modelName,
        choices: [{ index: 0, delta: { content: data.text }, finish_reason: null }],
      };
      this.writeStreamingChunk(res, chunk);
    });
    const turn = this.beginPreparedTurn(pendingTurn);

    try {
      await this.awaitTurnOrInterrupt(turn.channelId, req, res, turn.turnPromise);
      if (!this.canWriteResponse(res)) return;

      // Send finish chunk
      const finishChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: this.modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      this.writeStreamingChunk(res, finishChunk);
      this.writeStreamingDone(res);
    } catch (err) {
      this.handleStreamingTurnError(res, err, completionId, created);
    } finally {
      unsubscribe();
      if (this.canWriteResponse(res)) {
        res.end();
      }
    }
  }

  private sendError(
    res: ServerResponse,
    status: number,
    type: string,
    message: string,
  ): void {
    sendJson(res, status, {
      error: { message, type, param: null, code: null },
    });
  }
}
