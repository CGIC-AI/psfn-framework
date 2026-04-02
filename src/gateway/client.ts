// ── Gateway Client ──
// Agent-side typed RPC wrapper. Implements LLMProvider and EmbeddingService
// so it can be used as a drop-in replacement for direct clients.

import { JSONRPCServer, JSONRPCClient, JSONRPCServerAndClient, JSONRPCErrorException } from 'json-rpc-2.0';
import { Worker } from 'node:worker_threads';
import type { LLMProvider, EmbeddingService } from '../agent/contracts.js';
import type {
  AgentResponse,
  Attachment,
  CompletionPurpose,
  CorrelationMetadata,
  LLMContext,
  LLMModelHint,
  LLMResponse,
  StreamCallbacks,
  SubstrateMessage,
} from '../types.js';
import type { NdjsonConnection } from './transport.js';
import { createSocketClient } from './transport.js';
import { createComponentLogger } from '../logger.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from './backpressure.js';
import { registerReverseGatewayMethods } from './reverse-methods.js';
const log = createComponentLogger('GatewayClient');
import type { JournalIntegrityVerificationResult } from '../session/journal-utils.js';
import type { SessionIntegrityProvider } from '../session/store.js';
import type { JournalEntry } from '../session/types.js';
import type {
  LLMChatResult,
  LLMCompleteResult,
  LLMEmbedResult,
  DiscordSendResult,
  DiscordSendMediaResult,
  WebFetchResult,
  WebFetchBinaryResult,
  WebFetchLane,
  ShellExecResult,
  ShardBackendRequestParams,
  ShardBackendRequestResult,
  VaultWriteResult,
  VaultReadResult,
  VaultSearchResult,
  VaultDailyResult,
  FsReadResult,
  FsWriteResult,
  FsListResult,
  FsSearchParams,
  FsSearchResult,
  FsEditParams,
  FsEditResult,
  DiscordMessageNotification,
  LLMChunkNotification,
  VoiceHandleMessageResult,
  NotifyNtfyParams,
  NotifyNtfyResult,
  ConfirmationListResult,
  ConfirmationResolveParams,
  ConfirmationResolveResult,
  RuntimeHealthResult,
  RpcSubstrateMessage,
  VoiceStreamStartParams,
  VoiceStreamChunkParams,
  VoiceStreamEndParams,
  VoiceStreamCancelParams,
  VoiceStreamAckResult,
  VoiceStreamEndResult,
  VoiceStreamCancelResult,
  SessionHmacSignResult,
  SessionHmacVerifyResult,
  GitDiffParams,
  GitDiffResult,
  GitStatusResult,
  GitCreateBranchResult,
  GitApplyPatchResult,
  GitCommitResult,
  GitOpenPRResult,
  BeadsReadyParams,
  BeadsShowParams,
  BeadsCreateParams,
  BeadsUpdateParams,
  BeadsCloseParams,
  BeadsSyncParams,
  BeadsActionResult,
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationRpcResult,
} from './protocol.js';
import { GatewayErrors } from './protocol.js';
import { toErrorMessage } from '../utils/errors.js';

const DEFAULT_VOICE_STREAM_QUEUE_SIZE = 32;
const DEFAULT_VOICE_STREAM_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';
const DEFAULT_SESSION_INTEGRITY_RPC_TIMEOUT_MS = 3_000;
const DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS = 30_000;
const GATEWAY_KEEPALIVE_CHANNEL_ID = 'internal:gateway-keepalive';
const SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES = 64 * 1024;

const SESSION_INTEGRITY_WORKER_SOURCE = `
const net = require('node:net');
const { parentPort } = require('node:worker_threads');

if (!parentPort) {
  throw new Error('Session integrity worker requires a parent port');
}

function errorMessage(error) {
  if (error && typeof error.message === 'string') return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown session integrity worker error';
  }
}

function writeResponse(stateBuffer, payloadBuffer, payload) {
  const state = new Int32Array(stateBuffer);
  const view = new Uint8Array(payloadBuffer);
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8');
  const max = view.length;
  const size = Math.min(max, encoded.length);
  view.fill(0);
  view.set(encoded.subarray(0, size), 0);
  Atomics.store(state, 1, size);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
}

let activeSocket = null;
let activeSocketPath = null;
let connectPromise = null;
let buffer = '';
const pendingById = new Map();

function rejectPending(error) {
  for (const [id, pending] of pendingById.entries()) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pendingById.delete(id);
  }
}

function resetSocket(error) {
  if (activeSocket) {
    activeSocket.removeAllListeners();
    activeSocket.destroy();
  }
  activeSocket = null;
  activeSocketPath = null;
  connectPromise = null;
  buffer = '';
  rejectPending(error);
}

function wireSocket(socket) {
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    while (true) {
      const newline = buffer.indexOf('\\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      const pending = message && pendingById.get(message.id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      pending.resolve(message);
      pendingById.delete(message.id);
    }
  });

  socket.on('error', (error) => {
    resetSocket(error instanceof Error ? error : new Error(errorMessage(error)));
  });
  socket.on('close', () => {
    resetSocket(new Error('Session integrity RPC connection closed'));
  });
}

async function ensureSocket(socketPath) {
  if (
    activeSocket
    && !activeSocket.destroyed
    && activeSocketPath === socketPath
  ) {
    return activeSocket;
  }

  if (connectPromise) {
    return await connectPromise;
  }

  if (activeSocket && activeSocketPath !== socketPath) {
    resetSocket(new Error('Session integrity socket path changed'));
  }

  connectPromise = new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;

    const cleanup = () => {
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };

    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeSocket = socket;
      activeSocketPath = socketPath;
      wireSocket(socket);
      resolve(socket);
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  }).finally(() => {
    connectPromise = null;
  });

  return await connectPromise;
}

function requestRpc(socketPath, method, params, id, timeoutMs) {
  return ensureSocket(socketPath).then((socket) => new Promise((resolve, reject) => {
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n';

    const timer = setTimeout(() => {
      pendingById.delete(id);
      reject(new Error('Session integrity RPC timed out'));
    }, timeoutMs);

    pendingById.set(id, { resolve, reject, timer });

    try {
      socket.write(request);
    } catch (error) {
      clearTimeout(timer);
      pendingById.delete(id);
      reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }));
}

parentPort.on('message', async (job) => {
  const { stateBuffer, payloadBuffer, socketPath, method, params, requestId, timeoutMs } = job || {};
  if (!stateBuffer || !payloadBuffer || !socketPath || !method) {
    return;
  }
  try {
    const response = await requestRpc(socketPath, method, params, requestId, timeoutMs);
    writeResponse(stateBuffer, payloadBuffer, { ok: true, response });
  } catch (error) {
    const message = errorMessage(error);
    writeResponse(stateBuffer, payloadBuffer, { ok: false, error: message });
  }
});

parentPort.on('close', () => {
  resetSocket(new Error('Session integrity worker closed'));
});
`;

export interface GatewayClientOptions {
  voiceStreamQueueSize?: number;
  voiceStreamOverflowPolicy?: QueueOverflowPolicy;
  sessionIntegritySocketPath?: string;
  sessionIntegrityRpcTimeoutMs?: number;
  keepaliveIntervalMs?: number;
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

export interface GatewayConnectionCloseEvent {
  source: 'close' | 'error';
  error?: Error;
}

export class GatewayClient implements LLMProvider, EmbeddingService {
  private rpcInstance: JSONRPCServerAndClient;
  private conn: NdjsonConnection;
  private embeddingDims: number;
  private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private connectionCloseHandlers = new Set<(event: GatewayConnectionCloseEvent) => void>();
  private chunkHandlers = new Map<string, (text: string) => void>();
  private requestCounter = 0;
  private reverseMethodsRegistered = false;
  private handleMessageHandler: ((message: SubstrateMessage) => Promise<AgentResponse>) | null = null;
  private voiceStreams = new Map<string, VoiceStreamState>();
  private readonly voiceStreamQueueSize: number;
  private readonly voiceStreamOverflowPolicy: QueueOverflowPolicy;
  private readonly sessionIntegritySocketPath: string | null;
  private readonly sessionIntegrityRpcTimeoutMs: number;
  private readonly keepaliveIntervalMs: number;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private keepaliveInFlight = false;
  private sessionIntegrityWorker: Worker | null = null;
  private sessionIntegrityRequestCounter = 0;
  private closedNotified = false;
  private isDestroying = false;

  constructor(conn: NdjsonConnection, embeddingDims: number, options: GatewayClientOptions = {}) {
    this.conn = conn;
    this.embeddingDims = embeddingDims;
    this.voiceStreamQueueSize = options.voiceStreamQueueSize ?? DEFAULT_VOICE_STREAM_QUEUE_SIZE;
    this.voiceStreamOverflowPolicy = options.voiceStreamOverflowPolicy ?? DEFAULT_VOICE_STREAM_OVERFLOW_POLICY;
    this.sessionIntegritySocketPath = options.sessionIntegritySocketPath ?? null;
    this.sessionIntegrityRpcTimeoutMs = options.sessionIntegrityRpcTimeoutMs ?? DEFAULT_SESSION_INTEGRITY_RPC_TIMEOUT_MS;
    this.keepaliveIntervalMs = options.keepaliveIntervalMs ?? DEFAULT_GATEWAY_KEEPALIVE_INTERVAL_MS;

    if (!Number.isInteger(this.voiceStreamQueueSize) || this.voiceStreamQueueSize <= 0) {
      throw new Error(`voiceStreamQueueSize must be a positive integer, got ${this.voiceStreamQueueSize}`);
    }
    if (!Number.isInteger(this.sessionIntegrityRpcTimeoutMs) || this.sessionIntegrityRpcTimeoutMs <= 0) {
      throw new Error(
        `sessionIntegrityRpcTimeoutMs must be a positive integer, got ${this.sessionIntegrityRpcTimeoutMs}`,
      );
    }
    if (!Number.isInteger(this.keepaliveIntervalMs) || this.keepaliveIntervalMs <= 0) {
      throw new Error(`keepaliveIntervalMs must be a positive integer, got ${this.keepaliveIntervalMs}`);
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
      // json-rpc-2.0 receiveAndSend() payload param is typed as `any`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.rpcInstance.receiveAndSend(msg as any);
    });

    this.conn.on('close', () => {
      this.emitConnectionClose({ source: 'close' });
    });
    this.conn.on('error', (error: unknown) => {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.emitConnectionClose({ source: 'error', error: normalized });
    });

    this.startKeepalive();
  }

  static async connect(
    socketPath: string,
    embeddingDims: number,
    options: GatewayClientOptions = {},
  ): Promise<GatewayClient> {
    const conn = await createSocketClient({ socketPath });
    return new GatewayClient(conn, embeddingDims, {
      ...options,
      sessionIntegritySocketPath: options.sessionIntegritySocketPath ?? socketPath,
    });
  }

  // ── LLMProvider interface ──

  async stream(context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
    // Generate a unique per-request ID for routing streaming chunks
    const requestId = context.correlation?.requestId?.trim() || `req-${++this.requestCounter}`;
    const callType = context.correlation?.callType
      ?? context.correlation?.originType
      ?? 'chat';
    const purpose = context.correlation?.purpose
      ?? context.correlation?.originStage
      ?? 'chat';
    const modelHint = normalizeGatewayModelHint(context.modelHint);
    const hintedModel = normalizeCorrelationText(modelHint?.model);
    const hintedProvider = normalizeCorrelationText(modelHint?.provider);
    const qualifiedHint = hintedModel ? parseProviderQualifiedModel(hintedModel) : null;
    const model = qualifiedHint?.model ?? hintedModel ?? '';
    const provider = (hintedProvider ?? qualifiedHint?.provider ?? '').trim().toLowerCase();

    // Register chunk handler before sending the RPC so no chunks are missed
    if (callbacks?.onText) {
      this.chunkHandlers.set(requestId, callbacks.onText);
    }

    try {
      const result = await this.rpcInstance.request('llm.chat', {
        model,  // gateway resolves roster defaults when hint fields are unset
        provider,
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        stream: !!callbacks?.onText,
        ...(modelHint?.maxTokens !== undefined ? { maxTokens: modelHint.maxTokens } : {}),
        ...(modelHint?.contextWindow !== undefined ? { contextWindow: modelHint.contextWindow } : {}),
        ...(modelHint?.thinkingEnabled !== undefined ? { thinkingEnabled: modelHint.thinkingEnabled } : {}),
        ...(modelHint?.thinkingEffort !== undefined ? { thinkingEffort: modelHint.thinkingEffort } : {}),
        ...(modelHint?.temperature !== undefined ? { temperature: modelHint.temperature } : {}),
        ...(modelHint?.topP !== undefined ? { topP: modelHint.topP } : {}),
        ...(modelHint?.topK !== undefined ? { topK: modelHint.topK } : {}),
        ...(modelHint?.frequencyPenalty !== undefined ? { frequencyPenalty: modelHint.frequencyPenalty } : {}),
        ...(modelHint?.repetitionPenalty !== undefined ? { repetitionPenalty: modelHint.repetitionPenalty } : {}),
        requestId,
        ...(context.correlation?.turnId ? { turnId: context.correlation.turnId } : {}),
        ...(context.correlation?.channelId ? { channelId: context.correlation.channelId } : {}),
        ...(context.correlation?.toolName ? { toolName: context.correlation.toolName } : {}),
        ...(context.correlation?.toolCallId ? { toolCallId: context.correlation.toolCallId } : {}),
        callType,
        ...(context.correlation?.originType ? { originType: context.correlation.originType } : {}),
        ...(context.correlation?.originStage ? { originStage: context.correlation.originStage } : {}),
        purpose,
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

  async complete(
    context: LLMContext,
    purpose: CompletionPurpose,
    options: {
      signal?: AbortSignal;
      modelHint?: LLMModelHint;
      correlation?: Partial<CorrelationMetadata>;
    } = {},
  ): Promise<LLMResponse> {
    const correlation = {
      ...(context.correlation ?? {}),
      ...(options.correlation ?? {}),
    };
    const modelHint = mergeGatewayModelHints(context.modelHint, options.modelHint);
    const hintedModel = normalizeCorrelationText(modelHint?.model);
    const hintedProvider = normalizeCorrelationText(modelHint?.provider);
    const qualifiedHint = hintedModel ? parseProviderQualifiedModel(hintedModel) : null;
    const model = qualifiedHint?.model ?? hintedModel ?? '';
    const provider = (hintedProvider ?? qualifiedHint?.provider ?? '').trim().toLowerCase();

    const result = await this.requestWithAbortSignal<LLMCompleteResult>(
      'llm.complete',
      {
        model,
        provider,
        messages: context.messages,
        systemPrompt: context.systemPrompt,
        purpose,
        ...(modelHint?.maxTokens !== undefined ? { maxTokens: modelHint.maxTokens } : {}),
        ...(modelHint?.contextWindow !== undefined ? { contextWindow: modelHint.contextWindow } : {}),
        ...(modelHint?.thinkingEnabled !== undefined ? { thinkingEnabled: modelHint.thinkingEnabled } : {}),
        ...(modelHint?.thinkingEffort !== undefined ? { thinkingEffort: modelHint.thinkingEffort } : {}),
        ...(modelHint?.temperature !== undefined ? { temperature: modelHint.temperature } : {}),
        ...(modelHint?.topP !== undefined ? { topP: modelHint.topP } : {}),
        ...(modelHint?.topK !== undefined ? { topK: modelHint.topK } : {}),
        ...(modelHint?.frequencyPenalty !== undefined ? { frequencyPenalty: modelHint.frequencyPenalty } : {}),
        ...(modelHint?.repetitionPenalty !== undefined ? { repetitionPenalty: modelHint.repetitionPenalty } : {}),
        ...(correlation.turnId ? { turnId: correlation.turnId } : {}),
        ...(correlation.requestId ? { requestId: correlation.requestId } : {}),
        ...(correlation.channelId ? { channelId: correlation.channelId } : {}),
        ...(correlation.toolName ? { toolName: correlation.toolName } : {}),
        ...(correlation.toolCallId ? { toolCallId: correlation.toolCallId } : {}),
        ...(correlation.callType ? { callType: correlation.callType } : {}),
        ...(correlation.originType ? { originType: correlation.originType } : {}),
        ...(correlation.originStage ? { originStage: correlation.originStage } : {}),
      },
      options.signal,
    );

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

  async embed(text: string, options: { signal?: AbortSignal } = {}): Promise<Float32Array> {
    const results = await this.embedBatch([text], options);
    return results[0];
  }

  async embedBatch(
    texts: string[],
    options: { signal?: AbortSignal } = {},
  ): Promise<Float32Array[]> {
    const result = await this.requestWithAbortSignal<LLMEmbedResult>(
      'llm.embed',
      {
        texts,
      },
      options.signal,
    );

    return result.embeddings.map(e => new Float32Array(e));
  }

  // ── Discord methods ──

  async discordSend(channelId: string, content: string): Promise<void> {
    await this.rpcInstance.request('discord.send', {
      channelId,
      content,
    }) as DiscordSendResult;
  }

  async discordSendMedia(channelId: string, media: Attachment): Promise<void> {
    await this.rpcInstance.request('discord.sendMedia', {
      channelId,
      media,
    }) as DiscordSendMediaResult;
  }

  async discordTyping(channelId: string): Promise<void> {
    await this.rpcInstance.request('discord.typing', { channelId });
  }

  // ── Web fetch ──

  async webFetch(
    url: string,
    prompt?: string,
    lane: WebFetchLane = 'default',
  ): Promise<string> {
    const result = await this.rpcInstance.request('web.fetch', {
      url,
      prompt,
      lane,
    }) as WebFetchResult;
    return result.content;
  }

  async webFetchBinary(
    url: string,
    options: {
      lane?: WebFetchLane;
      maxBytes?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<WebFetchBinaryResult> {
    return await this.rpcInstance.request('web.fetch_binary', {
      url,
      lane: options.lane ?? 'default',
      ...(typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
        ? { maxBytes: Math.max(1, Math.floor(options.maxBytes)) }
        : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    }) as WebFetchBinaryResult;
  }

  async shellExec(
    command: string,
    args: string[] = [],
    options: {
      cwd?: string;
      timeoutMs?: number;
      maxOutputChars?: number;
      envVars?: string[];
    } = {},
  ): Promise<ShellExecResult> {
    return await this.rpcInstance.request('shell.exec', {
      command,
      args,
      ...options,
    }) as ShellExecResult;
  }

  async shardBackendRequest(
    params: ShardBackendRequestParams,
  ): Promise<ShardBackendRequestResult> {
    return await this.rpcInstance.request('shard.backend.request', params) as ShardBackendRequestResult;
  }

  async vaultWrite(
    name: string,
    content: string,
    options: {
      folder?: string;
      mode?: 'create' | 'append' | 'prepend';
    } = {},
  ): Promise<VaultWriteResult> {
    return await this.rpcInstance.request('vault.write', {
      name,
      content,
      ...options,
    }) as VaultWriteResult;
  }

  async vaultRead(name: string): Promise<VaultReadResult> {
    return await this.rpcInstance.request('vault.read', { name }) as VaultReadResult;
  }

  async vaultSearch(query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.rpcInstance.request('vault.search', {
      query,
      ...(typeof limit === 'number' && Number.isFinite(limit)
        ? { limit: Math.max(1, Math.floor(limit)) }
        : {}),
    }) as VaultSearchResult;
  }

  async vaultDaily(content?: string): Promise<VaultDailyResult> {
    return await this.rpcInstance.request('vault.daily', {
      ...(typeof content === 'string' ? { content } : {}),
    }) as VaultDailyResult;
  }

  async ['vault.write'](
    name: string,
    content: string,
    options?: {
      folder?: string;
      mode?: 'create' | 'append' | 'prepend';
    },
  ): Promise<VaultWriteResult> {
    return await this.vaultWrite(name, content, options);
  }

  async ['vault.read'](name: string): Promise<VaultReadResult> {
    return await this.vaultRead(name);
  }

  async ['vault.search'](query: string, limit?: number): Promise<VaultSearchResult> {
    return await this.vaultSearch(query, limit);
  }

  async ['vault.daily'](content?: string): Promise<VaultDailyResult> {
    return await this.vaultDaily(content);
  }

  // ── Filesystem ──

  async fsReadDetailed(path: string, options?: { maxBytes?: number }): Promise<FsReadResult> {
    return await this.rpcInstance.request('fs.read', {
      path,
      ...(typeof options?.maxBytes === 'number' ? { maxBytes: options.maxBytes } : {}),
    }) as FsReadResult;
  }

  async fsRead(path: string, options?: { maxBytes?: number }): Promise<string> {
    const result = await this.fsReadDetailed(path, options);
    return result.content;
  }

  async fsWrite(path: string, content: string): Promise<void> {
    await this.rpcInstance.request('fs.write', { path, content }) as FsWriteResult;
  }

  async fsList(glob = '**/*', maxEntries = 200): Promise<string[]> {
    const result = await this.rpcInstance.request('fs.list', {
      glob,
      maxEntries,
    }) as FsListResult;
    return result.paths;
  }

  async fsSearch(params: FsSearchParams): Promise<FsSearchResult> {
    return await this.rpcInstance.request('fs.search', params) as FsSearchResult;
  }

  async fsEdit(params: FsEditParams): Promise<FsEditResult> {
    return await this.rpcInstance.request('fs.edit', params) as FsEditResult;
  }

  // ── Git operations ──

  async gitStatus(): Promise<GitStatusResult> {
    return await this.rpcInstance.request('git.status', {}) as GitStatusResult;
  }

  async gitDiff(opts: GitDiffParams = {}): Promise<GitDiffResult> {
    return await this.rpcInstance.request('git.diff', opts) as GitDiffResult;
  }

  async gitCreateBranch(name: string, startPoint?: string): Promise<string> {
    const result = await this.rpcInstance.request('git.create_branch', {
      name,
      startPoint,
    }) as GitCreateBranchResult;
    return result.name;
  }

  async gitApplyPatch(filePath: string, content: string): Promise<void> {
    await this.rpcInstance.request('git.apply_patch', { filePath, content }) as GitApplyPatchResult;
  }

  async gitCommit(message: string, intent: string, scope?: string): Promise<GitCommitResult> {
    return await this.rpcInstance.request('git.commit', { message, intent, scope }) as GitCommitResult;
  }

  async gitOpenPR(title: string, body: string, base?: string): Promise<string> {
    const result = await this.rpcInstance.request('git.open_pr', { title, body, base }) as GitOpenPRResult;
    return result.url;
  }

  // ── Beads issue management ──

  async beadsReady(params: BeadsReadyParams = {}): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.ready', params) as BeadsActionResult;
  }

  async beadsShow(params: BeadsShowParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.show', params) as BeadsActionResult;
  }

  async beadsCreate(params: BeadsCreateParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.create', params) as BeadsActionResult;
  }

  async beadsUpdate(params: BeadsUpdateParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.update', params) as BeadsActionResult;
  }

  async beadsClose(params: BeadsCloseParams): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.close', params) as BeadsActionResult;
  }

  async beadsSync(params: BeadsSyncParams = {}): Promise<BeadsActionResult> {
    return await this.rpcInstance.request('beads.sync', params) as BeadsActionResult;
  }

  async imageCreate(params: ImageCreateParams): Promise<ImageGenerationRpcResult> {
    return await this.rpcInstance.request('image.create', params) as ImageGenerationRpcResult;
  }

  async imageEdit(params: ImageEditParams): Promise<ImageGenerationRpcResult> {
    return await this.rpcInstance.request('image.edit', params) as ImageGenerationRpcResult;
  }

  async notifyNtfy(params: NotifyNtfyParams): Promise<NotifyNtfyResult> {
    return await this.rpcInstance.request('notify.ntfy', params) as NotifyNtfyResult;
  }

  async runtimeHealth(): Promise<RuntimeHealthResult> {
    return await this.rpcInstance.request('runtime.health', {}) as RuntimeHealthResult;
  }

  async listConfirmationQueue(): Promise<ConfirmationListResult> {
    return await this.rpcInstance.request('confirmation.list', {}) as ConfirmationListResult;
  }

  async resolveConfirmationQueue(params: ConfirmationResolveParams): Promise<ConfirmationResolveResult> {
    return await this.rpcInstance.request('confirmation.resolve', params) as ConfirmationResolveResult;
  }

  async sessionHmacSign(entry: JournalEntry, previousHmac: string | null): Promise<JournalEntry> {
    const result = await this.rpcInstance.request('session.hmac.sign', {
      entry,
      previousHmac,
    }) as SessionHmacSignResult;
    return result.entry;
  }

  async sessionHmacVerify(
    entry: JournalEntry,
    previousHmac: string | null,
  ): Promise<JournalIntegrityVerificationResult> {
    return await this.rpcInstance.request('session.hmac.verify', {
      entry,
      previousHmac,
    }) as SessionHmacVerifyResult;
  }

  createSessionIntegrityProvider(): SessionIntegrityProvider {
    return {
      sign: (entry, previousHmac) => {
        const result = this.requestSessionIntegritySync<SessionHmacSignResult>('session.hmac.sign', {
          entry,
          previousHmac,
        });
        return result.entry;
      },
      verify: (entry, previousHmac) => this.requestSessionIntegritySync<SessionHmacVerifyResult>(
        'session.hmac.verify',
        {
          entry,
          previousHmac,
        },
      ),
    };
  }

  // ── Notification handlers ──

  onDiscordMessage(handler: (message: SubstrateMessage) => void): () => void {
    return this.onNotification('discord.message', (params) => {
      const notification = params as DiscordMessageNotification;
      handler(notification.message);
    });
  }

  onDisconnect(handler: (event: GatewayConnectionCloseEvent) => void): () => void {
    this.connectionCloseHandlers.add(handler);
    return () => {
      this.connectionCloseHandlers.delete(handler);
    };
  }

  private async requestWithAbortSignal<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!signal) {
      return await this.rpcInstance.request(method, params) as T;
    }

    if (signal.aborted) {
      throw createAbortError(signal.reason);
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;

      const finalize = (kind: 'resolve' | 'reject', value: unknown): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        if (kind === 'resolve') {
          resolve(value as T);
        } else {
          reject(value);
        }
      };

      const onAbort = () => {
        finalize('reject', createAbortError(signal.reason));
      };

      signal.addEventListener('abort', onAbort, { once: true });

      this.rpcInstance.request(method, params).then(
        (result) => finalize('resolve', result),
        (error) => finalize('reject', error),
      );
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

  private startKeepalive(): void {
    if (this.keepaliveTimer || this.isDestroying) {
      return;
    }
    this.keepaliveTimer = setInterval(() => {
      void this.sendKeepalive();
    }, this.keepaliveIntervalMs);
    this.keepaliveTimer.unref();
  }

  private stopKeepalive(): void {
    if (!this.keepaliveTimer) {
      return;
    }
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  private async sendKeepalive(): Promise<void> {
    if (this.isDestroying || this.keepaliveInFlight) {
      return;
    }
    this.keepaliveInFlight = true;
    try {
      await this.rpcInstance.request('discord.typing', {
        channelId: GATEWAY_KEEPALIVE_CHANNEL_ID,
      });
    } catch (error) {
      log.debug('Gateway keepalive RPC failed', { error: toErrorMessage(error) });
    } finally {
      this.keepaliveInFlight = false;
    }
  }

  /** Register a handler for reverse RPC calls from gateway (e.g. voice messages) */
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void {
    this.handleMessageHandler = handler;
    this.registerReverseMethods();
  }

  private registerReverseMethods(): void {
    if (this.reverseMethodsRegistered) return;
    this.reverseMethodsRegistered = true;

    registerReverseGatewayMethods({
      target: this.rpcInstance,
      dispatchHandleMessage: (message) => this.dispatchHandleMessage(message),
      handleVoiceStreamStart: (params) => this.handleVoiceStreamStart(params),
      handleVoiceStreamChunk: (params) => this.handleVoiceStreamChunk(params),
      handleVoiceStreamEnd: (params) => this.handleVoiceStreamEnd(params),
      handleVoiceStreamCancel: (params) => this.handleVoiceStreamCancel(params),
    });
  }

  private async dispatchHandleMessage(message: RpcSubstrateMessage): Promise<VoiceHandleMessageResult> {
    if (!this.handleMessageHandler) {
      throw new Error('No voice.handleMessage handler registered');
    }

    const substrateMessage = this.deserializeMessage(message);
    const response = await this.handleMessageHandler(substrateMessage);
    return {
      content: response.content,
      channelId: response.channelId,
      ...(response.attachments ? { attachments: response.attachments } : {}),
      model: response.metadata.model,
      durationMs: response.metadata.durationMs,
    } satisfies VoiceHandleMessageResult;
  }

  private handleVoiceStreamStart(params: VoiceStreamStartParams): VoiceStreamAckResult {
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

  private handleVoiceStreamChunk(params: VoiceStreamChunkParams): VoiceStreamAckResult {
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
    params: VoiceStreamEndParams,
  ): Promise<VoiceStreamEndResult> {
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
    params: VoiceStreamCancelParams,
  ): Promise<VoiceStreamCancelResult> {
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
  ): VoiceStreamAckResult {
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

  private emitConnectionClose(event: GatewayConnectionCloseEvent): void {
    if (this.isDestroying || this.closedNotified) {
      return;
    }
    this.closedNotified = true;
    this.stopKeepalive();
    for (const handler of this.connectionCloseHandlers) {
      try {
        handler(event);
      } catch (error) {
        log.error('Disconnect handler error', { error: toErrorMessage(error) });
      }
    }
  }

  private ensureSessionIntegrityWorker(): Worker {
    if (this.sessionIntegrityWorker) return this.sessionIntegrityWorker;
    if (!this.sessionIntegritySocketPath) {
      throw new Error('Session integrity provider requires a gateway socket path');
    }

    const worker = new Worker(SESSION_INTEGRITY_WORKER_SOURCE, { eval: true });
    worker.on('error', (error) => {
      log.error('Session integrity worker error', { error: error.message });
    });
    this.sessionIntegrityWorker = worker;
    return worker;
  }

  private requestSessionIntegritySync<T>(
    method: 'session.hmac.sign' | 'session.hmac.verify',
    params: Record<string, unknown>,
  ): T {
    const worker = this.ensureSessionIntegrityWorker();
    const stateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    const payloadBuffer = new SharedArrayBuffer(SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES);
    const state = new Int32Array(stateBuffer);
    const requestId = ++this.sessionIntegrityRequestCounter;

    worker.postMessage({
      stateBuffer,
      payloadBuffer,
      socketPath: this.sessionIntegritySocketPath,
      method,
      params,
      requestId,
      timeoutMs: this.sessionIntegrityRpcTimeoutMs,
    });

    const wait = Atomics.wait(state, 0, 0, this.sessionIntegrityRpcTimeoutMs + 250);
    if (wait === 'timed-out') {
      throw new Error(`Session integrity RPC timed out for ${method}`);
    }

    const payloadSize = Atomics.load(state, 1);
    if (!Number.isInteger(payloadSize) || payloadSize <= 0 || payloadSize > SESSION_INTEGRITY_RESPONSE_BUFFER_BYTES) {
      throw new Error('Session integrity RPC returned an invalid payload');
    }

    const raw = Buffer.from(new Uint8Array(payloadBuffer, 0, payloadSize)).toString('utf8');
    const parsed = JSON.parse(raw) as {
      ok: boolean;
      response?: { result?: unknown; error?: { code: number; message: string } };
      error?: string;
    };

    if (!parsed.ok) {
      throw new Error(parsed.error ?? `Session integrity RPC failed for ${method}`);
    }

    const rpcResponse = parsed.response;
    if (!rpcResponse) {
      throw new Error(`Session integrity RPC missing response for ${method}`);
    }

    if (rpcResponse.error) {
      throw new JSONRPCErrorException(rpcResponse.error.message, rpcResponse.error.code);
    }

    return rpcResponse.result as T;
  }

  // ── Lifecycle ──

  destroy(): void {
    if (this.isDestroying) return;
    this.isDestroying = true;
    this.stopKeepalive();
    this.voiceStreams.clear();
    this.connectionCloseHandlers.clear();
    if (this.sessionIntegrityWorker) {
      void this.sessionIntegrityWorker.terminate();
      this.sessionIntegrityWorker = null;
    }
    this.conn.destroy();
  }
}

function normalizeCorrelationText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProviderQualifiedModel(value: string): { provider: string; model: string } | null {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator >= value.length - 1) {
    return null;
  }
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  if (!provider || !model) return null;
  return { provider, model };
}

function normalizeGatewayModelHint(modelHint: LLMModelHint | undefined): LLMModelHint | undefined {
  if (!modelHint) return undefined;
  const model = normalizeCorrelationText(modelHint.model);
  const provider = normalizeCorrelationText(modelHint.provider)?.toLowerCase();
  const maxTokens = toPositiveInteger(modelHint.maxTokens);
  const contextWindow = toPositiveInteger(modelHint.contextWindow);
  const thinkingEnabled = typeof modelHint.thinkingEnabled === 'boolean'
    ? modelHint.thinkingEnabled
    : undefined;
  const thinkingEffort = toThinkingEffort(modelHint.thinkingEffort);
  const temperature = toFiniteNumber(modelHint.temperature);
  const topP = toUnitInterval(modelHint.topP);
  const topK = toPositiveInteger(modelHint.topK);
  const frequencyPenalty = toFiniteNumber(modelHint.frequencyPenalty);
  const repetitionPenalty = toFiniteNumber(modelHint.repetitionPenalty);
  if (
    !model
    && !provider
    && maxTokens === undefined
    && contextWindow === undefined
    && thinkingEnabled === undefined
    && thinkingEffort === undefined
    && temperature === undefined
    && topP === undefined
    && topK === undefined
    && frequencyPenalty === undefined
    && repetitionPenalty === undefined
  ) {
    return undefined;
  }
  return {
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(thinkingEnabled !== undefined ? { thinkingEnabled } : {}),
    ...(thinkingEffort !== undefined ? { thinkingEffort } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(topK !== undefined ? { topK } : {}),
    ...(frequencyPenalty !== undefined ? { frequencyPenalty } : {}),
    ...(repetitionPenalty !== undefined ? { repetitionPenalty } : {}),
  };
}

function mergeGatewayModelHints(
  contextHint: LLMModelHint | undefined,
  optionHint: LLMModelHint | undefined,
): LLMModelHint | undefined {
  const normalizedContext = normalizeGatewayModelHint(contextHint);
  const normalizedOption = normalizeGatewayModelHint(optionHint);
  if (!normalizedContext && !normalizedOption) return undefined;
  return {
    ...(normalizedContext ?? {}),
    ...(normalizedOption ?? {}),
  };
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function toPositiveInteger(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  return Math.floor(numeric);
}

function toUnitInterval(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric === undefined || numeric < 0 || numeric > 1) return undefined;
  return numeric;
}

function toThinkingEffort(value: unknown): LLMModelHint['thinkingEffort'] | undefined {
  switch (value) {
    case 'minimal':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return undefined;
  }
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    reason.name = reason.name || 'AbortError';
    return reason;
  }
  const message = typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : 'Request aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
