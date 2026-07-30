import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from '../../boundary/pi-agent/index.js';
import { runToolConformanceSweep } from '../../core/agent/tool-conformance/harness.js';
import { wireAgentVaultRuntime } from './vault-runtime.js';

function target() {
  const tools: AgentTool<any>[] = [];
  return {
    tools,
    registerTool(tool: AgentTool<any>): void {
      tools.push(tool);
    },
  };
}

function gateway() {
  return {
    vaultRead: vi.fn(async (name: string) => ({ name, content: 'live vault note' })),
    vaultWrite: vi.fn(),
    vaultSearch: vi.fn(async (query: string) => ({ query, results: [] })),
    vaultDaily: vi.fn(),
  };
}

describe('agent vault runtime', () => {
  it('is invoked by the production agent entrypoint', () => {
    const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(mainSource).toContain('wireAgentVaultRuntime({');
  });

  it('keeps the catalog surface absent when the gateway policy is disabled', () => {
    const runtimeTarget = target();
    expect(wireAgentVaultRuntime({
      target: runtimeTarget,
      gateway: gateway() as any,
      config: { obsidianVaultName: 'Companion' },
      env: {},
    })).toBe(false);
    expect(runtimeTarget.tools).toEqual([]);
  });

  it('fails closed when enabled without an owner-file vault name', () => {
    expect(() => wireAgentVaultRuntime({
      target: target(),
      gateway: gateway() as any,
      config: {},
      env: { VAULT_TOOLS_ENABLED: 'true' },
    })).toThrow(/obsidianVaultName is not configured/u);
  });

  it('registers the live gateway-backed vault tool and executes its read path', async () => {
    const runtimeTarget = target();
    const gatewayClient = gateway();
    expect(wireAgentVaultRuntime({
      target: runtimeTarget,
      gateway: gatewayClient as any,
      config: { obsidianVaultName: 'Companion' },
      env: { VAULT_TOOLS_ENABLED: 'true' },
    })).toBe(true);

    const vault = runtimeTarget.tools.find(tool => tool.name === 'vault');
    expect(vault?.wiringMeta?.requiredGatewayMethods).toEqual([
      'vault.write',
      'vault.read',
      'vault.search',
      'vault.daily',
    ]);
    const result = await vault!.execute('vault-read-probe', {
      action: 'read',
      name: 'Inbox.md',
    });
    expect(gatewayClient.vaultRead).toHaveBeenCalledWith('Inbox.md');
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('live vault note'),
    });
  });

  it('passes the live conformance read probe through the gateway', async () => {
    const runtimeTarget = target();
    const gatewayClient = gateway();
    wireAgentVaultRuntime({
      target: runtimeTarget,
      gateway: gatewayClient as any,
      config: { obsidianVaultName: 'Companion' },
      env: { VAULT_TOOLS_ENABLED: 'true' },
    });

    const result = await runToolConformanceSweep({
      tools: runtimeTarget.tools,
      trigger: 'manual',
    });

    expect(gatewayClient.vaultSearch).toHaveBeenCalledWith(
      '__psfn_tool_conformance_no_match__',
      1,
    );
    expect(result.results).toContainEqual(expect.objectContaining({
      toolName: 'vault',
      probeKind: 'read_only',
      action: 'search',
      ok: true,
    }));
  });
});
