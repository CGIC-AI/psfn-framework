import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { closeWikiRuntimeResources, wireWikiRuntime } from './runtime-wiring.js';

const embedding: EmbeddingProviderPort = {
  dims: 2,
  embed: async () => new Float32Array([1, 0]),
  embedBatch: async texts => texts.map(() => new Float32Array([1, 0])),
};

describe('multi-companion wiki runtime prerequisites', () => {
  it('fails closed before registration when PostgreSQL is missing', async () => {
    const registerTool = vi.fn();
    await expect(wireWikiRuntime({ registerTool }, '/unused', {
      embedding,
      companionId: 'companion-a',
      systemDataDir: '/unused',
      getMultiCompanion: () => true,
    })).rejects.toThrow('requires PostgreSQL');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('fails closed before registration when the embedding provider is missing', async () => {
    const registerTool = vi.fn();
    await expect(wireWikiRuntime({ registerTool }, '/unused', {
      databaseUrl: 'postgresql://unused/unused',
      companionId: 'companion-a',
      systemDataDir: '/unused',
      getMultiCompanion: () => true,
    })).rejects.toThrow('requires an embedding provider');
    expect(registerTool).not.toHaveBeenCalled();
  });

  it('fails closed before database access when the places registry is missing', async () => {
    const systemDataDir = mkdtempSync(join(tmpdir(), 'psfn-caretaker-places-'));
    const registerTool = vi.fn();
    try {
      await expect(wireWikiRuntime({ registerTool }, '/unused', {
        databaseUrl: 'postgresql://unused/unused',
        embedding,
        companionId: 'companion-a',
        systemDataDir,
        getMultiCompanion: () => true,
      })).rejects.toThrow('requires a valid places registry');
      expect(registerTool).not.toHaveBeenCalled();
    } finally {
      rmSync(systemDataDir, { recursive: true, force: true });
    }
  });
});

describe('wiki runtime resource shutdown', () => {
  it('closes every resource and reports any close failures', async () => {
    const failedClose = vi.fn(async () => { throw new Error('close failed'); });
    const successfulClose = vi.fn(async () => undefined);

    await expect(closeWikiRuntimeResources([
      { close: failedClose },
      { close: successfulClose },
    ])).rejects.toThrow('Failed to close wiki runtime resources');
    expect(failedClose).toHaveBeenCalledOnce();
    expect(successfulClose).toHaveBeenCalledOnce();
  });
});
