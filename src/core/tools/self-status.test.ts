import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import {
  chargeSurface,
  resetRunChargeRollingWindowForTests,
  runWithChargeContext,
} from '../../shared/telemetry/run-charge.js';
import type { ChargePolicyConfig } from '../../shared/contracts/charge-policy.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { buildRuntimeToolCatalogEntry } from '../agent/tool-catalog.js';
import {
  buildSelfStatusSnapshot,
  createSelfStatusTool,
  type SelfStatusToolRuntime,
} from './self-status.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content.map(part => part.text).join('');
}

function parseResult(result: AgentToolResult<any>): any {
  return JSON.parse(resultText(result));
}

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 10,
      background: 20,
      maintenance: 30,
      subagent: 40,
      shard: 50,
    },
    surfaceCosts: {
      ownerFileInspection: 1,
      localFilesystem: 1,
      memoryRead: 1,
      memoryWrite: 2,
      localEmbedding: 1,
      externalEmbedding: 2,
      localImageGeneration: 1,
      paidImageGeneration: 3,
      analysisWorkbenchExtensionBand: 2,
      subagentLaunch: 3,
      shardLaunch: 5,
      externalModelConsult: 4,
      moaRoundBase: 3,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 0,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 3,
    },
    fatigue: makeTestFatiguePolicyConfig(),
  };
}

function makeRuntime(overrides: Partial<SelfStatusToolRuntime> = {}): SelfStatusToolRuntime {
  const config: SubstrateConfig = {
    primaryModel: 'chat-model',
    primaryProvider: 'openrouter',
    extractionModel: 'memory-model',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 1024,
    extractionMaxTokens: 1024,
    characterCardPath: '/secret/card.json',
    dataDir: '/secret/data',
    databasePath: '/secret/db.sqlite',
    postgresDatabaseUrl: 'postgres://secret-user:secret-pass@db/psfn',
    discordToken: 'discord-secret-token',
    openRouterApiKeyRef: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {},
    capabilityTier: 'guided',
    chargePolicy: makeChargePolicy(),
    shardToolsets: {
      guided: ['north_star'],
    },
  };

  return {
    config,
    startedAtMs: 1_700_000_000_000,
    now: () => 1_700_000_120_000,
    getCapabilityTier: () => 'autonomous',
    getAdaptiveToolRuntimeState: () => ({
      generatedAt: 1_700_000_100_000,
      coreTools: ['tool_search', 'toolset', 'self_status', 'system'],
      extendedTools: ['north_star', 'media'],
      promotedToolsConfigured: ['north_star'],
      promotedToolsActive: ['north_star'],
      promotedToolsSkipped: [],
      loadedExtendedTools: [{
        toolName: 'media',
        source: 'extended_loaded',
        activatedAt: 1_700_000_010_000,
        lastActivatedAt: 1_700_000_020_000,
      }],
      activeTools: [
        { toolName: 'self_status', source: 'core' },
        { toolName: 'north_star', source: 'promoted' },
      ],
      lastSnapshot: null,
    }),
    getToolCatalogSnapshot: () => ({
      generatedAt: 1_700_000_100_000,
      tools: [
        { name: 'self_status', description: 'status', scope: 'core' },
        { name: 'north_star', description: 'guide', scope: 'extended' },
      ],
    }),
    getToolHealthStatusByName: () => new Map([
      ['media', 'degraded'],
      ['north_star', 'healthy'],
    ]),
    getObserverEvalSidecarHealth: () => ({
      status: 'disabled',
      observedAt: 1_700_000_100_000,
      enabled: false,
      available: false,
      accepting: false,
      queue: {
        queuedCount: 0,
        runningCount: 0,
        maxQueuedTurns: 32,
        overflowPolicy: 'drop_newest',
        shuttingDown: false,
      },
      counts: {
        accepted: 0,
        completed: 0,
        dropped: 0,
        failed: 0,
        timedOut: 0,
        retried: 0,
        lifecycleHookFailed: 0,
        shutdownTimedOut: 0,
      },
      dropCounts: {},
      failureCounts: {},
    }),
    getMemoryStats: async () => ({
      total: 7,
      byType: { fact: 5, preference: 2 },
      avgSalience: 0.42,
    }),
    listRecentSessions: () => [
      {
        sessionId: 'internal:heartbeat',
        channelId: 'internal:heartbeat',
        channelType: 'api',
        lastActivityAt: 1_700_000_110_000,
        messageCount: 4,
        lastRole: 'assistant',
        lastAuthorName: 'Scheduler',
        lastMessagePreview: 'private heartbeat text should not appear',
      },
      {
        sessionId: 'api:main',
        channelId: 'api:main',
        channelType: 'api',
        lastActivityAt: 1_700_000_090_000,
        messageCount: 12,
        lastRole: 'user',
        lastAuthorName: 'Operator',
        lastMessagePreview: 'private user text should not appear',
      },
    ],
    getStreamingState: () => false,
    ...overrides,
  };
}

describe('createSelfStatusTool', () => {
  beforeEach(() => {
    resetRunChargeRollingWindowForTests();
  });

  it('returns structured allowed runtime fields without message previews', async () => {
    const runtime = makeRuntime();
    const tool = createSelfStatusTool(runtime);
    const payload = parseResult(await tool.execute('self-status-1', {}));

    expect(payload.schemaVersion).toBe(1);
    expect(payload.capability).toEqual({
      status: 'available',
      tier: 'autonomous',
      source: 'runtime',
    });
    expect(payload.tools.activeTools).toEqual([
      { toolName: 'self_status', source: 'core' },
      { toolName: 'north_star', source: 'promoted' },
    ]);
    expect(payload.tools.counts).toMatchObject({
      core: 4,
      extended: 2,
      active: 2,
    });
    expect(payload.charge.lanes.interactive).toMatchObject({
      quota: 10,
      rollingWindowSpent: 0,
      rollingWindowRemaining: 10,
    });
    expect(payload.channels.recent[0]).toEqual({
      sessionId: 'internal:heartbeat',
      channelId: 'internal:heartbeat',
      channelType: 'api',
      lastActivityAt: 1_700_000_110_000,
      messageCount: 4,
      lastRole: 'assistant',
    });
    expect(payload.heartbeat).toMatchObject({
      status: 'available',
      channelId: 'internal:heartbeat',
      ageMs: 10_000,
    });
    expect(payload.uptime).toMatchObject({
      status: 'available',
      startedAtMs: 1_700_000_000_000,
      uptimeMs: 120_000,
    });
    expect(payload.memory.stats).toEqual({
      total: 7,
      byType: { fact: 5, preference: 2 },
      avgSalience: 0.42,
    });
    expect(payload.substrate.observerEval).toMatchObject({
      status: 'available',
      enabled: false,
      available: false,
    });
    expect(JSON.stringify(payload)).not.toContain('private heartbeat text');
    expect(JSON.stringify(payload)).not.toContain('private user text');
  });

  it('redacts secrets by construction even when secret-bearing config is present', async () => {
    const payload = await buildSelfStatusSnapshot(makeRuntime());
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain('discord-secret-token');
    expect(serialized).not.toContain('secret-pass');
    expect(serialized).not.toContain('OPENROUTER_API_KEY');
    expect(serialized).not.toContain('/secret/');
  });

  it('reports unavailable and degraded subsystems explicitly rather than guessing', async () => {
    const payload = await buildSelfStatusSnapshot({
      config: {},
      now: () => 1_700_000_000_000,
      startedAtMs: 1_700_000_000_000,
      getMemoryStats: async () => {
        throw new Error('memory failed with token secret-token');
      },
    });
    const serialized = JSON.stringify(payload);

    expect(payload.tools).toEqual({
      status: 'unavailable',
      reason: 'adaptive tool runtime state provider is not wired',
    });
    expect(payload.charge).toEqual({
      status: 'unavailable',
      reason: 'charge policy is not configured',
    });
    expect(payload.channels).toEqual({
      status: 'unavailable',
      reason: 'recent session provider is not wired',
    });
    expect(payload.heartbeat).toEqual({
      status: 'unavailable',
      reason: 'recent session provider is unavailable',
    });
    expect(payload.memory).toEqual({
      status: 'error',
      reason: 'memory stats provider failed',
    });
    expect(payload.substrate).toMatchObject({
      status: 'available',
      streaming: {
        status: 'unavailable',
        reason: 'streaming state provider is not wired',
      },
      observerEval: {
        status: 'unavailable',
        reason: 'observer eval sidecar health provider is not wired',
      },
    });
    expect(serialized).not.toContain('secret-token');
  });

  it('includes current run and rolling lane charge remaining when available', async () => {
    const runtime = makeRuntime();
    await runWithChargeContext({
      chargePolicy: runtime.config.chargePolicy,
      lane: 'interactive',
      runId: 'run-status-test',
    }, async () => {
      chargeSurface('memoryRead');
      const payload = await buildSelfStatusSnapshot({
        ...runtime,
        now: undefined,
      });

      expect((payload.charge as any).lanes.interactive).toMatchObject({
        quota: 10,
        rollingWindowSpent: 1,
        rollingWindowRemaining: 9,
        currentRunSpent: 1,
        currentRunRemaining: 9,
      });
      expect((payload.charge as any).currentRun).toMatchObject({
        lane: 'interactive',
        lineage: {
          runId: 'run-status-test',
        },
      });
    });
  });

  it('returns bounded diagnostics from the logs action only', async () => {
    const getDiagnosticsSnapshot = vi.fn(async query => ({
      schemaVersion: 1 as const,
      generatedAt: 1_700_000_120_000,
      window: {
        sinceMs: 1_700_000_060_000,
        untilMs: 1_700_000_120_000,
        windowMs: 60_000,
        limit: 5,
        includeFileLogs: false,
        logsDir: query.logsDir ?? '/app/logs',
      },
      sources: [],
      agentLog: { status: 'available' as const, counts: { warn: 1, error: 0, total: 1 }, records: [] },
      fileLogs: { status: 'unavailable' as const, reason: 'file log diagnostics disabled for this request' },
      toolValidationFailures: { status: 'available' as const, total: 0, byTool: [] },
      lifecycle: { status: 'available' as const, events: [] },
      rollout: { status: 'unavailable' as const, reason: 'requires kube surface (x5rt.4)' },
      pods: { status: 'unavailable' as const, reason: 'requires kube surface (x5rt.4)' },
      backup: {
        status: 'available' as const,
        counts: { success: 0, failure: 0, total: 0 },
        lastSuccess: null,
        lastFailure: null,
        recent: [],
      },
    }));
    const tool = createSelfStatusTool(makeRuntime({
      logsDir: '/runtime/logs',
      getDiagnosticsSnapshot,
    }));

    const payload = parseResult(await tool.execute('self-status-diagnostics', {
      action: 'logs',
      windowMs: 60_000,
      limit: 5,
      includeFileLogs: false,
    }));

    expect(payload.agentLog.counts.warn).toBe(1);
    expect(payload.rollout).toEqual({
      status: 'unavailable',
      reason: 'requires kube surface (x5rt.4)',
    });
    expect(getDiagnosticsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      logsDir: '/runtime/logs',
      windowMs: 60_000,
      limit: 5,
      includeFileLogs: false,
    }));
  });

  it('runs the conformance sweep and returns the aggregated result for action=conformance', async () => {
    let capturedTrigger: string | undefined;
    const runtime = {
      ...makeRuntime(),
      runConformance: async (trigger: 'manual') => {
        capturedTrigger = trigger;
        return { schemaVersion: 1 as const, ranAt: 7, trigger, results: [] };
      },
    };
    const tool = createSelfStatusTool(runtime);
    const result = await tool.execute('call-1', { action: 'conformance' });
    expect(capturedTrigger).toBe('manual');
    expect(parseResult(result)).toEqual({ schemaVersion: 1, ranAt: 7, trigger: 'manual', results: [] });
    expect((result.details as { isError?: boolean }).isError).toBeFalsy();
  });

  it('fails closed for action=conformance when the runner is not wired', async () => {
    const tool = createSelfStatusTool(makeRuntime());
    const result = await tool.execute('call-1', { action: 'conformance' });
    expect((result.details as { isError?: boolean }).isError).toBe(true);
    expect(resultText(result)).toContain('conformance runner is not wired');
  });

  it('renders safe tool catalog metadata for prompt/tool surfaces', () => {
    const tool = createSelfStatusTool(makeRuntime());
    const catalogEntry = buildRuntimeToolCatalogEntry(tool, 'core');

    expect(tool.description).toContain('safe structured snapshot of current runtime state');
    expect(JSON.stringify(tool.parameters)).toContain('Message content is never returned');
    expect(catalogEntry.schema).toMatchObject({
      actions: expect.arrayContaining([
        {
          name: 'snapshot',
          requiredCapabilities: ['internal.read'],
        },
        {
          name: 'diagnose',
          requiredCapabilities: ['internal.read'],
        },
        {
          name: 'logs',
          requiredCapabilities: ['internal.read'],
        },
        {
          name: 'conformance',
          requiredCapabilities: ['internal.read'],
        },
      ]),
      requiredCapabilities: ['internal.read'],
      reversibility: 'reversible',
      canonical: {
        domain: 'system',
        exposure: 'core',
      },
    });
  });
});
