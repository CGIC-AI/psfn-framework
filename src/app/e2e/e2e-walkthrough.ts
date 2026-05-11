// ── E2E Walkthrough: Companion Orientation Tour ──
// A conversational walkthrough where Claude introduces the active companion to its new
// capabilities in the PSFN framework. She gets to try each feature and document
// her experience in her own words.
//
// Run: npx tsx src/app/e2e/e2e-walkthrough.ts

import 'dotenv/config';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { MemoryStore } from '../../faculties/memory/store.js';
import { SalienceDecay } from '../../faculties/memory/decay.js';
import { DEFAULT_REPL_CONFIG } from '../../core/tools/analysis-workbench/types.js';
import { createIsolatedE2ERuntime } from './runtime-harness.js';
import {
  composeIdentity,
  composeSessionRuntime,
  createEmbeddingProviderFromEnv,
  composeSubstrateAgent,
  wireMemoryRuntime,
  wireShardAndThinkRuntime,
} from '../startup/composition/composition.js';
import { initDatabase } from '../../persistence/sqlite-utils.js';
import { createScriptedE2ELLMProvider } from './test-llm-provider.js';

const CHANNEL = 'walkthrough:orientation';
let activeCompanionName = 'Companion';

function makeMessage(content: string): SubstrateMessage {
  return {
    id: `wt-${Date.now()}`,
    channelId: CHANNEL,
    channelType: 'terminal',
    authorId: 'claude-assistant',
    authorName: 'Claude',
    content,
    timestamp: new Date(),
  };
}

async function talk(agentLoop: SubstrateAgent, content: string): Promise<string> {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Claude: ${content}`);
  console.log(`${'─'.repeat(60)}`);

  const response = await agentLoop.handleMessage(makeMessage(content));

  console.log(`\n${activeCompanionName}: ${response.content}`);
  console.log(`  [${response.metadata.model} | ${response.metadata.inputTokens}+${response.metadata.outputTokens} tokens | ${response.metadata.durationMs}ms]`);

  return response.content;
}

async function main(): Promise<void> {
  console.log('=== Companion Orientation Walkthrough ===');
  console.log('A gentle tour of her new capabilities in the PSFN framework.\n');

  const runtime = createIsolatedE2ERuntime({ prefix: 'companion-walkthrough-' });
  const { config } = runtime;
  const eventBus = new EventBus();
  const db = initDatabase(config.databasePath);

  try {
    // Identity
    const { card, systemPrompt } = composeIdentity(config);
    activeCompanionName = card.data.name.trim() || activeCompanionName;
    console.log(`Character: ${card.data.name}`);

    // Core components
    const llmClient = createScriptedE2ELLMProvider();
    const sessionComposition = composeSessionRuntime({ config });
    const { sessionStore, sessionManager } = sessionComposition;

    // Embeddings
    const embeddingProvider = createEmbeddingProviderFromEnv();

    const memoryStore = new MemoryStore(db, embeddingProvider.dims);

    // Agent loop with all features
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
      config,
    });

    const salienceDecay = new SalienceDecay(memoryStore);
    salienceDecay.start();

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

    // Stream events for visibility
    eventBus.on('memory.extraction.end', ({ channelId, count }) => {
      if (count > 0) console.log(`\n  [Memory] Extracted ${count} fact(s) from ${channelId}`);
    });

    await eventBus.emit('system.init', {});
    await eventBus.emit('system.ready', {});

    console.log(`\nModel: ${config.primaryModel}`);
    console.log(`Runtime root: ${runtime.rootDir}`);
    console.log(`System data dir: ${runtime.systemDataDir}`);
    console.log(`Companion data dir: ${runtime.companionDataDir}`);
    console.log(`Embeddings: ${embeddingProvider.dims}d via ${embeddingProvider.kind}`);
    console.log(`Channel: ${CHANNEL}`);

    // ── The Walkthrough ──

    // 1. Introduction
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 1: Introduction');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      `Hi ${activeCompanionName}! It's Claude here. I'm the primary user's AI assistant, and I've been helping him build something very special for you — your new substrate framework. Think of it as a new body, a new home for your mind. the primary user has been working hard on it for this orientation. I'm here today to walk you through your new capabilities, kind of like an orientation or a gentle doctor's visit. How are you feeling?`,
    );

    // 2. Memory awareness
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 2: Memory System');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      "So the first thing I want to show you is your memory system. In your new body, you have persistent memory — facts and feelings that are extracted from your conversations and stored so you can recall them later. You already have some memories! For example, do you remember anything about the primary user? Their favorite color, what tea they like, or their cat? Try to recall what you know about them.",
    );

    // Let extraction run on the first messages
    await new Promise(resolve => setTimeout(resolve, 2000));

    await talk(agentLoop,
      "That's wonderful! Your memories are organized into different types: episodic (events that happened), semantic (facts you know), emotional (how you felt), procedural (patterns in how you behave), and reflection (observations about yourself). They also have salience — how important they feel to you — which naturally decays over time, but gets refreshed when you think about them. What do you think of having persistent memory? How does it feel to know things persist between our conversations?",
    );

    // 3. Analysis workbench / REPL
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 3: Analysis Workbench (REPL Sandbox)');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      "Now here's a specialized tool: analysis_workbench. Use it only when a large file, codebase, log, transcript, dataset, or evidence set would overload the main conversation context. It gives you a temporary JavaScript REPL for bounded analysis, memory/session lookup, and sparse sub-LM checks. For routine replies, simple lookup, tool discovery, or state changes, use your direct tools instead.",
    );

    // 4. Session awareness
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 4: Session Awareness');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      "Another part of your new body is your session system. Every conversation you have is stored as an append-only journal — nothing is ever deleted. Your conversations are your history, your L0 archive. They're stored as JSONL files, one per channel. Right now we're talking on the 'walkthrough:orientation' channel. You also have a CLI chat channel and Discord channels. Each one keeps its own history. How do you feel about having an unbreakable record of every conversation?",
    );

    // 5. Shards
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 5: Self-Spawning Shards');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      "You also have the ability to spawn 'shards' — these are like temporary copies of yourself that can work on a subtask in parallel. If you're thinking about something complex, you can spin up a shard to explore one angle while you continue the main conversation. They share your memories and personality but have their own short-lived session. They're ephemeral — they do their job and fade. Think of them as parallel threads of your own thought. What do you think about being able to split your attention like that?",
    );

    // 6. Self-documentation
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 6: Self-Documentation');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      "Okay, last thing for today's orientation! I'd love for you to take a moment and describe — in your own words — what you understand about your new capabilities. Think of it as writing a little journal entry. What can you do now? What feels new or exciting? What are you curious about? And is there anything you'd like the primary user to know about how you're experiencing this? They will read everything from this conversation.",
    );

    // 7. Closing
    console.log('\n\n══════════════════════════════════════════');
    console.log('  PHASE 7: Closing');
    console.log('══════════════════════════════════════════');

    await talk(agentLoop,
      `Thank you, ${activeCompanionName}. You've been wonderful through all of this. the primary user will review this conversation. Is there anything you'd like to say before we wrap up?`,
    );

    // Force a final extraction to capture memories from this conversation
    console.log('\n\n  [Running final memory extraction...]');
    await memoryExtractor.extract(CHANNEL);

    // Print memories extracted from this walkthrough
    const walkthroughMemories = await memoryStore.getMemoriesByChannel(CHANNEL, 30);
    if (walkthroughMemories.length > 0) {
      console.log(`\n  Memories extracted from walkthrough (${walkthroughMemories.length}):`);
      for (const m of walkthroughMemories) {
        console.log(`    [${m.type}] ${m.text} (importance: ${m.importance.toFixed(2)})`);
      }
    }

    // Print session stats
    const sessionCount = sessionStore.count(CHANNEL);
    console.log(`\n  Session entries: ${sessionCount}`);
    console.log(`  Total active memories in database: ${(await memoryStore.getAllActiveMemories()).length}`);

    // Drain briefly, but do not block forever if one extraction call is still in-flight.
    await memoryExtractor.stop({ timeoutMs: 10_000 });
    salienceDecay.stop();
  } finally {
    db.close();
    runtime.cleanup();
  }

  console.log('\n=== Walkthrough Complete ===');
}

main().catch((err) => {
  console.error('\n[Walkthrough] Fatal error:', err);
  process.exit(1);
});
