import {
  JSONRPCErrorException,
  type JSONRPCServerAndClient,
} from 'json-rpc-2.0';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { WyomingShardRoutingConfig } from '../../system/config/runtime-config-contracts.js';
import {
  GatewayErrors,
  type RpcSubstrateMessage,
  type VoiceHandleMessageResult,
  type VoiceStreamCancelParams,
  type VoiceStreamChunkParams,
  type VoiceStreamEndParams,
  type VoiceStreamEndResult,
  type VoiceStreamMetadata,
  type VoiceStreamStartParams,
} from './protocol.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from './backpressure.js';
import { applyWyomingRoutingPolicy } from './wyoming-routing.js';
import {
  createGatewayRoutingEnvelope,
  type CompanionId,
} from '../../shared/routing/envelope.js';
import type { CompanionRoutingBinding } from '../../shared/routing/companion-id.js';

const DEFAULT_VOICE_CHUNK_SIZE = 120;
const DEFAULT_VOICE_QUEUE_SIZE = 32;
const DEFAULT_VOICE_OVERFLOW_POLICY: QueueOverflowPolicy = 'error';
export const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

interface ReverseVoiceRpcMethods {
  handleMessage: string;
  start: string;
  chunk: string;
  end: string;
  cancel: string;
}

const PRIMARY_REVERSE_VOICE_RPC_METHODS: ReverseVoiceRpcMethods = {
  handleMessage: 'voice.handleMessage',
  start: 'voice.stream.start',
  chunk: 'voice.stream.chunk',
  end: 'voice.stream.end',
  cancel: 'voice.stream.cancel',
};


export interface VoiceStreamRequestOptions {
  timeoutMs?: number;
  chunkSize?: number;
  maxQueueSize?: number;
  overflowPolicy?: QueueOverflowPolicy;
  correlationId?: string;
  streamId?: string;
  metadata?: VoiceStreamMetadata;
  signal?: AbortSignal;
}

export interface RequestAgentVoiceStreamOptions extends CompanionRoutingBinding {
  client: JSONRPCServerAndClient;
  message: SubstrateMessage;
  options?: VoiceStreamRequestOptions;
  wyomingShardRouting: WyomingShardRoutingConfig;
  companionId: CompanionId;
  nextRequestCounter: () => number;
}

export async function requestAgentVoiceStream({
  client,
  message,
  options = {},
  wyomingShardRouting,
  companionId,
  nextRequestCounter,
}: RequestAgentVoiceStreamOptions): Promise<VoiceHandleMessageResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const chunkSize = normalizePositiveInt(options.chunkSize, DEFAULT_VOICE_CHUNK_SIZE);
  const maxQueueSize = normalizePositiveInt(options.maxQueueSize, DEFAULT_VOICE_QUEUE_SIZE);
  const overflowPolicy = options.overflowPolicy ?? DEFAULT_VOICE_OVERFLOW_POLICY;
  const requestCounter = nextRequestCounter();
  const correlationId = options.correlationId ?? `voice-corr-${Date.now()}-${requestCounter}`;
  const streamId = options.streamId ?? `voice-stream-${Date.now()}-${requestCounter}`;
  // mmo9.6.1: every voice turn carries a transport-agnostic cancellation
  // identity. A transport that already minted one (to correlate its own
  // barge-in controller) keeps it; otherwise mint here so the streamed message
  // routing — and thus the agent's turn — is always addressable by cancelTurn.
  const cancellationId = (typeof message.routing?.cancellationId === 'string'
    && message.routing.cancellationId.trim())
    ? message.routing.cancellationId
    : `voice-cancel-${Date.now()}-${requestCounter}`;
  const gatewayAddressedMessage: SubstrateMessage = {
    ...message,
    routing: {
      ...(message.routing ?? {}),
      cancellationId,
      gateway: createGatewayRoutingEnvelope({
        companionId,
        ...(message.routing?.gateway?.shard
          ? { shard: message.routing.gateway.shard }
          : {}),
        ...(message.routing?.gateway?.subagentAddress
          ? { subagentAddress: message.routing.gateway.subagentAddress }
          : {}),
      }),
    },
  };
  const routedMessage = applyWyomingRoutingPolicy(
    gatewayAddressedMessage,
    options.metadata,
    wyomingShardRouting,
    companionId,
  );

  const queue = new BoundedQueue<string>({
    maxSize: maxQueueSize,
    overflowPolicy,
  });

  const chunks = chunkText(routedMessage.content, chunkSize);
  let droppedChunks = 0;
  for (const chunk of chunks) {
    try {
      const enqueueResult = queue.enqueue(chunk);
      if (enqueueResult.droppedReason) {
        droppedChunks += 1;
      }
    } catch (error) {
      if (error instanceof QueueOverflowError) {
        throw new JSONRPCErrorException(error.message, GatewayErrors.VOICE_STREAM_OVERFLOW);
      }
      throw error;
    }
  }

  const baseFrame = {
    correlationId,
    streamId,
    metadata: options.metadata,
  } as const;

  const reverseVoiceMethods = PRIMARY_REVERSE_VOICE_RPC_METHODS;

  // Races a reverse RPC against the agent timeout only. Used for the cancel
  // frame itself, which must still be sent while the turn is being aborted and
  // therefore must NOT lose to the abort rejection below.
  const timeoutRace = <T>(request: () => PromiseLike<T>): Promise<T> =>
    Promise.race([
      Promise.resolve(request()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent voice stream timed out')), timeoutMs),
      ),
    ]);

  let sequence = 0;
  let cancelled = false;
  let cancelSent = false;

  // mmo9.6.5: send voice.stream.cancel at most once per turn. The gateway's
  // handleVoiceStreamCancel keys off correlationId+streamId, aborts the
  // per-stream controller, and that abort trips the AbortSignal threaded into
  // the in-flight model turn — reaching SubstrateAgent.cancelTurn(cancellationId)
  // (mmo9.6.1) and the provider-port cancel, so upstream model + TTS generation
  // stops rather than only local transport state. A transport failure on the
  // cancel itself is swallowed: the local turn is torn down regardless, and a
  // lost cancel frame must not mask the original error being propagated.
  const sendCancel = async (cancelSequence: number, reason: string): Promise<void> => {
    if (cancelSent) {
      return;
    }
    cancelSent = true;
    const cancelPayload: VoiceStreamCancelParams = {
      ...baseFrame,
      sequence: cancelSequence,
      reason,
    };
    await timeoutRace(() => client.request(reverseVoiceMethods.cancel, cancelPayload))
      .catch(() => undefined);
  };

  // mmo9.6.5: attach a WHOLE-TURN abort listener, not just the chunk-loop poll.
  // In production the WS voice path (api-surface handleAssistantTurn ->
  // requestAgentVoiceStream) blocks awaiting voice.stream.end while the agent
  // generates the model turn. A barge-in that aborts options.signal during that
  // window previously did nothing: no cancel frame was sent and the await hung
  // until the agent timeout, so the model kept generating (defeating mmo9.6's
  // preemptive-interrupt goal). This listener rejects the in-flight reverse RPC
  // the instant the turn is aborted AND sends voice.stream.cancel so the agent
  // turn is actually cancelled end-to-end.
  const signal = options.signal;
  let detachAbortListener: (() => void) | undefined;
  const abortRejection = new Promise<never>((_, reject) => {
    if (!signal) {
      return;
    }
    const onAbort = (): void => {
      cancelled = true;
      // Fire-and-forget so the awaiting RPC unblocks immediately; sendCancel is
      // idempotent and swallows its own transport errors.
      void sendCancel(sequence + 1, 'aborted');
      reject(new Error('Voice stream aborted'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  // Keep the abort rejection considered handled even when no RPC is currently
  // racing it (an abort landing between awaits), preventing an unhandled
  // rejection while still surfacing to any active race.
  abortRejection.catch(() => undefined);

  const invokeWithTimeout = async <T>(request: () => PromiseLike<T>): Promise<T> => {
    if (signal?.aborted) {
      throw new Error('Voice stream aborted before dispatch');
    }

    const rpc = timeoutRace(request);
    // When the abort rejection wins the race the underlying RPC promise is
    // abandoned mid-flight; keep its eventual settlement handled so a later
    // rejection (the gateway's cancelled voice.stream.end) never surfaces as an
    // unhandled rejection.
    rpc.catch(() => undefined);
    return await Promise.race([rpc, abortRejection]);
  };

  const serializedMessage = serializeMessage({
    ...routedMessage,
    content: '',
  });
  const startParams: VoiceStreamStartParams = {
    ...baseFrame,
    sequence,
    message: serializedMessage,
  };

  try {
    try {
      await invokeWithTimeout(() => client.request(reverseVoiceMethods.start, startParams));
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        return requestAgentViaHandlePath(client, serializedMessage, timeoutMs);
      }
      throw error;
    }

    try {
      while (queue.size > 0) {
        if (signal?.aborted) {
          cancelled = true;
          await sendCancel(sequence + 1, 'aborted');
          throw new Error('Voice stream aborted');
        }

        const text = queue.dequeue();
        if (text === undefined) {
          break;
        }

        sequence += 1;
        const chunkParams: VoiceStreamChunkParams = {
          ...baseFrame,
          sequence,
          text,
        };

        const ack = await invokeWithTimeout(() =>
          client.request(reverseVoiceMethods.chunk, chunkParams) as Promise<{
            accepted: boolean;
            droppedChunks?: number;
          }>,
        );

        if (!ack.accepted) {
          droppedChunks += 1;
        } else if (typeof ack.droppedChunks === 'number') {
          droppedChunks = Math.max(droppedChunks, ack.droppedChunks);
        }
      }

      sequence += 1;
      const endParams: VoiceStreamEndParams = {
        ...baseFrame,
        sequence,
        metadata: {
          ...(options.metadata ?? {}),
          droppedChunks,
        },
      };

      const streamResult = await invokeWithTimeout(() =>
        client.request(reverseVoiceMethods.end, endParams) as Promise<VoiceStreamEndResult>,
      );

      return {
        content: streamResult.content,
        channelId: streamResult.channelId,
        ...(streamResult.attachments ? { attachments: streamResult.attachments } : {}),
        model: streamResult.model,
        durationMs: streamResult.durationMs,
      };
    } catch (error) {
      if (!cancelled) {
        await sendCancel(sequence + 1, 'stream-error');
      }
      throw error;
    }
  } finally {
    detachAbortListener?.();
  }
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) {
    return fallback;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function chunkText(text: string, chunkSize: number): string[] {
  const source = text;
  if (!source) return [''];

  const chunks: string[] = [];
  for (let index = 0; index < source.length; index += chunkSize) {
    chunks.push(source.slice(index, index + chunkSize));
  }

  return chunks;
}

function serializeMessage(message: SubstrateMessage): RpcSubstrateMessage {
  return {
    ...message,
    timestamp: message.timestamp instanceof Date
      ? message.timestamp.toISOString()
      : message.timestamp,
  };
}

function isMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const candidate = error as { code?: number; message?: string };
  return candidate.code === -32601 || candidate.message === 'Method not found';
}

async function requestAgentViaHandlePath(
  client: JSONRPCServerAndClient,
  message: RpcSubstrateMessage,
  timeoutMs: number,
): Promise<VoiceHandleMessageResult> {
  const invokeHandle = async (method: string): Promise<VoiceHandleMessageResult> => {
    const result = await Promise.race([
      client.request(method, { message }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent voice handle request timed out')), timeoutMs),
      ),
    ]);
    return result as VoiceHandleMessageResult;
  };

  return await invokeHandle(PRIMARY_REVERSE_VOICE_RPC_METHODS.handleMessage);
}
