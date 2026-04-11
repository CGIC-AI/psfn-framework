import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { GatewayFilesystemOps } from './gateway-ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { registerFilesystemTools, wireFilesystemRuntime, type FilesystemRuntimeTarget } from './runtime-wiring.js';

function createMockTarget(): FilesystemRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('filesystem runtime wiring', () => {
  it('registers the unified fs tool as core', () => {
    const target = createMockTarget();
    const ops = {
      read: vi.fn(async () => ({ content: 'hello', truncated: false })),
      list: vi.fn(async () => ['a.txt']),
      search: vi.fn(async () => ({
        query: 'a',
        glob: '**/*',
        mode: 'literal' as const,
        scannedFiles: 1,
        hitLimit: false,
        truncatedFiles: [],
        matches: [],
      })),
      write: vi.fn(async () => ({ path: 'a.txt', status: 'created' as const, bytesWritten: 1 })),
      edit: vi.fn(async () => ({ path: 'a.txt', replacements: 1 })),
    };

    registerFilesystemTools(target, ops);

    expect(target.registerTool.mock.calls.map((call: any[]) => call[0].name)).toEqual(['fs']);
    expect(target.registerTool.mock.calls.every((call: any[]) => call[1] === 'core')).toBe(true);
  });

  it('attaches gateway wiring metadata in gateway mode', () => {
    const target = createMockTarget();
    const gatewayOps = {
      filesystem: {
        read: vi.fn(async () => ({ content: 'content', truncated: false })),
        list: vi.fn(async () => []),
        search: vi.fn(async () => ({
          query: 'a',
          glob: '**/*',
          mode: 'literal' as const,
          scannedFiles: 1,
          hitLimit: false,
          truncatedFiles: [],
          matches: [],
        })),
        write: vi.fn(async () => ({ path: 'a.txt', status: 'created' as const, bytesWritten: 1 })),
        edit: vi.fn(async () => ({ path: 'a.txt', replacements: 1 })),
      },
    };

    registerFilesystemTools(target, new GatewayFilesystemOps(gatewayOps), { gatewayMode: true });

    expect(target.registerTool.mock.calls[0]?.[0].wiringMeta?.requiredGatewayMethods).toEqual([
      'fs.read',
      'fs.list',
      'fs.search',
      'fs.write',
      'fs.edit',
    ]);
  });

  it('wires local workspace filesystem ops with unified read/list/search/write/edit behavior', async () => {
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
      expect(content).toEqual({ content: 'remember this\n', truncated: false });

      const searched = await ops.search({ query: 'remember', glob: 'memories/**/*.txt' });
      expect(searched.matches).toEqual([
        expect.objectContaining({ path: 'memories/memorybook.txt', line: 1, column: 1 }),
      ]);

      const written = await ops.write({ path: 'memories/new.txt', content: 'fresh\n' });
      expect(written).toEqual({
        path: 'memories/new.txt',
        status: 'created',
        bytesWritten: 6,
      });

      const edited = await ops.edit({
        path: 'memories/new.txt',
        oldText: 'fresh',
        newText: 'restored',
      });
      expect(edited).toEqual({ path: 'memories/new.txt', replacements: 1 });

      await expect(ops.read(resolve(root, 'outside.txt'))).rejects.toThrow('workspace root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
