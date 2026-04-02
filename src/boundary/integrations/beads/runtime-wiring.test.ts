import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BeadsOperations } from './ops.js';
import type { BeadsRuntimeTarget } from './runtime-wiring.js';
import { registerBeadsTools } from './runtime-wiring.js';

function createMockTarget(): BeadsRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

function createMockOps(): BeadsOperations {
  return {
    ready: vi.fn(),
    show: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    close: vi.fn(),
    sync: vi.fn(),
  };
}

describe('registerBeadsTools', () => {
  let target: ReturnType<typeof createMockTarget>;

  beforeEach(() => {
    target = createMockTarget();
  });

  it('registers the unified beads tool as extended', () => {
    registerBeadsTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(1);

    const [tool, category] = target.registerTool.mock.calls[0] as [{ name: string }, string];
    expect(tool.name).toBe('beads');
    expect(category).toBe('extended');
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    registerBeadsTools(target, createMockOps(), { gatewayMode: true });

    const [tool] = target.registerTool.mock.calls[0] as [
      { wiringMeta?: { requiredGatewayMethods: string[] } },
    ];
    expect(tool.wiringMeta).toBeDefined();
    expect(tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'beads.ready',
      'beads.show',
      'beads.create',
      'beads.update',
      'beads.close',
      'beads.sync',
    ]);
  });
});

describe('entrypoint composition', () => {
  it('agent-main.ts registers beads tools via gateway-backed ops', () => {
    const source = readFileSync(resolve('src/app/agent/main.ts'), 'utf-8');
    expect(source).toContain('registerBeadsTools(');
    expect(source).toContain('createGatewayOpsPortFromClient(gateway)');
    expect(source).toContain('new GatewayBeadsOps(gatewayOps)');
  });
});
