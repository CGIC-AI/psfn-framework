import { describe, expect, it } from 'vitest';
import type {
  ClaimedBackgroundWorkJob,
  MemoryExtractionBackgroundPayload,
} from '../../core/agent/background-work/types.js';
import {
  AutomataRunRegistry,
  InMemoryAutomataRunStore,
} from '../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../system/config/automata-policy-config.js';
import { createBackgroundWorkAutomataLifecycle } from './automata-background-work-lifecycle.js';
import { NO_AUTOMATA_REDELIVERY } from '../../test-support/automata-run-redelivery.js';
import { intentionPostTurnHooksRunId } from '../../core/agent/background-work/automata-run-redelivery.js';
import { memoryExtractionTurnRunId } from '../../faculties/memory/extraction/memory-extraction-automata-run.js';

function memoryExtractionJob(): ClaimedBackgroundWorkJob {
  return {
    jobId: 'job-memory-1',
    idempotencyKey: 'memory-extraction:turn-1',
    logicalSessionId: 'session-1',
    kind: 'memory_extraction',
    payloadSchemaVersion: 1,
    payload: {},
    payloadFingerprint: 'fingerprint-1',
    sourceTurnId: 'turn-1',
    sourceRequestId: 'request-1',
    sourceChannelId: 'channel-1',
    state: 'running',
    reasonCode: 'started',
    attemptCount: 1,
    maxAttempts: 3,
    createdAtMs: 100,
    availableAtMs: 100,
    updatedAtMs: 110,
    leaseOwner: 'worker-1',
    leaseExpiresAtMs: 1_000,
    revision: 2,
    deferCount: 0,
    welfareClaimed: false,
  };
}

function memoryExtractionPayload(): MemoryExtractionBackgroundPayload {
  return {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: 'session-1',
      channelId: 'channel-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      turnRecordFingerprint: 'fingerprint-1',
      createdAtMs: 100,
    },
  };
}

async function registry(): Promise<AutomataRunRegistry> {
  return AutomataRunRegistry.hydrate({
    redelivery: NO_AUTOMATA_REDELIVERY,
    companionId: 'companion-a',
    policy: loadAutomataPolicySeedDefaults(),
    store: new InMemoryAutomataRunStore(),
    nowMs: 100,
  });
}

describe('background-work Automata lifecycle', () => {
  it('binds extraction to its source request/session and transitions idempotently', async () => {
    const runRegistry = await registry();
    const lifecycle = createBackgroundWorkAutomataLifecycle(runRegistry);
    const job = memoryExtractionJob();
    const payload = memoryExtractionPayload();

    await lifecycle.onClaimed({ job, payload });
    await lifecycle.onClaimed({ job, payload });
    expect(runRegistry.getRun('request-1')).toMatchObject({
      automatonClass: 'memory.extraction',
      workerId: 'background-work:job-memory-1',
      taskId: 'session-1',
      sessionIds: ['session-1', 'channel-1'],
      status: 'running',
    });

    await lifecycle.onCompleted({ job, payload });
    await lifecycle.onCompleted({ job, payload });
    expect(runRegistry.getRun('request-1')).toMatchObject({
      status: 'completed',
      outcome: 'completed',
    });
  });

  it('rejects a reused request id with conflicting source authority', async () => {
    const runRegistry = await registry();
    const lifecycle = createBackgroundWorkAutomataLifecycle(runRegistry);
    const job = memoryExtractionJob();
    const payload = memoryExtractionPayload();
    await lifecycle.onClaimed({ job, payload });

    await expect(lifecycle.onClaimed({
      job: { ...job, jobId: 'job-memory-conflict' },
      payload,
    })).rejects.toThrow('conflicts with its authoritative binding');
  });

  it('records terminal background failure without registering excluded work kinds', async () => {
    const runRegistry = await registry();
    const lifecycle = createBackgroundWorkAutomataLifecycle(runRegistry);
    const job = memoryExtractionJob();
    const payload = memoryExtractionPayload();

    await lifecycle.onClaimed({ job, payload });
    await lifecycle.onFailed({ job, payload, reasonCode: 'retry_exhausted' });
    expect(runRegistry.getRun('request-1')).toMatchObject({
      status: 'failed',
      outcome: 'blocked',
      failureReason: 'retry_exhausted',
    });

    await lifecycle.onClaimed({
      job: { ...job, kind: 'intention_post_turn_hooks' },
      payload: {
        schemaVersion: 1,
        kind: 'intention_post_turn_hooks',
        source: payload.source,
      },
    });
    expect(runRegistry.listRuns()).toHaveLength(1);
  });

  it('fails every linked run of a job the expiry sweep dead-lettered (vxllk)', async () => {
    const runRegistry = await registry();
    const lifecycle = createBackgroundWorkAutomataLifecycle(runRegistry);
    const job = memoryExtractionJob();
    await lifecycle.onClaimed({ job, payload: memoryExtractionPayload() });
    const register = (runId: string, automatonClass: 'memory.extraction' | 'background.intention_post_turn_hooks') => (
      runRegistry.register({
        runId,
        automatonClass,
        workerId: 'memory-extraction',
        taskId: 'session-1',
        taskLabel: 'test',
        taskSummary: 'test run',
        sessionIds: ['session-1'],
        createdAtMs: 100,
      })
    );
    await register(memoryExtractionTurnRunId('turn-1'), 'memory.extraction');
    await register('request-unrelated', 'memory.extraction');
    await register(intentionPostTurnHooksRunId('request-hooks', 2), 'background.intention_post_turn_hooks');

    const deadLettered = { ...job, state: 'failed' as const, reasonCode: 'lease_expired' as const };
    await lifecycle.onExpiredTerminal({ job: deadLettered, reasonCode: 'lease_expired' });
    await lifecycle.onExpiredTerminal({ job: deadLettered, reasonCode: 'lease_expired' });

    for (const runId of ['request-1', memoryExtractionTurnRunId('turn-1')]) {
      expect(runRegistry.getRun(runId)).toMatchObject({
        status: 'failed',
        statusReason: 'background_work_failed',
        failureReason: 'lease_expired',
      });
    }
    expect(runRegistry.getRun('request-unrelated')?.status).toBe('queued');

    await lifecycle.onExpiredTerminal({
      job: {
        ...deadLettered,
        jobId: 'job-hooks',
        kind: 'intention_post_turn_hooks',
        sourceRequestId: 'request-hooks',
        attemptCount: 2,
      },
      reasonCode: 'effect_outcome_unknown',
    });
    expect(runRegistry.getRun(intentionPostTurnHooksRunId('request-hooks', 2))).toMatchObject({
      status: 'failed',
      failureReason: 'effect_outcome_unknown',
    });
  });
});
