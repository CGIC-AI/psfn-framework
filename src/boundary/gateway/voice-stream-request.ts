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

export interface RequestAgentVoiceStreamOptions {
  client: JSONRPCServerAndClient;
  message: SubstrateMessage;
  options?: VoiceStreamRequestOptions;
  wyomingShardRouting: WyomingShardRoutingConfig;
  nextRequestCounter: () => number;
}

export async function requestAgentVoiceStream({
  client,
  message,
  options = {},
  wyomingShardRouting,
  nextRequestCounter,
}: RequestAgentVoiceStreamOptions): Promise<VoiceHandleMessageResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const chunkSize = normalizePositiveInt(options.chunkSize, DEFAULT_VOICE_CHUNK_SIZE);
  const maxQueueSize = normalizePositiveInt(options.maxQueueSize, DEFAULT_VOICE_QUEUE_SIZE);
  const overflowPolicy = options.overflowPolicy ?? DEFAULT_VOICE_OVERFLOW_POLICY;
  const requestCounter = nextRequestCounter();
  const correlationId = options.correlationId ?? `voice-corr-${Date.now()}-${requestCounter}`;
  const streamId = options.streamId ?? `voice-stream-${Date.now()}-${requestCounter}`;
  const routedMessage = applyWyomingRoutingPolicy(message, options.metadata, wyomingShardRouting);

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

  const invokeWithTimeout = async <T>(request: () => PromiseLike<T>): Promise<T> => {
    if (options.signal?.aborted) {
      throw new Error('Voice stream aborted before dispatch');
    }

    return await Promise.race([
      Promise.resolve(request()),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Agent voice stream timed out')), timeoutMs),
      ),
    ]);
  };

  const reverseVoiceMethods = PRIMARY_REVERSE_VOICE_RPC_METHODS;

  const sendCancel = async (sequence: number, reason: string): Promise<void> => {
    const cancelPayload: VoiceStreamCancelParams = {
      ...baseFrame,
      sequence,
      reason,
    };
    await invokeWithTimeout(() => client.request(reverseVoiceMethods.cancel, cancelPayload))
      .catch(() => undefined);
  };

  let sequence = 0;
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
    await invokeWithTimeout(() => client.request(reverseVoiceMethods.start, startParams));
  } catch (error) {
    if (isMethodNotFoundError(error)) {
      return requestAgentViaHandlePath(client, serializedMessage, timeoutMs);
    }
    throw error;
  }

  let cancelled = false;

  try {
    while (queue.size > 0) {
      if (options.signal?.aborted) {
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
      model: streamResult.model,
      durationMs: streamResult.durationMs,
    };
  } catch (error) {
    if (!cancelled) {
      await sendCancel(sequence + 1, 'stream-error');
    }
    throw error;
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
