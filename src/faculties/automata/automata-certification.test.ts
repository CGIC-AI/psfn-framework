import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  CHANNEL_INDEX_FILENAME,
  type ChannelIndexEntry,
} from '../../persistence/sessions/store-primitives.js';
import { saveChannelIndex } from '../../persistence/sessions/store/channel-index.js';
import {
  createFilesystemExactSessionPurgeSurfaces,
} from '../../persistence/sessions/exact-session-purge-surfaces.js';
import { sanitizeChannelId } from '../../persistence/sessions/store-file-contracts.js';
import { loadAutomataPolicySeedDefaults } from '../../system/config/automata-policy-config.js';
import type { AutomataBusEvent } from './bus/contract.js';
import type { PostgresAutomataBusRuntimeStore } from './bus/runtime-store.js';
import {
  buildAutomataBusWorkerScope,
  resolveAutomataBusWorkerFormation,
  type AutomataBusWorkerAccess,
  type AutomataBusWorkerPort,
} from './bus/worker-access.js';
import {
  EXACT_SESSION_PURGE_SURFACE_ORDER,
  InMemoryExactSessionPurgeSagaStore,
  ProductionExactSessionPurge,
  type ExactSessionSurfacePurgePort,
} from './production-exact-session-purge.js';
import {
  ProductionAutomataPermanentReferenceCustody,
  ProductionAutomataRetentionProofSource,
  ProductionExactSessionPurgeTargetAuthority,
} from './production-retention-authority.js';
import { AutomataRetentionCoordinator } from './retention-coordinator.js';
import { InMemoryAutomataRetentionStore } from './retention-store.js';
import { AutomataRunRegistry, InMemoryAutomataRunStore } from './run-registry.js';

const COMPANION_ID = 'companion-a';
const RUN_ID = 'run-retention';
const AUTOMATA_SESSION_ID = 'session-automata';
const COMPANION_SESSION_ID = 'session-companion';
const ACTIVE_JOURNAL = 'worker-session.jsonl';
const ROLLED_JOURNAL = 'worker-session.segment-0002.jsonl';
const COMPANION_JOURNAL = 'companion-session.jsonl';

function terminalFinding(): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId: 'bus-receipt:terminal',
    companionId: COMPANION_ID,
    sequence: 1,
    occurredAt: '2026-08-12T04:00:00.000Z',
    mustUnderstand: [],
    context: {
      automatonClass: 'subagent.bounded',
      runId: RUN_ID,
      taskId: 'task-retention',
      sessionIds: [AUTOMATA_SESSION_ID],
      artifactRefs: ['artifact:durable-report'],
    },
    type: 'finding',
    body: {
      claim: 'The durable report was promoted before raw session cleanup.',
      provenance: 'computed',
      evidence: [{
        kind: 'artifact',
        reference: 'bus-evidence:durable-report',
        summary: 'Content-addressed report evidence.',
      }],
      verification: { status: 'verified', by: 'certification-reviewer' },
      source: 'subagent-terminal-handoff',
    },
  };
}

function indexEntry(channelId: string, filename: string): ChannelIndexEntry {
  return {
    channelId,
    filename,
    filenames: [filename],
    messageCount: 1,
    activeTurnTombstoneCount: 0,
    activeTurnTombstoneIds: [],
    archiveFingerprint: 'certification-fixture',
    compactionFilenames: [],
    lastTimestamp: 1,
    lastMessageTimestamp: 1,
    lastMessageRole: 'user',
    lastMessagePreview: 'private raw fixture',
    maxId: 1,
    lastHmac: null,
    lastExtractionCoveredUpTo: 0,
    lastJournalType: 'message',
  };
}

describe('Automata assembled certification', () => {
  it('purges eligible worker L0 while preserving promoted evidence and companion-owned L0', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'psfn-automata-certification-'));
    const activePath = join(sessionsDir, ACTIVE_JOURNAL);
    const rolledPath = join(sessionsDir, ROLLED_JOURNAL);
    const companionPath = join(sessionsDir, COMPANION_JOURNAL);
    const workerChannelId = 'worker:retention';
    const workerTurnPath = join(
      sessionsDir,
      '_turn_records',
      `${sanitizeChannelId(workerChannelId)}.jsonl`,
    );
    mkdirSync(join(sessionsDir, '_turn_records'));
    for (const path of [activePath, rolledPath, companionPath, workerTurnPath]) {
      writeFileSync(path, 'private raw fixture\n');
    }
    saveChannelIndex(join(sessionsDir, CHANNEL_INDEX_FILENAME), new Map([
      [AUTOMATA_SESSION_ID, {
        ...indexEntry(workerChannelId, ACTIVE_JOURNAL),
        filenames: [ROLLED_JOURNAL, ACTIVE_JOURNAL],
      }],
      [COMPANION_SESSION_ID, indexEntry('companion:permanent', COMPANION_JOURNAL)],
    ]));

    try {
      const policy = loadAutomataPolicySeedDefaults();
      const registry = await AutomataRunRegistry.hydrate({
        companionId: COMPANION_ID,
        policy,
        store: new InMemoryAutomataRunStore(),
      });
      await registry.register({
        runId: RUN_ID,
        automatonClass: 'subagent.bounded',
        workerId: 'worker-retention',
        taskId: 'task-retention',
        taskLabel: 'Certify retention',
        taskSummary: 'Promote durable evidence before exact raw cleanup.',
        sessionIds: [AUTOMATA_SESSION_ID],
        artifacts: [{ kind: 'report', ref: 'artifact:durable-report', custody: 'durable' }],
        createdAtMs: 1,
      });
      await registry.transition(RUN_ID, {
        status: 'running',
        reason: 'agent_initialized',
        atMs: 2,
      });
      await registry.transition(RUN_ID, {
        status: 'completed',
        reason: 'completed',
        outcome: 'completed',
        atMs: 3,
      });

      const history = [terminalFinding()];
      const bus = {
        readHistory: vi.fn(async () => history),
      } as unknown as PostgresAutomataBusRuntimeStore;
      const retention = new InMemoryAutomataRetentionStore();
      await retention.recordClassification({
        schemaVersion: 1,
        companionId: COMPANION_ID,
        sessionId: AUTOMATA_SESSION_ID,
        ownership: 'automata',
        runId: RUN_ID,
        automatonClass: 'subagent.bounded',
        workerGeneration: 1,
        classifiedAtMs: 1,
        retentionDeadlineMs: 10,
      });
      await retention.recordClassification({
        schemaVersion: 1,
        companionId: COMPANION_ID,
        sessionId: COMPANION_SESSION_ID,
        ownership: 'companion',
        classifiedAtMs: 1,
      });

      const proofs = new ProductionAutomataRetentionProofSource({
        companionId: COMPANION_ID,
        registry,
        bus,
      });
      const custody = new ProductionAutomataPermanentReferenceCustody({
        companionId: COMPANION_ID,
        registry,
        bus,
      });
      const authority = new ProductionExactSessionPurgeTargetAuthority({
        companionId: COMPANION_ID,
        sessionsDir,
        classifications: retention,
        proofs,
      });
      const filesystem = createFilesystemExactSessionPurgeSurfaces(sessionsDir);
      const accelerationSurface = (): ExactSessionSurfacePurgePort => {
        let present = true;
        return {
          remove: async () => {
            const wasPresent = present;
            present = false;
            return wasPresent
              ? { status: 'removed', removedCount: 1 }
              : { status: 'already_absent', removedCount: 0 };
          },
          isAbsent: async () => !present,
        };
      };
      const rawSurfaces = {
        ...filesystem,
        transcript_projection: accelerationSurface(),
        redis_tail_pointers: accelerationSurface(),
      };
      const mutatedSessions: string[] = [];
      const surfaces = Object.fromEntries(EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => {
        const delegate = rawSurfaces[surface];
        return [surface, {
          remove: async (...args: Parameters<ExactSessionSurfacePurgePort['remove']>) => {
            mutatedSessions.push(args[0].sessionId);
            return await delegate.remove(...args);
          },
          isAbsent: (...args: Parameters<ExactSessionSurfacePurgePort['isAbsent']>) => (
            delegate.isAbsent(...args)
          ),
        } satisfies ExactSessionSurfacePurgePort];
      })) as Record<typeof EXACT_SESSION_PURGE_SURFACE_ORDER[number], ExactSessionSurfacePurgePort>;
      const purge = new ProductionExactSessionPurge({
        authority,
        custody,
        fence: { runExclusive: async (_input, operation) => await operation() },
        sagaStore: new InMemoryExactSessionPurgeSagaStore(),
        surfaces,
      });
      const coordinator = new AutomataRetentionCoordinator({
        store: retention,
        proofs,
        custody,
        purge,
      });

      await expect(coordinator.run({ companionId: COMPANION_ID, nowMs: 20, limit: 10 }))
        .resolves.toEqual([{
          sessionId: AUTOMATA_SESSION_ID,
          outcome: 'purged',
          reason: 'eligible',
        }]);

      expect(mutatedSessions).toEqual(EXACT_SESSION_PURGE_SURFACE_ORDER.map(
        () => AUTOMATA_SESSION_ID,
      ));
      expect(existsSync(activePath)).toBe(false);
      expect(existsSync(rolledPath)).toBe(false);
      expect(existsSync(workerTurnPath)).toBe(false);
      expect(existsSync(companionPath)).toBe(true);
      expect(retention.listClassifications()).toContainEqual(expect.objectContaining({
        sessionId: COMPANION_SESSION_ID,
        ownership: 'companion',
      }));
      expect(registry.getRun(RUN_ID)?.artifacts).toContainEqual({
        kind: 'report',
        ref: 'artifact:durable-report',
        custody: 'durable',
      });
      expect(history).toEqual([expect.objectContaining({ eventId: 'bus-receipt:terminal' })]);
      expect(retention.listAuditEvents()).toContainEqual(expect.objectContaining({
        kind: 'purged',
        preservedReferenceCount: 3,
      }));
      expect(JSON.stringify(retention.listAuditEvents())).not.toContain('private raw fixture');
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true });
    }
  });

  it('measures zero Bus calls for foreground retrieval against one bounded eligible briefing', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      const brief = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
        return { text: 'Automata Bus briefing\n- One bounded item.', itemCount: 1 };
      });
      const action = vi.fn(async () => ({ ok: true }));
      const port: AutomataBusWorkerPort = {
        isClassEligible: () => true,
        brief,
        search: action,
        append: action,
        correct: action,
        handoff: action,
        runs: action,
        inspect: action,
      };
      const access: AutomataBusWorkerAccess = {
        port,
        bounds: {
          maxQueryChars: 120,
          maxTextChars: 240,
          maxArrayItems: 8,
          maxSearchResults: 10,
          maxRunResults: 20,
          maxBriefingChars: 400,
          maxBriefingItems: 4,
          maxToolResultChars: 1_000,
        },
        identity: {
          companionId: COMPANION_ID,
          audience: 'eligible-automata',
          maxSensitivity: 'personal',
        },
      };

      const retrievalStart = Date.now();
      const retrieval = await resolveAutomataBusWorkerFormation({
        access,
        scope: buildAutomataBusWorkerScope(access, {
          automatonClass: 'memory.retrieval',
          runId: 'retrieval-run',
          taskId: 'foreground-retrieval',
        }),
        query: 'ordinary foreground recall',
      });
      const retrievalElapsedMs = Date.now() - retrievalStart;

      const eligibleStart = Date.now();
      const eligiblePromise = resolveAutomataBusWorkerFormation({
        access,
        scope: buildAutomataBusWorkerScope(access, {
          automatonClass: 'subagent.bounded',
          runId: 'eligible-run',
          taskId: 'bounded-briefing',
        }),
        query: 'one bounded briefing',
      });
      await vi.advanceTimersByTimeAsync(25);
      const eligible = await eligiblePromise;
      const eligibleElapsedMs = Date.now() - eligibleStart;

      expect({ retrievalElapsedMs, eligibleElapsedMs }).toEqual({
        retrievalElapsedMs: 0,
        eligibleElapsedMs: 25,
      });
      expect(retrieval).toBeNull();
      expect(brief).toHaveBeenCalledOnce();
      expect(eligible?.promptBlock).toContain('One bounded item.');
      expect(eligible?.promptBlock.length).toBeLessThan(2_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
