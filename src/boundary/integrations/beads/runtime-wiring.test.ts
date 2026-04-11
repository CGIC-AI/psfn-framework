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

  it('registers split beads tools with core and extended categories', () => {
    registerBeadsTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(6);
    expect(target.registerTool.mock.calls).toEqual([
      [expect.objectContaining({ name: 'issue_ready' }), 'core'],
      [expect.objectContaining({ name: 'issue_show' }), 'core'],
      [expect.objectContaining({ name: 'issue_create' }), 'extended'],
      [expect.objectContaining({ name: 'issue_update' }), 'extended'],
      [expect.objectContaining({ name: 'issue_close' }), 'extended'],
      [expect.objectContaining({ name: 'issue_sync' }), 'extended'],
    ]);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    registerBeadsTools(target, createMockOps(), { gatewayMode: true });

    const methodsByTool = new Map(
      target.registerTool.mock.calls.map(([tool]) => [
        (tool as { name: string }).name,
        (tool as { wiringMeta?: { requiredGatewayMethods?: string[] } }).wiringMeta?.requiredGatewayMethods,
      ]),
    );

    expect(methodsByTool).toEqual(new Map([
      ['issue_ready', ['beads.ready']],
      ['issue_show', ['beads.show']],
      ['issue_create', ['beads.create']],
      ['issue_update', ['beads.update']],
      ['issue_close', ['beads.close']],
      ['issue_sync', ['beads.sync']],
    ]));
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
