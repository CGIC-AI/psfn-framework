// d269: the main conversational reply returns as the RAW result of
// voice.transcript.end / voice.handleMessage. These tests pin that the
// reply-egress inspection hook (the gateway canary guard) sees that RAW result
// (carrier intact, before the field pick drops unknown keys) on BOTH the
// transcript path and the version-skew handle fallback, and that a throwing
// hook (a held reply) propagates instead of delivering content.

import { describe, expect, it, vi } from 'vitest';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import { requestAgentVoiceStream } from './voice-stream-request.js';
import { GatewayErrors } from './protocol.js';
import {
  CANARY_CARRIER_PARAM_KEY,
  generateCanaryToken,
} from '../../core/cogsec/canary/canary-token.js';

const WYOMING_ROUTING = {
  enabled: false,
  provider: 'openrouter',
  model: 'openai/gpt-4.1-mini',
  maxTokens: 1_000,
  timeoutMs: 30_000,
} as const;

const MESSAGE = {
  id: 'message-1',
  channelId: 'telegram:123',
  channelType: 'telegram',
  authorId: 'partner',
  authorName: 'Partner',
  content: 'hello there',
  timestamp: new Date('2026-07-20T12:00:00.000Z'),
} as const;

function makeTranscriptClient(endResult: Record<string, unknown>): {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn(async (method: string, params: any) => {
    if (method === 'voice.transcript.begin' || method === 'voice.transcript.chunk') {
      return {
        correlationId: params.correlationId,
        streamId: params.streamId,
        sequence: params.sequence,
        accepted: true,
        queueDepth: 0,
        droppedChunks: 0,
      };
    }
    if (method === 'voice.transcript.end') {
      return {
        correlationId: params.correlationId,
        streamId: params.streamId,
        droppedChunks: 0,
        ...endResult,
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { request };
}

describe('voice stream request reply-canary seam (d269)', () => {
  it('passes the RAW transcript-end result (carrier intact) to inspectReply and returns its cleaned reply', async () => {
    const token = generateCanaryToken();
    const client = makeTranscriptClient({
      content: 'a clean reply',
      channelId: 'telegram:123',
      model: 'test-model',
      durationMs: 10,
      [CANARY_CARRIER_PARAM_KEY]: token,
    });
    const seen: Array<{ method: string; result: unknown }> = [];
    const inspectReply = vi.fn((method: string, result: unknown) => {
      seen.push({ method, result });
      // The production guard strips the carrier; emulate that contract.
      const { [CANARY_CARRIER_PARAM_KEY]: _carrier, ...rest } = result as Record<string, unknown>;
      return rest;
    });

    const result = await requestAgentVoiceStream({
      client: client as any,
      message: { ...MESSAGE },
      wyomingShardRouting: WYOMING_ROUTING,
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      nextRequestCounter: () => 1,
      inspectReply,
    });

    expect(inspectReply).toHaveBeenCalledTimes(1);
    expect(seen[0]!.method).toBe('voice.transcript.end');
    // The hook saw the carrier BEFORE the field pick could drop it.
    expect((seen[0]!.result as Record<string, unknown>)[CANARY_CARRIER_PARAM_KEY]).toBe(token);
    expect(result).toMatchObject({ content: 'a clean reply', channelId: 'telegram:123' });
    expect(CANARY_CARRIER_PARAM_KEY in result).toBe(false);
  });

  it('propagates a held reply (inspectReply throw) instead of delivering content', async () => {
    const token = generateCanaryToken();
    const client = makeTranscriptClient({
      content: `leaking ${token}`,
      channelId: 'telegram:123',
      model: 'test-model',
      durationMs: 10,
      [CANARY_CARRIER_PARAM_KEY]: token,
    });
    const held = new JSONRPCErrorException('held', GatewayErrors.EGRESS_HELD);
    await expect(requestAgentVoiceStream({
      client: client as any,
      message: { ...MESSAGE },
      wyomingShardRouting: WYOMING_ROUTING,
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      nextRequestCounter: () => 2,
      inspectReply: () => {
        throw held;
      },
    })).rejects.toBe(held);
  });

  it('applies inspectReply on the voice.handleMessage version-skew fallback path', async () => {
    const token = generateCanaryToken();
    const request = vi.fn(async (method: string, params: any) => {
      if (method === 'voice.transcript.begin') {
        const error = new Error('Method not found') as Error & { code: number };
        error.code = -32601;
        throw error;
      }
      if (method === 'voice.handleMessage') {
        expect(params.message).toBeDefined();
        return {
          content: 'fallback reply',
          channelId: 'telegram:123',
          model: 'test-model',
          durationMs: 12,
          [CANARY_CARRIER_PARAM_KEY]: token,
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const inspectReply = vi.fn((_method: string, result: unknown) => {
      const { [CANARY_CARRIER_PARAM_KEY]: _carrier, ...rest } = result as Record<string, unknown>;
      return rest;
    });

    const result = await requestAgentVoiceStream({
      client: { request } as any,
      message: { ...MESSAGE },
      wyomingShardRouting: WYOMING_ROUTING,
      companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
      nextRequestCounter: () => 3,
      inspectReply,
    });

    expect(inspectReply).toHaveBeenCalledWith(
      'voice.handleMessage',
      expect.objectContaining({ [CANARY_CARRIER_PARAM_KEY]: token }),
    );
    expect(result).toMatchObject({ content: 'fallback reply' });
    expect(CANARY_CARRIER_PARAM_KEY in result).toBe(false);
  });
});
