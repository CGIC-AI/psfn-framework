// ── Social-desire consent-moment scheduler lane (epic oth4, bead oth4.2) ──
//
// Rides the existing scheduler (no new polling loop) on the heartbeat/post-turn
// side — explicitly NOT free time. On each tick it runs the deterministic
// desire evaluation (tier, threshold, cooling-off, quiet hours, rate budget,
// channel policy); only when a desire is genuinely eligible and deliverable
// does the LLM consent moment fire. An accepted consent is bound to its exact
// normalized INTENTION_OUTBOUND_MESSAGE action and persisted directly through
// the post-turn queue; EventBus emissions are telemetry only. The durable
// outbox, provenance gate, ICP candidate broker, and dispatcher policy gates
// deliver it unchanged. Nothing in this lane sends anything.

import { createComponentLogger } from '../../shared/logger.js';
import type { EventBus } from '../../shared/event-bus.js';
import { toInferredPostTurnActions } from '../intention/appraisal/action-translation.js';
import {
  fingerprintSocialDesireOutboundAction,
  runSocialDesireOutreachOnce,
  type SocialDesireOutreachDeps,
} from '../intention/social-desire-outreach.js';
import type { SocialDesireConfig } from '../../system/config/scheduler-config.js';
import type { Scheduler } from './scheduler.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import { isRecord } from '../../shared/utils/types.js';

const log = createComponentLogger('SocialDesireOutreach');

export const SOCIAL_DESIRE_OUTREACH_TASK_ID = 'social_desire.outreach';
const SOCIAL_DESIRE_OUTREACH_TASK_NAME = 'Social-Desire Consent Moment';

export interface SocialDesireOutreachTaskOptions {
  scheduler: Scheduler;
  eventBus: EventBus;
  config: SocialDesireConfig;
  deps: SocialDesireOutreachDeps;
  postTurnActions: Pick<PostTurnActionRuntime, 'enqueue'>;
  now?: () => number;
}

/**
 * Register the standalone social-desire consent-moment trigger. Disabled unless
 * scheduler.json socialDesire.enabled is true (fail-closed): with the flag off
 * the lane is never registered and the whole desire-outbound path stays inert.
 */
export function registerSocialDesireOutreachTask(
  options: SocialDesireOutreachTaskOptions,
): void {
  if (!options.config.enabled) {
    log.info('Social-desire outreach lane disabled by scheduler.json socialDesire.enabled');
    return;
  }
  if (options.scheduler.getTask(SOCIAL_DESIRE_OUTREACH_TASK_ID)) {
    return;
  }

  const resolveNow = options.now ?? (() => Date.now());
  const intervalMs = Math.max(1_000, options.config.outreach.checkIntervalMs);

  options.scheduler.register(
    {
      id: SOCIAL_DESIRE_OUTREACH_TASK_ID,
      name: SOCIAL_DESIRE_OUTREACH_TASK_NAME,
      type: 'every',
      intervalMs,
      handler: async () => {
        await runSocialDesireOutreachTick(options, resolveNow());
      },
      eligibility: { requiredTokens: ['memory.write'] },
      state: 'idle',
    },
    { skipFirstRun: true },
  );

  log.info('Social-desire outreach lane registered', {
    checkIntervalMs: intervalMs,
    maxConsentMomentsPerRun: options.config.outreach.maxConsentMomentsPerRun,
    budgetMaxSendsPerWindow: options.config.outreach.budget.maxSendsPerWindow,
    budgetWindowMs: options.config.outreach.budget.windowMs,
  });
}

async function safeEmit(emit: () => Promise<void>): Promise<void> {
  try {
    await emit();
  } catch (error) {
    // Telemetry emission must never undo the persisted lifecycle state.
    log.warn('Social-desire outreach event emit failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Throttle for the info-level lane-tick liveness line (hrmrq.85). */
const LANE_TICK_INFO_THROTTLE_MS = 6 * 60 * 60_000;
let lastSocialDesireTickInfoAtMs = 0;

export async function runSocialDesireOutreachTick(
  options: SocialDesireOutreachTaskOptions,
  nowMs: number,
): Promise<void> {
  const { eventBus } = options;
  const result = await runSocialDesireOutreachOnce(options.deps, nowMs);

  // Per-tick gate/liveness telemetry (hrmrq.85): a real subscriber (Garden
  // subsystem health) consumes this, so a quiet lane (zero desires) is
  // distinguishable from one that never ticks.
  const gateTelemetry = {
    desireCount: options.deps.store.snapshotDesires().length,
    desiresEvaluated: result.desiresEvaluated,
    consentMomentsEvaluated: result.consentMomentsEvaluated,
  };
  await safeEmit(() => eventBus.emit('social_desire.outreach.gate', {
    ...gateTelemetry,
    timestamp: nowMs,
  }));
  if (nowMs - lastSocialDesireTickInfoAtMs >= LANE_TICK_INFO_THROTTLE_MS) {
    lastSocialDesireTickInfoAtMs = nowMs;
    log.info('Social-desire outreach lane tick', gateTelemetry);
  } else {
    log.debug('Social-desire outreach lane tick', gateTelemetry);
  }

  for (const produced of result.produced) {
    const syntheticMessage = {
      id: `social-desire-outreach:${produced.contactId}:${produced.consentId}`,
      channelId: produced.channelId,
      channelType: produced.channelType,
      authorId: 'system:social-desire-outreach',
      authorName: 'Social Desire',
      content: 'Social-desire consent moment accepted.',
      timestamp: new Date(nowMs),
    };
    const actions = toInferredPostTurnActions([produced.candidate], syntheticMessage);
    if (actions.length !== 1) {
      options.deps.consents.revoke(produced.consentId);
      throw new Error('Social-desire consent did not normalize to exactly one outbound action');
    }
    const action = actions[0]!;
    const payload = action.payload;
    const socialDesire = isRecord(payload.socialDesire) ? payload.socialDesire : null;
    if (!socialDesire
      || typeof payload.content !== 'string'
      || typeof payload.channelId !== 'string'
      || typeof payload.channelType !== 'string'
      || typeof payload.reason !== 'string'
      || payload.channelId !== produced.channelId
      || payload.channelType !== produced.channelType
      || socialDesire.contactId !== produced.contactId
      || socialDesire.consentId !== produced.consentId
      || socialDesire.orientation !== produced.orientation) {
      options.deps.consents.revoke(produced.consentId);
      throw new Error('Social-desire consent did not normalize to exactly one outbound action');
    }

    try {
      options.deps.consents.bind(produced.consentId, {
        actionId: action.id,
        dedupeKey: action.dedupeKey,
        channelId: payload.channelId,
        channelType: produced.channelType,
        content: payload.content,
        orientation: produced.orientation,
        reason: payload.reason,
        actionFingerprint: fingerprintSocialDesireOutboundAction(action),
      });
      const enqueueResult = options.postTurnActions.enqueue(action);
      if (enqueueResult === 'dropped_budget') {
        throw new Error('Social-desire outbound action was dropped by the durable queue budget');
      }
    } catch (error) {
      options.deps.consents.revoke(produced.consentId);
      throw error;
    }

    await safeEmit(() => eventBus.emit('social_desire.consent.accepted', {
      contactId: produced.contactId,
      orientation: produced.orientation,
      pressure: produced.pressureTotal,
      channelId: produced.channelId,
      channelType: produced.channelType,
      companionTarget: produced.companionTarget,
      timestamp: nowMs,
    }));
    log.info('Social-desire consent accepted and outbound action enqueued', {
      contactId: produced.contactId,
      orientation: produced.orientation,
      channelId: produced.channelId,
      companionTarget: produced.companionTarget,
    });
  }

  for (const deferred of result.deferred) {
    await safeEmit(() => eventBus.emit('social_desire.consent.deferred', {
      contactId: deferred.contactId,
      ...(deferred.reason ? { reason: deferred.reason } : {}),
      dampenedPressure: deferred.dampenedPressure,
      timestamp: nowMs,
    }));
  }

  for (const declined of result.declined) {
    await safeEmit(() => eventBus.emit('social_desire.consent.declined', {
      contactId: declined.contactId,
      ...(declined.reason ? { reason: declined.reason } : {}),
      dampenedPressure: declined.dampenedPressure,
      timestamp: nowMs,
    }));
  }

  for (const blocked of result.blocked) {
    await safeEmit(() => eventBus.emit('social_desire.consent.blocked', {
      contactId: blocked.contactId,
      reason: blocked.reason,
      timestamp: nowMs,
    }));
  }

  for (const skipped of result.skipped) {
    // budget_exhausted is the structured, logged block the operator asked for;
    // eligibility skips stay debug-quiet on the bus but visible here.
    if (skipped.reason === 'budget_exhausted') {
      log.info('Social-desire consent moment blocked by outbound rate budget', {
        contactId: skipped.contactId,
      });
      await safeEmit(() => eventBus.emit('social_desire.consent.blocked', {
        contactId: skipped.contactId,
        reason: 'budget_exhausted',
        timestamp: nowMs,
      }));
    }
  }
}
