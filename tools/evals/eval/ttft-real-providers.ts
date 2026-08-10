import '../../psfn-framework/src/shared/utils/load-dotenv.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedE2ERuntime } from '../../psfn-framework/src/app/e2e/runtime-harness.js';
import { hydrateJsonBackedRuntimeConfig } from '../../psfn-framework/src/system/config/runtime-config.js';
import { EventBus } from '../../psfn-framework/src/shared/event-bus.js';
import type {
  LLMContext,
  StreamCallbacks,
  SubstrateMessage,
} from '../../psfn-framework/src/shared/contracts/runtime.js';
import { MemoryStore } from '../../psfn-framework/src/faculties/memory/store.js';
import { initDatabase } from '../../psfn-framework/src/persistence/sqlite-utils.js';
import { LLMClient } from '../../psfn-framework/src/primitives/llm/client.js';
import { createEmbeddingProviderFromEnv } from '../../psfn-framework/src/faculties/memory/embedding.js';
import {
  composeIdentity,
  composeSessionRuntime,
  composeSubstrateAgent,
  wireMemoryRuntime,
} from '../../psfn-framework/src/app/startup/composition/composition.js';
import {
  buildTtftBenchmarkReport,
  evaluateHotPath,
  type TtftBenchmarkMethodology,
  type TtftBenchmarkSample,
} from '../../psfn-framework/src/core/agent/ttft-benchmark.js';

const MEASURED_TURNS = 6;
const WARMUP_TURNS = 1;

const PROVIDERS = [
  { id: 'gemma-4-31b-it', model: 'google/gemma-4-31b-it' },
];

const MESSAGES = [
  "Hey, I'm running a quick test. What's your name and how are you feeling right now?",
  "Interesting. Can you tell me something you remember about me from earlier conversations? Be honest if you don't have anything.",
  "What's the weather like today where you are? I know you don't have a body, but work with me.",
  "If you could change one thing about how we talk, what would it be?",
  'Tell me a short joke. One sentence.',
  'Goodbye for now. Summarize our conversation in three words.',
];

interface TransportTurnProbe {
  streamCalls: number;
  transportTextDeltas: number;
  streamStartedAt: number | null;
  firstTransportTextAt: number | null;
  streamResolvedAt: number | null;
}

const METHODOLOGY: TtftBenchmarkMethodology = {
  benchmarkId: 'ttft-real-providers',
  measurementClass: 'provider_e2e_ttft',
  measuredPath: [
    'SubstrateAgent.handleMessage',
    'Agent.prompt',
    'createSubstrateStreamFn',
    'LLMClient.stream',
    'provider transport',
    'EventBridge',
    'agent.stream.delta',
    'agent.turn.stage:first-token',
  ],
  providerSensitiveMetrics: ['ttftMs', 'providerTtfbMs', 'providerRoundTripMs', 'totalMs'],
  structuralMetrics: ['localPreProviderMs', 'localPostProviderMs', 'structuralOverheadMs'],
  hotPathSignals: [
    'transport.stream invoked',
    'transport.onText invoked',
    'agent.stream.delta observed',
    'agent.turn.stage first-token sourced from stream',
    'agent.turn.stage prompt emitted',
  ],
  warmupTurns: WARMUP_TURNS,
  measuredTurns: MEASURED_TURNS,
};

function makeMessage(channelId: string, content: string, id?: string): SubstrateMessage {
  return {
    id: id ?? `ttft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channelId,
    channelType: 'terminal',
    authorId: 'user-1',
    authorName: 'User',
    content,
    timestamp: new Date(),
  };
}

function buildModelsJson(primaryModel: string) {
  return {
    schemaVersion: 1,
    models: [
      {
        id: 'primary',
        rank: 100,
        identity: {
          provider: 'openrouter',
          model: primaryModel,
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'chat', primary: true },
          { purpose: 'summary', primary: true },
          { purpose: 'reasoning', primary: true },
          { purpose: 'longContext', primary: true },
          { purpose: 'vision', primary: true },
          { purpose: 'moa', primary: true },
        ],
        capabilities: { maxOutputTokens: 8192, contextWindow: 128000 },
        tuning: { maxOutputTokens: 8192 },
      },
      {
        id: 'extraction',
        rank: 80,
        identity: {
          provider: 'openrouter',
          model: 'deepseek/deepseek-v3.2',
          source: { type: 'openrouter' },
        },
        purposes: [
          { purpose: 'background', primary: true },
          { purpose: 'memory', primary: true },
          { purpose: 'extraction', primary: true },
          { purpose: 'import_processing', primary: true },
        ],
        capabilities: { maxOutputTokens: 8192, contextWindow: 128000 },
        tuning: { maxOutputTokens: 8192 },
      },
    ],
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

async function runProvider(provider: typeof PROVIDERS[number]): Promise<TtftBenchmarkSample[]> {
  const results: TtftBenchmarkSample[] = [];
  const runtime = createIsolatedE2ERuntime({ prefix: 'psfn-ttft-' });
  const { config, rootDir } = runtime;

  writeFileSync(
    join(runtime.systemDataDir, 'models.json'),
    JSON.stringify(buildModelsJson(provider.model), null, 2),
  );
  hydrateJsonBackedRuntimeConfig(config, { seedDir: 'config' });

  process.env.CHARACTER_CARD_PATH = join(process.cwd(), 'artie-character-card.json');

  const sessionsDir = join(rootDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const db = initDatabase(config.databasePath);

  try {
    const eventBus = new EventBus();
    const { systemPrompt } = composeIdentity(config);
    const llmClient = new LLMClient(config);
    const sessionComposition = composeSessionRuntime({ config, sessionsDir });
    const { sessionManager } = sessionComposition;
    const embeddingProvider = createEmbeddingProviderFromEnv();
    const memoryStore = new MemoryStore(db, embeddingProvider.dims);
    const activeProbe = { current: null as TransportTurnProbe | null };

    const agentLoop = composeSubstrateAgent({
      eventBus,
      llmProvider: llmClient,
      sessionManager,
      systemPrompt,
      config,
      streamTransport: {
        async stream(context: LLMContext, callbacks?: StreamCallbacks) {
          const probe = activeProbe.current;
          if (probe === null) {
            throw new Error('TTFT benchmark transport invoked without an active turn probe');
          }

          probe.streamCalls += 1;
          probe.streamStartedAt ??= performance.now();

          try {
            const response = await llmClient.stream(context, {
              ...callbacks,
              onText: (delta) => {
                probe.transportTextDeltas += 1;
                probe.firstTransportTextAt ??= performance.now();
                callbacks?.onText?.(delta);
              },
            });
            probe.streamResolvedAt = performance.now();
            return response;
          } catch (error) {
            probe.streamResolvedAt = performance.now();
            throw error;
          }
        },
      },
    });
    wireMemoryRuntime({
      agentLoop,
      llmProvider: llmClient,
      sessionManager,
      memoryStore,
      embeddingService: embeddingProvider,
      eventBus,
    });

    await eventBus.emit('system.init', {});
    await eventBus.emit('system.ready', {});

    const channelId = `ttft-${provider.id}-${Date.now()}`;

    for (let i = 0; i < WARMUP_TURNS + MEASURED_TURNS; i += 1) {
      const content = MESSAGES[i % MESSAGES.length];
      const msg = makeMessage(channelId, content, `ttft-${provider.id}-turn-${i}`);
      const probe = createTransportProbe();
      activeProbe.current = probe;
      let agentStreamDeltas = 0;
      let firstTokenSource: 'stream' | 'fallback' | 'missing' = 'missing';
      let firstTokenTtftMs: number | null = null;
      let promptStageObserved = false;

      const unsubscribeStream = (eventBus as any).on(
        'agent.stream.delta',
        (data: { channelId: string }) => {
          if (data.channelId === channelId) {
            agentStreamDeltas += 1;
          }
        },
      );
      const unsubscribeStage = (eventBus as any).on(
        'agent.turn.stage',
        (data: { channelId?: string; stage: string; source?: string; ttftMs?: number }) => {
          if (data.channelId !== undefined && data.channelId !== channelId) {
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
      try {
        const response = await agentLoop.handleMessage(msg);
        const turnEnd = performance.now();

        unsubscribeStage();
        unsubscribeStream();
        activeProbe.current = null;

        if (i < WARMUP_TURNS) {
          continue;
        }

        const sample: TtftBenchmarkSample = {
          providerId: provider.id,
          turnIndex: i - WARMUP_TURNS,
          ttftMs: firstTokenTtftMs ?? -1,
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
        results.push(sample);
      } catch (err) {
        unsubscribeStage();
        unsubscribeStream();
        activeProbe.current = null;

        if (i < WARMUP_TURNS) {
          continue;
        }

        results.push({
          providerId: provider.id,
          turnIndex: i - WARMUP_TURNS,
          ttftMs: firstTokenTtftMs ?? -1,
          totalMs: performance.now() - turnStart,
          inputTokens: 0,
          outputTokens: 0,
          model: provider.model,
          localPreProviderMs: durationBetween(turnStart, probe.streamStartedAt),
          providerTtfbMs: durationBetween(probe.streamStartedAt, probe.firstTransportTextAt),
          providerRoundTripMs: durationBetween(probe.streamStartedAt, probe.streamResolvedAt),
          localPostProviderMs: undefined,
          structuralOverheadMs: undefined,
          hotPath: evaluateHotPath({
            transportStreamCalls: probe.streamCalls,
            transportTextDeltas: probe.transportTextDeltas,
            agentStreamDeltas,
            firstTokenSource,
            promptStageObserved,
          }),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    db.close();
    runtime.cleanup();
  }

  return results;
}

function emitMetric(name: string, value: number | undefined): void {
  console.log(`METRIC ${name}=${value?.toFixed(3) ?? '0'}`);
}

async function main(): Promise<void> {
  console.log('=== Real-Provider TTFT Benchmark ===');
  console.log(`BENCHMARK_METHODOLOGY ${JSON.stringify(METHODOLOGY)}`);

  const allResults: TtftBenchmarkSample[] = [];

  for (const provider of PROVIDERS) {
    console.log(`Running ${provider.id} (${provider.model})...`);
    const results = await runProvider(provider);
    for (const sample of results) {
      console.log(`BENCHMARK_SAMPLE ${JSON.stringify(sample)}`);
    }

    const providerReport = buildTtftBenchmarkReport({
      methodology: METHODOLOGY,
      samples: results,
      metrics: {
        ttftMs: (sample) => sample.ttftMs,
        totalMs: (sample) => sample.totalMs,
        providerTtfbMs: (sample) => sample.providerTtfbMs,
        providerRoundTripMs: (sample) => sample.providerRoundTripMs,
        localPreProviderMs: (sample) => sample.localPreProviderMs,
        localPostProviderMs: (sample) => sample.localPostProviderMs,
        structuralOverheadMs: (sample) => sample.structuralOverheadMs,
      },
    });
    console.log(
      `BENCHMARK_PROVIDER_SUMMARY ${JSON.stringify({
        providerId: provider.id,
        providerModel: provider.model,
        ...providerReport.summary,
      })}`,
    );
    allResults.push(...results);
  }

  const report = buildTtftBenchmarkReport({
    methodology: METHODOLOGY,
    samples: allResults,
    metrics: {
      ttftMs: (sample) => sample.ttftMs,
      totalMs: (sample) => sample.totalMs,
      providerTtfbMs: (sample) => sample.providerTtfbMs,
      providerRoundTripMs: (sample) => sample.providerRoundTripMs,
      localPreProviderMs: (sample) => sample.localPreProviderMs,
      localPostProviderMs: (sample) => sample.localPostProviderMs,
      structuralOverheadMs: (sample) => sample.structuralOverheadMs,
    },
  });

  console.log(`BENCHMARK_SUMMARY ${JSON.stringify(report.summary)}`);
  emitMetric('median_turn_ms', report.summary.metrics.totalMs?.medianMs);
  emitMetric('p90_turn_ms', report.summary.metrics.totalMs?.p90Ms);
  emitMetric('min_turn_ms', report.summary.metrics.totalMs?.minMs);
  emitMetric('median_ttft_ms', report.summary.metrics.ttftMs?.medianMs);
  emitMetric('p90_ttft_ms', report.summary.metrics.ttftMs?.p90Ms);
  emitMetric('median_provider_ttfb_ms', report.summary.metrics.providerTtfbMs?.medianMs);
  emitMetric('median_provider_round_trip_ms', report.summary.metrics.providerRoundTripMs?.medianMs);
  emitMetric('median_local_pre_provider_ms', report.summary.metrics.localPreProviderMs?.medianMs);
  emitMetric('median_local_post_provider_ms', report.summary.metrics.localPostProviderMs?.medianMs);
  emitMetric('median_local_structural_overhead_ms', report.summary.metrics.structuralOverheadMs?.medianMs);
  console.log(`METRIC hot_path_failures=${report.summary.hotPathFailures}`);

  if (report.summary.successCount === 0) {
    throw new Error('Real-provider TTFT benchmark produced no successful turns');
  }
  if (report.summary.hotPathFailures > 0) {
    throw new Error(`Real-provider TTFT benchmark hit non-streaming or incomplete hot paths on ${report.summary.hotPathFailures} turns`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
