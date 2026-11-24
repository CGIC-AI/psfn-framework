/**
 * Tests for host-executed automata (`host-execution.ts`) and `SubagentFaculty`
 * integration: per-attempt budgets under a terminal attempt cap, concurrent
 * independent tasks with per-task exclusivity, core-bound attempt credentials,
 * lost-child retries, cancellation, and governed Automata Bus writes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../../boundary/pi-agent/index.js';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { resetCompletionHandoffDedupeForTests } from '../../core/agent/completion-handoff.js';
import type { LLMProviderPort as LLMProvider } from '../../core/agent/contracts.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { EventBus } from '../../shared/event-bus.js';
import { loadAutomataPolicySeedDefaults } from '../../system/config/automata-policy-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { NO_AUTOMATA_REDELIVERY } from '../../test-support/automata-run-redelivery.js';
import { createInMemoryAutomataBus } from '../../test-support/in-memory-automata-bus.js';
import { viewerContextIt } from '../../test-support/viewer-context-it.js';
import {
  CanonicalAutomataBusWriter,
  createProductionAutomataBusWorkerAccess,
} from '../automata/bus/production-worker-adapter.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../automata/run-registry.js';
import { SubagentFaculty } from './faculty.js';
import {
  HostedAutomataExecutor,
  type HostedAttemptClaim,
  type HostedAutomataEvent,
  type HostedAutomatonTask,
  type HostedResult,
} from './host-execution.js';
import { buildSubagentWorkSpec } from './work-spec.js';

const POLICY = { maxAttempts: 3, leaseMs: 1_000, maxIterations: 250 } as const;
const HOST = 'principal-a/host-1';

function busTool(execute?: SubstrateAgentTool['execute']): SubstrateAgentTool {
  return {
    name: 'automata_bus',
    label: 'automata_bus',
    description: 'test bus',
    parameters: {},
    execute: vi.fn(execute ?? (async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: {} }))),
  } as unknown as SubstrateAgentTool;
}

function task(subagentId: string, tool: SubstrateAgentTool | null = busTool()): HostedAutomatonTask {
  return {
    subagentId,
    runId: subagentId,
    taskId: `task-${subagentId}`,
    automatonClass: 'subagent.bounded',
    name: subagentId,
    goal: `Goal of ${subagentId}`,
    context: null,
    busTool: tool,
  };
}

function world(policy = POLICY) {
  let now = 0;
  let minted = 0;
  const events: HostedAutomataEvent[] = [];
  const executor = new HostedAutomataExecutor(policy, {
    now: () => now,
    mintCredential: () => `credential-${++minted}`,
    onEvent: event => events.push(event),
    sweepTimer: false,
  });
  return {
    executor,
    events,
    advance: (ms: number) => { now += ms; },
    claim: (limit = 8, maxIterations = 250, owner = HOST) => unwrap(executor.claim(owner, { maxIterations, limit })),
  };
}

function unwrap<T>(result: HostedResult<T>): T {
  if (!result.ok) throw new Error(`refused: ${result.refusal}: ${result.message}`);
  return result.value;
}

function refusal<T>(result: HostedResult<T>): string | null {
  return result.ok ? null : result.refusal;
}

describe('HostedAutomataExecutor: per-attempt budgets and terminal attempt cap', () => {
  it('gives every attempt its own budget and credential, and ends the task failed at the cap', async () => {
    const w = world();
    const outcome = w.executor.execute(task('a'));
    const budgets: number[] = [];
    const credentials: string[] = [];
    const ends = [
      { kind: 'failed', code: 'model_error' },
      { kind: 'lost', code: 'process_exit' },
      { kind: 'failed', code: 'model_error' },
    ] as const;
    const answers: string[] = [];
    for (const [index, end] of ends.entries()) {
      const [claim] = w.claim(1, 250 - index * 10) as HostedAttemptClaim[];
      expect(claim!.attempt).toBe(index + 1);
      expect(claim!.maxAttempts).toBe(3);
      budgets.push(claim!.budget.maxIterations);
      credentials.push(claim!.credential);
      answers.push(unwrap(w.executor.report(HOST, claim!.credential, end)).next);
      expect(refusal(w.executor.heartbeat(HOST, claim!.credential))).toBe('attempt_ended');
    }
    expect(budgets).toEqual([250, 240, 230]);
    expect(new Set(credentials).size).toBe(3);
    expect(answers).toEqual(['retry', 'retry', 'failed']);
    await expect(outcome).resolves.toEqual({
      kind: 'failed',
      reason: 'attempt_cap_exhausted',
      lastFailure: 'failed:model_error',
      attempts: 3,
    });
    expect(w.claim()).toEqual([]);
    for (const credential of credentials) {
      expect(refusal(await w.executor.callBus(HOST, credential, { action: 'note', text: 'late' }))).toBe('attempt_ended');
    }
    expect(w.events.filter(event => event.kind === 'task_ended')).toEqual([
      { kind: 'task_ended', subagentId: 'a', outcome: 'failed', attempts: 3 },
    ]);
  });

  it('refuses a host budget above the policy and leaves the task waiting', async () => {
    const w = world();
    const outcome = w.executor.execute(task('a'));
    expect(refusal(w.executor.claim(HOST, { maxIterations: 251, limit: 1 }))).toBe('budget_exceeds_policy');
    expect(refusal(w.executor.claim(HOST, { maxIterations: 0, limit: 1 }))).toBe('invalid');
    const [claim] = w.claim(1, 250);
    expect(claim!.attempt).toBe(1);
    unwrap(w.executor.report(HOST, claim!.credential, { kind: 'succeeded', summary: 'done', model: 'm', apiCalls: 7 }));
    await expect(outcome).resolves.toEqual({ kind: 'completed', summary: 'done', model: 'm', apiCalls: 7, attempts: 1 });
  });

  it('completes on a later attempt after an earlier one fails', async () => {
    const w = world();
    const outcome = w.executor.execute(task('a'));
    const [first] = w.claim();
    expect(unwrap(w.executor.report(HOST, first!.credential, { kind: 'failed', code: 'model_error' })).next).toBe('retry');
    const [second] = w.claim();
    expect(unwrap(w.executor.report(HOST, second!.credential, { kind: 'succeeded', summary: 'ok', model: null, apiCalls: 2 })).next)
      .toBe('completed');
    await expect(outcome).resolves.toMatchObject({ kind: 'completed', attempts: 2 });
  });
});

describe('HostedAutomataExecutor: concurrent attempts with per-task exclusivity', () => {
  it('runs attempts of different tasks at once, with one live attempt per task', async () => {
    const w = world();
    let releaseA!: () => void;
    const aBlocked = new Promise<void>(resolve => { releaseA = resolve; });
    const toolA = busTool(async () => {
      await aBlocked;
      return { content: [{ type: 'text' as const, text: 'a-written' }], details: {} };
    });
    const toolB = busTool(async () => ({ content: [{ type: 'text' as const, text: 'b-written' }], details: {} }));
    const outcomeA = w.executor.execute(task('a', toolA));
    const outcomeB = w.executor.execute(task('b', toolB));
    const claims = w.claim(8);
    expect(claims.map(claim => claim.subagentId)).toEqual(['a', 'b']);
    expect(w.claim(8)).toEqual([]);
    const [a, b] = claims;
    const aWrite = w.executor.callBus(HOST, a!.credential, { action: 'note', text: 'a' });
    expect(unwrap(await w.executor.callBus(HOST, b!.credential, { action: 'note', text: 'b' })).text).toBe('b-written');
    unwrap(w.executor.report(HOST, b!.credential, { kind: 'succeeded', summary: 'b done', model: null, apiCalls: 1 }));
    await expect(outcomeB).resolves.toMatchObject({ kind: 'completed', summary: 'b done' });
    releaseA();
    expect(unwrap(await aWrite).text).toBe('a-written');
    unwrap(w.executor.report(HOST, a!.credential, { kind: 'succeeded', summary: 'a done', model: null, apiCalls: 1 }));
    await expect(outcomeA).resolves.toMatchObject({ kind: 'completed', summary: 'a done' });
  });

  it('lets several host instances claim different tasks', () => {
    const w = world();
    void w.executor.execute(task('a'));
    void w.executor.execute(task('b'));
    const [a] = w.claim(1, 250, 'principal-a/host-1');
    const [b] = w.claim(1, 250, 'principal-a/host-2');
    expect([a!.subagentId, b!.subagentId]).toEqual(['a', 'b']);
    expect(unwrap(w.executor.heartbeat('principal-a/host-2', b!.credential)).status).toBe('active');
    w.executor.close();
  });
});

describe('HostedAutomataExecutor: core-bound credentials and leases', () => {
  it('binds the credential to the attempt and to the host instance that claimed it', async () => {
    const w = world();
    void w.executor.execute(task('a'));
    const [claim] = w.claim();
    expect(refusal(w.executor.heartbeat('principal-a/host-2', claim!.credential))).toBe('not_attempt_owner');
    expect(refusal(w.executor.heartbeat('principal-b/host-1', claim!.credential))).toBe('not_attempt_owner');
    expect(refusal(w.executor.heartbeat(HOST, 'credential-unknown'))).toBe('unknown_attempt');
    expect(refusal(await w.executor.callBus(HOST, '', { action: 'note', text: 'x' }))).toBe('unknown_attempt');
    expect(unwrap(w.executor.heartbeat(HOST, claim!.credential))).toEqual({ status: 'active', attempt: 1 });
    w.executor.close();
  });

  it('ends an attempt whose lease ran out as a lost child, and retries the task', async () => {
    const w = world();
    void w.executor.execute(task('a'));
    const [first] = w.claim();
    w.advance(900);
    unwrap(w.executor.heartbeat(HOST, first!.credential));
    w.advance(900);
    unwrap(await w.executor.callBus(HOST, first!.credential, { action: 'note', text: 'x' }));
    w.advance(1_000);
    expect(refusal(w.executor.heartbeat(HOST, first!.credential))).toBe('attempt_ended');
    expect(w.events).toContainEqual({ kind: 'attempt_ended', subagentId: 'a', attempt: 1, end: 'lost:lease_expired' });
    const [second] = w.claim();
    expect(second!.attempt).toBe(2);
    expect(second!.credential).not.toBe(first!.credential);
    w.executor.close();
  });

  it('runs Bus calls through the governed tool core formed, and refuses without one', async () => {
    const w = world();
    const tool = busTool();
    void w.executor.execute(task('a', tool));
    void w.executor.execute(task('b', null));
    const [a, b] = w.claim();
    expect([a!.busAccess, b!.busAccess]).toEqual([true, false]);
    unwrap(await w.executor.callBus(HOST, a!.credential, { action: 'note', text: 'one' }));
    unwrap(await w.executor.callBus(HOST, a!.credential, { action: 'note', text: 'two' }));
    expect(vi.mocked(tool.execute).mock.calls.map(call => call.slice(0, 2))).toEqual([
      ['a:attempt:1:bus:1', { action: 'note', text: 'one' }],
      ['a:attempt:1:bus:2', { action: 'note', text: 'two' }],
    ]);
    expect(refusal(await w.executor.callBus(HOST, b!.credential, { action: 'note', text: 'x' }))).toBe('no_bus_access');
    w.executor.close();
  });

  it('cancels a waiting task at once and a live attempt through its heartbeat', async () => {
    const w = world();
    const waiting = w.executor.execute(task('a'));
    w.executor.cancel('a', 'parent_cancelled');
    await expect(waiting).resolves.toEqual({ kind: 'cancelled', reason: 'parent_cancelled', attempts: 0 });

    const live = w.executor.execute(task('b'));
    const [claim] = w.claim();
    w.executor.cancel('b', 'parent_cancelled');
    expect(unwrap(w.executor.heartbeat(HOST, claim!.credential)).status).toBe('cancel_requested');
    expect(refusal(await w.executor.callBus(HOST, claim!.credential, { action: 'note', text: 'x' }))).toBe('cancel_requested');
    expect(unwrap(w.executor.report(HOST, claim!.credential, { kind: 'cancelled' })).next).toBe('cancelled');
    await expect(live).resolves.toEqual({ kind: 'cancelled', reason: 'parent_cancelled', attempts: 1 });
  });

  it('refuses malformed reports and fails open tasks when closed', async () => {
    const w = world();
    const outcome = w.executor.execute(task('a'));
    const [claim] = w.claim();
    expect(refusal(w.executor.report(HOST, claim!.credential, { kind: 'failed', code: 'Not A Code' }))).toBe('invalid');
    expect(refusal(w.executor.report(HOST, claim!.credential, { kind: 'succeeded', summary: 's', model: null, apiCalls: -1 })))
      .toBe('invalid');
    w.executor.close();
    await expect(outcome).resolves.toMatchObject({ kind: 'failed', reason: 'host_execution_closed', attempts: 1 });
    await expect(w.executor.execute(task('b'))).resolves.toMatchObject({ kind: 'failed', reason: 'host_execution_closed' });
  });
});

// -- SubagentFaculty integration ---------------------------------------------

const SLOT = { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192, contextWindow: 128_000 };
const CONFIG: SubstrateConfig = {
  primaryModel: SLOT.model,
  primaryProvider: SLOT.provider,
  extractionModel: SLOT.model,
  extractionProvider: SLOT.provider,
  discordToken: '',
  discordBotId: '',
  characterCardPath: '',
  dataDir: './data',
  databasePath: ':memory:',
  sessionMessageLimit: 30,
  memoryRetrievalLimit: 15,
  extractionInterval: 5,
  primaryMaxTokens: 8192,
  extractionMaxTokens: 8192,
  maintenanceIntervalMs: 300_000,
  defaultContextWindow: 128_000,
  extractionThresholdPct: 30,
  compactionThresholdPct: 70,
  companionId: '11111111-1111-4111-8111-111111111111',
  characterName: 'Companion',
  modelRoster: { chat: SLOT, background: SLOT },
  modelRegistry: {
    schemaVersion: 1,
    models: (['chat', 'background'] as const).map((purpose, index) => ({
      id: purpose,
      rank: (index + 1) * 10,
      identity: { provider: SLOT.provider, model: SLOT.model, source: { type: SLOT.provider } },
      purposes: [{ purpose, primary: true }],
      capabilities: { maxOutputTokens: SLOT.maxTokens, contextWindow: SLOT.contextWindow },
      tuning: { maxOutputTokens: SLOT.maxTokens, contextWindow: SLOT.contextWindow },
    })),
  },
};

function mockLLM(): LLMProvider {
  const response = { content: 'unused', toolCalls: [], model: 'mock-model', inputTokens: 0, outputTokens: 0, stopReason: 'stop' };
  return { stream: vi.fn(async () => response), complete: vi.fn(async () => response) } as unknown as LLMProvider;
}

const ownerIt = viewerContextIt();

describe('HostedAutomataExecutor through SubagentFaculty', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'psfn-hosted-automata-'));
    resetCompletionHandoffDedupeForTests();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function hostedFaculty() {
    const bus = createInMemoryAutomataBus();
    const registry = await AutomataRunRegistry.hydrate({
      redelivery: NO_AUTOMATA_REDELIVERY,
      companionId: CONFIG.companionId,
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });
    const access = createProductionAutomataBusWorkerAccess({
      companionId: CONFIG.companionId,
      registry,
      store: bus.store,
      runtime: bus.runtime,
      writer: new CanonicalAutomataBusWriter({ companionId: CONFIG.companionId, store: bus.store, runtime: bus.runtime }),
      bounds: {
        maxQueryChars: 200,
        maxTextChars: 400,
        maxArrayItems: 8,
        maxSearchResults: 10,
        maxRunResults: 20,
        maxBriefingChars: 400,
        maxBriefingItems: 4,
        maxToolResultChars: 4_000,
      },
    });
    const executor = new HostedAutomataExecutor(POLICY, { sweepTimer: false });
    const faculty = new SubagentFaculty({
      eventBus: new EventBus(),
      llmProvider: mockLLM(),
      sessionStore: new SessionStore(root),
      embeddingService: null,
      memoryProvider: null,
      config: CONFIG,
      parentSystemPrompt: 'You are Companion.',
      automataBusWorkerAccess: access,
      automataRunRegistry: registry,
      automataSessionClassification: { classifyAtCreation: vi.fn(async () => undefined) },
      hostExecution: executor,
    });
    return { bus, registry, executor, faculty };
  }

  async function claimWhenQueued(executor: HostedAutomataExecutor): Promise<HostedAttemptClaim> {
    for (let tries = 0; tries < 50; tries += 1) {
      const claims = executor.claim(HOST, { maxIterations: 250, limit: 1 });
      if (claims.ok && claims.value.length > 0) return claims.value[0]!;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    throw new Error('the faculty never queued the hosted attempt');
  }

  ownerIt('runs a spawned automaton on the host: a lost child is retried, and its Bus write stays one event', async () => {
    const prompt = vi.spyOn(Agent.prototype, 'prompt');
    const { bus, registry, executor, faculty } = await hostedFaculty();
    const spawned = await faculty.spawn({
      name: 'route-research',
      task: 'Map the route docs.',
      workSpec: buildSubagentWorkSpec(),
    });

    const first = await claimWhenQueued(executor);
    expect(first).toMatchObject({ attempt: 1, goal: 'Map the route docs.', busAccess: true, budget: { maxIterations: 250 } });
    const note = { action: 'note', text: 'Route docs live under docs/routes.' };
    const written = unwrap(await executor.callBus(HOST, first.credential, note));
    expect(written.isError).toBe(false);
    expect(unwrap(executor.report(HOST, first.credential, { kind: 'lost', code: 'process_exit' })).next).toBe('retry');
    expect(refusal(await executor.callBus(HOST, first.credential, note))).toBe('attempt_ended');

    const second = await claimWhenQueued(executor);
    expect(second.attempt).toBe(2);
    expect(JSON.parse(unwrap(await executor.callBus(HOST, second.credential, note)).text).result.inserted).toBe(false);
    unwrap(executor.report(HOST, second.credential, { kind: 'succeeded', summary: 'Mapped the routes.', model: 'host-model', apiCalls: 4 }));

    const result = await faculty.wait(spawned.subagentId);
    expect(result).toMatchObject({ outcome: 'completed', content: 'Mapped the routes.' });
    expect([...bus.events.values()].filter(entry => entry.event.type === 'finding')).toHaveLength(1);
    expect(prompt).not.toHaveBeenCalled();
    expect(registry.getRun(spawned.subagentId)?.status).toBe('completed');
    await expect(faculty.message(spawned.subagentId, 'more')).rejects.toThrow();
    prompt.mockRestore();
    executor.close();
  });

  ownerIt('fails the automaton once the attempt cap is reached', async () => {
    const { registry, executor, faculty } = await hostedFaculty();
    const spawned = await faculty.spawn({ name: 'flaky', task: 'Do the flaky thing.', workSpec: buildSubagentWorkSpec() });
    for (let attempt = 1; attempt <= POLICY.maxAttempts; attempt += 1) {
      const claim = await claimWhenQueued(executor);
      expect(claim.attempt).toBe(attempt);
      unwrap(executor.report(HOST, claim.credential, { kind: 'failed', code: 'model_error' }));
    }
    const result = await faculty.wait(spawned.subagentId);
    expect(result).toMatchObject({ lifecycleState: 'failed', outcome: 'blocked', stateReason: 'execution_failed' });
    expect(result.failureReason).toContain('attempt_cap_exhausted after 3 host attempts');
    expect(executor.claim(HOST, { maxIterations: 250, limit: 8 })).toEqual({ ok: true, value: [] });
    expect(registry.getRun(spawned.subagentId)?.status).toBe('failed');
    executor.close();
  });

  ownerIt('cancels a hosted automaton through its heartbeat', async () => {
    const { executor, faculty } = await hostedFaculty();
    const spawned = await faculty.spawn({ name: 'long', task: 'Take a while.', workSpec: buildSubagentWorkSpec() });
    const claim = await claimWhenQueued(executor);
    const cancelled = faculty.cancel(spawned.subagentId, 'owner_stopped');
    expect(unwrap(executor.heartbeat(HOST, claim.credential)).status).toBe('cancel_requested');
    unwrap(executor.report(HOST, claim.credential, { kind: 'cancelled' }));
    await expect(cancelled).resolves.toMatchObject({ outcome: 'cancelled' });
    executor.close();
  });
});
