import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayVaultOps } from './gateway-ops.js';

describe('GatewayVaultOps', () => {
  let gateway: any;
  let ops: GatewayVaultOps;

  beforeEach(() => {
    gateway = {
      vaultWrite: vi.fn(async (name: string, _content: string, options?: { mode?: string; folder?: string }) => ({
        name,
        folder: options?.folder,
        mode: options?.mode ?? 'create',
      })),
      vaultRead: vi.fn(async (name: string) => ({ name, content: 'hello' })),
      vaultSearch: vi.fn(async (query: string, limit?: number) => ({ query, results: [{ path: `${limit ?? 0}` }] })),
      vaultDaily: vi.fn(async (content?: string) => (
        content
          ? { date: '2026-03-06', mode: 'append' as const }
          : { date: '2026-03-06', content: 'daily', mode: 'read' as const }
      )),
      shellExec: vi.fn(),
    };
    ops = new GatewayVaultOps(gateway, {
      vaultName: 'CompanionVault',
      cliPath: 'obsidian',
      timeoutMs: 10_000,
    });
  });

  it('delegates write/read/search/daily to dedicated vault RPC methods', async () => {
    await expect(ops.write('Inbox', 'entry', { mode: 'append' }))
      .resolves.toEqual({ name: 'Inbox', folder: undefined, mode: 'append' });
    await expect(ops.read('Inbox.md'))
      .resolves.toEqual({ name: 'Inbox.md', content: 'hello' });
    await expect(ops.search('focus', 12))
      .resolves.toEqual({ query: 'focus', results: [{ path: '12' }] });
    await expect(ops.daily({ content: 'entry' }))
      .resolves.toEqual({ date: '2026-03-06', mode: 'append' });
    await expect(ops.daily())
      .resolves.toEqual({ date: '2026-03-06', content: 'daily', mode: 'read' });

    expect(gateway.vaultWrite).toHaveBeenCalledWith('Inbox', 'entry', { mode: 'append' });
    expect(gateway.vaultRead).toHaveBeenCalledWith('Inbox.md');
    expect(gateway.vaultSearch).toHaveBeenCalledWith('focus', 12);
    expect(gateway.vaultDaily).toHaveBeenCalledWith('entry');
    expect(gateway.vaultDaily).toHaveBeenCalledWith(undefined);
  });

  it('does not route through shell.exec', async () => {
    await ops.read('Inbox.md');
    expect(gateway.shellExec).not.toHaveBeenCalled();
  });
});
