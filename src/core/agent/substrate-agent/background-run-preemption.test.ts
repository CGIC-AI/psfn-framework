import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_CONTINUATION_RUNTIME_CLASS,
  FOREGROUND_CHAT_RUNTIME_CLASS,
  MAINTENANCE_REFLECTION_RUNTIME_CLASS,
  POST_TURN_APPRAISAL_RUNTIME_CLASS,
} from '../worker-lanes.js';
import {
  AgentRunPreemptedError,
  BackgroundTurnPreemption,
  resolveTurnRunLaneClass,
  shouldPreemptAgentRun,
} from './background-run-preemption.js';

describe('background turn preemption policy (z4vhu)', () => {
  it('lets only a higher-priority lane preempt a preemptable run; unknown lanes never preempt', () => {
    expect(shouldPreemptAgentRun(MAINTENANCE_REFLECTION_RUNTIME_CLASS, FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(true);
    expect(shouldPreemptAgentRun(BACKGROUND_CONTINUATION_RUNTIME_CLASS, FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(true);
    expect(shouldPreemptAgentRun(FOREGROUND_CHAT_RUNTIME_CLASS, FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(false);
    expect(shouldPreemptAgentRun(POST_TURN_APPRAISAL_RUNTIME_CLASS, FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(false);
    expect(shouldPreemptAgentRun(MAINTENANCE_REFLECTION_RUNTIME_CLASS, MAINTENANCE_REFLECTION_RUNTIME_CLASS)).toBe(false);
    expect(shouldPreemptAgentRun(undefined, FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(false);
    expect(shouldPreemptAgentRun('made_up_lane', FOREGROUND_CHAT_RUNTIME_CLASS)).toBe(false);
  });

  it('classifies sleeptime / dream-pass turns as maintenance and chat as foreground', () => {
    const base = { authorId: 'a', authorName: 'A', content: 'x', timestamp: new Date(0), channelType: 'terminal' as const };
    expect(resolveTurnRunLaneClass({ ...base, id: 's', channelId: 'internal:reflection:sleeptime-review' }))
      .toBe(MAINTENANCE_REFLECTION_RUNTIME_CLASS);
    expect(resolveTurnRunLaneClass({ ...base, id: 'd', channelId: 'internal:reflection:dream-pass' }))
      .toBe(MAINTENANCE_REFLECTION_RUNTIME_CLASS);
    expect(resolveTurnRunLaneClass({ ...base, id: 'c', channelId: 'api:person:session' }))
      .toBe(FOREGROUND_CHAT_RUNTIME_CLASS);
  });

  it('refuses a preempted background turn that has not reached its run yet, and waits for it to settle', async () => {
    let current: string | null = null;
    const preemption = new BackgroundTurnPreemption({
      preemptActiveRun: () => null,
      currentTurnMessageId: () => current,
    });
    let reachPrompt!: () => void;
    const setup = new Promise<void>((resolve) => { reachPrompt = resolve; });
    const background = preemption.track(
      { messageId: 'sleeptime-1', laneClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS },
      async () => {
        await setup;
        current = 'sleeptime-1';
        // What the prompt() guard does for the calling turn.
        if (preemption.isCurrentTurnPreempted()) throw new AgentRunPreemptedError();
        return 'ran';
      },
    ).catch((error: unknown) => error);

    const preempting = preemption.preemptFor({ messageId: 'chat-1', laneClass: FOREGROUND_CHAT_RUNTIME_CLASS });
    reachPrompt();
    const events = await preempting;
    expect(events).toMatchObject([{
      preemptorMessageId: 'chat-1',
      preemptedMessageId: 'sleeptime-1',
      preemptedLaneClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS,
      abortedActiveRun: false,
    }]);
    expect(await background).toBeInstanceOf(AgentRunPreemptedError);
  });

  it('is a no-op without tracked lower-priority turns', async () => {
    const preemption = new BackgroundTurnPreemption({
      preemptActiveRun: () => { throw new Error('must not abort anything'); },
      currentTurnMessageId: () => null,
    });
    expect(preemption.preemptFor({ messageId: 'chat', laneClass: FOREGROUND_CHAT_RUNTIME_CLASS })).toBeNull();
  });
});
