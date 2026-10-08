import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPartial } from '@total-typescript/shoehorn';
import { afterEach, describe, expect, vi } from 'vitest';
import { Agent } from '../../../boundary/pi-agent/index.js';
import { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import { SessionManager } from '../../../core/session/manager.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { EventBus } from '../../../shared/event-bus.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { viewerContextIt } from '../../../test-support/viewer-context-it.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { CompletionHandoffRecord } from '../../../shared/contracts/completion-handoff.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { wireShardAndThinkRuntime } from './composition.js';

const SOURCE_CHANNEL = 'api:parent';
const CAPTURED_SESSION = 'session:captured-parent';
const OTHER_SESSION = 'session:later-parent';
const it = viewerContextIt({
  channelId: SOURCE_CHANNEL,
  sessionId: CAPTURED_SESSION,
  requestId: 'parent-request',
  turnId: 'parent-turn',
  viewerTrustLevel: 'primary',
  viewerChannelPrivacy: 'private',
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('child completion production composition', () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it.each(['shard', 'subagent'] as const)(
    'delivers a %s result once to its captured session without authoring partner speech',
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'completion-composition-'));
      roots.push(root);
      const config: SubstrateConfig = {
        primaryModel: 'deepseek/deepseek-v3.2', primaryProvider: 'openrouter',
        extractionModel: 'deepseek/deepseek-v3.2', extractionProvider: 'openrouter',
        discordToken: '', discordBotId: '', characterCardPath: '',
        dataDir: root, databasePath: ':memory:',
        sessionMessageLimit: 30, memoryRetrievalLimit: 15, extractionInterval: 5,
        primaryMaxTokens: 16_384, extractionMaxTokens: 8_192,
        maintenanceIntervalMs: 300_000, defaultContextWindow: 128_000,
        extractionThresholdPct: 30, compactionThresholdPct: 70,
        companionId: createCompanionId('11111111-1111-4111-8111-111111111111'),
        characterName: 'Test Companion',
        modelRoster: {
          chat: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 16_384, contextWindow: 128_000 },
        },
        modelRegistry: {
          schemaVersion: 1,
          models: [{
            id: 'test-model', rank: 10,
            identity: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2', source: { type: 'openrouter' } },
            purposes: [{ purpose: 'chat', primary: true }, { purpose: 'background', primary: true }],
            capabilities: { maxOutputTokens: 16_384, contextWindow: 128_000 },
            tuning: { maxOutputTokens: 16_384 },
          }],
        },
      };
      const llmProvider: LLMProviderPort = {
        stream: vi.fn(async () => { throw new Error('Unexpected provider stream'); }),
        complete: vi.fn(async () => { throw new Error('Unexpected provider completion'); }),
      };
      const eventBus = new EventBus();
      const sessionStore = new SessionStore(root);
      const sessionManager = new SessionManager(sessionStore, config, eventBus);
      sessionManager.setActiveContextSession(CAPTURED_SESSION);
      const parent = new SubstrateAgent(eventBus, llmProvider, sessionManager, 'test parent', config, {
        backgroundWorkDisabled: true,
      });
      const sent = vi.fn();
      eventBus.on('message.sent', sent);
      const handoffs: Array<{ handoff: CompletionHandoffRecord; noticeBuffered: boolean }> = [];
      eventBus.on('agent.completion_handoff', event => { handoffs.push(event); });
      const entered = deferred();
      const release = deferred();
      // Only the external worker generation is controlled. Composition, worker
      // lifecycle, notice delivery, dedupe, and parent storage remain real.
      vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
        entered.resolve();
        await release.promise;
        this.state.messages.push({
          role: 'assistant', content: [{ type: 'text', text: 'The bounded research result is ready.' }],
          api: 'test', provider: 'test', model: 'test-model',
          usage: {
            input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop', timestamp: Date.now(),
        });
      });
      const shards = wireShardAndThinkRuntime({
        agentLoop: parent, eventBus, llmProvider, sessionStore, sessionManager, config,
        embeddingService: fromPartial({}),
        memoryStore: fromPartial({ getStats: () => ({ total: 0, avgSalience: 0, byType: {} }) }),
        companionDataDir: root, parentSystemPrompt: 'test parent',
        snapshotParentCapabilityGrant: () => ({
          tier: 'custom', customTokens: ['shard.spawn'], grantedTokens: ['shard.spawn'],
        }),
        shardParentIcpDelivery: null,
      });

      try {
        let completion: Promise<unknown>;
        let replay: (() => Promise<unknown>) | undefined;
        if (kind === 'shard') {
          completion = shards.spawn({
            name: 'bounded research', task: 'Inspect the supplied example.', maxTurns: 1,
            sourceContext: {
              channelId: SOURCE_CHANNEL, logicalSessionId: CAPTURED_SESSION,
              requestId: 'parent-request', turnId: 'parent-turn',
            },
          });
        } else {
          const tool = parent.getToolCatalog().core.find(candidate => candidate.name === 'subagent');
          if (!tool) throw new Error('Composition did not register the subagent tool');
          const spawned = await tool.execute('spawn-child', {
            action: 'spawn', name: 'bounded research', task: 'Inspect the supplied example.', max_turns: 1,
          });
          expect(spawned.details?.isError).not.toBe(true);
          const text = spawned.content.find(block => block.type === 'text');
          if (text?.type !== 'text') throw new Error('Subagent spawn returned no result');
          const payload = JSON.parse(text.text) as { subagent_id: string };
          replay = () => tool.execute('wait-child', { action: 'wait', subagent_id: payload.subagent_id });
          completion = replay();
        }
        await Promise.race([
          entered.promise,
          completion.then(result => { throw new Error(`Child stopped before generation: ${JSON.stringify(result)}`); }),
        ]);
        sessionManager.setActiveContextSession(OTHER_SESSION);
        release.resolve();
        await completion;
        if (replay) await replay();

        const terminal = handoffs.filter(event => event.handoff.status === 'completed');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
          noticeBuffered: true,
          handoff: { source: kind, origin: { logicalSessionId: CAPTURED_SESSION } },
        });
        expect(parent.completionNotices.drain(CAPTURED_SESSION)).toMatchObject([{
          source: kind, status: 'completed', summary: 'The bounded research result is ready.',
        }]);
        expect(parent.completionNotices.drain(CAPTURED_SESSION)).toEqual([]);
        expect(parent.completionNotices.peek(OTHER_SESSION)).toEqual([]);
        expect(parent.completionNotices.peek(SOURCE_CHANNEL)).toEqual([]);
        for (const session of [CAPTURED_SESSION, OTHER_SESSION, SOURCE_CHANNEL]) {
          expect(sessionStore.getRecent(session, 10)).toEqual([]);
        }
        expect(sent).not.toHaveBeenCalled();
        expect(llmProvider.stream).not.toHaveBeenCalled();
        expect(llmProvider.complete).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
    },
  );
});
