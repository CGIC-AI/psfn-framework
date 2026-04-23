/* eslint-disable no-console */

import { describe, expect, it, vi } from 'vitest';
import { SubstrateAgent } from './substrate-agent.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SessionManager } from '../session/manager.js';
import type { LLMProviderPort, LLMResponse } from './substrate-agent.js';
import type {
  LLMContext,
  StreamCallbacks,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  buildTtftBenchmarkReport,
  evaluateHotPath,
  type TtftBenchmarkMethodology,
  type TtftBenchmarkSample,
} from './ttft-benchmark.js';

const TEST_SYSTEM_PROMPT = 'You are Companion.';
const STREAM_CHUNKS = ['Mock', ' response', ' from', ' Companion'];
const TEST_ASSISTANT_RESPONSE = STREAM_CHUNKS.join('');
const WARMUP_RUNS = 5;
const MEASURED_RUNS = 20;

interface TransportTurnProbe {
  streamCalls: number;
  transportTextDeltas: number;
  streamStartedAt: number | null;
  firstTransportTextAt: number | null;
  streamResolvedAt: number | null;
}

function makeConfig(): SubstrateConfig {
  return {
    companionId: 'test-companion',
    companionName: 'Companion',
    primaryProvider: 'openrouter',
    primaryMaxTokens: 1024,
    defaultContextWindow: 128_000,
    dataDir: '/tmp/psfn-autoresearch-data',
    modelRoster: {
      chat: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2', maxTokens: 1024, contextWindow: 128_000 },
    },
    modelRegistry: {
      version: 1,
      models: [
        {
          id: 'deepseek-v3.2',
          identity: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
          rank: 1,
          purposes: [{ purpose: 'chat', primary: true }],
          capabilities: { contextWindow: 128_000, maxOutputTokens: 1024 },
        },
      ],
    },
    credentialVault: { get: () => 'fake-key' },
    capabilityTier: 'standard',
    responseStyleOverrides: {},
    openRouterProviderOrder: [],
    observationMaskingWindow: 0,
    compactionThresholdPct: 80,
    continuityMessageLimit: 0,
    defaultTrustLevel: 'regular',
    channels: {},
    skills: {},
    scheduler: {},
    trustPolicy: {},
    runtimeHooks: {},
  } as unknown as SubstrateConfig;
}

function makeMessage(index: number): SubstrateMessage {
  return {
    id: `msg-${index}`,
    channelId: `ttft-benchmark-${index}`,
    channelType: 'api',
    authorId: 'user-1',
    authorName: 'User',
    content: 'Hello there',
    timestamp: new Date(),
  };
}

function makeMockSessionManager(): SessionManager {
  return {
    recordUserMessage: vi.fn().mockReturnValue(101),
    recordToolObservation: vi.fn().mockReturnValue(102),
    recordAssistantMessage: vi.fn().mockReturnValue(103),
    recordSystemMessage: vi.fn().mockReturnValue(104),
    recordTurn: vi.fn(),
    appendSystemNote: vi.fn(),
    awaitPendingAutoCompaction: vi.fn().mockResolvedValue(undefined),
    scheduleAutoCompactionBetweenTurns: vi.fn().mockResolvedValue(undefined),
    buildContext: vi.fn().mockResolvedValue({
      systemPrompt: TEST_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'Hello' }],
    }),
    getRecentMessages: vi.fn().mockReturnValue([]),
    getRoleEnvelopeRefsForEntries: vi.fn().mockReturnValue([]),
    resolveSessionChannelId: vi.fn((channelId: string) => channelId),
    getActiveFocusMemoryScopeQuery: vi.fn().mockReturnValue(null),
    setActiveContextSession: vi.fn(),
    getActiveContextSession: vi.fn().mockReturnValue(null),
    continuityStore: null,
  } as unknown as SessionManager;
}

function makeStreamingResponse(): LLMResponse {
  return {
    content: TEST_ASSISTANT_RESPONSE,
    toolCalls: [],
    model: 'deepseek/deepseek-v3.2',
    inputTokens: 100,
    outputTokens: 50,
    stopReason: 'stop',
  };
}

function createTransportProbe(): TransportTurnProbe {
  return {
    streamCalls: 0,
    transportTextDeltas: 0,
    streamStartedAt: null,
    firstTransportTextAt: null,
    streamResolvedAt: null,
  };
}

function durationBetween(start: number | null, end: number | null): number | undefined {
  if (start === null || end === null) {
    return undefined;
  }
  return end - start;
}

function makeStreamingLLMProvider(activeProbe: { current: TransportTurnProbe | null }): LLMProviderPort {
  return {
    async stream(_context: LLMContext, callbacks?: StreamCallbacks): Promise<LLMResponse> {
      const probe = activeProbe.current;
      if (probe === null) {
        throw new Error('TTFT benchmark stream called without an active probe');
      }

      probe.streamCalls += 1;
      probe.streamStartedAt ??= performance.now();

      await Promise.resolve();
      for (const chunk of STREAM_CHUNKS) {
        probe.transportTextDeltas += 1;
        probe.firstTransportTextAt ??= performance.now();
        callbacks?.onText?.(chunk);
        await Promise.resolve();
      }

      const response = makeStreamingResponse();
      probe.streamResolvedAt = performance.now();
      callbacks?.onDone?.(response);
      return response;
    },
    complete: vi.fn(async () => makeStreamingResponse()),
  };
}

describe('TTFT benchmark', () => {
  it('measures local structural latency while proving the live streaming hot path', async () => {
    const methodology: TtftBenchmarkMethodology = {
      benchmarkId: 'autoresearch-ttft',
      measurementClass: 'local_structural_latency',
      measuredPath: [
        'SubstrateAgent.handleMessage',
        'Agent.prompt',
        'createSubstrateStreamFn',
        'transport.stream',
        'EventBridge',
        'agent.stream.delta',
        'agent.turn.stage:first-token',
      ],
      providerSensitiveMetrics: ['ttftMs', 'totalMs'],
      structuralMetrics: ['localPreProviderMs', 'localPostProviderMs', 'structuralOverheadMs'],
      hotPathSignals: [
        'transport.stream invoked',
        'transport.onText invoked',
        'agent.stream.delta observed',
        'agent.turn.stage first-token sourced from stream',
        'agent.turn.stage prompt emitted',
      ],
      warmupTurns: WARMUP_RUNS,
      measuredTurns: MEASURED_RUNS,
    };

    const config = makeConfig();
    const eventBus = new EventBus();
    const activeProbe = { current: null as TransportTurnProbe | null };
    const llmProvider = makeStreamingLLMProvider(activeProbe);
    const agent = new SubstrateAgent(
      eventBus,
      llmProvider,
      makeMockSessionManager(),
      TEST_SYSTEM_PROMPT,
      config,
    );

    const samples: TtftBenchmarkSample[] = [];

    for (let i = 0; i < WARMUP_RUNS + MEASURED_RUNS; i += 1) {
      const message = makeMessage(i);
      const probe = createTransportProbe();
      activeProbe.current = probe;
      let agentStreamDeltas = 0;
      let firstTokenSource: 'stream' | 'fallback' | 'missing' = 'missing';
      let firstTokenTtftMs: number | null = null;
      let promptStageObserved = false;

      const unsubscribeStream = (eventBus as any).on('agent.stream.delta', (data: { channelId: string }) => {
        if (data.channelId === message.channelId) {
          agentStreamDeltas += 1;
        }
      });
      const unsubscribeStage = (eventBus as any).on(
        'agent.turn.stage',
        (data: { channelId?: string; stage: string; source?: string; ttftMs?: number }) => {
          if (data.channelId !== undefined && data.channelId !== message.channelId) {
            return;
          }
          if (data.stage === 'first-token') {
            firstTokenSource = data.source === 'stream' || data.source === 'fallback'
              ? data.source
              : 'missing';
            if (typeof data.ttftMs === 'number' && Number.isFinite(data.ttftMs)) {
              firstTokenTtftMs = data.ttftMs;
            }
          }
          if (data.stage === 'prompt') {
            promptStageObserved = true;
          }
        },
      );

      const turnStart = performance.now();
      const response = await agent.handleMessage(message);
      const turnEnd = performance.now();

      unsubscribeStage();
      unsubscribeStream();
      activeProbe.current = null;

      if (i < WARMUP_RUNS) {
        continue;
      }

      const measuredTtftMs = typeof firstTokenTtftMs === 'number' ? firstTokenTtftMs : -1;
      const sample: TtftBenchmarkSample = {
        providerId: 'mock-streaming-provider',
        turnIndex: i - WARMUP_RUNS,
        ttftMs: measuredTtftMs,
        totalMs: turnEnd - turnStart,
        inputTokens: response.metadata.inputTokens,
        outputTokens: response.metadata.outputTokens,
        model: response.metadata.model,
        localPreProviderMs: durationBetween(turnStart, probe.streamStartedAt),
        providerTtfbMs: durationBetween(probe.streamStartedAt, probe.firstTransportTextAt),
        providerRoundTripMs: durationBetween(probe.streamStartedAt, probe.streamResolvedAt),
        localPostProviderMs: durationBetween(probe.streamResolvedAt, turnEnd),
        structuralOverheadMs:
          (durationBetween(turnStart, probe.streamStartedAt) ?? 0)
          + (durationBetween(probe.streamResolvedAt, turnEnd) ?? 0),
        hotPath: evaluateHotPath({
          transportStreamCalls: probe.streamCalls,
          transportTextDeltas: probe.transportTextDeltas,
          agentStreamDeltas,
          firstTokenSource,
          promptStageObserved,
        }),
      };

      expect(sample.hotPath.liveHotPathSatisfied).toBe(true);
      expect(response.content).toContain(TEST_ASSISTANT_RESPONSE);
      samples.push(sample);
    }

    const report = buildTtftBenchmarkReport({
      methodology,
      samples,
      metrics: {
        ttftMs: (sample) => sample.ttftMs,
        totalMs: (sample) => sample.totalMs,
        localPreProviderMs: (sample) => sample.localPreProviderMs,
        localPostProviderMs: (sample) => sample.localPostProviderMs,
        structuralOverheadMs: (sample) => sample.structuralOverheadMs,
      },
    });
    const ttftSummary = report.summary.metrics.ttftMs;
    const totalSummary = report.summary.metrics.totalMs;
    const structuralSummary = report.summary.metrics.structuralOverheadMs;

    expect(report.summary.errorCount).toBe(0);
    expect(report.summary.hotPathFailures).toBe(0);
    expect(ttftSummary.count).toBe(MEASURED_RUNS);
    expect(structuralSummary.count).toBe(MEASURED_RUNS);

    console.log(`BENCHMARK_METHODOLOGY ${JSON.stringify(methodology)}`);
    console.log(`BENCHMARK_SAMPLE ${JSON.stringify(samples[0])}`);
    console.log(`BENCHMARK_SUMMARY ${JSON.stringify(report.summary)}`);
    console.log(`METRIC median_turn_ms=${totalSummary.medianMs.toFixed(3)}`);
    console.log(`METRIC p90_turn_ms=${totalSummary.p90Ms.toFixed(3)}`);
    console.log(`METRIC min_turn_ms=${totalSummary.minMs.toFixed(3)}`);
    console.log(`METRIC median_local_structural_overhead_ms=${structuralSummary.medianMs.toFixed(3)}`);
    console.log(`METRIC median_hot_path_ttft_ms=${ttftSummary.medianMs.toFixed(3)}`);
    console.log(`METRIC hot_path_failures=${report.summary.hotPathFailures}`);
  });
});
