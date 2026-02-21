// ── Gateway Client ──
// Agent-side typed RPC wrapper. Implements LLMProvider and EmbeddingService
// so it can be used as a drop-in replacement for direct clients.

import { JSONRPCServer, JSONRPCClient, JSONRPCServerAndClient, JSONRPCErrorException } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type {
  AgentResponse,
  CompletionPurpose,
  LLMContext,
  LLMResponse,
  StreamCallbacks,
  SubstrateMessage,
} from '../types.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketClient } from './transport.js';
import { createComponentLogger } from '../logger.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from './backpressure.js';
const log = createComponentLogger('GatewayClient');
import type {
  LLMChatResult,
  LLMCompleteResult,
  LLMEmbedResult,
  DiscordSendResult,
  WebFetchResult,
  FsReadResult,
  FsWriteResult,
  DiscordMessageNotification,
  LLMChunkNotification,
  DiscordHandleMessageParams,
  DiscordHandleMessageResult,
  RpcSubstrateMessage,
  DiscordVoiceStreamStartParams,
  DiscordVoiceStreamChunkParams,
  DiscordVoiceStreamEndParams,
  DiscordVoiceStreamCancelParams,
  DiscordVoiceStreamAckResult,
  DiscordVoiceStreamEndResult,
  DiscordVoiceStreamCancelResult,
} from './protocol.js';
import { GatewayErrors } from './protocol.js';

const DEFAULT_VOICE_STREAM_QUEUE_SIZE = 32;
const DEFAULT_VOICE_STREAM_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';

export interface GatewayClientOptions {
  voiceStreamQueueSize?: number;
  voiceStreamOverflowPolicy?: QueueOverflowPolicy;
}

interface VoiceStreamState {
  correlationId: string;
  streamId: string;
  baseMessage: RpcSubstrateMessage;
  expectedSequence: number;
  chunkQueue: BoundedQueue<string>;
  chunks: string[];
  droppedChunks: number;
  cancelled: boolean;
}

export class GatewayClient implements LLMProvider, EmbeddingService {
  private rpcInstance: JSONRPCServerAndClient;
  private conn: NdjsonConnection;
  private embeddingDims: number;
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private chunkHandlers = new Map<string, (text: string) => void>();
  private requestCounter = 0;
  private reverseMethodsRegistered = false;
  private handleMessageHandler: ((message: SubstrateMessage) => Promise<AgentResponse>) | null = null;
  private voiceStreams = new Map<string, VoiceStreamState>();
  private readonly voiceStreamQueueSize: number;
  private readonly voiceStreamOverflowPolicy: QueueOverflowPolicy;

  constructor(conn: NdjsonConnection, embeddingDims: number, options: GatewayClientOptions = {}) {
    this.conn = conn;
    this.embeddingDims = embeddingDims;
    this.voiceStreamQueueSize = options.voiceStreamQueueSize ?? DEFAULT_VOICE_STREAM_QUEUE_SIZE;
    this.voiceStreamOverflowPolicy = options.voiceStreamOverflowPolicy ?? DEFAULT_VOICE_STREAM_OVERFLOW_POLICY;

    if (!Number.isInteger(this.voiceStreamQueueSize) || this.voiceStreamQueueSize <= 0) {
      throw new Error(`voiceStreamQueueSize must be a positive integer, got ${this.voiceStreamQueueSize}`);
    }

    // Create bidirectional RPC instance (client sends requests to gateway,
    // server handles incoming requests from gateway like discord.handleMessage)
    this.rpcInstance = new JSONRPCServerAndClient(
      new JSONRPCServer(),
      new JSONRPCClient((request) => { this.conn.send(request); }),
    );

    // Route incoming messages
    this.conn.onMessage((message: unknown) => {
      const msg = message as Record<string, unknown>;

      // Intercept llm.chunk notifications — these use our custom routing
      if ('method' in msg && !('id' in msg)) {
        const method = msg.method as string;
        if (method === 'llm.chunk') {
          this.handleChunkNotification(msg.params);
          return;
        }
        // Other notifications (discord.message) use our handler system
        this.handleNotification(method, msg.params);
        return;
      }

      // Everything else: responses to our requests + incoming RPC requests from gateway
      this.rpcInstance.receiveAndSend(msg as any);
    });
  }

  static async connect(
    socketPath: string,
    embeddingDims: number,
    options: GatewayClientOptions = {},
  ): Promise<GatewayClient> {
    const conn = await createSocketClient({ socketPath });
    return new GatewayClient(conn, embeddingDims, options);
  }

  // ── LLMProvider interface ──

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    // Generate a unique per-request ID for routing streaming chunks
    const requestId = `req-${++this.requestCounter}`;

    // Register chunk handler before sending the RPC so no chunks are missed
    if (callbacks?.onText) {
      this.chunkHandlers.set(requestId, callbacks.onText);
    }

    try {
      const result = await this.rpcInstance.request('llm.chat', {
        model: '',  // gateway uses its own config
        provider: '',
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        stream: !!callbacks?.onText,
        requestId,
        ...(context.tools?.length ? { tools: context.tools } : {}),
      }) as LLMChatResult;

      const response: LLMResponse = {
        content: result.content,
        toolCalls: result.toolCalls,
        model: result.model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        stopReason: result.stopReason,
      };

      callbacks?.onDone?.(response);
      return response;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      callbacks?.onError?.(err);
      throw err;
    } finally {
      this.chunkHandlers.delete(requestId);
    }
  }

  async complete(context: LLMContext, purpose: CompletionPurpose): Promise<LLMResponse> {
    const result = await this.rpcInstance.request('llm.complete', {
      model: '',
      provider: '',
      messages: context.messages,
      systemPrompt: context.systemPrompt,
      purpose,
    }) as LLMCompleteResult;

    return {
      content: result.content,
      toolCalls: [],
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      stopReason: result.stopReason,
    };
  }

  // ── EmbeddingService interface ──

  get dims(): number {
    return this.embeddingDims;
  }

  async embed(text: string): Promise<Float32Array> {
    const results = await this.embedBatch([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const result = await this.rpcInstance.request('llm.embed', {
      texts,
    }) as LLMEmbedResult;

    return result.embeddings.map(e => new Float32Array(e));
  }

  // ── Discord methods ──

  async discordSend(channelId: string, content: string): Promise<void> {
    await this.rpcInstance.request('discord.send', {
      channelId,
      content,
    }) as DiscordSendResult;
  }

  async discordTyping(channelId: string): Promise<void> {
    await this.rpcInstance.request('discord.typing', { channelId });
  }

  // ── Web fetch ──

  async webFetch(url: string, prompt?: string): Promise<string> {
    const result = await this.rpcInstance.request('web.fetch', {
      url,
      prompt,
    }) as WebFetchResult;
    return result.content;
  }

  // ── Filesystem ──

  async fsRead(path: string): Promise<string> {
    const result = await this.rpcInstance.request('fs.read', { path }) as FsReadResult;
    return result.content;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.rpcInstance.request('fs.write', { path, content }) as FsWriteResult;
  }

  // ── Notification handlers ──

  onDiscordMessage(handler: (message: SubstrateMessage) => void): () => void {
    return this.onNotification('discord.message', (params) => {
      const notification = params as DiscordMessageNotification;
      handler(notification.message);
    });
  }

  private onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notificationHandlers.get(method) ?? [];
    handlers.push(handler);
    this.notificationHandlers.set(method, handlers);
    return () => {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    };
  }

  /** Register a handler for reverse RPC calls from gateway (e.g. voice messages) */
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void {
    this.handleMessageHandler = handler;
    this.registerReverseMethods();
  }

  private registerReverseMethods(): void {
    if (this.reverseMethodsRegistered) return;
    this.reverseMethodsRegistered = true;

    this.rpcInstance.addMethod(
      'discord.handleMessage',
      async (params: DiscordHandleMessageParams) => this.dispatchHandleMessage(params.message),
    );
    this.rpcInstance.addMethod(
      'discord.voice.start',
      async (params: DiscordVoiceStreamStartParams) => this.handleVoiceStreamStart(params),
    );
    this.rpcInstance.addMethod(
      'discord.voice.chunk',
      async (params: DiscordVoiceStreamChunkParams) => this.handleVoiceStreamChunk(params),
    );
    this.rpcInstance.addMethod(
      'discord.voice.end',
      async (params: DiscordVoiceStreamEndParams) => this.handleVoiceStreamEnd(params),
    );
    this.rpcInstance.addMethod(
      'discord.voice.cancel',
      async (params: DiscordVoiceStreamCancelParams) => this.handleVoiceStreamCancel(params),
    );
  }

  private async dispatchHandleMessage(message: RpcSubstrateMessage): Promise<DiscordHandleMessageResult> {
    if (!this.handleMessageHandler) {
      throw new Error('No discord.handleMessage handler registered');
    }

    const substrateMessage = this.deserializeMessage(message);
    const response = await this.handleMessageHandler(substrateMessage);
    return {
      content: response.content,
      channelId: response.channelId,
      model: response.metadata.model,
      durationMs: response.metadata.durationMs,
    } satisfies DiscordHandleMessageResult;
  }

  private handleVoiceStreamStart(params: DiscordVoiceStreamStartParams): DiscordVoiceStreamAckResult {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    if (this.voiceStreams.has(key)) {
      throw this.rpcError('Voice stream already exists', GatewayErrors.VOICE_STREAM_SEQUENCE);
    }

    const state: VoiceStreamState = {
      correlationId: params.correlationId,
      streamId: params.streamId,
      baseMessage: params.message,
      expectedSequence: params.sequence + 1,
      chunkQueue: new BoundedQueue<string>({
        maxSize: this.voiceStreamQueueSize,
        overflowPolicy: this.voiceStreamOverflowPolicy,
      }),
      chunks: [],
      droppedChunks: 0,
      cancelled: false,
    };
    this.voiceStreams.set(key, state);

    return this.streamAck(state, params.sequence, true);
  }

  private handleVoiceStreamChunk(params: DiscordVoiceStreamChunkParams): DiscordVoiceStreamAckResult {
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    this.assertSequence(state, params.sequence);
    if (state.cancelled) {
      throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED);
    }

    let accepted = true;
    try {
      const result = state.chunkQueue.enqueue(params.text);
      accepted = result.accepted;
      if (result.droppedReason) {
        state.droppedChunks += 1;
      }
    } catch (error) {
      if (error instanceof QueueOverflowError) {
        throw this.rpcError(error.message, GatewayErrors.VOICE_STREAM_OVERFLOW);
      }
      throw error;
    }

    state.expectedSequence = params.sequence + 1;
    return this.streamAck(state, params.sequence, accepted);
  }

  private async handleVoiceStreamEnd(
    params: DiscordVoiceStreamEndParams,
  ): Promise<DiscordVoiceStreamEndResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    if (state.cancelled) {
      this.voiceStreams.delete(key);
      throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED);
    }
    this.assertSequence(state, params.sequence);
    state.expectedSequence = params.sequence + 1;
    this.drainQueuedChunks(state);

    try {
      const result = await this.dispatchHandleMessage({
        ...state.baseMessage,
        content: state.baseMessage.content + state.chunks.join(''),
      });
      return {
        ...result,
        correlationId: state.correlationId,
        streamId: state.streamId,
        droppedChunks: state.droppedChunks,
      };
    } finally {
      this.voiceStreams.delete(key);
    }
  }

  private async handleVoiceStreamCancel(
    params: DiscordVoiceStreamCancelParams,
  ): Promise<DiscordVoiceStreamCancelResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.voiceStreams.get(key);
    if (!state) {
      return {
        correlationId: params.correlationId,
        streamId: params.streamId,
        cancelled: false,
      };
    }

    state.cancelled = true;
    state.chunkQueue.clear();
    this.voiceStreams.delete(key);

    return {
      correlationId: params.correlationId,
      streamId: params.streamId,
      cancelled: true,
    };
  }

  private streamAck(
    state: VoiceStreamState,
    sequence: number,
    accepted: boolean,
  ): DiscordVoiceStreamAckResult {
    return {
      correlationId: state.correlationId,
      streamId: state.streamId,
      sequence,
      accepted,
      queueDepth: state.chunkQueue.size,
      droppedChunks: state.droppedChunks,
    };
  }

  private requireVoiceStream(correlationId: string, streamId: string): VoiceStreamState {
    const state = this.voiceStreams.get(this.voiceStreamKey(correlationId, streamId));
    if (!state) {
      throw this.rpcError('Voice stream not found', GatewayErrors.VOICE_STREAM_NOT_FOUND);
    }
    return state;
  }

  private assertSequence(state: VoiceStreamState, sequence: number): void {
    if (sequence !== state.expectedSequence) {
      throw this.rpcError(
        `Unexpected voice stream sequence: expected ${state.expectedSequence}, got ${sequence}`,
        GatewayErrors.VOICE_STREAM_SEQUENCE,
      );
    }
  }

  private drainQueuedChunks(state: VoiceStreamState): void {
    while (state.chunkQueue.size > 0) {
      const chunk = state.chunkQueue.dequeue();
      if (chunk !== undefined) {
        state.chunks.push(chunk);
      }
    }
  }

  private deserializeMessage(message: RpcSubstrateMessage): SubstrateMessage {
    return {
      ...message,
      timestamp: typeof message.timestamp === 'string'
        ? new Date(message.timestamp)
        : message.timestamp,
    };
  }

  private voiceStreamKey(correlationId: string, streamId: string): string {
    return `${correlationId}::${streamId}`;
  }

  private rpcError(message: string, code: number): Error {
    return new JSONRPCErrorException(message, code);
  }

  private handleChunkNotification(params: unknown): void {
    const chunk = params as LLMChunkNotification;
    const handler = chunk.requestId
      ? this.chunkHandlers.get(chunk.requestId)
      : undefined;

    if (handler) {
      handler(chunk.text);
      return;
    }

    // Backward compat: if requestId is missing or '0', fall back to any single handler
    if (!chunk.requestId || chunk.requestId === '0') {
      const fallback = this.chunkHandlers.values().next().value;
      if (fallback) {
        fallback(chunk.text);
        return;
      }
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const handlers = this.notificationHandlers.get(method);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(params);
        } catch (err) {
          log.error(`Notification handler error for ${method}`, { error: String(err) });
        }
      }
    }
  }

  // ── Lifecycle ──

  destroy(): void {
    this.voiceStreams.clear();
    this.conn.destroy();
  }
}
