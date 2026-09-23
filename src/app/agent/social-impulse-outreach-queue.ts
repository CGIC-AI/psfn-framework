import { createHash } from 'node:crypto';
import type { PostTurnActionRuntime } from '../../core/agent/post-turn-action-runtime.js';
import { MAINTENANCE_REFLECTION_RUNTIME_CLASS } from '../../core/agent/worker-lanes.js';
import { isRecord } from '../../shared/utils/types.js';

const EVALUATE_KIND = 'social-desire.outreach.evaluate';

/**
 * Durable request for an immediate per-contact social-desire evaluation, for
 * example after a felt EmoSim impulse raised pressure (psfn-framework-vcq8v.4).
 * It runs only after the source turn releases ownership. The queued action
 * uses the maintenance lane (the foreground chat lane admits no queued work);
 * the outreach turn it may open is classified as foreground chat by its
 * internal:social-outreach:<contact> channel.
 */
export function createSocialDesireEvaluationQueue(options: {
  actions: Pick<PostTurnActionRuntime, 'enqueue' | 'registerHandler'>;
  evaluate(): Promise<void>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  options.actions.registerHandler(EVALUATE_KIND, async action => {
    if (!isRecord(action.payload) || Object.keys(action.payload).length !== 1
      || typeof action.payload.sourceId !== 'string' || !action.payload.sourceId.trim()) {
      throw new Error('Social desire evaluation requires an exact source identity');
    }
    await options.evaluate();
  }, { executionMode: 'foreground', runtimeClass: MAINTENANCE_REFLECTION_RUNTIME_CLASS });

  return {
    async request(sourceId: string): Promise<void> {
      const normalized = sourceId.trim();
      if (!normalized) throw new Error('Social desire evaluation requires an exact source identity');
      const id = `${EVALUATE_KIND}:${createHash('sha256').update(normalized).digest('hex')}`;
      const result = options.actions.enqueue({
        id,
        kind: EVALUATE_KIND,
        dedupeKey: id,
        payload: { sourceId: normalized },
        channelId: 'internal:social-outreach',
        sourceMessageId: normalized,
        inferredAt: now(),
      });
      if (result === 'dropped_budget') throw new Error('Social desire evaluation queue admission was unavailable');
    },
  };
}
