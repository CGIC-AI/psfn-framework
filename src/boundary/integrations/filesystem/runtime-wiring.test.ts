import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { GatewayFilesystemOps } from './gateway-ops.js';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { registerFilesystemTools, wireFilesystemRuntime, type FilesystemRuntimeTarget } from './runtime-wiring.js';
import { readTextFile } from './workspace-ops.js';

function createMockTarget(): FilesystemRuntimeTarget & { registerTool: ReturnType<typeof vi.fn> } {
  return {
    registerTool: vi.fn(),
  };
}

describe('filesystem runtime wiring', () => {
  it('registers the unified fs tool as core', () => {
    const target = createMockTarget();
    const ops = {
      read: vi.fn(async () => ({
        content: 'hello',
        offsetBytes: 0,
        nextOffsetBytes: null,
        eof: true,
        truncated: false,
      })),
      list: vi.fn(async () => ({
        paths: ['a.txt'],
        scannedEntries: 1,
        maxEntries: 200,
        maxScannedEntries: 5000,
        truncated: false,
        scanLimitReached: false,
        entryLimitReached: false,
      })),
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

  it('attaches gateway wiring metadata and enforces the shared direct-read cap in gateway mode', async () => {
    const target = createMockTarget();
    const gatewayOps = {
      filesystem: {
        read: vi.fn(async () => ({
          content: 'content',
          offsetBytes: 0,
          nextOffsetBytes: null,
          eof: true,
          truncated: false,
        })),
        list: vi.fn(async () => ({
          paths: [],
          scannedEntries: 0,
          maxEntries: 200,
          maxScannedEntries: 5000,
          truncated: false,
          scanLimitReached: false,
          entryLimitReached: false,
        })),
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

    const ops = new GatewayFilesystemOps(gatewayOps);
    registerFilesystemTools(target, ops, { gatewayMode: true });

    expect(target.registerTool.mock.calls[0]?.[0].wiringMeta?.requiredGatewayMethods).toEqual([
      'fs.read',
      'fs.list',
      'fs.search',
      'fs.write',
      'fs.edit',
    ]);
    await expect(ops.read('notes.txt', { maxBytes: 200_001 })).rejects.toThrow('max_bytes');
    expect(gatewayOps.filesystem.read).not.toHaveBeenCalled();
    await expect(ops.read('notes.txt')).resolves.toMatchObject({ content: 'content' });
    expect(gatewayOps.filesystem.read).toHaveBeenCalledWith('notes.txt', {
      maxBytes: 100_000,
      offsetBytes: 0,
    });
  });

  it('wires local workspace filesystem ops with unified read/list/search/write/edit behavior', async () => {
    const root = mkdtempSync(join(tmpdir(), 'filesystem-runtime-'));
    const workspace = join(root, 'workspaces', 'personal', 'companion-a');
    mkdirSync(join(workspace, 'memories'), { recursive: true });
    writeFileSync(join(workspace, 'memories', 'memorybook.txt'), 'remember this\n', 'utf-8');

    try {
      const target = createMockTarget();
      const ops = wireFilesystemRuntime(target, workspace);
      expect(ops).toBeInstanceOf(WorkspaceFilesystemOps);

      const listed = await ops.list('memories/**/*.txt', 10);
      expect(listed).toMatchObject({
        paths: ['memories/memorybook.txt'],
        maxEntries: 10,
        truncated: false,
        scanLimitReached: false,
        entryLimitReached: false,
      });

      const content = await ops.read('memories/memorybook.txt');
      expect(content).toEqual({
        content: 'remember this\n',
        offsetBytes: 0,
        nextOffsetBytes: null,
        eof: true,
        truncated: false,
      });

      const searched = await ops.search({ query: 'remember', glob: 'memories/**/*.txt' });
      expect(searched.matches).toEqual([
        expect.objectContaining({ path: 'memories/memorybook.txt', line: 1, column: 1 }),
      ]);

      const largePath = join(workspace, 'memories', 'large.txt');
      const largeContent = `${`${'x'.repeat(100)}\n`.repeat(200)}needle`;
      writeFileSync(largePath, largeContent, 'utf-8');
      await expect(ops.read('memories/large.txt', { maxBytes: 200_000 }))
        .resolves.toMatchObject({
          content: largeContent,
          eof: true,
          truncated: false,
        });
      await expect(ops.read('memories/large.txt', { maxBytes: 200_001 }))
        .rejects.toThrow('max_bytes');
      await expect(ops.read('memories/large.txt', { maxBytes: 20_000 })).resolves.toMatchObject({
        content: largeContent.slice(0, 20_000),
        offsetBytes: 0,
        nextOffsetBytes: 20_000,
        eof: false,
        truncated: true,
      });
      await expect(readTextFile(largePath)).resolves.toMatchObject({
        content: largeContent,
        eof: true,
        truncated: false,
      });
      const searchedPastDirectCap = await ops.search({
        query: 'needle',
        glob: 'memories/large.txt',
        maxBytesPerFile: 40_000,
      });
      expect(searchedPastDirectCap.matches).toEqual([
        expect.objectContaining({ path: 'memories/large.txt', line: 201, column: 1 }),
      ]);

      const written = await ops.write({ path: 'memories/new.txt', content: 'fresh\n' });
      expect(written).toEqual({
        path: 'memories/new.txt',
        status: 'created',
        bytesWritten: 6,
      });
      const prefixedPath = 'workspaces/personal/companion-a/memories/prefixed.txt';
      await expect(ops.write({ path: prefixedPath, content: 'prefixed\n' }))
        .resolves.toMatchObject({ path: 'memories/prefixed.txt', status: 'created' });
      await expect(ops.read(prefixedPath))
        .resolves.toMatchObject({ content: 'prefixed\n', eof: true });

      const edited = await ops.edit({
        path: 'memories/new.txt',
        oldText: 'fresh',
        newText: 'restored',
      });
      expect(edited).toEqual({ path: 'memories/new.txt', replacements: 1 });
      const editedPrefixed = await ops.edit({
        path: prefixedPath,
        oldText: 'prefixed',
        newText: 'normalized',
      });
      expect(editedPrefixed).toEqual({
        path: 'memories/prefixed.txt',
        replacements: 1,
      });
      await expect(ops.read('memories/prefixed.txt'))
        .resolves.toMatchObject({ content: 'normalized\n', eof: true });

      await expect(ops.read(resolve(root, 'outside.txt'))).rejects.toThrow('workspace root');
      await expect(ops.write({ path: '../escape.txt', content: 'nope' }))
        .rejects.toThrow('without traversal segments');

      mkdirSync(join(workspace, 'workspaces', 'personal', 'companion-a'), { recursive: true });
      await expect(ops.write({ path: prefixedPath, content: 'ambiguous\n' }))
        .rejects.toThrow('ambiguous');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
