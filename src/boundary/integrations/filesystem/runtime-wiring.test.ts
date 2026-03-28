import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../../gateway/client.js';
import { GatewayFilesystemOps } from './gateway-ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { registerFilesystemTools, wireFilesystemRuntime, type FilesystemRuntimeTarget } from './runtime-wiring.js';

function createMockTarget(): FilesystemRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('filesystem runtime wiring', () => {
  it('registers fs_list and fs_read as core tools', () => {
    const target = createMockTarget();
    const ops = {
      read: vi.fn(async () => 'hello'),
      list: vi.fn(async () => ['a.txt']),
    };

    registerFilesystemTools(target, ops);

    expect(target.registerTool.mock.calls.map((call: any[]) => call[0].name)).toEqual(['fs_list', 'fs_read']);
    expect(target.registerTool.mock.calls.every((call: any[]) => call[1] === 'core')).toBe(true);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    const target = createMockTarget();
    const gateway = {
      fsRead: vi.fn(async () => 'content'),
      fsList: vi.fn(async () => []),
    } as unknown as GatewayClient;

    registerFilesystemTools(target, new GatewayFilesystemOps(gateway), { gatewayMode: true });

    const methodsByTool = new Map(
      target.registerTool.mock.calls.map((call: any[]) => [call[0].name, call[0].wiringMeta?.requiredGatewayMethods]),
    );
    expect(methodsByTool.get('fs_list')).toEqual(['fs.list']);
    expect(methodsByTool.get('fs_read')).toEqual(['fs.read']);
  });

  it('wires local workspace filesystem ops with workspace-relative list/read behavior', async () => {
    const root = mkdtempSync(join(tmpdir(), 'filesystem-runtime-'));
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, 'memories'), { recursive: true });
    writeFileSync(join(workspace, 'memories', 'memorybook.txt'), 'remember this\n', 'utf-8');

    try {
      const target = createMockTarget();
      const ops = wireFilesystemRuntime(target, workspace);
      expect(ops).toBeInstanceOf(WorkspaceFilesystemOps);

      const listed = await ops.list('memories/**/*.txt', 10);
      expect(listed).toEqual(['memories/memorybook.txt']);

      const content = await ops.read('memories/memorybook.txt');
      expect(content).toBe('remember this\n');

      await expect(ops.read(resolve(root, 'outside.txt'))).rejects.toThrow('workspace root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
