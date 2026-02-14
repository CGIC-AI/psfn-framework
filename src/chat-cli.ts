// ── CLI Chat Tool ──
// Interactive terminal chat with PSFN, using the same runtime stack as Discord.
// Run: npx tsx src/chat-cli.ts
// Or:  npm run chat

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig } from './types.js';
import type { SubstrateMessage } from './types.js';
import { EventBus } from './event-bus.js';
import { loadCharacterCard, composeSystemPrompt } from './identity/loader.js';
import { LLMClient } from './llm/client.js';
import { SessionStore } from './session/store.js';
import { SessionManager } from './session/manager.js';
import { AgentLoop } from './agent-loop.js';
import { MemoryStore } from './memory/store.js';
import { EmbeddingProvider } from './memory/embedding.js';
import { MemoryRetriever } from './memory/retrieval.js';
import { MemoryExtractor } from './memory/extraction.js';
import { SalienceDecay } from './memory/decay.js';
import { ShardManager } from './shards/manager.js';
import { createSpawnShardTool } from './shards/tools.js';
import { createThinkTool } from './repl/tools.js';
import { DEFAULT_REPL_CONFIG } from './repl/types.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadSettings, applySettings } from './settings.js';

const CHANNEL_ID = 'cli:chat';

async function main(): Promise<void> {
  const config = loadConfig();
  const savedSettings = loadSettings(config.dataDir);
  applySettings(config, savedSettings);
  const eventBus = new EventBus();

  console.log('[CLI] Initializing PSFN...');

  // Database for memory (L2)
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Identity
  const card = loadCharacterCard(config.characterCardPath);
  const systemPrompt = composeSystemPrompt(card);
  console.log(`[CLI] Loaded character: ${card.data.name}`);

  // Core components
  const llmClient = new LLMClient(config);
  const sessionStore = new SessionStore(join(config.dataDir, 'sessions'));
  const sessionManager = new SessionManager(sessionStore, config);

  // Embeddings
  const embeddingProvider = new EmbeddingProvider({
    ollamaUrl: process.env.OLLAMA_URL,
    model: process.env.EMBEDDING_MODEL,
    dims: process.env.EMBEDDING_DIMS ? parseInt(process.env.EMBEDDING_DIMS, 10) : undefined,
  });

  const memoryStore = new MemoryStore(db, embeddingProvider.dims);

  // Agent loop
  const agentLoop = new AgentLoop(
    eventBus,
    llmClient,
    sessionManager,
    systemPrompt,
    config,
  );

  // Memory
  agentLoop.memoryProvider = new MemoryRetriever(memoryStore, embeddingProvider, config);
  agentLoop.memoryExtractor = new MemoryExtractor(
    llmClient,
    sessionManager,
    memoryStore,
    embeddingProvider,
    eventBus,
    config,
  );

  const salienceDecay = new SalienceDecay(memoryStore);
  salienceDecay.start();

  // Shards
  const shardManager = new ShardManager({
    eventBus,
    llmProvider: llmClient,
    sessionStore,
    embeddingService: embeddingProvider,
    memoryProvider: agentLoop.memoryProvider,
    config,
    parentSystemPrompt: systemPrompt,
  });
  agentLoop.registerTool(createSpawnShardTool(shardManager));

  // Think tool (RLM+REPL)
  agentLoop.registerTool(createThinkTool({
    llmProvider: llmClient,
    embeddingService: embeddingProvider,
    memoryStore,
    sessionManager,
    config: DEFAULT_REPL_CONFIG,
  }));

  // Event logging for debugging
  eventBus.on('agent.stream.delta', ({ text }) => {
    process.stdout.write(text);
  });

  eventBus.on('memory.extraction.end', ({ channelId, count }) => {
    if (count > 0) {
      console.log(`\n[Memory] Extracted ${count} fact(s) from ${channelId}`);
    }
  });

  await eventBus.emit('system.init', {});
  await eventBus.emit('system.ready', {});

  console.log(`[CLI] Ready — ${embeddingProvider.dims}d embeddings via Ollama`);
  console.log('[CLI] Type your message, or /quit to exit, /memories to list stored memories\n');

  // REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'You> ',
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input === '/quit' || input === '/exit') {
      console.log('[CLI] Shutting down...');
      salienceDecay.stop();
      db.close();
      rl.close();
      process.exit(0);
    }

    if (input === '/memories') {
      const memories = memoryStore.getAllActiveMemories();
      if (memories.length === 0) {
        console.log('[Memory] No memories stored yet.\n');
      } else {
        console.log(`[Memory] ${memories.length} active memories:`);
        for (const m of memories) {
          console.log(`  [${m.type}] ${m.text} (salience: ${m.salience.toFixed(2)}, confidence: ${m.confidence.toFixed(2)})`);
        }
        console.log();
      }
      rl.prompt();
      return;
    }

    if (input === '/sessions') {
      const count = sessionStore.count(CHANNEL_ID);
      const recent = sessionStore.getRecent(CHANNEL_ID, 5);
      console.log(`[Session] ${count} entries in ${CHANNEL_ID}`);
      for (const e of recent) {
        console.log(`  [${e.role}] ${e.content.slice(0, 80)}${e.content.length > 80 ? '...' : ''}`);
      }
      console.log();
      rl.prompt();
      return;
    }

    const message: SubstrateMessage = {
      id: `cli-${Date.now()}`,
      channelId: CHANNEL_ID,
      channelType: 'terminal',
      authorId: 'operator',
      authorName: 'V',
      content: input,
      timestamp: new Date(),
    };

    try {
      // Newline before streaming output
      process.stdout.write('\nPSFN> ');
      const response = await agentLoop.handleMessage(message);
      // Newline after streamed response
      console.log();
      console.log(`  [${response.metadata.model} | ${response.metadata.inputTokens}+${response.metadata.outputTokens} tokens | ${response.metadata.durationMs}ms]\n`);
    } catch (err) {
      console.error('\n[Error]', err instanceof Error ? err.message : err);
      console.log();
    }

    rl.prompt();
  });

  rl.on('close', () => {
    salienceDecay.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[CLI] Fatal error:', err);
  process.exit(1);
});
