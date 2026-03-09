import { JSONRPCErrorException } from 'json-rpc-2.0';
import { describe, expect, it, vi } from 'vitest';
import type { PolicyConfig } from '../policy.js';
import { evaluatePolicy } from '../policy.js';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerVaultMethods } from './vault.js';

function createMockVaultOps() {
  return {
    write: vi.fn(async (name: string, _content: string, opts?: { folder?: string; mode?: 'create' | 'append' | 'prepend' }) => ({
      name,
      folder: opts?.folder,
      mode: opts?.mode ?? 'create',
    })),
    read: vi.fn(async (name: string) => ({ name, content: `content:${name}` })),
    search: vi.fn(async (query: string, limit?: number) => ({
      query,
      results: [{ path: 'Notes/Example.md', snippet: `${query}:${limit ?? 'none'}` }],
    })),
    daily: vi.fn(async (opts?: { content?: string }) => (
      opts?.content
        ? { date: '2026-03-06', mode: 'append' as const }
        : { date: '2026-03-06', content: 'daily content', mode: 'read' as const }
    )),
  };
}

function createHarness(policyConfig: PolicyConfig): {
  invoke(method: string, params: Record<string, unknown>): Promise<unknown>;
} {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const keyring = {
    activeVersion: 'v1',
    keys: { v1: 'test-vault-secret' },
  };

  const runtime: GatewayMethodRuntime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        methods.set(name, handler);
      },
    } as any,
    llmProvider: {} as any,
    embeddingService: {} as any,
    discordAdapter: {} as any,
    policyConfig,
    workspacePath: process.cwd(),
    sessionHmacKeyring: keyring,
    notifyAll: vi.fn(),
    listPendingConfirmations: () => [],
    resolveConfirmation: vi.fn(async () => ({
      id: 'noop',
      status: 'not_found',
      message: 'noop',
      executed: false,
    })),
    sendNtfy: vi.fn(async () => ({ status: 'debounced', topic: 'noop' })),
    nextStreamRequestId: () => 'stream-1',
    audited: (_method, handler) => handler,
    gated: (method, handler) => async (params) => {
      const decision = evaluatePolicy(
        { method, params: params as Record<string, unknown> },
        policyConfig,
      );
      if (decision === 'DENY') {
        throw new JSONRPCErrorException('Policy denied', GatewayErrors.POLICY_DENIED);
      }
      return handler(params);
    },
  };

  registerVaultMethods(runtime);

  return {
    invoke(method: string, params: Record<string, unknown>) {
      const handler = methods.get(method);
      if (!handler) {
        throw new Error(`Method not registered: ${method}`);
      }
      return handler(params);
    },
  };
}

describe('registerVaultMethods', () => {
  it('routes allowlisted vault RPC methods through dedicated gateway vault ops', async () => {
    const ops = createMockVaultOps();
    const harness = createHarness({
      workspacePath: process.cwd(),
      vault: {
        enabled: true,
        allowActions: ['read', 'search', 'daily', 'write'],
        ops,
      },
    });

    await expect(harness.invoke('vault.read', { name: 'Inbox.md' }))
      .resolves.toEqual({ name: 'Inbox.md', content: 'content:Inbox.md' });
    await expect(harness.invoke('vault.search', { query: 'focus', limit: 5 }))
      .resolves.toMatchObject({ query: 'focus' });
    await expect(harness.invoke('vault.daily', { content: 'note' }))
      .resolves.toEqual({ date: '2026-03-06', mode: 'append' });
    await expect(harness.invoke('vault.write', {
      name: 'Inbox',
      content: 'hello',
      mode: 'append',
    })).resolves.toEqual({ name: 'Inbox', folder: undefined, mode: 'append' });

    expect(ops.read).toHaveBeenCalledWith('Inbox.md');
    expect(ops.search).toHaveBeenCalledWith('focus', 5);
    expect(ops.daily).toHaveBeenCalledWith({ content: 'note' });
    expect(ops.write).toHaveBeenCalledWith('Inbox', 'hello', {
      folder: undefined,
      mode: 'append',
    });
  });

  it('denies vault RPC calls when vault policy is disabled', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
    });

    await expect(harness.invoke('vault.read', { name: 'Inbox.md' })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
  });

  it('denies disallowed vault actions via action allowlist', async () => {
    const harness = createHarness({
      workspacePath: process.cwd(),
      vault: {
        enabled: true,
        allowActions: ['read'],
        ops: createMockVaultOps(),
      },
    });

    await expect(harness.invoke('vault.write', {
      name: 'Inbox',
      content: 'blocked',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
    });
  });

  it('rejects malformed payloads before executing vault operations', async () => {
    const ops = createMockVaultOps();
    const harness = createHarness({
      workspacePath: process.cwd(),
      vault: {
        enabled: true,
        allowActions: ['read'],
        ops,
      },
    });

    await expect(harness.invoke('vault.read', {
      name: '',
    })).rejects.toMatchObject({
      code: GatewayErrors.POLICY_DENIED,
      message: expect.stringContaining('non-empty string'),
    });
    expect(ops.read).not.toHaveBeenCalled();
  });

  it('fails closed at startup when vault policy is enabled without configured ops', () => {
    expect(() => createHarness({
      workspacePath: process.cwd(),
      vault: {
        enabled: true,
        allowActions: ['read'],
      },
    })).toThrow(/vault operations are not configured/i);
  });
});
