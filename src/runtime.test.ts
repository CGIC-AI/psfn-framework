import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SubstrateRuntime,
  buildRuntimeChannelsConfigOverrides,
  createEmbeddingDimensionMismatchFatalMessage,
} from './runtime.js';
import {
  buildChannelAdapterFactoryManifest,
  loadChannelAdaptersFromManifest,
} from './runtime/channel-lifecycle.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
} from './runtime/bootstrap-helpers.js';
import { buildSessionHmacKeyring } from './session/journal-utils.js';
import { createKeyringIntegrityProvider } from './session/store-primitives.js';
import { composeSessionRuntime } from './bootstrap/composition.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import {
  readLastActiveSession,
} from './lifecycle/notifications.js';
import { installExternalPluginFixture } from './runtime/test-fixtures/external-plugin.js';

function makeRuntime(): SubstrateRuntime {
  return new SubstrateRuntime({
    dataDir: '/tmp/psfn-runtime-test',
  } as any);
}

function makeMinimalConfig(overrides?: Record<string, unknown>) {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 50,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: { model: 'test-model', provider: 'test', maxTokens: 16384, contextWindow: 1000 },
    },
    ...overrides,
  } as any;
}

describe('buildRuntimeChannelsConfigOverrides', () => {
  it('returns empty overrides when telegram settings keys are not present', () => {
    const overrides = buildRuntimeChannelsConfigOverrides(
      makeMinimalConfig({
        telegramEnabled: true,
        telegramAuthorizedUsers: ['111'],
      }),
      {},
    );

    expect(overrides).toEqual({});
  });

  it('maps telegram settings-backed config values into channel overrides', () => {
    const overrides = buildRuntimeChannelsConfigOverrides(
      makeMinimalConfig({
        telegramEnabled: true,
        telegramAuthorizedUsers: ['111', '222'],
      }),
      {
        telegramEnabled: false,
        telegramAuthorizedUsers: 'ignored-here',
      },
    );

    expect(overrides).toEqual({
      telegram: {
        enabled: true,
        allowedUsers: ['111', '222'],
      },
    });
  });

  it('passes an empty allowlist override when telegramAuthorizedUsers was explicitly set empty', () => {
    const overrides = buildRuntimeChannelsConfigOverrides(
      makeMinimalConfig({
        telegramAuthorizedUsers: undefined,
      }),
      {
        telegramAuthorizedUsers: undefined,
      },
    );

    expect(overrides).toEqual({
      telegram: {
        allowedUsers: [],
      },
    });
  });
});

describe('createEmbeddingDimensionMismatchFatalMessage', () => {
  it('returns a fatal startup message for embedding dimension mismatch', () => {
    const message = createEmbeddingDimensionMismatchFatalMessage({
      status: 'mismatch',
      configuredDims: 1024,
      storedDims: 768,
    });

    expect(message).toContain('Embedding dimension mismatch detected at startup');
    expect(message).toContain('configured=1024');
    expect(message).toContain('stored=768');
  });

  it('returns null when embedding dimensions are compatible', () => {
    expect(createEmbeddingDimensionMismatchFatalMessage({
      status: 'match',
      configuredDims: 1024,
      storedDims: 1024,
    })).toBeNull();
  });
});

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
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
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

  it('sends graceful shutdown notification on normal stop path', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };
    runtime.lifecycleNotifier = {
      notifyShutdown: vi.fn().mockResolvedValue(undefined),
    };

    await runtime.stop();

    expect(runtime.lifecycleNotifier.notifyShutdown).toHaveBeenCalledWith(undefined);
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown when graceful shutdown notification fails', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };
    runtime.lifecycleNotifier = {
      notifyShutdown: vi.fn().mockRejectedValue(new Error('ntfy offline')),
    };

    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(runtime.lifecycleNotifier.notifyShutdown).toHaveBeenCalledTimes(2);
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('passes EXTRACTION_DRAIN_TIMEOUT_MS to memoryExtractor.stop', async () => {
    process.env.EXTRACTION_DRAIN_TIMEOUT_MS = '3456';
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    runtime.scheduler = { stop: vi.fn() };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
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
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
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

  it('waits for scheduler drain before stopping extractor', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    let resolveSchedulerStop: (() => void) | undefined;
    runtime.scheduler = {
      stop: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
        resolveSchedulerStop = resolve;
      })),
    };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    const stopPromise = runtime.stop();
    await vi.waitFor(() => {
      expect(runtime.scheduler.stop).toHaveBeenCalledTimes(1);
    });

    expect(runtime.memoryExtractor.stop).not.toHaveBeenCalled();

    resolveSchedulerStop?.();
    await stopPromise;

    expect(runtime.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(runtime.memoryExtractor.stop).toHaveBeenCalledTimes(1);
  });

  it('retries transient shutdown failures and continues after persistent failures', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = {
      emit: vi.fn()
        .mockRejectedValueOnce(new Error('transient event bus failure'))
        .mockResolvedValue(undefined),
    };
    runtime.scheduler = { stop: vi.fn().mockResolvedValue(undefined) };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.moduleLoader = { shutdown: vi.fn().mockRejectedValue(new Error('persistent module failure')) };
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    await expect(runtime.stop()).resolves.toBeUndefined();

    expect(runtime.eventBus.emit).toHaveBeenCalledTimes(2);
    expect(runtime.moduleLoader.shutdown).toHaveBeenCalledTimes(2);
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('shares one stop promise for concurrent shutdown calls', async () => {
    const runtime = makeRuntime() as any;
    runtime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
    let resolveSchedulerStop: (() => void) | undefined;
    runtime.scheduler = {
      stop: vi.fn().mockImplementation(() => new Promise<void>((resolve) => {
        resolveSchedulerStop = resolve;
      })),
    };
    runtime.memoryExtractor = { stop: vi.fn().mockResolvedValue(true) };
    runtime.sessionStore = {
      markGracefulShutdownForActiveChannels: vi.fn().mockReturnValue([]),
    };
    runtime.stopVoiceObservers = vi.fn();
    runtime.stopDebugObserver = vi.fn();
    runtime.stopChannels = vi.fn().mockResolvedValue(undefined);
    runtime.db = { close: vi.fn() };

    const stopOne = runtime.stop();
    const stopTwo = runtime.stop();
    await vi.waitFor(() => {
      expect(runtime.scheduler.stop).toHaveBeenCalledTimes(1);
    });

    expect(runtime.eventBus.emit).toHaveBeenCalledTimes(1);

    resolveSchedulerStop?.();
    await Promise.all([stopOne, stopTwo]);

    expect(runtime.memoryExtractor.stop).toHaveBeenCalledTimes(1);
    expect(runtime.db.close).toHaveBeenCalledTimes(1);
  });

  it('queues retroactive extraction for crash recovery candidates', () => {
    const runtime = makeRuntime() as any;
    const queueRetroactiveExtraction = vi.fn().mockResolvedValue(undefined);
    runtime.memoryExtractor = { queueRetroactiveExtraction };
    runtime.sessionStore = {
      getCrashRecoveryExtractionCandidates: vi.fn().mockReturnValue([]),
    };
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

  it('retries unresolved crash-recovery backlog after graceful shutdown + restart', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-crash-retry-'));
    try {
      const channelId = 'api:restart-recovery';
      const firstStore = new SessionStore(sessionsDir);
      firstStore.append({
        channelId,
        role: 'user',
        content: 'Message 1',
        timestamp: 1_000,
      });
      firstStore.insertExtractionMarker(channelId, 1, 1_500);
      firstStore.append({
        channelId,
        role: 'assistant',
        content: 'Message 2',
        timestamp: 2_000,
      });

      const firstRuntime = makeRuntime() as any;
      const firstRecoveryRuns: Promise<void>[] = [];
      firstRuntime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
      firstRuntime.scheduler = { stop: vi.fn() };
      firstRuntime.memoryExtractor = {
        queueRetroactiveExtraction: vi.fn().mockImplementation(() => {
          const run = Promise.resolve();
          firstRecoveryRuns.push(run);
          return run;
        }),
        stop: vi.fn().mockImplementation(async () => {
          await Promise.all(firstRecoveryRuns);
          return true;
        }),
      };
      firstRuntime.sessionStore = firstStore;
      firstRuntime.stopVoiceObservers = vi.fn();
      firstRuntime.stopDebugObserver = vi.fn();
      firstRuntime.stopChannels = vi.fn().mockResolvedValue(undefined);
      firstRuntime.db = { close: vi.fn() };
      firstRuntime.crashRecoveryQueue = firstStore.getCrashRecoveryExtractionCandidates();
      firstRuntime.seedCrashRecoveryRetryBacklog(firstRuntime.crashRecoveryQueue);

      firstRuntime.queueCrashRecoveryExtractions();
      await Promise.resolve();
      await firstRuntime.stop();

      const restartedStore = new SessionStore(sessionsDir);
      const pendingAfterFirstRun = restartedStore.getCrashRecoveryExtractionCandidates();
      expect(pendingAfterFirstRun).toHaveLength(1);
      expect(pendingAfterFirstRun[0].channelId).toBe(channelId);

      const secondRuntime = makeRuntime() as any;
      const secondRecoveryRuns: Promise<void>[] = [];
      secondRuntime.eventBus = { emit: vi.fn().mockResolvedValue(undefined) };
      secondRuntime.scheduler = { stop: vi.fn() };
      secondRuntime.memoryExtractor = {
        queueRetroactiveExtraction: vi.fn().mockImplementation(async (queuedChannelId: string, entries: any[]) => {
          const run = (async () => {
            const coveredUpTo = entries[entries.length - 1]?.id ?? 0;
            restartedStore.insertExtractionMarker(queuedChannelId, coveredUpTo, 3_000);
          })();
          secondRecoveryRuns.push(run);
          return run;
        }),
        stop: vi.fn().mockImplementation(async () => {
          await Promise.all(secondRecoveryRuns);
          return true;
        }),
      };
      secondRuntime.sessionStore = restartedStore;
      secondRuntime.stopVoiceObservers = vi.fn();
      secondRuntime.stopDebugObserver = vi.fn();
      secondRuntime.stopChannels = vi.fn().mockResolvedValue(undefined);
      secondRuntime.db = { close: vi.fn() };
      secondRuntime.crashRecoveryQueue = restartedStore.getCrashRecoveryExtractionCandidates();
      secondRuntime.seedCrashRecoveryRetryBacklog(secondRuntime.crashRecoveryQueue);

      secondRuntime.queueCrashRecoveryExtractions();
      await secondRuntime.stop();

      const cleanStore = new SessionStore(sessionsDir);
      expect(cleanStore.getCrashRecoveryExtractionCandidates()).toEqual([]);
      expect(cleanStore.getUncleanShutdownChannels()).toEqual([]);
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('starts channel adapters in parallel and keeps healthy adapters when one fails', async () => {
    const runtime = makeRuntime() as any;
    const startHealthy = vi.fn().mockResolvedValue(undefined);
    const startFailing = vi.fn().mockRejectedValue(new Error('failed to connect'));
    runtime.channelRegistry = new Map([
      ['healthy', { id: 'healthy', gateway: { start: startHealthy } }],
      ['failing', { id: 'failing', gateway: { start: startFailing } }],
    ]);
    runtime.agentLoop = { setChannelRegistry: vi.fn() };

    await expect(runtime.startChannels()).resolves.toBeUndefined();

    expect(startHealthy).toHaveBeenCalledTimes(1);
    expect(startFailing).toHaveBeenCalledTimes(1);
    expect(runtime.channelRegistry.has('healthy')).toBe(true);
    expect(runtime.channelRegistry.has('failing')).toBe(false);
    expect(runtime.agentLoop.setChannelRegistry).toHaveBeenCalledWith(runtime.channelRegistry);
  });

  it('fails startup when all channel adapters fail to start', async () => {
    const runtime = makeRuntime() as any;
    runtime.channelRegistry = new Map([
      ['failing-a', { id: 'failing-a', gateway: { start: vi.fn().mockRejectedValue(new Error('down')) } }],
      ['failing-b', { id: 'failing-b', gateway: { start: vi.fn().mockRejectedValue(new Error('down')) } }],
    ]);
    runtime.agentLoop = { setChannelRegistry: vi.fn() };

    await expect(runtime.startChannels()).rejects.toThrow('No channel adapters started successfully');
  });
});

describe('runtime plugin fixture seams', () => {
  it('loads a sample external plugin fixture through the published channel/STT/TTS seams', async () => {
    const fixture = installExternalPluginFixture();
    const registry = new Map<string, any>();
    const log = {
      error: vi.fn(),
      warn: vi.fn(),
    };

    try {
      await loadChannelAdaptersFromManifest(
        registry,
        buildChannelAdapterFactoryManifest([fixture.channelEntry]),
        () => undefined,
        log,
      );

      const sttBinding = createRuntimeVoiceSttConnector(fixture.config as any);
      const ttsBinding = createRuntimeVoiceTtsConnector(fixture.config as any);
      const channel = registry.get('fixture-channel');

      expect(channel).toBeDefined();
      expect(sttBinding?.provider).toBe('fixture-stt');
      expect(ttsBinding?.provider).toBe('fixture-tts');

      await channel.outbound.sendText({ channelId: 'fixture-room' }, 'hello');
      await sttBinding!.connector.startStream({
        sampleRateHz: 16_000,
        channels: 1,
        encoding: 'pcm_s16le',
      });
      await ttsBinding!.connector.synthesizeBuffer({ text: 'hello' });

      expect(fixture.state.channelMessages).toEqual([{ channelId: 'fixture-room', text: 'hello' }]);
      expect(fixture.state.sttStarts).toBe(1);
      expect(fixture.state.ttsBufferRequests).toEqual(['hello']);
    } finally {
      fixture.restore();
    }
  });
});

describe('SubstrateRuntime latest session restoration', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-session-restore-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reuses latest session metadata by default at startup', () => {
    const runtime = new SubstrateRuntime({
      dataDir,
    } as any) as any;
    runtime.sessionManager = {
      resolveStartupSessionMetadata: vi.fn().mockReturnValue({
        sessionId: '123456789012345678',
        channelType: 'discord',
        timestamp: 2_000,
      }),
    };

    runtime.restoreLatestSessionMetadata();

    expect(runtime.sessionManager.resolveStartupSessionMetadata).toHaveBeenCalledWith('reuse_latest_session');
    const restored = readLastActiveSession(dataDir);
    expect(restored?.sessionId).toBe('123456789012345678');
    expect(restored?.channelType).toBe('discord');
    expect(restored?.timestamp).toBe(2_000);
  });

  it('writes a fresh startup session when sessionRestartBehavior is new_session', () => {
    const runtime = new SubstrateRuntime({
      dataDir,
      sessionRestartBehavior: 'new_session',
    } as any) as any;
    runtime.sessionManager = {
      resolveStartupSessionMetadata: vi.fn().mockReturnValue({
        sessionId: 'api:restart-test-session',
        channelType: 'api',
        timestamp: 3_000,
      }),
    };

    runtime.restoreLatestSessionMetadata();

    expect(runtime.sessionManager.resolveStartupSessionMetadata).toHaveBeenCalledWith('new_session');
    const restored = readLastActiveSession(dataDir);
    expect(restored?.sessionId).toBe('api:restart-test-session');
    expect(restored?.channelType).toBe('api');
    expect(restored?.timestamp).toBe(3_000);
  });
});

describe('Single-process session HMAC integrity wiring', () => {
  let dir: string;
  const envBackup: Record<string, string | undefined> = {};
  const hmacEnvVars = [
    'GATEWAY_SESSION_HMAC_KEYS',
    'GATEWAY_SESSION_HMAC_KEY',
    'GATEWAY_SESSION_HMAC_ACTIVE_VERSION',
  ];

  function saveAndClearEnv(): void {
    for (const key of hmacEnvVars) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  }

  function restoreEnv(): void {
    for (const key of hmacEnvVars) {
      if (envBackup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = envBackup[key];
      }
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-runtime-hmac-'));
    saveAndClearEnv();
  });

  afterEach(() => {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds keyring from single key and passes to composeSessionRuntime', () => {
    const keyring = buildSessionHmacKeyring({
      singleKey: 'test-secret-key',
    });
    expect(keyring).not.toBeNull();
    expect(keyring!.activeVersion).toBe('v1');
    expect(keyring!.keys['v1']).toBe('test-secret-key');

    const provider = createKeyringIntegrityProvider(keyring);
    expect(provider).not.toBeNull();

    const sessionsDir = join(dir, 'sessions');
    const composition = composeSessionRuntime({
      config: makeMinimalConfig(),
      sessionsDir,
      sessionIntegrityProvider: provider,
    });

    // Write an entry and read it back -- the entry should have an HMAC signature
    composition.sessionStore.append({
      channelId: 'dm:test',
      role: 'user',
      content: 'Signed message',
      authorId: 'u1',
      authorName: 'User',
      timestamp: Date.now(),
    });

    // Create a second store with the same keyring to verify the signature survives round-trip
    const verifyStore = new SessionStore(sessionsDir, { integrityKeyring: keyring });
    const entries = verifyStore.getRecent('dm:test', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Signed message');
  });

  it('returns null keyring when no HMAC env vars are set', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: undefined,
      singleKey: undefined,
      activeVersion: undefined,
    });
    expect(keyring).toBeNull();

    const provider = createKeyringIntegrityProvider(keyring);
    expect(provider).toBeNull();
  });

  it('resolves keyring from versioned keys matching gateway pattern', () => {
    const keyring = buildSessionHmacKeyring({
      serializedKeys: 'v1:first-key,v2:second-key',
      activeVersion: 'v2',
    });
    expect(keyring).not.toBeNull();
    expect(keyring!.activeVersion).toBe('v2');
    expect(Object.keys(keyring!.keys)).toEqual(['v1', 'v2']);

    const provider = createKeyringIntegrityProvider(keyring);
    expect(provider).not.toBeNull();
  });

  it('detects tampered entries when verified with mismatched keyring', async () => {
    const keyring = buildSessionHmacKeyring({ singleKey: 'integrity-test' });
    const provider = createKeyringIntegrityProvider(keyring);

    const sessionsDir = join(dir, 'sessions');
    const composition = composeSessionRuntime({
      config: makeMinimalConfig(),
      sessionsDir,
      sessionIntegrityProvider: provider,
    });

    composition.sessionStore.append({
      channelId: 'dm:integrity',
      role: 'user',
      content: 'First signed entry',
      authorId: 'u1',
      authorName: 'User',
      timestamp: Date.now(),
    });
    composition.sessionStore.append({
      channelId: 'dm:integrity',
      role: 'assistant',
      content: 'Signed reply',
      timestamp: Date.now(),
    });

    // Verify with a mismatched keyring -- should produce unverified entries
    const wrongKeyring = buildSessionHmacKeyring({ singleKey: 'wrong-key' });
    const wrongStore = new SessionStore(sessionsDir, { integrityKeyring: wrongKeyring });
    const manager = new SessionManager(wrongStore, makeMinimalConfig());

    const ctx = await manager.buildContext(
      'dm:integrity',
      'Sys',
      '',
      undefined,
      undefined,
      { isDirectMessage: true },
    );
    // With a mismatched key, the content should be wrapped in unverified tags
    expect(ctx.messages.some(m => m.content.includes('<unverified_history>'))).toBe(true);
  });

  it('composeSessionRuntime works without integrity provider (existing behavior)', () => {
    const sessionsDir = join(dir, 'sessions-no-hmac');
    const composition = composeSessionRuntime({
      config: makeMinimalConfig(),
      sessionsDir,
    });

    composition.sessionStore.append({
      channelId: 'ch:plain',
      role: 'user',
      content: 'Unsigned message',
      authorId: 'u1',
      authorName: 'User',
      timestamp: Date.now(),
    });

    const entries = composition.sessionStore.getRecent('ch:plain', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Unsigned message');
  });
});
