import { describe, expect, it, vi } from 'vitest';
import { SubstrateRuntime } from './runtime.js';

function makeRuntime(): SubstrateRuntime {
  return new SubstrateRuntime({
    dataDir: '/tmp/psfn-runtime-test',
  } as any);
}

describe('SubstrateRuntime crash recovery wiring', () => {
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
