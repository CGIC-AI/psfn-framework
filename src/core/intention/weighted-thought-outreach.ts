// ── Internal-state-driven outreach initiation (Charter 6.24, bead 1xb.2) ──
//
// The last mile from internal state to an unprompted outbound message. A
// weighted thought whose decayed weight crosses `nudgeThreshold` produces a
// NUDGE — an LLM consent moment the companion accepts or declines. On accept we
// emit an INTENTION_OUTBOUND_MESSAGE post-turn action through the EXISTING
// durable-outbox delivery handler (dedupe, provenance, quiet-hours, dispatcher
// policy gates, rate limits all unchanged). On decline the thought is dampened
// (not deleted) so it defers and can re-accumulate.
//
// Everything before the nudge is DETERMINISTIC and zero-LLM: the weight gate,
// channel resolution, and the quiet-hours time gate all run first, so the LLM
// nudge only fires when a thought is genuinely near threshold, deliverable to a
// policy-approved channel, and inside the delivery window.

import type { ChannelType, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
import {
  evaluateDeterministicGate,
  type GateDecision,
} from '../../shared/gating/deterministic-gate.js';
import {
  evaluateProactiveOutboundTimeGate,
  type ProactiveQuietHoursConfig,
} from './proactive-time-gate.js';
import {
  INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
  type IntentionOutboundMessageActionPayload,
} from './appraisal/types.js';
import { hashString } from './appraisal/shared.js';
import {
  applyDeclineDampening,
  markThoughtAccepted,
  markThoughtNudged,
  topWeightedThoughts,
  type ThoughtWeight,
  type WeightedThoughtLifecycleConfig,
} from './weighted-thoughts.js';
import type { WeightedThoughtStorePort } from './weighted-thought-store-port.js';

export const WEIGHTED_THOUGHT_OUTREACH_GATE_LANE = 'weighted_thought_outreach';

export type NudgeDecision =
  | { action: 'accept'; content: string }
  | { action: 'decline'; reason?: string };

export interface NudgeEvaluationInput {
  thought: ThoughtWeight;
  weight: number;
  channelId: string;
  channelType: ChannelType;
}

/**
 * The consent moment. Production wires this to an LLM call that lets the
 * companion accept (with a message) or decline; tests inject fakes. Called ONLY
 * when the deterministic pre-checks all passed.
 */
export interface NudgeEvaluator {
  evaluate(input: NudgeEvaluationInput): Promise<NudgeDecision>;
}

export interface OutreachChannelPolicy {
  /** Configured primary private heartbeat/DM channel (the default target). */
  primaryChannelId?: string;
  primaryChannelType: ChannelType;
  /**
   * Fail-closed group-continuation approver. A concern raised in a group
   * channel may target that group ONLY when this approves (source-channel
   * provenance + trust/capability policy + permissions + rate limits). Absent
   * or returning false routes the item internal-only.
   */
  approveGroupContinuation?: (input: {
    thought: ThoughtWeight;
    sourceChannelId: string;
    sourceChannelType: ChannelType;
  }) => boolean | Promise<boolean>;
}

export type OutreachChannelResolution =
  | { outcome: 'deliver'; channelId: string; channelType: ChannelType; target: 'primary' | 'group_continuation' }
  | { outcome: 'internal_only' | 'reject'; reason: string };

/**
 * Provenance-driven, fail-closed channel resolution. Prefers the configured
 * primary private channel; a group source may continue in-channel only with
 * explicit policy approval; anything else stays internal-only. Never guesses an
 * arbitrary target.
 */
export async function resolveOutreachChannel(
  thought: ThoughtWeight,
  policy: OutreachChannelPolicy,
): Promise<OutreachChannelResolution> {
  const { provenance } = thought;
  const hasLiveProvenance = Boolean(provenance.concernId ?? provenance.pendingFollowUpId);
  if (!hasLiveProvenance) {
    // The delivery handler fail-closes on outbound without live provenance;
    // keep such thoughts internal rather than forming an unprovoked send.
    return { outcome: 'internal_only', reason: 'missing_live_provenance' };
  }

  const primaryChannelId = policy.primaryChannelId?.trim() || undefined;
  const sourceChannelId = provenance.sourceChannelId?.trim() || undefined;

  // A source channel distinct from the primary DM is a group/guild continuation
  // candidate — allowed only as a policy-approved continuation.
  if (sourceChannelId && primaryChannelId && sourceChannelId !== primaryChannelId) {
    const sourceChannelType = provenance.sourceChannelType;
    if (!sourceChannelType) {
      return { outcome: 'internal_only', reason: 'group_continuation_missing_channel_type' };
    }
    const approved = policy.approveGroupContinuation
      ? await policy.approveGroupContinuation({ thought, sourceChannelId, sourceChannelType })
      : false;
    if (!approved) {
      return { outcome: 'internal_only', reason: 'group_continuation_denied' };
    }
    return {
      outcome: 'deliver',
      channelId: sourceChannelId,
      channelType: sourceChannelType,
      target: 'group_continuation',
    };
  }

  if (!primaryChannelId) {
    return { outcome: 'reject', reason: 'no_primary_channel' };
  }
  return {
    outcome: 'deliver',
    channelId: primaryChannelId,
    channelType: policy.primaryChannelType,
    target: 'primary',
  };
}

export function buildOutboundActionCandidate(input: {
  thought: ThoughtWeight;
  content: string;
  channelId: string;
  channelType: ChannelType;
}): PostTurnActionCandidate {
  const { thought, content, channelId, channelType } = input;
  return {
    kind: INTENTION_OUTBOUND_MESSAGE_ACTION_KIND,
    dedupeKey: `${INTENTION_OUTBOUND_MESSAGE_ACTION_KIND}:weighted-thought:${thought.id}:${hashString(content)}`,
    payload: {
      channelId,
      channelType,
      content,
      reason: `weighted_thought:${thought.thoughtClass}`,
      ...(thought.provenance.pendingFollowUpId
        ? { pendingFollowUpId: thought.provenance.pendingFollowUpId }
        : {}),
      ...(thought.provenance.concernId ? { concernIds: [thought.provenance.concernId] } : {}),
    } satisfies IntentionOutboundMessageActionPayload,
    maxRetries: 1,
  };
}

export interface WeightedThoughtOutreachDeps {
  store: WeightedThoughtStorePort;
  lifecycleConfig: WeightedThoughtLifecycleConfig;
  nudgeThreshold: number;
  maxNudgesPerRun: number;
  quietHours?: ProactiveQuietHoursConfig | null;
  channelPolicy: OutreachChannelPolicy;
  nudgeEvaluator: NudgeEvaluator;
  contactId?: string;
}

export interface OutreachActionProduced {
  thoughtId: string;
  thoughtClass: string;
  weight: number;
  candidate: PostTurnActionCandidate;
  channelId: string;
  channelType: ChannelType;
  target: 'primary' | 'group_continuation';
}

export interface WeightedThoughtOutreachRunResult {
  gate: GateDecision;
  /** Whether the deterministic gate opened (i.e. any nudge evaluation ran). */
  evaluated: boolean;
  /** Number of times the LLM nudge evaluator was invoked (0 when gate closed). */
  nudgesEvaluated: number;
  produced: OutreachActionProduced[];
  declined: Array<{ thoughtId: string; reason?: string; dampenedWeight: number }>;
  blocked: Array<{ thoughtId: string; reason: string; channelId?: string }>;
  deferred: Array<{ thoughtId: string; reason: string; nextEligibleAtMs: number }>;
}

/**
 * Evaluate weighted thoughts once and produce outreach actions for accepted
 * nudges. Pure orchestration over injected ports — no bus, no scheduler — so it
 * is directly testable. Emits nothing; the scheduler wrapper turns the result
 * into typed events and enqueues the produced actions.
 */
export async function runWeightedThoughtOutreachOnce(
  deps: WeightedThoughtOutreachDeps,
  nowMs: number,
): Promise<WeightedThoughtOutreachRunResult> {
  const snapshot = deps.store.snapshotActiveThoughts(deps.contactId);
  const limit = Math.max(1, Math.floor(deps.maxNudgesPerRun));
  const top = topWeightedThoughts(snapshot, nowMs, limit, deps.lifecycleConfig.relevanceFloor);
  const maxWeight = top.length > 0 ? top[0]!.weight : 0;

  const gate = evaluateDeterministicGate(
    {
      lane: WEIGHTED_THOUGHT_OUTREACH_GATE_LANE,
      openWhenAny: [{ input: 'maxWeight', comparator: 'gte', threshold: deps.nudgeThreshold }],
      closedReason: 'no_thought_near_threshold',
      openReason: 'thought_crossed_threshold',
    },
    { maxWeight, thoughtCount: snapshot.length },
  );

  const result: WeightedThoughtOutreachRunResult = {
    gate,
    evaluated: gate.open,
    nudgesEvaluated: 0,
    produced: [],
    declined: [],
    blocked: [],
    deferred: [],
  };
  if (!gate.open) {
    // Zero LLM: nothing is near threshold.
    return result;
  }

  for (const view of top) {
    if (result.produced.length >= limit) break;
    if (view.weight < deps.nudgeThreshold) break; // top is sorted desc

    // 1. Deterministic channel resolution (fail-closed, provenance-driven).
    const channel = await resolveOutreachChannel(view.thought, deps.channelPolicy);
    if (channel.outcome !== 'deliver') {
      result.blocked.push({ thoughtId: view.thought.id, reason: channel.reason });
      continue;
    }

    // 2. Deterministic quiet-hours / delivery-window gate (still zero LLM).
    const timeGate = evaluateProactiveOutboundTimeGate({
      nowMs,
      quietHours: deps.quietHours ?? null,
    });
    if (!timeGate.allowed) {
      result.deferred.push({
        thoughtId: view.thought.id,
        reason: timeGate.reason,
        nextEligibleAtMs: timeGate.nextEligibleAtMs,
      });
      continue;
    }

    // 3. The consent moment (LLM). She may accept or decline.
    result.nudgesEvaluated += 1;
    const nudged = markThoughtNudged(view.thought, nowMs);
    const decision = await deps.nudgeEvaluator.evaluate({
      thought: nudged,
      weight: view.weight,
      channelId: channel.channelId,
      channelType: channel.channelType,
    });

    if (decision.action === 'accept') {
      const content = decision.content.trim();
      if (!content) {
        // An accept with blank content cannot produce an outbound message.
        // Persist decline dampening so the thought defers instead of
        // re-qualifying (and burning an LLM nudge) on every run.
        await deps.store.save(applyDeclineDampening(nudged, deps.lifecycleConfig, nowMs));
        result.blocked.push({ thoughtId: view.thought.id, reason: 'empty_nudge_content', channelId: channel.channelId });
        continue;
      }
      await deps.store.save(markThoughtAccepted(nudged, nowMs));
      result.produced.push({
        thoughtId: view.thought.id,
        thoughtClass: view.thought.thoughtClass,
        weight: view.weight,
        candidate: buildOutboundActionCandidate({
          thought: view.thought,
          content,
          channelId: channel.channelId,
          channelType: channel.channelType,
        }),
        channelId: channel.channelId,
        channelType: channel.channelType,
        target: channel.target,
      });
      continue;
    }

    // Declined: dampen (not zero) so it defers and can re-accumulate.
    const dampened = applyDeclineDampening(nudged, deps.lifecycleConfig, nowMs);
    await deps.store.save(dampened);
    result.declined.push({
      thoughtId: view.thought.id,
      ...(decision.reason ? { reason: decision.reason } : {}),
      dampenedWeight: dampened.accumulatedWeight,
    });
  }

  return result;
}
