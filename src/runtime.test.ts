import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubstrateRuntime } from './runtime.js';

function makeRuntime(): SubstrateRuntime {
  return new SubstrateRuntime({
    dataDir: '/tmp/psfn-runtime-test',
  } as any);
}

describe('SubstrateRuntime crash recovery wiring', () => {
  const originalExtractionDrainTimeoutMs = process.env.EXTRACTION_DRAIN_TIMEOUT_MS;

  function restoreExtractionDrainTimeout(): void {
    if (originalExtractionDrainTimeoutMs === undefined) {
      delete process.env.EXTRACTION_DRAIN_TIMEOUT_MS;
      return;
    }
    process.env.EXTRACTION_DRAIN_TIMEOUT_MS = originalExtractionDrainTimeoutMs;
  }

  afterEach(() => {
    restoreExtractionDrainTimeout();
  });

  it('writes graceful shutdown markers during clean stop', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue(['api:test']),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    await runtime.stop();

    expect(runtime.memoryExtractor.stop).toHaveBeenCalled();
    expect(runtime.sessionStore.markGracefulShutdownForActiveChannels).toHaveBeenCalled();
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('passes EXTRACTION_DRAIN_TIMEOUT_MS to memoryExtractor.stop', async () => {
    process.env.EXTRACTION_DRAIN_TIMEOUT_MS = '3456';
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    await runtime.stop();

    expect(runtime.memoryExtractor.stop).toHaveBeenCalledWith({ timeoutMs: 3456 });
  });

  it('waits for in-flight extraction to complete before final shutdown', async () => {
    delete process.env.EXTRACTION_DRAIN_TIMEOUT_MS;
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    let resolveExtraction: (() => void) | undefined;
    let extractionCompleted = false;
    const inFlightExtraction = new Promise<void>((resolve) => {
      resolveExtraction = resolve;
    }).then(() => {
      extractionCompleted = true;
    });

    runtime.memoryExtractor = {
      maybeExtract: vi.fn(() => inFlightExtraction),
      stop: vi.fn(async () => {
        await inFlightExtraction;
        return true;
      }),
    };

    const triggeredExtraction = runtime.memoryExtractor.maybeExtract('api:stop-drain');
    const stopPromise = runtime.stop();
    await Promise.resolve();
    expect(runtime.stopChannels).not.toHaveBeenCalled();
    expect(runtime.db.close).not.toHaveBeenCalled();

    resolveExtraction?.();
    await triggeredExtraction;
    await stopPromise;

    expect(extractionCompleted).toBe(true);
    expect(runtime.memoryExtractor.stop).toHaveBeenCalledWith({ timeoutMs: 10_000 });
    expect(runtime.stopChannels).toHaveBeenCalledTimes(1);
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('queues retroactive extraction for crash recovery candidates', () => {
    const runtime = makeRuntime() as any;
    const queueRetroactiveExtraction = vi.fn().mockResolvedValue(undefined);
    runtime.memoryExtractor = { queueRetroactiveExtraction };
    const pendingQueue = [
      {
        channelId: 'api:recover-1',
        lastExtractionCoveredUpTo: 3,
        unextractedEntries: [{ id: 4, channelId: 'api:recover-1', role: 'user', content: 'x', timestamp: 1 }],
      },
      {
        channelId: 'api:recover-2',
        lastExtractionCoveredUpTo: 5,
        unextractedEntries: [{ id: 6, channelId: 'api:recover-2', role: 'assistant', content: 'y', timestamp: 2 }],
      },
    ];
    runtime.crashRecoveryQueue = pendingQueue;

    runtime.queueCrashRecoveryExtractions();

    expect(queueRetroactiveExtraction).toHaveBeenCalledTimes(2);
    expect(queueRetroactiveExtraction).toHaveBeenNthCalledWith(1, 'api:recover-1', pendingQueue[0].unextractedEntries);
    expect(queueRetroactiveExtraction).toHaveBeenNthCalledWith(2, 'api:recover-2', pendingQueue[1].unextractedEntries);
    expect(runtime.crashRecoveryQueue).toEqual([]);
  });
});
