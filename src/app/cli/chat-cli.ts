// ── CLI Chat Tool ──
// Interactive terminal chat with the active companion, using the same runtime stack as Discord.
// Run: npx tsx src/app/cli/chat-cli.ts
// Or:  npm run chat

import '../../shared/utils/load-dotenv.js';
import { createInterface } from 'node:readline';
import { loadConfig } from '../../system/config/load-config.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import { resolveCompanionNameFromCard } from '../../core/identity/companion-runtime.js';
import { LLMClient } from '../../primitives/llm/client.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import { DEFAULT_REPL_CONFIG } from '../../core/tools/analysis-workbench/types.js';
import {
  hydrateCanonicalStartupConfig,
  hydrateSecretBearingConfig,
} from '../startup/support/bootstrap-helpers.js';
import { applyGatewayTlsConfig } from '../../boundary/gateway/tls.js';
import {
  composeIdentity,
  composeMemoryStoreAsync,
  composeSessionRuntimeAsync,
  createEmbeddingProviderFromConfig,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';

const CHANNEL_ID = 'cli:chat';

async function main(): Promise<void> {
  const config = loadConfig();
  applyGatewayTlsConfig({
    caPath: config.gatewayTlsCaPath,
    rejectUnauthorized: config.gatewayTlsRejectUnauthorized,
  });
  await hydrateSecretBearingConfig(config, { env: process.env });
  hydrateCanonicalStartupConfig(config, { env: process.env });
  const eventBus = new EventBus();

  console.log('[CLI] Initializing companion runtime...');

  // Identity
  const { card, systemPrompt } = composeIdentity(config);
  const companionName = resolveCompanionNameFromCard(card);
  console.log(`[CLI] Loaded character: ${companionName}`);

  // Core components
  const llmClient = new LLMClient(config);
  const sessionComposition = await composeSessionRuntimeAsync({ config });
  const { sessionStore, sessionManager } = sessionComposition;

  // Embeddings
  const embeddingProvider = createEmbeddingProviderFromConfig(config);

  const memoryStore = await composeMemoryStoreAsync(config, embeddingProvider.dims);

  // Agent loop
  const agentLoop = composeSubstrateAgent({
    eventBus,
    llmProvider: llmClient,
    sessionManager,
    systemPrompt,
    config,
  });

  // Memory
  agentLoop.memoryExtractor = wireMemoryRuntime({
    agentLoop,
    llmProvider: llmClient,
    sessionManager,
    memoryStore,
    embeddingService: embeddingProvider,
    eventBus,
    config,
  });

  const salienceDecay = new SalienceDecay(memoryStore);
  salienceDecay.start();

  // Shards and analysis workbench (RLM+REPL)
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

  console.log(`[CLI] Ready — ${embeddingProvider.dims}d embeddings via ${embeddingProvider.kind}`);
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
      rl.close();
      process.exit(0);
    }

    if (input === '/memories') {
      const memories = await memoryStore.getAllActiveMemories();
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
      authorId: 'primary-user',
      authorName: 'PrimaryUser',
      content: input,
      timestamp: new Date(),
    };

    try {
      // Newline before streaming output
      process.stdout.write(`\n${companionName}> `);
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
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[CLI] Fatal error:', err);
  process.exit(1);
});
