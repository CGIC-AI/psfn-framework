import { createHash } from 'node:crypto';
import type { PostTurnActionHandlerResult, PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import { MAINTENANCE_REFLECTION_RUNTIME_CLASS } from '../../core/agent/worker-lanes.js';
import { isRecord } from '../../shared/utils/types.js';

const DISPOSITION_KIND = 'social-outreach.disposition';
const EXECUTION_KIND = 'social-outreach.execute';

/** Content-free durable work, executed only after the source turn releases ownership. */
export function createSocialImpulseOutreachQueue(options: {
  actions: Pick<PostTurnActionRuntime, 'enqueue' | 'registerHandler'>;
  runDisposition(opportunityId: string): Promise<PostTurnActionHandlerResult | void>;
  runExecution(opportunityId: string): Promise<PostTurnActionHandlerResult | void>;
  nextEligibleAt(): number | undefined;
  now(): number;
}) {
  for (const [kind, run] of [
    [DISPOSITION_KIND, options.runDisposition],
    [EXECUTION_KIND, options.runExecution],
  ] as const) {
    options.actions.registerHandler(kind, async action => {
      if (!isRecord(action.payload) || Object.keys(action.payload).length !== 1
        || typeof action.payload.opportunityId !== 'string'
        || !action.payload.opportunityId.startsWith('felt-impulse:would_message:')) {
        throw new Error('Social outreach queue requires an exact opportunity identity');
      }
      const rescheduleAt = options.nextEligibleAt();
      if (rescheduleAt !== undefined) return { rescheduleAt, detail: 'quiet_hours' };
      return await run(action.payload.opportunityId);
    }, { executionMode: 'foreground', runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS });
  }

  const enqueue = async (kind: string, opportunityId: string): Promise<void> => {
    const id = `${kind}:${createHash('sha256').update(opportunityId).digest('hex')}`;
    const result = options.actions.enqueue({
      id,
      kind,
      dedupeKey: id,
      payload: { opportunityId },
      channelId: 'internal:social-outreach',
      sourceMessageId: opportunityId,
      inferredAt: options.now(),
      runAt: options.nextEligibleAt(),
    });
    if (result === 'dropped_budget') throw new Error('Social outreach queue admission was unavailable');
  };
  return {
    enqueueDisposition: (opportunityId: string) => enqueue(DISPOSITION_KIND, opportunityId),
    enqueueExecution: (opportunityId: string) => enqueue(EXECUTION_KIND, opportunityId),
  };
}
