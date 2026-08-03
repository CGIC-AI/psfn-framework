/**
 * Multi-companion isolation regression for direct-database Garden services
 * (psfn-framework-mus2.16, invariant 11 in docs/garden-control-plane.md).
 *
 * The fleet-scoped Garden runs one process for many companions. Every direct-DB
 * Garden service captures its companion scope at construction (a Postgres schema
 * or companion-id column, a per-companion data root, or the connection-selected
 * companion identity). This suite proves the load-bearing consequence: when the
 * fleet Garden instantiates a service PER companion, interleaved requests for
 * companion A and companion B on the same process can neither read nor write
 * each other's rows — across cached in-memory reads, durable audit writes, and
 * live event streams.
 *
 * Companion identities here are fixtures only, never real deployment data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../../../shared/event-bus.js';
import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { ShardExecutionPort } from '../../../faculties/shards/port.js';
import { AdminDashboardDataService } from './dashboard-service.js';
import {
  AdminAuditHistoryDataService,
  GardenAuditHistoryJsonlStore,
} from './audit-history-service.js';
import { AdminSessionTurnObservabilityStore } from './session-turn-observability.js';
import type { AdminSessionTurnData } from './types.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

const OPAQUE_ID_KEYRING = {
  activeVersion: 'v1',
  keys: { v1: 'garden-db-isolation-test-secret-not-public' },
};

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'psfn-garden-db-isolation-'));
  tempDirs.push(dir);
  return dir;
}

function dashboardDeps(eventBus: EventBus, channels: string[]): {
  eventBus: EventBus;
  getMemoryStatsForRequest: () => Promise<{ total: number; avgSalience: number; byType: Record<string, number> }>;
  sessionStore: SessionStore;
  scheduler: Scheduler;
  shardManager: ShardExecutionPort;
} {
  return {
    eventBus,
    getMemoryStatsForRequest: async () => ({ total: 0, avgSalience: 0, byType: {} }),
    sessionStore: {
      listChannels: () => channels.map(id => ({ channelId: id })),
      getLatestSessionByTimestamp: () => null,
    } as unknown as SessionStore,
    scheduler: { taskCount: 0 } as unknown as Scheduler,
    shardManager: {
      getActiveCount: () => 0,
      getActiveShards: () => [],
    } as unknown as ShardExecutionPort,
  };
}

function minimalRecord(turnId: string, channelId: string): AdminSessionTurnData['record'] {
  return {
    turnId,
    channelId,
    requestId: 'request-1',
    userMessage: { role: 'user', content: 'hello' },
    toolCalls: [],
    extractedMemoryIds: [],
    concernDeltaRefs: [],
    contactDeltaRefs: [],
  } as unknown as AdminSessionTurnData['record'];
}

describe('multi-companion isolation: dashboard-service (cached reads + live event stream)', () => {
  it('keeps per-companion session reads and live turn telemetry separate under interleaving', async () => {
    // Each companion's fleet Garden service instance binds its OWN store + bus.
    const busA = new EventBus();
    const busB = new EventBus();
    const dashboardA = new AdminDashboardDataService(dashboardDeps(busA, ['a-1', 'a-2', 'a-3']));
    const dashboardB = new AdminDashboardDataService(dashboardDeps(busB, ['b-1']));

    // Interleave live telemetry: three turns for A, one for B, on their own buses.
    await busA.emit('agent.turn.usage', {
      message: {
        id: 'a', channelId: 'a-1', channelType: 'api', authorId: 'op', authorName: 'op',
        content: 'x', timestamp: new Date(1),
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, llmCalls: 1, toolCalls: 0, contextUtilization: 10, estimatedCostUsd: 1 },
    });
    await busB.emit('agent.turn.usage', {
      message: {
        id: 'b', channelId: 'b-1', channelType: 'api', authorId: 'op', authorName: 'op',
        content: 'y', timestamp: new Date(2),
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, llmCalls: 1, toolCalls: 0, contextUtilization: 20, estimatedCostUsd: 1 },
    });
    await busA.emit('agent.turn.usage', {
      message: {
        id: 'a2', channelId: 'a-2', channelType: 'api', authorId: 'op', authorName: 'op',
        content: 'x', timestamp: new Date(3),
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, llmCalls: 1, toolCalls: 0, contextUtilization: 30, estimatedCostUsd: 1 },
    });

    const [dataA, dataB] = await Promise.all([
      dashboardA.getDashboardData(),
      dashboardB.getDashboardData(),
    ]);

    // Session-count reads come only from each companion's own session store.
    expect(dataA.stats.sessionCount).toBe(3);
    expect(dataB.stats.sessionCount).toBe(1);

    // Live turn counters accumulate only from each companion's own event bus.
    expect(dataA.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(2);
    expect(dataB.stats.transientSessionTelemetry.turnsSinceOperatorStart).toBe(1);
  });
});

describe('multi-companion isolation: audit-history-service (durable writes)', () => {
  it('routes each companion audit write to its own store and never cross-reads', async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const pathA = join(dirA, 'garden-audit-history.jsonl');
    const pathB = join(dirB, 'garden-audit-history.jsonl');

    const auditA = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(pathA),
      scopeId: COMPANION_A,
      opaqueIdKeyring: OPAQUE_ID_KEYRING,
    });
    const auditB = new AdminAuditHistoryDataService({
      gardenStore: new GardenAuditHistoryJsonlStore(pathB),
      scopeId: COMPANION_B,
      opaqueIdKeyring: OPAQUE_ID_KEYRING,
    });

    // Interleave writes across the two companion services.
    auditA.appendGardenEntry({ actionType: 'settings_change', decision: 'allowed', narrative: 'A-first' });
    auditB.appendGardenEntry({ actionType: 'settings_change', decision: 'allowed', narrative: 'B-first' });
    auditA.appendGardenEntry({ actionType: 'settings_change', decision: 'allowed', narrative: 'A-second' });

    // Each durable file holds only its own companion's writes.
    const fileA = readFileSync(pathA, 'utf8');
    const fileB = readFileSync(pathB, 'utf8');
    expect(fileA).toContain('A-first');
    expect(fileA).toContain('A-second');
    expect(fileA).not.toContain('B-first');
    expect(fileB).toContain('B-first');
    expect(fileB).not.toContain('A-first');
    expect(fileB).not.toContain('A-second');

    // Reads through each service only see its own companion's rows.
    const [historyA, historyB] = await Promise.all([
      auditA.getAuditHistory({ source: 'garden', timeRange: 'all' }),
      auditB.getAuditHistory({ source: 'garden', timeRange: 'all' }),
    ]);
    const narrativesA = historyA.entries.map(entry => entry.narrative).sort();
    const narrativesB = historyB.entries.map(entry => entry.narrative).sort();
    expect(narrativesA).toEqual(['A-first', 'A-second']);
    expect(narrativesB).toEqual(['B-first']);
  });
});

describe('multi-companion isolation: session-turn observability (event streams)', () => {
  it('keeps each companion turn stream on its own instance under interleaving', async () => {
    const busA = new EventBus();
    const busB = new EventBus();
    const observabilityA = new AdminSessionTurnObservabilityStore({ eventBus: busA });
    const observabilityB = new AdminSessionTurnObservabilityStore({ eventBus: busB });

    // Interleave stage telemetry for a shared turnId string on the two buses.
    // A shared turnId is the adversarial case: only the bus-bound instance may
    // observe it; the other must stay empty (no cross-stream leak).
    await busA.emit('agent.turn.stage', {
      turnId: 'turn-shared', channelId: 'a-channel', stage: 'first-token', elapsedMs: 5, ttftMs: 5,
    });
    await busB.emit('agent.turn.stage', {
      turnId: 'turn-b-only', channelId: 'b-channel', stage: 'first-token', elapsedMs: 7, ttftMs: 7,
    });
    await busA.emit('agent.turn.stage', {
      turnId: 'turn-shared', channelId: 'a-channel', stage: 'response-complete', elapsedMs: 9,
    });

    const aOwnTurn = observabilityA.buildTurnData(minimalRecord('turn-shared', 'a-channel'));
    const bViewOfATurn = observabilityB.buildTurnData(minimalRecord('turn-shared', 'b-channel'));
    const bOwnTurn = observabilityB.buildTurnData(minimalRecord('turn-b-only', 'b-channel'));
    const aViewOfBTurn = observabilityA.buildTurnData(minimalRecord('turn-b-only', 'a-channel'));

    // A observed its own turn's stages; B never saw it.
    expect(aOwnTurn.stages.length).toBe(2);
    expect(bViewOfATurn.stages.length).toBe(0);

    // B observed its own turn's stages; A never saw it.
    expect(bOwnTurn.stages.length).toBe(1);
    expect(aViewOfBTurn.stages.length).toBe(0);
  });
});
