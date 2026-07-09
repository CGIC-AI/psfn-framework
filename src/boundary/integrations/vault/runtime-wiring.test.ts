import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerVaultTools, wireVaultRuntime } from './runtime-wiring.js';
import type { VaultOperations } from './ops.js';
import type { VaultRuntimeTarget } from './runtime-wiring.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockReturnValue(''),
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

  it('registers split vault tools as extended', () => {
    registerVaultTools(target, createMockOps());
    expect(target.registerTool).toHaveBeenCalledTimes(1);
    expect(target.registerTool.mock.calls).toEqual([
      [expect.objectContaining({ name: 'vault' }), 'extended'],
    ]);
  });

  it('attaches gateway wiring metadata for all vault RPC methods when gatewayMode is true', () => {
    registerVaultTools(target, createMockOps(), { gatewayMode: true });

    const methodsByTool = new Map(
      target.registerTool.mock.calls.map(([tool]) => [
        (tool as { name: string }).name,
        (tool as { wiringMeta?: { requiredGatewayMethods?: string[] } }).wiringMeta?.requiredGatewayMethods,
      ]),
    );

    expect(methodsByTool).toEqual(new Map([
      ['vault', ['vault.write', 'vault.read', 'vault.search', 'vault.daily']],
    ]));
  });

  it('attaches vault service wiring metadata without gatewayMode', () => {
    registerVaultTools(target, createMockOps());

    for (const [tool] of target.registerTool.mock.calls as Array<[
      {
        wiringMeta?: {
          requiredServices?: string[];
          requiredGatewayMethods?: string[];
        };
      },
      string,
    ]>) {
      expect(tool.wiringMeta?.requiredServices).toEqual(['vault']);
      expect(tool.wiringMeta?.requiredGatewayMethods).toBeUndefined();
    }
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
