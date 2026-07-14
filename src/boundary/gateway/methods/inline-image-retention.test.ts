import { describe, expect, it, vi } from 'vitest';
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import {
  GatewayInlineImageRetention,
  type GatewayInlineImageRetentionOptions,
  type GatewayRetainedImageDescriptor,
} from '../inline-image-retention.js';
import { GatewayErrors } from '../protocol.js';
import type { VisionIntakeImageScreenResult } from '../intake/vision-screener.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerIntakeImageMethods } from './intake-image.js';
import { registerLLMMethods } from './llm.js';

type MethodHandler = (params: unknown) => Promise<unknown>;

function createHarness(options: {
  retention?: GatewayInlineImageRetentionOptions;
  screenResult?: VisionIntakeImageScreenResult;
} = {}) {
  const methods = new Map<string, MethodHandler>();
  const stream = vi.fn(async () => ({
    content: 'saw image',
    toolCalls: [],
    model: 'vision-model',
    inputTokens: 10,
    outputTokens: 2,
    stopReason: 'stop' as const,
  }));
  const runtime = {
    target: {
      addMethod: (name: string, handler: MethodHandler) => methods.set(name, handler),
    } as unknown as JSONRPCServerAndClient,
    inlineImageRetention: new GatewayInlineImageRetention(options.retention),
    visionIntake: {
      screenImage: vi.fn(async (): Promise<VisionIntakeImageScreenResult> => options.screenResult ?? ({
        kind: 'screened',
        mode: 'enforce',
        flagged: false,
        withheld: false,
      })),
    },
    llmProvider: {
      stream,
      complete: vi.fn(),
    },
    notifyRequester: vi.fn(),
    nextStreamRequestId: () => 'gateway-request-1',
    audited: <P, R>(_method: string, handler: (params: P) => Promise<R>) => handler,
  } as unknown as GatewayMethodRuntime;
  registerIntakeImageMethods(runtime);
  registerLLMMethods(runtime);
  return { methods, stream };
}

describe('gateway inline image retention RPC flow', () => {
  it('proactively removes retained partner bytes at TTL without later cache activity', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const retention = new GatewayInlineImageRetention({
        ttlMs: 10,
        maxEntries: 1,
        createHandle: () => 'idle-expiry-handle',
      });

      retention.retain({
        dataBase64: 'aGVsbG8=',
        mimeType: 'image/png',
        requestScope: 'turn-idle-expiry',
      });
      expect(retention.getRetentionStats()).toEqual({ entryCount: 1, decodedBytes: 5 });
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(5);
      retention.retain({
        dataBase64: 'd29ybGQ=',
        mimeType: 'image/png',
        requestScope: 'turn-idle-expiry',
      });
      expect(retention.getRetentionStats()).toEqual({ entryCount: 1, decodedBytes: 5 });
      expect(vi.getTimerCount()).toBe(1);

      vi.advanceTimersByTime(5);
      expect(retention.getRetentionStats()).toEqual({ entryCount: 1, decodedBytes: 5 });

      vi.advanceTimersByTime(5);

      expect(retention.getRetentionStats()).toEqual({ entryCount: 0, decodedBytes: 0 });
      expect(vi.getTimerCount()).toBe(0);

      retention.retain({
        dataBase64: 'YWdhaW4=',
        mimeType: 'image/png',
        requestScope: 'turn-idle-expiry',
      });
      expect(vi.getTimerCount()).toBe(1);
      retention.clear();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a screened inline image and resolves it for the scoped main model call', async () => {
    const { methods, stream } = createHarness();
    const imageBase64 = 'aGVsbG8=';
    const requestScope = 'turn-1';

    const screened = await methods.get('intake.screen_image')!({
      imageBase64,
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope,
    }) as VisionIntakeImageScreenResult & {
      retainedImage?: GatewayRetainedImageDescriptor;
    };

    expect(screened.retainedImage).toEqual(expect.objectContaining({
      requestScope,
      handle: expect.any(String),
      expiresAt: expect.any(Number),
    }));

    await methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: requestScope,
      messages: [{
        role: 'user',
        content: [{
          type: 'gateway_image_ref',
          handle: screened.retainedImage!.handle,
        }],
      }],
    });

    expect(stream).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      messages: [{
        role: 'user',
        content: [{ type: 'image', data: imageBase64, mimeType: 'image/png' }],
      }],
    });
  });

  it('does not retain bytes when screening was skipped or withheld', async () => {
    for (const screenResult of [
      {
        kind: 'skipped' as const,
        flagged: false,
        withheld: false,
        reason: 'screening unavailable',
      },
      {
        kind: 'screened' as const,
        mode: 'enforce' as const,
        flagged: true,
        withheld: true,
      },
    ]) {
      const { methods } = createHarness({ screenResult });
      const result = await methods.get('intake.screen_image')!({
        imageBase64: 'aGVsbG8=',
        mimeType: 'image/png',
        originRef: 'discord:channel:message:attachment:0',
        requestScope: 'turn-screening-required',
      }) as VisionIntakeImageScreenResult;
      expect(result.retainedImage).toBeUndefined();
    }
  });

  it('leaves the URL-addressed screening path unchanged and does not mint a retained handle', async () => {
    const { methods } = createHarness();
    const result = await methods.get('intake.screen_image')!({
      imageUrl: 'https://cdn.example.test/partner-image.png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-url-path',
    }) as VisionIntakeImageScreenResult;

    expect(result).toMatchObject({
      kind: 'screened',
      withheld: false,
    });
    expect(result.retainedImage).toBeUndefined();
  });

  it('fails closed when a retained handle is used outside its request scope', async () => {
    const { methods, stream } = createHarness();
    const screened = await methods.get('intake.screen_image')!({
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-owner',
    }) as VisionIntakeImageScreenResult;

    await expect(methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-other',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: screened.retainedImage!.handle }],
      }],
    })).rejects.toMatchObject({ code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS });
    expect(stream).not.toHaveBeenCalled();
  });

  it('expires retained bytes after the bounded TTL', async () => {
    let now = 1_000;
    const { methods, stream } = createHarness({
      retention: { ttlMs: 10, now: () => now },
    });
    const screened = await methods.get('intake.screen_image')!({
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-expired',
    }) as VisionIntakeImageScreenResult;
    now += 10;

    await expect(methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-expired',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: screened.retainedImage!.handle }],
      }],
    })).rejects.toMatchObject({ code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS });
    expect(stream).not.toHaveBeenCalled();
  });

  it('evicts oldest retained bytes at the count cap', async () => {
    let handleSequence = 0;
    const { methods, stream } = createHarness({
      retention: {
        maxEntries: 1,
        createHandle: () => `handle-${String(++handleSequence)}`,
      },
    });
    const first = await methods.get('intake.screen_image')!({
      imageBase64: 'Zmlyc3Q=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-capped',
    }) as VisionIntakeImageScreenResult;
    const second = await methods.get('intake.screen_image')!({
      imageBase64: 'c2Vjb25k',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:1',
      requestScope: 'turn-capped',
    }) as VisionIntakeImageScreenResult;

    await expect(methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-capped',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: first.retainedImage!.handle }],
      }],
    })).rejects.toMatchObject({ code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS });
    await methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-capped',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: second.retainedImage!.handle }],
      }],
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('evicts oldest retained bytes at the aggregate byte cap', async () => {
    let handleSequence = 0;
    const { methods, stream } = createHarness({
      retention: {
        maxEntries: 2,
        maxBytes: 6,
        createHandle: () => `handle-${String(++handleSequence)}`,
      },
    });
    const first = await methods.get('intake.screen_image')!({
      imageBase64: 'Zmlyc3Q=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-byte-capped',
    }) as VisionIntakeImageScreenResult;
    const second = await methods.get('intake.screen_image')!({
      imageBase64: 'c2Vjb25k',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:1',
      requestScope: 'turn-byte-capped',
    }) as VisionIntakeImageScreenResult;

    await expect(methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-byte-capped',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: first.retainedImage!.handle }],
      }],
    })).rejects.toMatchObject({ code: GatewayErrors.INLINE_IMAGE_RETENTION_MISS });
    await methods.get('llm.chat')!({
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-byte-capped',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle: second.retainedImage!.handle }],
      }],
    });
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
