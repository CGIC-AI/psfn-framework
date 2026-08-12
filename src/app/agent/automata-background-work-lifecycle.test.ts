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
    })).rejects.toThrow('conflicts with its background-work binding');
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
});
