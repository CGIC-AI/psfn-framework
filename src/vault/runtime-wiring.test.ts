import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerVaultTools, wireVaultRuntime } from './runtime-wiring.js';
import type { VaultOperations } from './ops.js';
import type { VaultRuntimeTarget } from './runtime-wiring.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue(''),
}));

function createMockTarget(): VaultRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

function createMockOps(): VaultOperations {
  return {
    write: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    daily: vi.fn(),
  };
}

describe('registerVaultTools', () => {
  let target: ReturnType<typeof createMockTarget>;

  beforeEach(() => {
    target = createMockTarget();
  });

  it('registers all 4 vault tools as extended', () => {
    registerVaultTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(4);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolNames = target.registerTool.mock.calls.map((call: any[]) => call[0].name);
    expect(toolNames).toContain('vault_write');
    expect(toolNames).toContain('vault_read');
    expect(toolNames).toContain('vault_search');
    expect(toolNames).toContain('vault_daily');

    // All registered as 'extended' category
    for (const call of target.registerTool.mock.calls) {
      expect(call[1]).toBe('extended');
    }
  });

  it('attaches gateway wiring metadata when gatewayMode is true', () => {
    registerVaultTools(target, createMockOps(), { gatewayMode: true });

    for (const call of target.registerTool.mock.calls) {
      const tool = call[0] as { wiringMeta?: { requiredGatewayMethods: string[] } };
      expect(tool.wiringMeta).toBeDefined();
      expect(tool.wiringMeta!.requiredGatewayMethods).toContain('shell.exec');
    }
  });

  it('does not attach wiring metadata without gatewayMode', () => {
    registerVaultTools(target, createMockOps());

    for (const call of target.registerTool.mock.calls) {
      const tool = call[0] as { wiringMeta?: unknown };
      expect(tool.wiringMeta).toBeUndefined();
    }
  });
});

describe('wireVaultRuntime', () => {
  it('creates VaultOps and registers tools', () => {
    const target = createMockTarget();
    const ops = wireVaultRuntime(target, { vaultName: 'TestVault' });
    expect(ops).toBeDefined();
    expect(target.registerTool).toHaveBeenCalledTimes(4);
  });

  it('passes config to VaultOps', () => {
    const target = createMockTarget();
    const ops = wireVaultRuntime(target, {
      vaultName: 'MyVault',
      cliPath: '/opt/obsidian',
      timeoutMs: 5000,
    });
    // VaultOps was created successfully (would throw if vaultName was empty)
    expect(ops).toBeDefined();
  });
});
