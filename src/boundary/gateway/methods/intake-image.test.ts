// ── intake.screen_image RPC method tests (htm9.8) ──

import { describe, expect, it } from 'vitest';
import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type { GatewayMethodRuntime } from './types.js';
import { registerIntakeImageMethods } from './intake-image.js';
import type { VisionIntakeImageScreenResult } from '../intake/vision-screener.js';
import type { GatewayVisionIntakeScreener } from '../intake/compose-screening.js';

type MethodHandler = (params: unknown) => Promise<unknown>;

function makeRuntime(visionIntake?: GatewayVisionIntakeScreener): {
  runtime: GatewayMethodRuntime;
  methods: Map<string, MethodHandler>;
} {
  const methods = new Map<string, MethodHandler>();
  const runtime = {
    target: {
      addMethod: (name: string, handler: MethodHandler) => {
        methods.set(name, handler);
      },
    } as unknown as JSONRPCServerAndClient,
    ...(visionIntake ? { visionIntake } : {}),
    // Audit wrapper passthrough (audit behavior is covered by server tests).
    audited: <P, R>(_method: string, handler: (params: P) => Promise<R>) => handler,
  } as unknown as GatewayMethodRuntime;
  return { runtime, methods };
}

const SCREENED: VisionIntakeImageScreenResult = {
  kind: 'screened',
  mode: 'enforce',
  flagged: true,
  withheld: true,
  envelopeId: 'env-1',
  action: 'quarantine',
};

describe('intake.screen_image', () => {
  it('answers skipped (explicit, auditable) when no vision intake is composed', async () => {
    const { runtime, methods } = makeRuntime();
    registerIntakeImageMethods(runtime);
    const handler = methods.get('intake.screen_image');
    expect(handler).toBeDefined();
    const result = await handler!({ imageUrl: 'https://cdn.test/x.png', originRef: 'r' }) as VisionIntakeImageScreenResult;
    expect(result.kind).toBe('skipped');
    expect(result.withheld).toBe(false);
  });

  it('routes a validated request to the composed screener', async () => {
    const seen: unknown[] = [];
    const { runtime, methods } = makeRuntime({
      screenImage: async (input) => {
        seen.push(input);
        return SCREENED;
      },
    });
    registerIntakeImageMethods(runtime);
    const result = await methods.get('intake.screen_image')!({
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/png',
      originRef: 'discord:c:m:attachment:0',
      subjectIndex: 0,
      canonicalContactId: 'contact-1',
    }) as VisionIntakeImageScreenResult;

    expect(result).toEqual(SCREENED);
    expect(seen).toEqual([{
      image: { dataBase64: 'aGVsbG8=', mimeType: 'image/png' },
      originRef: 'discord:c:m:attachment:0',
      subjectIndex: 0,
      canonicalContactId: 'contact-1',
    }]);
  });

  it('fails closed on malformed params: missing origin, both/neither image forms, bad mime, oversize', async () => {
    const { runtime, methods } = makeRuntime({ screenImage: async () => SCREENED });
    registerIntakeImageMethods(runtime);
    const handler = methods.get('intake.screen_image')!;

    await expect(handler({ imageUrl: 'https://x.test/a.png' })).rejects.toThrow(/originRef is required/);
    await expect(handler({ originRef: 'r' })).rejects.toThrow(/exactly one of imageUrl or imageBase64/);
    await expect(handler({
      originRef: 'r',
      imageUrl: 'https://x.test/a.png',
      imageBase64: 'aGk=',
    })).rejects.toThrow(/exactly one of imageUrl or imageBase64/);
    await expect(handler({ originRef: 'r', imageBase64: 'aGk=' }))
      .rejects.toThrow(/image\/\* mimeType/);
    await expect(handler({
      originRef: 'r',
      imageBase64: 'A'.repeat(12 * 1024 * 1024),
      mimeType: 'image/png',
    })).rejects.toThrow(/screening cap/);
  });
});
