import { describe, expect, it, vi } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import { registerGatedDescriptors } from './register.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';

const descriptor: GatedMethodDescriptor = fromAny({
  name: 'test.gated',
  decode: (params: unknown) => params,
  handler: vi.fn(async () => 'ok'),
  summary: () => ({}),
  approvalAction: 'test',
  approvalScope: () => 'test',
});

describe('registerGatedDescriptors', () => {
  it('fails closed without approvalBoundary.gate even when a legacy gated helper exists', () => {
    const runtime = fromAny<GatewayMethodRuntime>({
      target: { addMethod: vi.fn() },
      policyConfig: { workspacePath: '/workspace' },
      authenticatedCompanionId: () => 'companion-a',
      gated: vi.fn(),
    });

    expect(() => registerGatedDescriptors(runtime, [descriptor])).toThrow(
      'Gateway method runtime is missing approvalBoundary.gate',
    );
    expect(runtime.target.addMethod).not.toHaveBeenCalled();
  });
});
