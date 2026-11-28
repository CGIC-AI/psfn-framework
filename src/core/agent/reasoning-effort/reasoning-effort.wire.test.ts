import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import type { CorrelationMetadata } from '../../../shared/contracts/runtime.js';
import {
  sanitizeCoreSubstrateConfig,
  type SubstrateConfig,
} from '../../../system/config/runtime-config-contracts.js';
import { LLMClient } from '../../../primitives/llm/client.js';
import { PiProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import {
  captureWire,
  makeReasoningWireConfig,
  reasoningWireRegistry,
} from '../../../test-support/reasoning-wire.js';
import { buildLLMWorkSpec, completeWithWorkSpec } from '../../../primitives/llm/work-spec.js';
import { resolveRoutingCandidates } from '../../../primitives/llm/routing.js';
import { resolveCandidates as resolveHintedCandidates } from '../../../primitives/llm/model-hint-routing.js';
import { EventBus } from '../../../shared/event-bus.js';
import { AdminSubsystemHealthDataService } from '../../../operator/garden/services/subsystem-health-service.js';
import { createSelfStatusTool } from '../../tools/self-status.js';
import { createSubstrateStreamFn, resolveModel } from '../stream-adapter.js';
import { withLaneReasoningEffort } from './provider.js';
import { ReasoningEffortRuntime, type ReasoningEffortChange } from './runtime.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const registry = reasoningWireRegistry;

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  const config = makeReasoningWireConfig(overrides);
  tempDirs.push(config.dataDir);
  return config;
}

function agentTurnContext(channelId: string, extra: Partial<CorrelationMetadata> = {}): Partial<CorrelationMetadata> {
  return {
    callType: channelId.startsWith('internal:') ? 'scheduled' : 'chat',
    purpose: 'agent.turn.prompt',
    channelId,
    turnId: 'turn-1',
    requestId: 'request-1',
    ...extra,
  };
}

interface Harness {
  config: SubstrateConfig;
  bodies: Array<Record<string, unknown>>;
  logged: Array<{ message: string; fields?: Record<string, unknown> }>;
  changes: ReasoningEffortChange[];
  /** One agent-turn model call (the real stream adapter over the real LLMClient). */
  turnCall(context: Partial<CorrelationMetadata>, purpose?: 'chat' | 'memory'): Promise<Record<string, unknown>>;
  /** The real self_status tool, executed inside the turn's request context. */
  tool(context: Partial<CorrelationMetadata>, params: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  /** A direct own-time completion (the chooser / deliberation path) with a work-spec output cap. */
  directCall(context: Partial<CorrelationMetadata>, maxOutputTokens: number): Promise<Record<string, unknown>>;
}

function harness(config: SubstrateConfig): Harness {
  const bodies = captureWire();
  const logged: Harness['logged'] = [];
  const changes: ReasoningEffortChange[] = [];
  const runtime = new PiProviderRuntime(undefined, config);
  // Autonomous work-spec calls must be accountable; record usage in memory.
  const client = new LLMClient(config, { runtime, usageRecorder: { recordUsageEvent: async () => undefined } });
  const reasoning = new ReasoningEffortRuntime({
    getSettings: () => config.reasoningEffort,
    catalogue: runtime,
    resolvePurposeCandidate: (purpose) => resolveRoutingCandidates(config, purpose)[0],
    logger: { info: (message, fields) => logged.push({ message, ...(fields ? { fields } : {}) }) },
    onChange: change => changes.push(change),
  });
  // The agent process holds the credential-free core config, as in production.
  const coreConfig = sanitizeCoreSubstrateConfig(config);
  const streamFn = createSubstrateStreamFn(coreConfig, {
    reasoningEffort: reasoning,
    transport: { stream: client.stream.bind(client) },
  });
  const selfStatus = createSelfStatusTool({ config, reasoning });
  const lastBody = (): Record<string, unknown> => bodies.at(-1)!;
  return {
    config,
    bodies,
    logged,
    changes,
    async turnCall(context, purpose = 'chat') {
      const llmContext: Context = {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'hello', timestamp: 0 }],
      };
      await runWithRequestContext(context, async () => {
        const stream = await streamFn(resolveModel(coreConfig, runtime, purpose), llmContext, {});
        for await (const _event of stream as AsyncIterable<unknown>) {
          // drain
        }
      });
      return lastBody();
    },
    async tool(context, params) {
      const result = await runWithRequestContext(context, async () => selfStatus.execute('call-1', params as never));
      const first = (result.content as Array<{ type: string; text?: string }>)[0];
      return { text: first?.text ?? '', isError: (result.details as { isError?: boolean } | undefined)?.isError === true };
    },
    async directCall(context, maxOutputTokens) {
      const provider = withLaneReasoningEffort(client, reasoning);
      await completeWithWorkSpec(
        provider,
        { systemPrompt: 'System', messages: [{ role: 'user', content: 'choose' }] },
        buildLLMWorkSpec({ purpose: 'background', durable: false, maxOutputTokens, correlation: context }),
      );
      return lastBody();
    },
  };
}

const FREE_TIME = agentTurnContext('internal:free-time:idle', {
  requesterProvenance: 'self_directed',
  requestAudience: 'self',
  sessionId: 'free-time-session',
});
const REFLECTION = agentTurnContext('internal:reflection:daily-review', {
  requesterProvenance: 'self_directed',
  requestAudience: 'self',
  sessionId: 'reflection-session',
});
const CHAT = agentTurnContext('discord-channel-1', { requesterProvenance: 'human', sessionId: 'chat-session' });

function wire(body: Record<string, unknown>): { model: unknown; reasoning: unknown; max_tokens: unknown } {
  return { model: body.model, reasoning: body.reasoning, max_tokens: body.max_tokens };
}

describe('reasoning effort on the provider wire', () => {
  // On origin/main every lane sent no reasoning parameter at all (provider
  // default): the routed OpenRouter slot declared no supportsReasoning, so the
  // endpoint model had reasoning=false and pi-ai dropped any effort.
  it('main chat sends low and keeps its full slot budget', async () => {
    const h = harness(makeConfig());
    expect(wire(await h.turnCall(CHAT))).toEqual({
      model: 'z-ai/glm-5',
      reasoning: { effort: 'low' },
      max_tokens: 16384,
    });
  });

  it('free time sends medium', async () => {
    const h = harness(makeConfig());
    expect(wire(await h.turnCall(FREE_TIME))).toEqual({
      model: 'z-ai/glm-5',
      reasoning: { effort: 'medium' },
      max_tokens: 16384,
    });
  });

  it('a reflection turn on the memory slot sends medium', async () => {
    const h = harness(makeConfig());
    expect(wire(await h.turnCall(REFLECTION, 'memory'))).toMatchObject({
      model: 'deepseek/deepseek-v3.2',
      reasoning: { effort: 'medium' },
    });
  });

  it('leaves internal machinery off-lane exactly as routed', async () => {
    const h = harness(makeConfig());
    expect(wire(await h.turnCall(agentTurnContext('internal:cogsec-review')))).toEqual({
      model: 'z-ai/glm-5',
      reasoning: undefined,
      max_tokens: 16384,
    });
  });

  it('follows the owner setting, and never lowers a higher slot tuning', async () => {
    const owner = harness(makeConfig({
      reasoningEffort: { chat: 'minimal', freeTime: 'high', reflection: 'medium', selfDirected: 'medium' },
    }));
    expect((await owner.turnCall(CHAT)).reasoning).toEqual({ effort: 'minimal' });
    expect((await owner.turnCall(FREE_TIME)).reasoning).toEqual({ effort: 'high' });

    const tuned = harness(makeConfig({ modelRegistry: registry({ tuning: { thinkingEffort: 'high' } }) }));
    expect((await tuned.turnCall(CHAT)).reasoning).toEqual({ effort: 'high' });

    // A slot that only enables thinking is sent medium on main; chat's low floor keeps it.
    const enabled = harness(makeConfig({ modelRegistry: registry({ tuning: { thinkingEnabled: true } }) }));
    expect((await enabled.turnCall(CHAT)).reasoning).toEqual({ effort: 'medium' });
  });

  it('bounds a lane level to what the model supports, logged once', async () => {
    const h = harness(makeConfig({
      reasoningEffort: { chat: 'low', freeTime: 'xhigh', reflection: 'medium', selfDirected: 'medium' },
    }));
    expect((await h.turnCall(FREE_TIME)).reasoning).toEqual({ effort: 'high' });
    expect((await h.turnCall(FREE_TIME)).reasoning).toEqual({ effort: 'high' });
    expect(h.logged.filter(entry => entry.message.includes('bounded'))).toHaveLength(1);
  });

  it('a model that cannot reason gets no effort, logged once', async () => {
    const h = harness(makeConfig({ modelRegistry: registry({ model: 'openai/gpt-4o-mini' }), primaryModel: 'openai/gpt-4o-mini' }));
    expect(wire(await h.turnCall(CHAT))).toMatchObject({ model: 'openai/gpt-4o-mini', reasoning: undefined });
    expect(wire(await h.turnCall(FREE_TIME))).toMatchObject({ model: 'openai/gpt-4o-mini', reasoning: undefined });
    const ignored = h.logged.filter(entry => entry.message.includes('cannot reason'));
    expect(ignored).toHaveLength(2); // once per requested level (chat low, free time medium)
    await h.turnCall(CHAT);
    expect(h.logged.filter(entry => entry.message.includes('cannot reason'))).toHaveLength(2);

    const refused = await h.tool(FREE_TIME, { action: 'reasoning_set', level: 'high', scope: 'session' });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain('cannot reason');
  });

  it('a direct own-time call carries the lane effort and is not starved by its answer-sized cap', async () => {
    const h = harness(makeConfig());
    expect(wire(await h.directCall(FREE_TIME, 1024))).toEqual({
      model: 'deepseek/deepseek-v3.2',
      reasoning: { effort: 'medium' },
      max_tokens: 8192,
    });
    // Off-lane, the same call keeps the provider default and its cap.
    expect(wire(await h.directCall(agentTurnContext('internal:scheduler'), 1024))).toEqual({
      model: 'deepseek/deepseek-v3.2',
      reasoning: undefined,
      max_tokens: 1024,
    });
  });
});

describe('an effort-only model hint keeps the routed chain', () => {
  it('leads with the purpose primary, keeps its slot key, and keeps the fallbacks', () => {
    const base = registry();
    const config = makeConfig({
      modelRegistry: {
        ...base,
        models: [
          ...base.models,
          {
            id: 'background-fallback',
            rank: 60,
            identity: { provider: 'openrouter', model: 'z-ai/glm-5', source: { type: 'openrouter' as const } },
            purposes: [{ purpose: 'background' as const, primary: false }],
            capabilities: { maxOutputTokens: 8192, contextWindow: 128000 },
            tuning: { maxOutputTokens: 8192 },
          },
        ],
      },
    });
    const routed = resolveRoutingCandidates(config, 'background');
    const hinted = resolveHintedCandidates(config, 'background', { thinkingEffort: 'medium' });
    const view = (candidate: { slotKey?: string; model: string; thinkingEffort?: string }) =>
      [candidate.slotKey, candidate.model, candidate.thinkingEffort ?? null];
    expect(routed.length).toBeGreaterThan(1);
    // The hinted primary leads; the whole routed chain (the un-hinted primary
    // included, as for any knob-only hint) follows as transient fallbacks.
    expect(hinted.map(view)).toEqual([
      ['extraction', 'deepseek/deepseek-v3.2', 'medium'],
      ...routed.map(view),
    ]);
  });
});

describe('Garden sees the companion\'s choices', () => {
  it('records a reasoning_set made through the tool in the reasoning_effort lane', async () => {
    const config = makeConfig();
    captureWire();
    const bus = new EventBus();
    const garden = new AdminSubsystemHealthDataService({ eventBus: bus });
    const runtime = new PiProviderRuntime(undefined, config);
    const reasoning = new ReasoningEffortRuntime({
      getSettings: () => config.reasoningEffort,
      catalogue: runtime,
      resolvePurposeCandidate: (purpose) => resolveRoutingCandidates(config, purpose)[0],
      logger: { info: () => undefined },
      onChange: (change) => { void bus.emit('agent.reasoning_effort.changed', change); },
    });
    const selfStatus = createSelfStatusTool({ config, reasoning });
    await runWithRequestContext(FREE_TIME, async () => selfStatus.execute('call-1', {
      action: 'reasoning_set', level: 'high', scope: 'session',
    } as never));

    const lane = (await garden.getSnapshot()).lanes.find(candidate => candidate.id === 'reasoning_effort');
    expect(lane).toMatchObject({
      observedEventCount: 1,
      lastOutcome: 'ran',
      lastReason: 'freeTime:session:baseline->high',
      counts: { supportedLevels: 4 },
    });
  });
});

describe('self_status reasoning_* (the companion chooses its own level)', () => {
  it('reads the lane, the level and the bound model\'s levels', async () => {
    const h = harness(makeConfig());
    await h.turnCall(FREE_TIME);
    const read = await h.tool(FREE_TIME, { action: 'reasoning_read' });
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.text)).toMatchObject({
      action: 'reasoning_read',
      model: 'openrouter/z-ai/glm-5',
      canReason: true,
      supportedLevels: ['minimal', 'low', 'medium', 'high'],
      lane: 'freeTime',
      level: 'medium',
      source: 'lane_setting',
    });
  });

  it('a turn choice changes the very next request and ends with the turn', async () => {
    const h = harness(makeConfig());
    await h.turnCall(FREE_TIME);
    const set = await h.tool(FREE_TIME, { action: 'reasoning_set', level: 'high', scope: 'turn' });
    expect(set.isError).toBe(false);
    expect((await h.turnCall(FREE_TIME)).reasoning).toEqual({ effort: 'high' });
    expect((await h.turnCall({ ...FREE_TIME, turnId: 'turn-2' })).reasoning).toEqual({ effort: 'medium' });
    expect(h.changes).toEqual([expect.objectContaining({
      lane: 'freeTime',
      scope: 'turn',
      level: 'high',
      previousLevel: null,
      model: 'z-ai/glm-5',
    })]);
  });

  it('a session choice lasts across turns of that session only; a lane choice spans the lane', async () => {
    const h = harness(makeConfig());
    await h.turnCall(CHAT);
    await h.tool(CHAT, { action: 'reasoning_set', level: 'high', scope: 'session' });
    expect((await h.turnCall({ ...CHAT, turnId: 'turn-2' })).reasoning).toEqual({ effort: 'high' });
    expect((await h.turnCall({ ...CHAT, sessionId: 'other-chat', channelId: 'discord-channel-2' })).reasoning)
      .toEqual({ effort: 'low' });

    await h.tool(REFLECTION, { action: 'reasoning_set', level: 'minimal', scope: 'lane' });
    expect((await h.turnCall({ ...REFLECTION, channelId: 'internal:reflection:weekly-review', sessionId: 'weekly' }, 'memory')).reasoning)
      .toEqual({ effort: 'minimal' });

    const cleared = await h.tool(REFLECTION, { action: 'reasoning_clear', scope: 'lane' });
    expect(JSON.parse(cleared.text)).toMatchObject({ cleared: true });
    expect((await h.turnCall(REFLECTION, 'memory')).reasoning).toEqual({ effort: 'medium' });
  });

  it('refuses a level the bound model does not take, naming the levels it does', async () => {
    const h = harness(makeConfig());
    await h.turnCall(FREE_TIME);
    const refused = await h.tool(FREE_TIME, { action: 'reasoning_set', level: 'xhigh', scope: 'turn' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('minimal, low, medium, high');
    expect((await h.turnCall(FREE_TIME)).reasoning).toEqual({ effort: 'medium' });
  });

  it('rejects malformed parameters', async () => {
    const h = harness(makeConfig());
    expect(await h.tool(FREE_TIME, { action: 'reasoning_set', level: 'high', scope: 'forever' }))
      .toMatchObject({ isError: true });
    expect(await h.tool(FREE_TIME, { action: 'reasoning_set', level: 'loud', scope: 'turn' }))
      .toMatchObject({ isError: true });
  });
});
