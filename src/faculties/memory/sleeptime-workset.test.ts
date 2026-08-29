import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimedConversationalActivityWorkItem,
  ConversationalActivityCheckpointInput,
  ConversationalActivityClaimInput,
  ConversationalActivityFailureInput,
  ConversationalActivityPurpose,
  ConversationalActivityResumeInput,
  ConversationalActivityStageCheckpointInput,
  ConversationalActivityWorkItem,
  ConversationalActivityWorksetPort,
} from '../../core/session/conversational-activity-workset.js';
import {
  SLEEPTIME_WORKSET_STAGES,
  SleeptimeWorksetRunner,
} from './sleeptime-workset.js';

class RestartableWorkset implements ConversationalActivityWorksetPort {
  readonly items = new Map<string, ConversationalActivityWorkItem>();

  constructor(items: readonly ConversationalActivityWorkItem[]) {
    for (const item of items) this.items.set(item.logicalSessionId, structuredClone(item));
  }

  async enumerate(purpose: ConversationalActivityPurpose): Promise<ConversationalActivityWorkItem[]> {
    return [...this.items.values()]
      .filter(item => item.purpose === purpose && item.revision > item.checkpointRevision)
      .map(item => structuredClone(item));
  }

  async claim(input: ConversationalActivityClaimInput): Promise<ClaimedConversationalActivityWorkItem | null> {
    const item = this.items.get(input.logicalSessionId);
    if (!item || item.claimantId || item.revision !== input.revision) return null;
    Object.assign(item, { claimantId: input.claimantId, claimedAtMs: 1 });
    return structuredClone(item) as ClaimedConversationalActivityWorkItem;
  }

  async resumeClaim(input: ConversationalActivityResumeInput): Promise<ClaimedConversationalActivityWorkItem | null> {
    const item = this.items.get(input.logicalSessionId);
    return item?.claimantId === input.claimantId
      ? structuredClone(item) as ClaimedConversationalActivityWorkItem
      : null;
  }

  async checkpointStage(input: ConversationalActivityStageCheckpointInput): Promise<void> {
    const item = this.requireClaim(input);
    item.completedStages = [...item.completedStages, input.stage];
    delete item.lastFailure;
  }

  async recordFailure(input: ConversationalActivityFailureInput): Promise<void> {
    const item = this.requireClaim(input);
    item.lastFailure = { stage: input.stage, message: input.message, failedAtMs: 2 };
  }

  async checkpoint(input: ConversationalActivityCheckpointInput): Promise<void> {
    const item = this.requireClaim(input);
    item.checkpointRevision = input.revision;
    item.completedStages = [];
    delete item.claimantId;
    delete item.claimedAtMs;
    delete item.lastFailure;
  }

  private requireClaim(input: ConversationalActivityCheckpointInput): ConversationalActivityWorkItem {
    const item = this.items.get(input.logicalSessionId);
    if (!item || item.claimantId !== input.claimantId || item.revision !== input.revision) {
      throw new Error('active claim mismatch');
    }
    return item;
  }
}

function item(logicalSessionId: string, occurredAtMs: number): ConversationalActivityWorkItem {
  return {
    purpose: 'sleeptime_consolidation',
    logicalSessionId,
    revision: 1,
    activityKind: logicalSessionId.startsWith('free-time:')
      ? 'experiential_free_time'
      : 'direct_message',
    occurredAtMs,
    checkpointRevision: 0,
    completedStages: [],
  };
}

describe('SleeptimeWorksetRunner', () => {
  it('snapshots every changed session, includes free-time, and drains stages sequentially', async () => {
    const workset = new RestartableWorkset([
      item('dm:beta', 1_000),
      item('free-time:project', 900),
      item('dm:alpha', 800),
    ]);
    const calls: string[] = [];
    const runner = new SleeptimeWorksetRunner({
      workset,
      claimantId: 'companion-sleeptime',
      runStage: async ({ logicalSessionId, stage }) => {
        calls.push(`${logicalSessionId}:${stage}`);
      },
    });

    await expect(runner.run()).resolves.toEqual({
      outcome: 'complete',
      completedSessions: 3,
      remainingSessions: 0,
    });
    expect(calls).toEqual(
      ['dm:alpha', 'dm:beta', 'free-time:project'].flatMap(sessionId => (
        SLEEPTIME_WORKSET_STAGES.map(stage => `${sessionId}:${stage}`)
      )),
    );
    await expect(workset.enumerate('sleeptime_consolidation')).resolves.toEqual([]);
  });

  it('resumes after restart from the first incomplete stage without replaying checkpoints', async () => {
    const workset = new RestartableWorkset([item('dm:alpha', 1_000), item('dm:beta', 900)]);
    const firstCalls: string[] = [];
    const firstRunner = new SleeptimeWorksetRunner({
      workset,
      claimantId: 'companion-sleeptime',
      runStage: async ({ logicalSessionId, stage }) => {
        firstCalls.push(`${logicalSessionId}:${stage}`);
        if (logicalSessionId === 'dm:alpha' && stage === 'dream_meaning') {
          throw new Error('simulated process interruption');
        }
      },
    });

    await expect(firstRunner.run()).resolves.toMatchObject({
      outcome: 'retry',
      completedSessions: 1,
      failures: [{ logicalSessionId: 'dm:alpha', stage: 'dream_meaning' }],
    });
    expect(workset.items.get('dm:alpha')?.completedStages).toEqual([
      'sleep_consolidation',
      'arc_formation',
    ]);

    const resumedCalls: string[] = [];
    const restartedRunner = new SleeptimeWorksetRunner({
      workset,
      claimantId: 'companion-sleeptime',
      runStage: async ({ logicalSessionId, stage }) => {
        resumedCalls.push(`${logicalSessionId}:${stage}`);
      },
    });
    await expect(restartedRunner.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(resumedCalls).toEqual([
      'dm:alpha:dream_meaning',
      'dm:alpha:wiki_pass',
      'dm:alpha:orientation_review',
    ]);
    expect(firstCalls).toContain('dm:beta:orientation_review');
  });

  it('checkpoints before yielding to newly active foreground conversation', async () => {
    const workset = new RestartableWorkset([item('dm:alpha', 1_000), item('dm:beta', 900)]);
    const shouldYield = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const runner = new SleeptimeWorksetRunner({
      workset,
      claimantId: 'companion-sleeptime',
      shouldYield,
      runStage: vi.fn(async () => undefined),
    });

    await expect(runner.run()).resolves.toMatchObject({
      outcome: 'yield',
      completedSessions: 0,
      remainingSessions: 2,
    });
    expect(workset.items.get('dm:alpha')?.completedStages).toEqual(['sleep_consolidation']);
  });
});
