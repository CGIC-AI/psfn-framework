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

  it('registers the unified vault tool as extended', () => {
    registerVaultTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(1);

    const [tool, scope] = target.registerTool.mock.calls[0] as [
      { name: string },
      string,
    ];
    expect(tool.name).toBe('vault');
    expect(scope).toBe('extended');
  });

  it('attaches gateway wiring metadata for all vault RPC methods when gatewayMode is true', () => {
    registerVaultTools(target, createMockOps(), { gatewayMode: true });

    const [tool] = target.registerTool.mock.calls[0] as [
      { wiringMeta?: { requiredGatewayMethods: string[] } },
    ];
    expect(tool.wiringMeta).toBeDefined();
    expect(tool.wiringMeta?.requiredGatewayMethods).toEqual([
      'vault.write',
      'vault.read',
      'vault.search',
      'vault.daily',
    ]);
  });

  it('attaches vault service wiring metadata without gatewayMode', () => {
    registerVaultTools(target, createMockOps());

    const [tool] = target.registerTool.mock.calls[0] as [
      {
        wiringMeta?: {
          requiredServices?: string[];
          requiredGatewayMethods?: string[];
        };
      },
    ];
    expect(tool.wiringMeta?.requiredServices).toEqual(['vault']);
    expect(tool.wiringMeta?.requiredGatewayMethods).toBeUndefined();
  });
});

describe('wireVaultRuntime', () => {
  it('creates VaultOps and registers tools', () => {
    const target = createMockTarget();
    const ops = wireVaultRuntime(target, { vaultName: 'TestVault' });
    expect(ops).toBeDefined();
    expect(target.registerTool).toHaveBeenCalledTimes(1);
  });

  it('passes config to VaultOps', () => {
    const target = createMockTarget();
    const ops = wireVaultRuntime(target, {
      vaultName: 'MyVault',
      cliPath: '/opt/obsidian',
      timeoutMs: 5000,
    });
    expect(ops).toBeDefined();
  });
});
