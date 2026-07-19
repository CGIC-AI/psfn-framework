import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent, type AgentTool } from '../../../boundary/pi-agent/index.js';
import { resolveInstalledAgentTurnTools } from '../../../boundary/pi-agent/agent-loop-patch.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { SessionManager } from '../../../core/session/manager.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import { EventBus } from '../../../shared/event-bus.js';
import type {
  AgentResponse,
  LLMResponse,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { CapabilityGrantSnapshot } from '../../../system/capabilities/access.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createPolicyGovernedShardParentIcpDelivery } from '../../../channels/backplane/shard-parent-icp-ingress.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import { SHARD_PARENT_ICP_TOOL_NAME } from '../../../faculties/shards/parent-icp-tool.js';
import { wireShardAndThinkRuntime, type ToolRuntimeOptions } from './composition.js';

const PARENT_COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');
const TEST_CONFIG: SubstrateConfig = {
  primaryModel: 'test-model',
  primaryProvider: 'test',
  extractionModel: 'test-model',
  extractionProvider: 'test',
  discordToken: '',
  discordBotId: '',
  characterCardPath: '',
  dataDir: './data',
  databasePath: ':memory:',
  sessionMessageLimit: 30,
  memoryRetrievalLimit: 15,
  extractionInterval: 5,
  primaryMaxTokens: 16_384,
  extractionMaxTokens: 8_192,
  maintenanceIntervalMs: 300_000,
  defaultContextWindow: 128_000,
  extractionThresholdPct: 30,
  compactionThresholdPct: 70,
  companionId: PARENT_COMPANION_ID,
  characterName: 'Companion',
  modelRoster: {
    chat: {
      model: 'test-model',
      provider: 'test',
      maxTokens: 16_384,
      contextWindow: 128_000,
    },
  },
};
const CAPABILITY_SNAPSHOT: CapabilityGrantSnapshot = Object.freeze({
  tier: 'custom',
  customTokens: Object.freeze(['shard.spawn']),
  grantedTokens: Object.freeze(['shard.spawn']),
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function llmResponse(content: string): LLMResponse {
  return {
    content,
    toolCalls: [],
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    stopReason: 'stop',
  };
}

class ParentAgentProbe {
  readonly completionNotices = null;
  readonly memoryProvider = null;
  readonly tools: AgentTool<unknown>[] = [];
  readonly received: SubstrateMessage[] = [];

  registerTool(tool: AgentTool<unknown>): void {
    this.tools.push(tool);
  }

  getToolCatalog(): { core: readonly AgentTool<unknown>[]; extended: readonly AgentTool<unknown>[] } {
    return { core: this.tools, extended: [] };
  }

  async handleMessage(message: SubstrateMessage): Promise<AgentResponse> {
    this.received.push(message);
    return {
      content: 'Parent processed shard message.',
      channelId: message.channelId,
      metadata: {
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      },
    };
  }

  async waitForIdle(): Promise<void> {}
}

describe('shard-parent ICP production composition', () => {
  let root: string;
  let sessionStore: SessionStore;
  let sessionManager: SessionManager;
  let eventBus: EventBus;
  let parentAgent: ParentAgentProbe;
  let llmProvider: LLMProviderPort;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'inner-worker-parent-composition-'));
    sessionStore = new SessionStore(root);
    eventBus = new EventBus();
    sessionManager = new SessionManager(
      sessionStore,
      { ...TEST_CONFIG, dataDir: root },
      eventBus,
    );
    parentAgent = new ParentAgentProbe();
    llmProvider = {
      stream: vi.fn(async () => llmResponse('unused')),
      complete: vi.fn(async () => llmResponse('unused')),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseOptions(): ToolRuntimeOptions {
    return {
      agentLoop: parentAgent as never,
      eventBus,
      llmProvider,
      sessionStore,
      embeddingService: null as never,
      memoryStore: {
        getStats: () => ({ total: 0, avgSalience: 0, byType: {} }),
      } as never,
      sessionManager,
      config: { ...TEST_CONFIG, dataDir: root },
      companionDataDir: root,
      parentSystemPrompt: 'test parent',
      snapshotParentCapabilityGrant: () => CAPABILITY_SNAPSHOT,
      shardParentIcpDelivery: null,
    };
  }

  it('requires the shard-parent ingress dependency to be explicit at composition', () => {
    const incompleteOptions = baseOptions();
    Reflect.deleteProperty(incompleteOptions, 'shardParentIcpDelivery');
    expect(() => wireShardAndThinkRuntime(incompleteOptions))
      .toThrow(/requires an explicit policy-governed ordinary ICP delivery port/u);

    const undefinedOptions = baseOptions();
    Object.defineProperty(undefinedOptions, 'shardParentIcpDelivery', {
      configurable: true,
      enumerable: true,
      value: undefined,
    });
    expect(() => wireShardAndThinkRuntime(undefinedOptions))
      .toThrow(/requires an explicit policy-governed ordinary ICP delivery port/u);
  });

  it('delivers a live shard message through governed intake with exact lineage', async () => {
    const releaseShard = deferred();
    const sentByLiveShard: string[] = [];
    const parentReplies: string[] = [];
    const prompt = vi.spyOn(Agent.prototype, 'prompt').mockImplementation(async function (this: Agent) {
      const parentIcpTool = resolveInstalledAgentTurnTools(this)
        .find(tool => tool.name === SHARD_PARENT_ICP_TOOL_NAME);
      if (!parentIcpTool) {
        throw new Error('Live shard did not receive its ordinary parent ICP tool');
      }
      sentByLiveShard.push('Status: Bearer private-token');
      const result = await parentIcpTool.execute(
        'live-shard-parent-icp-call',
        { content: 'Status: Bearer private-token' },
      );
      parentReplies.push((result.content[0] as { text: string }).text);
      await releaseShard.promise;
      this.state.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: 'bounded shard result' }],
        api: 'test',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0,
          },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });
    });
    const snapshot = {
      envelopeId: 'screened-shard-output',
      sourceClass: 'subagent_output',
      sourceRiskTier: 'untrusted',
      state: 'released_sanitized',
      riskLabels: ['secrets/credential_material'],
      subject: { kind: 'body' },
    };
    const screen = vi.fn(async (text: string) => ({
      effectiveText: text.includes('Bearer')
        ? 'Status: [REDACTED:credential]'
        : text,
      snapshot,
    }));
    const delivery = createPolicyGovernedShardParentIcpDelivery({
      parentCompanionId: PARENT_COMPANION_ID,
      intakeScreening: { screen } as never,
      agentLoop: parentAgent,
      idFactory: () => 'shard-parent-production-message',
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    const shardPort = wireShardAndThinkRuntime({
      ...baseOptions(),
      shardParentIcpDelivery: delivery,
    });

    try {
      const pendingShard = shardPort.spawn({
        name: 'bounded research',
        task: 'Wait while parent ingress is tested',
        maxTurns: 1,
      });
      await vi.waitFor(() => {
        expect(shardPort.getActiveCount()).toBe(1);
      });
      const [liveShard] = shardPort.getActiveShards();
      expect(liveShard).toBeDefined();

      await vi.waitFor(() => {
        expect(sentByLiveShard).toEqual(['Status: Bearer private-token']);
        expect(screen).toHaveBeenCalledTimes(2);
        expect(parentAgent.received).toHaveLength(1);
        expect(parentReplies).toEqual(['Parent reply: Parent processed shard message.']);
      });
      expect(parentAgent.received[0]).toMatchObject({
        id: 'shard-parent-production-message',
        channelType: 'companion',
        authorId: `shard:${liveShard!.id}`,
        content: 'Status: [REDACTED:credential]',
        routing: {
          source: 'companion',
          authorIsMachineIntelligence: true,
          shardParentIcp: {
            schemaVersion: 1,
            routingCompanionId: PARENT_COMPANION_ID,
            lineage: {
              parentCompanionId: PARENT_COMPANION_ID,
              shardId: liveShard!.id,
            },
            direction: 'shard_to_parent',
          },
          intakeEnvelopes: [snapshot],
        },
      });
      await expect(shardPort.shardParentIcp.sendShardParentIcp(
        'foreign-shard',
        'must deny',
      )).rejects.toThrow(/unavailable or foreign/u);

      releaseShard.resolve();
      await pendingShard;
    } finally {
      releaseShard.resolve();
      prompt.mockRestore();
    }
  });
});
