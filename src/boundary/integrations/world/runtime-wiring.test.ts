import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacesRegistryConfig } from '../../../shared/contracts/places-registry.js';
import type { WorldOperations } from './ops.js';
import type { WorldRuntimeTarget } from './runtime-wiring.js';
import { registerWorldTools } from './runtime-wiring.js';

const REGISTRY: PlacesRegistryConfig = { schemaVersion: 1, sites: [], places: [] };

function createMockTarget(): WorldRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return { registerTool: vi.fn() };
}

function createMockOps(): WorldOperations {
  return {
    getStates: vi.fn(),
    callService: vi.fn(),
  };
}

describe('registerWorldTools', () => {
  let target: ReturnType<typeof createMockTarget>;

  beforeEach(() => {
    target = createMockTarget();
  });

  it('registers the world tool as an extended surface', () => {
    registerWorldTools(target, createMockOps(), { placesRegistry: REGISTRY });
    expect(target.registerTool).toHaveBeenCalledTimes(1);
    expect(target.registerTool.mock.calls).toEqual([
      [expect.objectContaining({ name: 'world' }), 'extended'],
    ]);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    registerWorldTools(target, createMockOps(), { placesRegistry: REGISTRY, gatewayMode: true });

    const [tool] = target.registerTool.mock.calls[0] as [
      { name: string; wiringMeta?: { requiredGatewayMethods?: string[] } },
    ];
    expect(tool.name).toBe('world');
    expect(tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'home_assistant.get_states',
      'home_assistant.call_service',
    ]);
  });

  it('omits wiring metadata outside gateway mode', () => {
    registerWorldTools(target, createMockOps(), { placesRegistry: REGISTRY });
    const [tool] = target.registerTool.mock.calls[0] as [
      { wiringMeta?: unknown },
    ];
    expect(tool.wiringMeta).toBeUndefined();
  });
});

describe('entrypoint composition', () => {
  it('agent-main.ts registers world tools via gateway-backed ops', () => {
    const source = readFileSync(resolve('src/app/agent/main.ts'), 'utf-8');
    expect(source).toContain('registerWorldTools(');
    expect(source).toContain('new GatewayWorldOps(gatewayOps)');
    expect(source).toContain('placesRegistry: placesRegistryConfig');
  });
});
