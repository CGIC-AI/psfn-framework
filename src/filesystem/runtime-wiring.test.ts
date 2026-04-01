import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '../gateway/client.js';
import { GatewayFilesystemOps } from './gateway-ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { registerFilesystemTools, wireFilesystemRuntime, type FilesystemRuntimeTarget } from './runtime-wiring.js';

function createMockTarget(): FilesystemRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('filesystem runtime wiring', () => {
  it('registers fs as a core tool', () => {
    const target = createMockTarget();
    const ops = {
      read: vi.fn(async () => ({ content: 'hello', truncated: false })),
      list: vi.fn(async () => ['a.txt']),
      search: vi.fn(async () => ({
        query: 'hello',
        glob: '**/*',
        mode: 'literal',
        scannedFiles: 1,
        hitLimit: false,
        truncatedFiles: [],
        matches: [],
      })),
      write: vi.fn(async () => ({ path: 'a.txt', status: 'created', bytesWritten: 5 })),
      edit: vi.fn(async () => ({ path: 'a.txt', replacements: 1 })),
    };

    registerFilesystemTools(target, ops);

    expect(target.registerTool.mock.calls.map((call: any[]) => call[0].name)).toEqual(['fs']);
    expect(target.registerTool.mock.calls.every((call: any[]) => call[1] === 'core')).toBe(true);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    const target = createMockTarget();
    const gateway = {
      fsReadDetailed: vi.fn(async () => ({ content: 'content', truncated: false })),
      fsList: vi.fn(async () => []),
      fsSearch: vi.fn(async () => ({
        query: 'content',
        glob: '**/*',
        mode: 'literal',
        scannedFiles: 0,
        hitLimit: false,
        truncatedFiles: [],
        matches: [],
      })),
      fsWrite: vi.fn(async () => undefined),
      fsEdit: vi.fn(async () => ({ success: true, replacements: 1 })),
    } as unknown as GatewayClient;

    registerFilesystemTools(target, new GatewayFilesystemOps(gateway), { gatewayMode: true });

    const methodsByTool = new Map(
      target.registerTool.mock.calls.map((call: any[]) => [call[0].name, call[0].wiringMeta?.requiredGatewayMethods]),
    );
    expect(methodsByTool.get('fs')).toEqual(['fs.read', 'fs.list', 'fs.search', 'fs.write', 'fs.edit']);
  });

  it('wires local workspace filesystem ops with workspace-relative inspection and mutation behavior', async () => {
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

      const content = await ops.read('memories/memorybook.txt', { maxBytes: 100 });
      expect(content).toEqual({ content: 'remember this\n', truncated: false });

      const searched = await ops.search({ query: 'remember', glob: 'memories/**/*.txt' });
      expect(searched.matches).toHaveLength(1);

      const writeResult = await ops.write({
        path: 'memories/new-note.txt',
        content: 'new note\n',
      });
      expect(writeResult.status).toBe('created');

      const editResult = await ops.edit({
        path: 'memories/new-note.txt',
        oldText: 'new note',
        newText: 'updated note',
      });
      expect(editResult.replacements).toBe(1);

      await expect(ops.read(resolve(root, 'outside.txt'))).rejects.toThrow('workspace root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
