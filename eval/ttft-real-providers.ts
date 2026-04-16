// Real-provider TTFT benchmark for autoresearch.
// Measures time-to-first-token across multiple providers over multi-turn sessions.
//
// Run: npx tsx eval/ttft-real-providers.ts

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createIsolatedE2ERuntime } from '../src/app/e2e/runtime-harness.js';
import { hydrateJsonBackedRuntimeConfig } from '../src/system/config/runtime-config.js';
import { EventBus } from '../src/shared/event-bus.js';
import { SessionStore } from '../src/persistence/sessions/store.js';
import { MemoryStore } from '../src/faculties/memory/store.js';
import { initDatabase } from '../src/persistence/sqlite-utils.js';
import { LLMClient } from '../src/primitives/llm/client.js';
import { createEmbeddingProviderFromEnv } from '../src/faculties/memory/embedding.js';
import {
  composeIdentity,
  composeSessionRuntime,
  composeSubstrateAgent,
  wireMemoryRuntime,
} from '../src/app/startup/composition/composition.js';
import type { SubstrateMessage } from '../src/shared/contracts/runtime.js';

const TURNS_PER_PROVIDER = 10;
const WARMUP_TURNS = 1;

const PROVIDERS = [
  { id: 'gemma-4-31b-it', model: 'google/gemma-4-31b-it' },
  { id: 'deepseek-v3.2', model: 'deepseek/deepseek-v3.2' },
];

const MESSAGES = [
  "Hey, I'm running a quick test. What's your name and how are you feeling right now?",
  "Interesting. Can you tell me something you remember about me from earlier conversations? Be honest if you don't have anything.",
  "What's the weather like today where you are? I know you don't have a body, but work with me.",
  "If you could change one thing about how we talk, what would it be?",
  "Tell me a short joke. One sentence.",
  "Goodbye for now. Summarize our conversation in three words.",
];

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

interface TurnResult {
  providerId: string;
  turnIndex: number;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
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

async function runProvider(provider: typeof PROVIDERS[number]): Promise<TurnResult[]> {
  const results: TurnResult[] = [];
  const runtime = createIsolatedE2ERuntime({ prefix: 'psfn-ttft-' });
  const { config, rootDir } = runtime;

  // Write a valid models.json for this provider and re-hydrate config
  writeFileSync(
    join(runtime.systemDataDir, 'models.json'),
    JSON.stringify(buildModelsJson(provider.model), null, 2),
  );
  hydrateJsonBackedRuntimeConfig(config, { seedDir: 'config' });

  // Point to Artie character card
  process.env.CHARACTER_CARD_PATH = join(process.cwd(), 'artie-character-card.json');

  const sessionsDir = join(rootDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const databasePath = config.databasePath;
  const db = initDatabase(databasePath);

  try {
    const eventBus = new EventBus();
    const { card, systemPrompt } = composeIdentity(config);
    const companionName = card.data.name.trim() || 'Companion';

    const llmClient = new LLMClient(config);
    const sessionComposition = composeSessionRuntime({ config, sessionsDir });
    const { sessionStore, sessionManager } = sessionComposition;
    const embeddingProvider = createEmbeddingProviderFromEnv();
    const memoryStore = new MemoryStore(db, embeddingProvider.dims);

    const agentLoop = composeSubstrateAgent({
      eventBus,
      llmProvider: llmClient,
      sessionManager,
      systemPrompt,
      config,
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

    for (let i = 0; i < WARMUP_TURNS + TURNS_PER_PROVIDER; i++) {
      const content = MESSAGES[i % MESSAGES.length];
      const msg = makeMessage(channelId, content, `ttft-${provider.id}-turn-${i}`);

      let firstTokenAt: number | null = null;
      const turnStart = performance.now();

      const unsubscribe = eventBus.on('agent.stream.delta', () => {
        if (firstTokenAt === null) {
          firstTokenAt = performance.now();
        }
      });

      try {
        const response = await agentLoop.handleMessage(msg);
        const turnEnd = performance.now();
        unsubscribe();

        if (i < WARMUP_TURNS) continue; // skip warmup from results

        results.push({
          providerId: provider.id,
          turnIndex: i - WARMUP_TURNS,
          ttftMs: firstTokenAt !== null ? firstTokenAt - turnStart : -1,
          totalMs: turnEnd - turnStart,
          inputTokens: response.metadata.inputTokens,
          outputTokens: response.metadata.outputTokens,
          model: response.metadata.model,
        });
      } catch (err) {
        unsubscribe();
        if (i < WARMUP_TURNS) continue;
        results.push({
          providerId: provider.id,
          turnIndex: i - WARMUP_TURNS,
          ttftMs: -1,
          totalMs: performance.now() - turnStart,
          inputTokens: 0,
          outputTokens: 0,
          model: provider.model,
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

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  console.log('=== Real-Provider TTFT Benchmark ===\n');
  const allResults: TurnResult[] = [];

  for (const provider of PROVIDERS) {
    console.log(`Running ${provider.id} (${provider.model})...`);
    const results = await runProvider(provider);
    for (const r of results) {
      const status = r.error ? `ERROR: ${r.error}` : `ttft=${r.ttftMs.toFixed(0)}ms total=${r.totalMs.toFixed(0)}ms tokens=${r.inputTokens}/${r.outputTokens}`;
      console.log(`  turn ${r.turnIndex + 1}: ${status}`);
    }
    allResults.push(...results);
    console.log();
  }

  // Per-provider summary
  console.log('=== Per-Provider Summary ===');
  for (const provider of PROVIDERS) {
    const providerResults = allResults.filter(r => r.providerId === provider.id && !r.error);
    const ttfts = providerResults.map(r => r.ttftMs).sort((a, b) => a - b);
    const totals = providerResults.map(r => r.totalMs).sort((a, b) => a - b);
    const errors = allResults.filter(r => r.providerId === provider.id && r.error);

    if (ttfts.length === 0) {
      console.log(`${provider.id}: ALL ERRORS (${errors.length} failures)`);
      continue;
    }

    console.log(
      `${provider.id}: ` +
      `median_ttft=${percentile(ttfts, 50).toFixed(0)}ms ` +
      `p90_ttft=${percentile(ttfts, 90).toFixed(0)}ms ` +
      `median_total=${percentile(totals, 50).toFixed(0)}ms ` +
      `errors=${errors.length}/${TURNS_PER_PROVIDER}`
    );
  }

  // Global summary
  const allTtfts = allResults.filter(r => !r.error).map(r => r.ttftMs).sort((a, b) => a - b);
  const allTotals = allResults.filter(r => !r.error).map(r => r.totalMs).sort((a, b) => a - b);
  const totalErrors = allResults.filter(r => r.error).length;

  console.log('\n=== Global Summary ===');
  console.log(`Providers tested: ${PROVIDERS.length}`);
  console.log(`Total turns: ${allResults.length}`);
  console.log(`Successful turns: ${allTtfts.length}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`Global median TTFT: ${percentile(allTtfts, 50).toFixed(0)}ms`);
  console.log(`Global p90 TTFT: ${percentile(allTtfts, 90).toFixed(0)}ms`);
  console.log(`Global median total: ${percentile(allTotals, 50).toFixed(0)}ms`);

  // METRIC lines for autoresearch parsing
  console.log(`\nMETRIC median_turn_ms=${percentile(allTotals, 50).toFixed(3)}`);
  console.log(`METRIC p90_turn_ms=${percentile(allTotals, 90).toFixed(3)}`);
  console.log(`METRIC min_turn_ms=${allTotals[0]?.toFixed(3) ?? '0'}`);
  console.log(`METRIC median_ttft_ms=${percentile(allTtfts, 50).toFixed(3)}`);
  console.log(`METRIC p90_ttft_ms=${percentile(allTtfts, 90).toFixed(3)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
