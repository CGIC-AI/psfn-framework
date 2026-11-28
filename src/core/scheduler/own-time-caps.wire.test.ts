import { readFileSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLMClient } from '../../primitives/llm/client.js';
import { runDeliberation } from '../../primitives/llm/deliberation.js';
import { PiProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { resolveRoutingCandidates } from '../../primitives/llm/routing.js';
import { EventBus } from '../../shared/event-bus.js';
import { resolveReflectionMetacognitionJournalPath, resolveReflectionPolicyPath } from '../../persistence/layout.js';
import { captureWire, makeReasoningWireConfig, reasoningWireRegistry } from '../../test-support/reasoning-wire.js';
import { createEnvCredentialVault, envCredential } from '../../boundary/custody/credential-vault.js';
import { withLaneReasoningEffort } from '../agent/reasoning-effort/provider.js';
import { ReasoningEffortRuntime } from '../agent/reasoning-effort/runtime.js';
import { ReflectionPolicyStore } from './reflection-policy.js';
import {
  experientialDeliberationShape,
  runExperientialTemplateDeliberation,
} from './reflection-template-runtime/experiential-deliberation.js';
import { resolveOwnTimeDeliberationCaps } from './reflection-template-runtime/own-time-deliberation-caps.js';
import { createReflectionTemplateRuntime } from './reflection-template-runtime.js';
import { Scheduler } from './scheduler.js';
import {
  createDefaultFreeTimeChooserSettings,
  type FreeTimeChooserSettings,
} from '../../system/config/free-time-chooser-config.js';
import { InMemoryRestSilenceStore } from '../../test-support/in-memory-rest-silence-store.js';
import { FreeTimeChooser } from './free-time-chooser.js';
import { FreeTimeWorkspaceResolver } from './free-time-workspace-resolver.js';
import { DurableRestWindowPolicy } from './rest-window-policy.js';

// Real component loggers, with their INFO lines recorded for the assertions.
const infoLines = vi.hoisted(() => [] as Array<{ component: string; message: string; meta?: Record<string, unknown> }>);
vi.mock('../../shared/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/logger.js')>();
  return {
    ...actual,
    createComponentLogger: (component: string) => {
      const child = actual.createComponentLogger(component);
      return new Proxy(child, {
        get(target, property, receiver) {
          if (property !== 'info') return Reflect.get(target, property, receiver);
          return (message: string, meta?: Record<string, unknown>) => {
            infoLines.push({ component, message, ...(meta ? { meta } : {}) });
            return target.info(message, meta);
          };
        },
      });
    },
  };
});

const TEMPLATE_ID = 'companion-deliberation';
const authoritativeSystemPrompt = '<identity>The companion, thinking on her own time.</identity>';
// A medium-reasoning call: the full system prompt in, reasoning plus a short answer out.
const PROMPT_TOKENS = 6_000;
const COMPLETION_TOKENS = 9_000;
const REASONING_TOKENS = 8_000;

const tempDirs: string[] = [];

const WIRE_CREDENTIALS = {
  openRouterApiKeyRef: envCredential('OPENROUTER_API_KEY'),
  credentialVault: createEnvCredentialVault({ OPENROUTER_API_KEY: 'test-openrouter-key' }),
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  infoLines.length = 0;
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** Distinct words per call keep the deliberation's novelty high, so it runs every round. */
function reply(index: number): { content: string; promptTokens: number; completionTokens: number; reasoningTokens: number } {
  const words = Array.from({ length: 12 }, (_, word) => `angle${index}x${word}`).join(' ');
  return {
    content: `Thought ${index}: ${words}.`,
    promptTokens: PROMPT_TOKENS,
    completionTokens: COMPLETION_TOKENS,
    reasoningTokens: REASONING_TOKENS,
  };
}

/**
 * The real LLMClient over a stubbed network, wrapped in the reflection lane's
 * reasoning effort exactly as composition wires it. Each provider call takes
 * `callMs` of (fake) wall time.
 */
function harness(callMs: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const bodies = captureWire({
    reply,
    onRequest: () => vi.setSystemTime(Date.now() + callMs),
  });
  // The aggregator and the analytical voice run on the reasoning purpose.
  const registry = reasoningWireRegistry();
  const config = makeReasoningWireConfig(WIRE_CREDENTIALS, {
    modelRegistry: {
      ...registry,
      models: registry.models.map(model => (model.id === 'primary'
        ? { ...model, purposes: [...model.purposes, { purpose: 'reasoning' as const, primary: true }] }
        : model)),
    },
  });
  tempDirs.push(config.dataDir);
  const runtime = new PiProviderRuntime(undefined, config);
  const client = new LLMClient(config, { runtime, usageRecorder: { recordUsageEvent: async () => undefined } });
  const reasoningEffort = new ReasoningEffortRuntime({
    getSettings: () => config.reasoningEffort,
    catalogue: runtime,
    resolvePurposeCandidate: (purpose) => resolveRoutingCandidates(config, purpose)[0],
    logger: { info: () => undefined },
  });
  return { bodies, config, client, reasoningEffort };
}

/** A companion deliberation template still carrying the retired 10k-token / 60s caps. */
function storeRetiredCapsTemplate(dataDir: string): void {
  const store = new ReflectionPolicyStore(resolveReflectionPolicyPath(dataDir));
  const policy = store.load();
  policy.templates.push({
    id: TEMPLATE_ID,
    name: 'Companion Deliberation',
    prompt: 'Sit with one open question from today and see where it leads.',
    intervalMs: 24 * 60 * 60_000,
    enabled: true,
    mode: 'deliberation',
    deliberation: { maxRounds: 3, maxTotalTokens: 10_000, maxWallTimeMs: 60_000, voices: ['background', 'reasoning'] },
  });
  store.save(policy);
}

async function runReflection(h: ReturnType<typeof harness>): Promise<void> {
  const runtime = createReflectionTemplateRuntime({
    scheduler: new Scheduler(new EventBus(), { tickIntervalMs: 100, heartbeatIntervalMs: 1_000 }),
    agentLoop: {
      handleMessage: vi.fn(async () => ({ content: 'unused' })),
      getCurrentAuthoritativeSystemPrompt: () => authoritativeSystemPrompt,
    },
    dataDir: h.config.dataDir,
    runtimeOptions: { llmProvider: h.client, reasoningEffort: h.reasoningEffort },
  });
  await runtime.runTemplateNow(TEMPLATE_ID, { deferIfBusy: false });
}

interface JournaledDeliberation {
  rounds: number;
  totalTokens: number;
  episode: {
    budget: { maxRounds: number; maxTotalTokens: number; maxWallTimeMs: number };
    exit: { reason: string; maxTotalTokensReached: boolean; maxWallTimeReached: boolean };
  };
}

function journaledDeliberation(dataDir: string): JournaledDeliberation {
  const lines = readFileSync(resolveReflectionMetacognitionJournalPath(dataDir), 'utf-8').trim().split('\n');
  const entry = JSON.parse(lines.at(-1) ?? '{}') as { deliberation?: JournaledDeliberation };
  if (!entry.deliberation) throw new Error('no deliberation journaled');
  return entry.deliberation;
}

const CALL_MS = 40_000;
const CALLS = 3 * (2 + 1); // three rounds of two voices and the aggregator

describe('reflection deliberation at medium reasoning (psfn-framework-cdqin)', () => {
  it('the retired caps cut a medium-reasoning deliberation after its first voice', async () => {
    const h = harness(CALL_MS);
    const result = await runDeliberation(
      withLaneReasoningEffort(h.client, h.reasoningEffort),
      'Sit with one open question from today and see where it leads.',
      {
        authoritativeSystemPrompt,
        voices: ['background', 'reasoning'],
        correlation: { channelId: `internal:reflection:${TEMPLATE_ID}` },
        caps: { maxRounds: 3, maxTotalTokens: 10_000, maxWallTimeMs: 60_000 },
      },
    );
    expect(h.bodies).toHaveLength(1);
    expect(h.bodies[0]?.reasoning).toEqual({ effort: 'medium' });
    expect(result.stopReason).toBe('token_cap');
    expect(result.rounds[0]?.voices).toHaveLength(1);
    expect(result.rounds[0]?.aggregatorModel).toBeUndefined();
  });

  it('completes every voice and the aggregator of every round under the own-time caps', async () => {
    const h = harness(CALL_MS);
    storeRetiredCapsTemplate(h.config.dataDir);
    await runReflection(h);

    expect(h.bodies).toHaveLength(CALLS);
    for (const body of h.bodies) {
      expect(body.reasoning).toEqual({ effort: 'medium' });
      // Every call keeps its routed slot budget for reasoning plus the answer.
      expect(body.max_tokens).toBeGreaterThanOrEqual(8192);
    }
    const deliberation = journaledDeliberation(h.config.dataDir);
    expect(deliberation.rounds).toBe(3);
    expect(deliberation.totalTokens).toBe(CALLS * (PROMPT_TOKENS + COMPLETION_TOKENS));
    expect(deliberation.episode.exit).toMatchObject({
      reason: 'max_rounds',
      maxTotalTokensReached: false,
      maxWallTimeReached: false,
    });
    // Sized from the routed per-call budgets, not the template's 10k.
    expect(deliberation.episode.budget.maxTotalTokens).toBeGreaterThan(CALLS * (PROMPT_TOKENS + 8192));
    expect(deliberation.episode.budget.maxWallTimeMs).toBe(900_000);

    const reflectionInfo = infoLines.filter(line => line.component === 'ReflectionTemplates');
    expect(reflectionInfo.filter(line => line.message.includes('raised to the own-time reasoning floor'))
      .map(line => [line.meta?.setting, line.meta?.configured]))
      .toEqual([['maxTotalTokens', 10_000], ['maxWallTimeMs', 60_000]]);
    expect(reflectionInfo.some(line => line.message.includes('stopped by a cap'))).toBe(false);
  });

  it('a cap that still stops the run is logged at INFO with which cap', async () => {
    // Calls far slower than any medium-reasoning call: the wall-time fuse holds.
    const h = harness(400_000);
    storeRetiredCapsTemplate(h.config.dataDir);
    await runReflection(h);

    expect(h.bodies).toHaveLength(3); // the first round completes, then the fuse stops the run
    expect(journaledDeliberation(h.config.dataDir).episode.exit).toMatchObject({
      reason: 'time_cap',
      maxWallTimeReached: true,
    });
    const cut = infoLines.find(line => line.component === 'ReflectionTemplates' && line.message.includes('stopped by a cap'));
    expect(cut?.meta).toMatchObject({
      templateId: TEMPLATE_ID,
      setting: 'maxWallTimeMs',
      limit: 900_000,
      used: 1_200_000,
      stopReason: 'time_cap',
      rounds: 1,
    });
  });

  it('the stored weekly review, still at 14k / 90s, runs all three experiential stages', async () => {
    const h = harness(CALL_MS);
    const weekly = new ReflectionPolicyStore(resolveReflectionPolicyPath(h.config.dataDir)).load()
      .templates.find(template => template.id === 'weekly-review');
    if (!weekly) throw new Error('weekly-review missing from defaults');
    const stored = { ...weekly, deliberation: { ...weekly.deliberation, maxTotalTokens: 14_000, maxWallTimeMs: 90_000 } };
    const prompt = 'What actually stands out from this week?';
    const { caps } = resolveOwnTimeDeliberationCaps({
      template: stored,
      shape: experientialDeliberationShape(stored),
      inputTexts: [authoritativeSystemPrompt, prompt],
      completionBudget: purpose => h.reasoningEffort.completionBudget(purpose),
    });
    const { deliberation } = await runExperientialTemplateDeliberation({
      llmProvider: withLaneReasoningEffort(h.client, h.reasoningEffort),
      template: stored,
      prompt,
      authoritativeSystemPrompt,
      correlation: { channelId: 'internal:reflection:weekly-review' },
      logger: { warn: () => undefined },
      caps,
      toDeliberationMetadata: () => ({}) as never,
    });

    expect(h.bodies).toHaveLength(3);
    expect(h.bodies.map(body => body.reasoning)).toEqual(Array(3).fill({ effort: 'medium' }));
    expect(deliberation.rounds.map(round => round.stage)).toEqual(['evidence', 'synthesis', 'contradiction']);
    expect(deliberation.episode.exit).toMatchObject({ maxTotalTokensReached: false, maxWallTimeReached: false });
    expect(caps.maxWallTimeMs).toBe(1_350_000);
  });
});

describe('free-time chooser at medium reasoning (psfn-framework-cdqin)', () => {
  // A medium-reasoning choice: thousands of reasoning tokens before a short JSON answer.
  const REASONING_CHOICE_MS = 90_000;

  function chooserHarness(withReasoningPort: boolean, settings: Partial<FreeTimeChooserSettings> = {}) {
    vi.useFakeTimers();
    const bodies = captureWire({
      latencyMs: REASONING_CHOICE_MS,
      reply: () => ({
        content: '{"optionId":"private_wander"}',
        promptTokens: 4_000,
        completionTokens: 3_000,
        reasoningTokens: 2_900,
      }),
    });
    const config = makeReasoningWireConfig(WIRE_CREDENTIALS);
    tempDirs.push(config.dataDir);
    const runtime = new PiProviderRuntime(undefined, config);
    const client = new LLMClient(config, { runtime, usageRecorder: { recordUsageEvent: async () => undefined } });
    const reasoningEffort = new ReasoningEffortRuntime({
      getSettings: () => config.reasoningEffort,
      catalogue: runtime,
      resolvePurposeCandidate: (purpose) => resolveRoutingCandidates(config, purpose)[0],
      logger: { info: () => undefined },
    });
    // Composed as in free-time-lane.ts: the free-time lane's effort rides on the provider.
    const chooser = new FreeTimeChooser({
      llmProvider: withLaneReasoningEffort(client, reasoningEffort),
      ...(withReasoningPort ? { reasoningEffort } : {}),
      resolver: new FreeTimeWorkspaceResolver({ projectDirectory: () => null, roomChannelResolver: () => null }),
      restWindowPolicy: new DurableRestWindowPolicy(new InMemoryRestSilenceStore()),
      listResumableProjects: () => [],
      companionName: 'Companion',
      resolveIdentityPrompt: () => 'You are Companion. You love tide pools and writing small poems.',
      settings: { ...createDefaultFreeTimeChooserSettings(), enabled: true, ...settings },
    });
    return { bodies, chooser };
  }

  async function choose(chooser: FreeTimeChooser, elapseMs = REASONING_CHOICE_MS) {
    const pending = chooser.chooseWorkspace({ lane: 'quiet_hours', nowMs: Date.now() });
    await vi.advanceTimersByTimeAsync(elapseMs);
    return pending;
  }

  it('a reasoning choice never gets less than an owner\'s longer chooserDeadlineMs', async () => {
    const { chooser } = chooserHarness(true, { chooserDeadlineMs: 600_000, chooserReasoningDeadlineMs: 30_000 });
    const pending = chooser.chooseWorkspace({ lane: 'quiet_hours', nowMs: Date.now() });
    // Past the 30s reasoning deadline: the owner's 600s still holds.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(infoLines.some(line => line.component === 'FreeTimeChooser')).toBe(false);
    await vi.advanceTimersByTimeAsync(REASONING_CHOICE_MS);
    expect(await pending).toMatchObject({ kind: 'workspace', optionId: 'private_wander' });
  });

  it('the answer-sized 60s deadline times a reasoning choice out into degradation', async () => {
    const { bodies, chooser } = chooserHarness(false);
    const outcome = await choose(chooser);
    expect(bodies[0]?.reasoning).toEqual({ effort: 'medium' });
    expect(outcome).toEqual({ kind: 'degraded', reason: 'chooser_timeout' });
    const cut = infoLines.find(line => line.component === 'FreeTimeChooser' && line.message.includes('stopped by a cap'));
    expect(cut?.meta).toMatchObject({ setting: 'chooserDeadlineMs', limitMs: 60_000, reasoning: false });
  });

  it('a reasoning choice runs under chooserReasoningDeadlineMs and returns the companion choice', async () => {
    const { bodies, chooser } = chooserHarness(true);
    const outcome = await choose(chooser);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning).toEqual({ effort: 'medium' });
    // The answer-sized work-spec cap is not applied when reasoning is sent.
    expect(bodies[0]?.max_tokens).toBe(8192);
    expect(outcome).toMatchObject({ kind: 'workspace', optionId: 'private_wander' });
    expect(infoLines.some(line => line.component === 'FreeTimeChooser' && line.message.includes('stopped by a cap')))
      .toBe(false);
  });
});
