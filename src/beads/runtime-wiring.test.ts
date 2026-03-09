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

  it('registers read-only beads tools as core and mutation beads tools as extended', () => {
    registerBeadsTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(6);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = target.registerTool.mock.calls.map((call: any[]) => call[0].name);
    expect(names).toEqual([
      'issue_ready',
      'issue_show',
      'issue_create',
      'issue_update',
      'issue_close',
      'issue_sync',
    ]);

    expect(target.registerTool.mock.calls.find((call: any[]) => call[0].name === 'issue_ready')?.[1]).toBe('core');
    expect(target.registerTool.mock.calls.find((call: any[]) => call[0].name === 'issue_show')?.[1]).toBe('core');
    for (const call of target.registerTool.mock.calls.filter((entry: any[]) => !['issue_ready', 'issue_show'].includes(entry[0].name))) {
      expect(call[1]).toBe('extended');
    }
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    registerBeadsTools(target, createMockOps(), { gatewayMode: true });

    const expectedMethodsByTool: Record<string, string> = {
      issue_ready: 'beads.ready',
      issue_show: 'beads.show',
      issue_create: 'beads.create',
      issue_update: 'beads.update',
      issue_close: 'beads.close',
      issue_sync: 'beads.sync',
    };

    for (const call of target.registerTool.mock.calls) {
      const tool = call[0] as {
        name: string;
        wiringMeta?: { requiredGatewayMethods: string[] };
      };
      expect(tool.wiringMeta).toBeDefined();
      expect(tool.wiringMeta?.requiredGatewayMethods).toContain(expectedMethodsByTool[tool.name]);
    }
  });
});

describe('entrypoint composition', () => {
  it('agent-main.ts registers beads tools via gateway-backed ops', () => {
    const source = readFileSync(resolve('src/agent-main.ts'), 'utf-8');
    expect(source).toContain('registerBeadsTools(');
    expect(source).toContain('new GatewayBeadsOps(gateway)');
  });
});
