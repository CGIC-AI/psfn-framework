// ── Gateway Client ──
// Agent-side typed RPC wrapper. Implements LLMProvider and EmbeddingService
// so it can be used as a drop-in replacement for direct clients.

import { JSONRPCClient } from 'json-rpc-2.0';
import type { LLMProvider, EmbeddingService } from '../agent-loop.js';
import type { LLMContext, LLMResponse, StreamCallbacks, SubstrateMessage } from '../types.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketClient } from './transport.js';
import { createComponentLogger } from '../logger.js';
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
} from './protocol.js';

export class GatewayClient implements LLMProvider, EmbeddingService {
  private rpcClient: JSONRPCClient;
  private conn: NdjsonConnection;
  private embeddingDims: number;
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private chunkHandlers = new Map<string, (text: string) => void>();
  private requestCounter = 0;

  constructor(conn: NdjsonConnection, embeddingDims: number) {
    this.conn = conn;
    this.embeddingDims = embeddingDims;

    // Create RPC client that sends over the NDJSON connection
    this.rpcClient = new JSONRPCClient((request) => {
      this.conn.send(request);
    });

    // Route incoming messages: responses go to RPC client, notifications to handlers
    this.conn.onMessage((message: unknown) => {
      const msg = message as Record<string, unknown>;

      if ('method' in msg && !('id' in msg)) {
        // JSON-RPC notification (no id)
        this.handleNotification(msg.method as string, msg.params);
      } else if ('id' in msg) {
        // JSON-RPC response
        this.rpcClient.receive(msg as any);
      }
    });
  }

  static async connect(socketPath: string, embeddingDims: number): Promise<GatewayClient> {
    const conn = await createSocketClient({ socketPath });
    return new GatewayClient(conn, embeddingDims);
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
      const result = await this.rpcClient.request('llm.chat', {
        model: '',  // gateway uses its own config
        provider: '',
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        stream: !!callbacks?.onText,
        requestId,
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

  async complete(context: LLMContext, purpose: 'extraction' | 'summary'): Promise<LLMResponse> {
    const result = await this.rpcClient.request('llm.complete', {
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
    const result = await this.rpcClient.request('llm.embed', {
      texts,
    }) as LLMEmbedResult;

    return result.embeddings.map(e => new Float32Array(e));
  }

  // ── Discord methods ──

  async discordSend(channelId: string, content: string): Promise<void> {
    await this.rpcClient.request('discord.send', {
      channelId,
      content,
    }) as DiscordSendResult;
  }

  async discordTyping(channelId: string): Promise<void> {
    await this.rpcClient.request('discord.typing', { channelId });
  }

  // ── Web fetch ──

  async webFetch(url: string, prompt?: string): Promise<string> {
    const result = await this.rpcClient.request('web.fetch', {
      url,
      prompt,
    }) as WebFetchResult;
    return result.content;
  }

  // ── Filesystem ──

  async fsRead(path: string): Promise<string> {
    const result = await this.rpcClient.request('fs.read', { path }) as FsReadResult;
    return result.content;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.rpcClient.request('fs.write', { path, content }) as FsWriteResult;
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

  private handleNotification(method: string, params: unknown): void {
    // Special case: streaming chunks are routed by requestId
    if (method === 'llm.chunk') {
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
      return;
    }

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
    this.conn.destroy();
  }
}
