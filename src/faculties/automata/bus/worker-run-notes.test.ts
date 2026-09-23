import { describe, expect, it, vi } from 'vitest';

import { loadAutomataPolicySeedDefaults } from '../../../system/config/automata-policy-config.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from '../run-registry.js';
import type { AutomataBusEvent } from './contract.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import type { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import {
  CanonicalAutomataBusWriter,
  createProductionAutomataBusWorkerAccess,
} from './production-worker-adapter.js';
import { openAutomataBusWorkerRun, type AutomataWorkerRunPort } from './worker-access.js';
import type { AutomataWorkerLifecycleEvent } from './worker-execution.js';
import { runGovernedAutomataClass } from './class-lifecycle.js';

const COMPANION_ID = 'companion-a';
const BOUNDS = {
  maxQueryChars: 120,
  maxTextChars: 240,
  maxArrayItems: 8,
  maxSearchResults: 10,
  maxRunResults: 20,
  maxBriefingChars: 600,
  maxBriefingItems: 4,
  maxToolResultChars: 2_000,
} as const;

/**
 * A durable-looking Bus: the canonical writer validates and persists every
 * event exactly as production does; the spawn briefing stands in for the
 * Postgres query service (whose ranking has its own tests) with a lexical
 * match over current findings.
 */
function createBus() {
  const events = new Map<string, AutomataBusEvent>();
  const store = {
    appendAllocated: vi.fn(async (input: {
      eventId: string;
      createEvent(sequence: number): unknown;
    }) => {
      const event = input.createEvent(events.size + 1) as AutomataBusEvent;
      events.set(event.eventId, event);
      return { event, inserted: true };
    }),
    readHistory: vi.fn(async () => [...events.values()]),
    readEventById: vi.fn(async (input: { eventId: string }) => events.get(input.eventId) ?? null),
  } as unknown as PostgresAutomataBusRuntimeStore;
  const findings = () => [...events.values()].filter(
    (event): event is Extract<AutomataBusEvent, { type: 'finding' }> => event.type === 'finding',
  );
  const canonical = {
    getCurrentByEventIds: vi.fn(async (input: { eventIds: string[] }) => findings()
      .filter(event => input.eventIds.includes(event.eventId))
      .map(event => ({
        eventId: event.eventId,
        companionId: event.companionId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        automatonClass: event.context.automatonClass,
        taskId: event.context.taskId,
        runId: event.context.runId,
        claim: event.body.claim,
        provenance: event.body.provenance,
        verificationStatus: event.body.verification.status,
        audience: 'eligible-automata' as const,
        sensitivity: 'confidential' as const,
      }))),
  };
  const indexing = {
    indexCurrentFinding: vi.fn(async (finding: { eventId: string }) => ({
      status: 'indexed' as const,
      eventId: finding.eventId,
      modelIdentity: { provider: 'test', model: 'test', dimensions: 2 },
    })),
  };
  const createSpawnBriefing = vi.fn(async (input: { query: string }) => {
    const terms = input.query.toLowerCase().split(/\s+/u).filter(Boolean);
    const matches = findings().filter(event => (
      terms.some(term => event.body.claim.toLowerCase().includes(term))
    ));
    return {
      text: ['Automata Bus briefing', ...matches.map(event => (
        `- [${event.context.automatonClass}/${event.context.taskId}] ${event.body.claim}`
      ))].join('\n'),
      itemCount: matches.length,
      diagnostics: {
        cache: 'disabled' as const,
        semanticPath: 'ann' as const,
        indexState: 'ready' as const,
        reindexState: 'current' as const,
        modelIdentity: { provider: 'test', model: 'test', dimensions: 2 },
        indexingLag: { pendingCount: 0 },
      },
    };
  });
  const writer = new CanonicalAutomataBusWriter({
    companionId: COMPANION_ID,
    store,
    runtime: { canonical, indexing } as unknown as AutomataBusProductionRuntime,
  });
  return { events, findings, writer, store, createSpawnBriefing };
}

async function createRegistry(runIds: readonly string[]) {
  const registry = await AutomataRunRegistry.hydrate({
    companionId: COMPANION_ID,
    policy: loadAutomataPolicySeedDefaults(),
    store: new InMemoryAutomataRunStore(),
  });
  for (const runId of runIds) {
    await registry.register({
      runId,
      automatonClass: 'subagent.bounded',
      workerId: runId,
      taskId: `task-${runId}`,
      taskLabel: 'Audit the deploy chart',
      taskSummary: 'Audit the deploy chart',
      sessionIds: [`subagent:${runId}`],
      createdAtMs: 1_700_000_000_000,
    });
    await registry.transition(runId, {
      status: 'running',
      reason: 'agent_initialized',
      atMs: 1_700_000_000_010,
    });
  }
  return registry;
}

function runPort(registry: AutomataRunRegistry, runId: string): AutomataWorkerRunPort {
  return {
    begin: async () => ({
      companionId: COMPANION_ID,
      lineage: {
        automatonClass: 'subagent.bounded',
        runId,
        taskId: `task-${runId}`,
        workerId: runId,
        sessionIds: [`subagent:${runId}`],
      },
      attempt: registry.getRun(runId)!.workerGeneration,
      execute: true,
    }),
    terminalize: async () => undefined,
  };
}

function toolText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map(part => part.text ?? '').join('');
}

describe('automata worker run notes', () => {
  it('reads prior run notes at spawn and writes new notes that the next run is briefed on', async () => {
    const bus = createBus();
    const registry = await createRegistry(['run-1', 'run-2']);
    const access = createProductionAutomataBusWorkerAccess({
      companionId: COMPANION_ID,
      registry,
      store: bus.store,
      runtime: { query: { createSpawnBriefing: bus.createSpawnBriefing } } as unknown as AutomataBusProductionRuntime,
      writer: bus.writer,
      bounds: BOUNDS,
    });

    const first = await openAutomataBusWorkerRun({
      access,
      run: runPort(registry, 'run-1'),
      briefingQuery: 'deploy chart',
    });
    expect(first.promptBlock).toContain('Before you start: read the spawn briefing below');
    expect(first.promptBlock).toContain('action=note');
    expect(first.promptBlock).toContain('(no prior notes yet)');
    expect(first.tool).not.toBeNull();

    const noted = await first.tool!.execute('call-1', {
      action: 'note',
      text: 'Deploy chart: helm lint needs the fleet overlay; the default values skip per-companion objects.',
    });
    expect(toolText(noted)).toContain('"action": "note"');
    expect(first.observedBusWrites).toBe(1);
    const [note] = bus.findings();
    expect(note?.context.runId).toBe('run-1');
    expect(note?.body.provenance).toBe('computed');
    expect(note?.body.evidence).toEqual([{
      kind: 'artifact',
      reference: 'automata-run:run-1',
      summary: 'Run note recorded by the worker for future runs',
    }]);

    const second = await openAutomataBusWorkerRun({
      access,
      run: runPort(registry, 'run-2'),
      briefingQuery: 'deploy chart',
    });
    expect(second.briefing?.itemCount).toBe(1);
    expect(second.promptBlock).toContain('### Spawn briefing (prior run notes)');
    expect(second.promptBlock).toContain(
      '[subagent.bounded/task-run-1] Deploy chart: helm lint needs the fleet overlay',
    );
    expect(second.promptBlock).not.toContain('(no prior notes yet)');
  });

  it('rejects an empty or oversized note without writing', async () => {
    const bus = createBus();
    const registry = await createRegistry(['run-1']);
    const access = createProductionAutomataBusWorkerAccess({
      companionId: COMPANION_ID,
      registry,
      store: bus.store,
      runtime: { query: { createSpawnBriefing: bus.createSpawnBriefing } } as unknown as AutomataBusProductionRuntime,
      writer: bus.writer,
      bounds: BOUNDS,
    });
    const run = await openAutomataBusWorkerRun({
      access,
      run: runPort(registry, 'run-1'),
      briefingQuery: 'deploy chart',
    });
    for (const text of ['   ', 'x'.repeat(BOUNDS.maxTextChars + 1)]) {
      const result = await run.tool!.execute('call', { action: 'note', text });
      expect(toolText(result)).toContain('automata_bus failed safely');
    }
    const extra = await run.tool!.execute('call', { action: 'note', text: 'ok', claim: 'no' });
    expect(toolText(extra)).toContain('unknown fields: claim');
    expect(bus.findings()).toEqual([]);
    expect(run.observedBusWrites).toBe(0);
  });

  it('gives handoff-only classes no briefing query and no tool', async () => {
    const bus = createBus();
    const registry = await AutomataRunRegistry.hydrate({
      companionId: COMPANION_ID,
      policy: loadAutomataPolicySeedDefaults(),
      store: new InMemoryAutomataRunStore(),
    });
    const access = createProductionAutomataBusWorkerAccess({
      companionId: COMPANION_ID,
      registry,
      store: bus.store,
      runtime: { query: { createSpawnBriefing: bus.createSpawnBriefing } } as unknown as AutomataBusProductionRuntime,
      writer: bus.writer,
      bounds: BOUNDS,
    });
    const telemetry: AutomataWorkerLifecycleEvent[] = [];
    let seen: unknown = 'unset';
    const outcome = await runGovernedAutomataClass({
      runtime: { registry, workerAccess: access, telemetry: event => telemetry.push(event) },
      spec: {
        automatonClass: 'scheduler.free_time',
        runId: 'free-time:1',
        workerId: 'free-time',
        taskId: 'free-time:solo',
        taskLabel: 'Free time',
        taskSummary: 'Free time block',
      },
      briefingQuery: 'free time',
      work: async run => {
        seen = { tool: run?.tool ?? null, promptBlock: run?.promptBlock ?? null };
        return { value: 'done', summary: 'Free-time block: turnsUsed=1' };
      },
    });
    expect(outcome).toEqual({ status: 'executed', value: 'done' });
    expect(seen).toEqual({ tool: null, promptBlock: null });
    expect(bus.createSpawnBriefing).not.toHaveBeenCalled();
    expect(telemetry
      .filter(event => event.stage === 'brief' || event.stage === 'tool')
      .map(event => `${event.stage}:${event.status}:${event.detail}`))
      .toEqual(['brief:skipped:handoff_only_class', 'tool:skipped:handoff_only_class']);
  });
});
