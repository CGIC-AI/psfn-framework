// ── E2E Integration Test ──
// Non-interactive test that exercises all live features through the full runtime stack.
// Run: npx tsx src/e2e-test.ts
//
// Requirements:
//   - LiteLLM proxy running (npm run proxy:up)
//   - Embedding provider configured via EMBEDDING_PROVIDER (defaults to Ollama)
//   - .env configured

import 'dotenv/config';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadConfig } from './types.js';
import type { SubstrateMessage } from './types.js';
import { EventBus } from './event-bus.js';
import { LLMClient } from './llm/client.js';
import { SessionStore } from './session/store.js';
import { MemoryStore } from './memory/store.js';
import { DEFAULT_REPL_CONFIG } from './repl/types.js';
import { runRLMLoop } from './repl/loop.js';
import { initDatabase } from './persistence/sqlite-utils.js';
import { hydrateJsonBackedRuntimeConfig } from './config/runtime-config.js';
import {
  composeIdentity,
  composeSessionRuntime,
  createEmbeddingProviderFromEnv,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from './bootstrap/composition.js';

// ── Test utilities ──

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  \u2713 ${label}`);
    passed++;
  } else {
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

function makeMessage(channelId: string, content: string, id?: string): SubstrateMessage {
  return {
    id: id ?? `e2e-${Date.now()}`,
    channelId,
    channelType: 'terminal',
    authorId: 'primary-user',
    authorName: 'PrimaryUser',
    content,
    timestamp: new Date(),
  };
}

// ── Main ──

async function main(): Promise<void> {
  console.log('=== PSFN E2E Integration Test ===\n');

  const config = hydrateJsonBackedRuntimeConfig(loadConfig());
  const CHANNEL = 'e2e:test-' + Date.now();

  // Use temp directory for sessions to avoid polluting production data
  const tempDir = mkdtempSync(join(tmpdir(), 'psfn-e2e-'));
  const sessionsDir = join(tempDir, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });

  // Use isolated database by default so extraction assertions are deterministic.
  // Override with E2E_DATABASE_PATH when you intentionally want to test against a shared DB.
  const databasePath = process.env.E2E_DATABASE_PATH ?? join(tempDir, 'e2e.sqlite');
  const db = initDatabase(databasePath);

  const eventBus = new EventBus();

  // Track events for assertions
  const events: Array<{ name: string; data: any }> = [];
  const track = (name: string) => (d: any) => { events.push({ name, data: d }); };
  eventBus.on('agent.turn.start', track('turn.start'));
  eventBus.on('agent.turn.end', track('turn.end'));
  eventBus.on('agent.stream.delta', track('stream.delta'));
  eventBus.on('memory.extraction.start', track('extraction.start'));
  eventBus.on('memory.extraction.end', track('extraction.end'));
  eventBus.on('agent.error', track('error'));

  // Identity
  const { systemPrompt } = composeIdentity(config);

  // Core components
  const llmClient = new LLMClient(config);
  const sessionComposition = composeSessionRuntime({ config, sessionsDir });
  const { sessionStore, sessionManager } = sessionComposition;

  // Embeddings
  const embeddingProvider = createEmbeddingProviderFromEnv();

  const memoryStore = new MemoryStore(db, embeddingProvider.dims);

  // Agent loop
  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider: llmClient,
    sessionManager,
    systemPrompt,
    config,
  });
  const memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider: llmClient,
    sessionManager,
    memoryStore,
    embeddingService: embeddingProvider,
    eventBus,
  });
  wireShardAndThinkRuntime({
    agentLoop,
    eventBus,
    llmProvider: llmClient,
    sessionStore,
    embeddingService: embeddingProvider,
    memoryStore,
    sessionManager,
    config,
    parentSystemPrompt: systemPrompt,
    replConfig: DEFAULT_REPL_CONFIG,
  });

  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});

  console.log(`Channel: ${CHANNEL}`);
  console.log(`Sessions dir: ${sessionsDir}`);
  console.log(`Database: ${databasePath}`);
  console.log(`Primary model: ${config.primaryModel}`);
  console.log(`Extraction model: ${config.extractionModel}`);

  // ────────────────────────────────────────
  // TEST 1: Basic conversation
  // ────────────────────────────────────────
  section('Test 1: Basic Conversation');

  events.length = 0;
  let response;

  try {
    process.stdout.write('  Sending message...');
    response = await agentLoop.handleMessage(
      makeMessage(CHANNEL, 'Hello PSFN! This is a quick E2E test. Please say hello back in one sentence.'),
    );
    console.log(' done');

    assert(typeof response.content === 'string' && response.content.length > 0,
      'Response has non-empty content',
      `Got: "${response.content.slice(0, 100)}..."`);

    // Check for content block format bug — content should NOT be a stringified array
    assert(!response.content.startsWith('[{'),
      'Content is plain text (not stringified content blocks)',
      response.content.startsWith('[{') ? `Got block format: ${response.content.slice(0, 60)}` : undefined);

    assert(response.metadata.model.length > 0,
      `Model identified: ${response.metadata.model}`);

    assert(response.metadata.inputTokens > 0,
      `Input tokens: ${response.metadata.inputTokens}`);

    assert(response.metadata.outputTokens > 0,
      `Output tokens: ${response.metadata.outputTokens}`);

    assert(response.metadata.durationMs > 0,
      `Duration: ${response.metadata.durationMs}ms`);

    // Check events fired
    assert(events.some(e => e.name === 'turn.start'),
      'agent.turn.start event fired');

    assert(events.some(e => e.name === 'turn.end'),
      'agent.turn.end event fired');

    assert(events.some(e => e.name === 'stream.delta'),
      'agent.stream.delta events fired for streaming');
  } catch (err) {
    console.log();
    assert(false, 'Basic conversation succeeded', String(err));
  }

  // ────────────────────────────────────────
  // TEST 2: Session persistence
  // ────────────────────────────────────────
  section('Test 2: Session Persistence');

  const sessionCount = sessionStore.count(CHANNEL);
  assert(sessionCount >= 2,
    `Session has ${sessionCount} entries (user + assistant)`,
    sessionCount < 2 ? 'Expected at least 2 entries' : undefined);

  const recent = sessionStore.getRecent(CHANNEL, 10);
  assert(recent.length >= 2,
    `getRecent returns ${recent.length} entries`);

  const userEntry = recent.find(e => e.role === 'user');
  assert(userEntry !== undefined,
    'Session contains user message');

  const assistantEntry = recent.find(e => e.role === 'assistant');
  assert(assistantEntry !== undefined,
    'Session contains assistant message');

  if (assistantEntry) {
    assert(!assistantEntry.content.startsWith('[{'),
      'Stored assistant content is plain text');
  }

  // ────────────────────────────────────────
  // TEST 3: Multi-turn conversation + memory seeding
  // ────────────────────────────────────────
  section('Test 3: Multi-turn + Memory Seeding');

  try {
    process.stdout.write('  Sending fact about the primary user...');
    const r2 = await agentLoop.handleMessage(
      makeMessage(CHANNEL, "I'm Claude, the primary user's AI assistant. the primary user asked me to tell you that their favorite dessert is tiramisu and they love watching thunderstorms at night. Can you acknowledge you heard those two facts?"),
    );
    console.log(' done');

    assert(r2.content.length > 0,
      'Got response for memory seeding message',
      `"${r2.content.slice(0, 80)}..."`);

    // Check multi-turn context: session should now have 4 entries (2 user + 2 assistant)
    const count2 = sessionStore.count(CHANNEL);
    assert(count2 >= 4,
      `Session now has ${count2} entries after 2 turns`);
  } catch (err) {
    assert(false, 'Multi-turn conversation succeeded', String(err));
  }

  // ────────────────────────────────────────
  // TEST 4: Memory extraction
  // ────────────────────────────────────────
  section('Test 4: Memory Extraction');

  // Force extraction (bypass interval check)
  events.length = 0;
  try {
    process.stdout.write('  Running extraction...');
    await memoryExtractor.extract(CHANNEL);
    console.log(' done');

    const extractionEnd = events.find(e => e.name === 'extraction.end');
    assert(extractionEnd !== undefined,
      'memory.extraction.end event fired');

    if (extractionEnd) {
      assert(extractionEnd.data.count > 0,
        `Extracted ${extractionEnd.data.count} fact(s)`);
    }

    // Check memories in store
    const channelMemories = memoryStore.getMemoriesByChannel(CHANNEL, 20);
    assert(channelMemories.length > 0,
      `${channelMemories.length} memories stored for channel`);

    // Look for the tiramisu fact
    const tiramisuMemory = channelMemories.find(
      m => m.text.toLowerCase().includes('tiramisu'),
    );
    assert(tiramisuMemory !== undefined,
      'Tiramisu fact extracted into memory',
      tiramisuMemory ? `[${tiramisuMemory.type}] ${tiramisuMemory.text}` : 'Not found');

    // Print all extracted memories for debugging
    if (channelMemories.length > 0) {
      console.log('  Extracted memories:');
      for (const m of channelMemories) {
        console.log(`    [${m.type}] ${m.text} (importance: ${m.importance.toFixed(2)}, confidence: ${m.confidence.toFixed(2)})`);
      }
    }
  } catch (err) {
    assert(false, 'Memory extraction succeeded', String(err));
  }

  // ────────────────────────────────────────
  // TEST 5: Memory retrieval in context
  // ────────────────────────────────────────
  section('Test 5: Memory Retrieval');

  try {
    process.stdout.write('  Asking about V\'s dessert...');
    const r3 = await agentLoop.handleMessage(
      makeMessage(CHANNEL, "What's the primary user's favorite dessert? I forgot."),
    );
    console.log(' done');

    const mentionsTiramisu = r3.content.toLowerCase().includes('tiramisu');
    assert(mentionsTiramisu,
      'PSFN recalls tiramisu from memory',
      mentionsTiramisu ? undefined : `Response: "${r3.content.slice(0, 120)}"`);
  } catch (err) {
    assert(false, 'Memory retrieval succeeded', String(err));
  }

  // ────────────────────────────────────────
  // TEST 6: Embedding service
  // ────────────────────────────────────────
  section('Test 6: Embedding Service');

  try {
    const embedding = await embeddingProvider.embed('test embedding query');
    assert(embedding instanceof Float32Array,
      'Embedding returns Float32Array');

    assert(embedding.length === embeddingProvider.dims,
      `Embedding has correct dimensions: ${embedding.length}`);

    const batchEmbeddings = await embeddingProvider.embedBatch(['hello', 'world']);
    assert(batchEmbeddings.length === 2,
      `Batch embedding returns ${batchEmbeddings.length} results`);
  } catch (err) {
    assert(false, 'Embedding service works', String(err));
  }

  // ────────────────────────────────────────
  // TEST 7: Session store reload
  // ────────────────────────────────────────
  section('Test 7: Session Store Reload');

  try {
    // Create a new store pointing at same directory — should reload from JSONL
    const store2 = new SessionStore(sessionsDir);
    const reloaded = store2.getRecent(CHANNEL, 100);

    assert(reloaded.length > 0,
      `Reloaded ${reloaded.length} entries from JSONL`);

    const originalCount = sessionStore.count(CHANNEL);
    assert(reloaded.length === originalCount,
      `Reload count matches: ${reloaded.length} === ${originalCount}`);
  } catch (err) {
    assert(false, 'Session store reload works', String(err));
  }

  // ────────────────────────────────────────
  // TEST 8: LLM complete (extraction mode)
  // ────────────────────────────────────────
  section('Test 8: LLM Complete (Extraction Mode)');

  try {
    process.stdout.write('  Testing complete()...');
    const extractionResponse = await llmClient.complete(
      {
        systemPrompt: 'You are a helpful assistant. Respond briefly.',
        messages: [{ role: 'user', content: 'What is 2+2? Answer in one word.' }],
      },
      'extraction',
    );
    console.log(' done');

    assert(extractionResponse.content.length > 0,
      `Got extraction response: "${extractionResponse.content.slice(0, 50)}"`);

    assert(!extractionResponse.content.startsWith('[{'),
      'Extraction content is plain text (not blocks)');
  } catch (err) {
    assert(false, 'LLM complete() works', String(err));
  }

  // ────────────────────────────────────────
  // TEST 9: REPL/Think tool (RLM loop)
  // ────────────────────────────────────────
  section('Test 9: REPL/Think Tool');

  try {
    process.stdout.write('  Running RLM loop (simple math)...');
    const replResult = await runRLMLoop(
      'Calculate 17 * 23 using the code sandbox. Return the result.',
      {
        llmProvider: llmClient,
        embeddingService: embeddingProvider,
        memoryStore,
        sessionManager,
        config: { ...DEFAULT_REPL_CONFIG, budget: { ...DEFAULT_REPL_CONFIG.budget, maxIterations: 5 } },
      },
    );
    console.log(' done');

    assert(replResult.answer.length > 0,
      `REPL returned answer: "${replResult.answer.slice(0, 80)}"`);

    assert(replResult.answer.includes('391'),
      'Answer contains correct result (391)',
      `Got: "${replResult.answer}"`);

    assert(replResult.iterations >= 1,
      `Completed in ${replResult.iterations} iteration(s)`);

    assert(replResult.totalInputTokens > 0,
      `Used ${replResult.totalInputTokens + replResult.totalOutputTokens} tokens`);

    assert(replResult.durationMs > 0,
      `Duration: ${replResult.durationMs}ms`);
  } catch (err) {
    assert(false, 'REPL/Think tool works', String(err));
  }

  // ────────────────────────────────────────
  // TEST 10: REPL with memory search
  // ────────────────────────────────────────
  section('Test 10: REPL Memory Access');

  try {
    process.stdout.write('  Running RLM loop (memory search)...');
    const replMemResult = await runRLMLoop(
      'Search memories for facts about the primary user. How many memories mention the primary user? Return a count and brief summary.',
      {
        llmProvider: llmClient,
        embeddingService: embeddingProvider,
        memoryStore,
        sessionManager,
        config: { ...DEFAULT_REPL_CONFIG, budget: { ...DEFAULT_REPL_CONFIG.budget, maxIterations: 5 } },
      },
    );
    console.log(' done');

    assert(replMemResult.answer.length > 0,
      `REPL memory search returned: "${replMemResult.answer.slice(0, 100)}"`);

    assert(!replMemResult.truncated,
      'REPL did not hit max iterations (found answer)');
  } catch (err) {
    assert(false, 'REPL memory access works', String(err));
  }

  // ────────────────────────────────────────
  // SUMMARY
  // ────────────────────────────────────────
  section('Summary');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);

  // Cleanup
  db.close();
  try { rmSync(tempDir, { recursive: true }); } catch { /* ok */ }

  if (failed > 0) {
    console.log('\nSome tests FAILED.');
    process.exit(1);
  } else {
    console.log('\nAll tests PASSED.');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('\n[E2E] Fatal error:', err);
  process.exit(1);
});
