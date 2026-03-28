import { describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayWebFetchOps } from './gateway-ops.js';
import { registerWebTools, type WebRuntimeTarget } from './runtime-wiring.js';

function createMockTarget(): WebRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('web runtime wiring', () => {
  it('registers web_fetch as a core tool', () => {
    const target = createMockTarget();
    const ops = {
      fetch: vi.fn(async () => 'content'),
    };

    registerWebTools(target, ops);

    expect(target.registerTool.mock.calls.map((call: any[]) => call[0].name)).toEqual(['web_fetch']);
    expect(target.registerTool.mock.calls[0][1]).toBe('core');
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    const target = createMockTarget();
    const gateway = {
      webFetch: vi.fn(async () => 'content'),
    } as unknown as GatewayClient;

    registerWebTools(target, new GatewayWebFetchOps(gateway), { gatewayMode: true });

    expect(target.registerTool.mock.calls[0][0].wiringMeta?.requiredGatewayMethods).toEqual(['web.fetch']);
  });
});
