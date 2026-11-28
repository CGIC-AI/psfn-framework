import type { CorrelationMetadata, ModelThinkingEffort } from '../../../shared/contracts/runtime.js';
import type { ModelLookupRuntime } from '../../../primitives/llm/models.js';
import {
  clampEffortToSupport,
  resolveCandidateReasoningSupport,
  type CandidateReasoningSupport,
} from '../../../primitives/llm/reasoning-support.js';
import type { RoutingCandidate, RoutingPurpose } from '../../../primitives/llm/routing.js';
import {
  createDefaultReasoningEffortSettings,
  thinkingEffortRank,
  type ReasoningEffortLane,
  type ReasoningEffortSettings,
} from '../../../system/config/reasoning-effort-config.js';
import { resolveReasoningEffortLane } from './lanes.js';
import {
  ReasoningEffortOverrideStore,
  type ReasoningEffortOverride,
  type ReasoningOverrideKey,
  type ReasoningOverrideScope,
} from './overrides.js';

type RequestContext = Partial<CorrelationMetadata> | undefined;

export type ReasoningEffortSource = 'companion' | 'lane_setting' | 'slot_tuning';

export interface ReasoningEffortDecision {
  lane: ReasoningEffortLane;
  provider: string;
  model: string;
  /** The level asked for before the model's support bounded it. */
  requested: ModelThinkingEffort;
  source: ReasoningEffortSource;
  overrideScope?: ReasoningOverrideScope;
  /** The level sent to the provider; absent when the bound model cannot reason. */
  effective?: ModelThinkingEffort;
  supportedLevels: readonly ModelThinkingEffort[];
}

/** Content-free record of a companion reasoning choice, for the event bus and Garden. */
export interface ReasoningEffortChange {
  lane: ReasoningEffortLane;
  scope: ReasoningOverrideScope;
  /** The chosen level, or null when the choice at this scope was cleared. */
  level: ModelThinkingEffort | null;
  previousLevel: ModelThinkingEffort | null;
  provider: string;
  model: string;
  supportedLevels: readonly ModelThinkingEffort[];
  channelId?: string;
  companionId?: string;
  timestamp: number;
}

export type ReasoningEffortSetResult =
  | { ok: true; change: ReasoningEffortChange; decision: ReasoningEffortDecision }
  | { ok: false; reason: 'no_lane' | 'model_cannot_reason' | 'level_unsupported' | 'no_turn' | 'no_session'; supportedLevels: readonly ModelThinkingEffort[] };

interface ReasoningLogger {
  info(message: string, fields?: Record<string, unknown>): void;
}

export interface ReasoningEffortRuntimeOptions {
  /** Live owner baseline (per-companion overlay applied); absent means the contract default. */
  readonly getSettings: () => ReasoningEffortSettings | undefined;
  readonly catalogue: ModelLookupRuntime;
  /** The routed primary candidate for a purpose (a turn binds `chat` before its first call). */
  readonly resolvePurposeCandidate: (purpose: RoutingPurpose) => RoutingCandidate | undefined;
  readonly logger: ReasoningLogger;
  readonly onChange?: (change: ReasoningEffortChange) => void;
  readonly now?: () => number;
}

/**
 * Applies the companion's reasoning effort to its own model calls.
 *
 * Precedence for a laned call: the companion's own choice (turn, then
 * session, then lane) wins outright; otherwise the owner's lane baseline is a
 * floor under the slot's models.json `tuning.thinkingEffort`, so an owner's
 * higher slot value is never lowered. The result is bounded to the levels the
 * bound model supports; a model that cannot reason gets no effort at all,
 * logged once per model. Calls on no lane are left exactly as routed.
 */
export class ReasoningEffortRuntime {
  private readonly overrides = new ReasoningEffortOverrideStore();
  private readonly loggedModels = new Set<string>();
  /** The first candidate of the most recent turn call, i.e. the model the turn is bound to. */
  private lastBound: { sessionKey?: string; candidate: RoutingCandidate } | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ReasoningEffortRuntimeOptions) {
    this.now = options.now ?? Date.now;
  }

  decide(candidate: RoutingCandidate, context: RequestContext): ReasoningEffortDecision | null {
    const lane = resolveReasoningEffortLane(context);
    if (!lane) return null;
    const override = this.overrides.resolve(overrideKey(lane, context));
    const support = resolveCandidateReasoningSupport(this.options.catalogue, candidate);
    const { requested, source } = override
      ? { requested: override.level, source: 'companion' as const }
      : this.baseline(lane, candidate);
    const effective = clampEffortToSupport(requested, support);
    const decision: ReasoningEffortDecision = {
      lane,
      provider: candidate.provider,
      model: candidate.model,
      requested,
      source,
      ...(override ? { overrideScope: override.scope } : {}),
      ...(effective ? { effective } : {}),
      supportedLevels: support.levels,
    };
    this.logBoundOnce(decision, support);
    return decision;
  }

  /**
   * A turn call's routed candidates as they should be sent. The first one is
   * remembered as the model this turn is bound to, so the companion's
   * `reasoning_*` actions are bounded by the model that actually answers.
   */
  applyToCandidates(candidates: readonly RoutingCandidate[], context: RequestContext): RoutingCandidate[] {
    const first = candidates[0];
    if (first) {
      const sessionKey = overrideKey('chat', context).sessionKey;
      this.lastBound = { ...(sessionKey ? { sessionKey } : {}), candidate: first };
    }
    return candidates.map(candidate => this.applyToCandidate(candidate, context));
  }

  /** Whether a candidate can reason, and the levels it accepts. */
  reasoningSupport(candidate: RoutingCandidate): CandidateReasoningSupport {
    return resolveCandidateReasoningSupport(this.options.catalogue, candidate);
  }

  /** The model the current turn is bound to, falling back to the routed chat primary. */
  boundCandidate(context: RequestContext): RoutingCandidate | undefined {
    const sessionKey = overrideKey('chat', context).sessionKey;
    if (this.lastBound && this.lastBound.sessionKey === sessionKey) return this.lastBound.candidate;
    return this.options.resolvePurposeCandidate('chat');
  }

  /** The candidate as it should be sent: its effort set to the lane decision. */
  applyToCandidate(candidate: RoutingCandidate, context: RequestContext): RoutingCandidate {
    const decision = this.decide(candidate, context);
    if (!decision) return candidate;
    if (!decision.effective) {
      // The model cannot reason: send no effort rather than one pi-ai drops silently.
      return candidate.thinkingEffort === undefined ? candidate : { ...candidate, thinkingEffort: undefined };
    }
    return {
      ...candidate,
      thinkingEffort: decision.effective,
      ...(candidate.supportsReasoning === undefined ? { supportsReasoning: true } : {}),
    };
  }

  /**
   * A model hint carrying the lane effort for a direct (non-turn) own-time
   * call, decided against the purpose's routed primary; undefined off-lane or
   * when that model cannot reason.
   */
  resolveModelHint(
    purpose: RoutingPurpose,
    context: RequestContext,
  ): { thinkingEffort: ModelThinkingEffort } | undefined {
    const candidate = this.options.resolvePurposeCandidate(purpose);
    if (!candidate) return undefined;
    const effective = this.decide(candidate, context)?.effective;
    return effective ? { thinkingEffort: effective } : undefined;
  }

  setOverride(
    input: { level: ModelThinkingEffort; scope: ReasoningOverrideScope },
    candidate: RoutingCandidate,
    context: RequestContext,
  ): ReasoningEffortSetResult {
    const lane = resolveReasoningEffortLane(context);
    const support = resolveCandidateReasoningSupport(this.options.catalogue, candidate);
    if (!lane) return { ok: false, reason: 'no_lane', supportedLevels: support.levels };
    if (!support.reasoning || support.levels.length === 0) {
      return { ok: false, reason: 'model_cannot_reason', supportedLevels: [] };
    }
    if (!support.levels.includes(input.level)) {
      return { ok: false, reason: 'level_unsupported', supportedLevels: support.levels };
    }
    const key = overrideKey(lane, context);
    if (input.scope === 'turn' && !key.turnId) return { ok: false, reason: 'no_turn', supportedLevels: support.levels };
    if (input.scope === 'session' && !key.sessionKey) {
      return { ok: false, reason: 'no_session', supportedLevels: support.levels };
    }
    const previous = this.overrides.get(input.scope, key);
    const override: ReasoningEffortOverride = {
      level: input.level,
      scope: input.scope,
      lane,
      setAtMs: this.now(),
      ...(input.scope === 'session' ? { sessionKey: key.sessionKey } : {}),
      ...(input.scope === 'turn' ? { turnId: key.turnId } : {}),
    };
    this.overrides.set(override);
    const change = this.recordChange(lane, input.scope, input.level, previous, candidate, support, context);
    return { ok: true, change, decision: this.decide(candidate, context)! };
  }

  clearOverride(
    scope: ReasoningOverrideScope,
    candidate: RoutingCandidate,
    context: RequestContext,
  ): ReasoningEffortChange | null {
    const lane = resolveReasoningEffortLane(context);
    if (!lane) return null;
    const removed = this.overrides.clear(scope, overrideKey(lane, context));
    if (!removed) return null;
    const support = resolveCandidateReasoningSupport(this.options.catalogue, candidate);
    return this.recordChange(lane, scope, null, removed, candidate, support, context);
  }

  private baseline(
    lane: ReasoningEffortLane,
    candidate: RoutingCandidate,
  ): { requested: ModelThinkingEffort; source: ReasoningEffortSource } {
    const laneLevel = (this.options.getSettings() ?? createDefaultReasoningEffortSettings())[lane];
    // The slot's own effort, as main sends it: tuning.thinkingEffort, or
    // medium for a slot that only enables thinking.
    const slotLevel = candidate.thinkingEffort ?? (candidate.thinkingEnabled === true ? 'medium' : undefined);
    if (slotLevel && thinkingEffortRank(slotLevel) > thinkingEffortRank(laneLevel)) {
      return { requested: slotLevel, source: 'slot_tuning' };
    }
    return { requested: laneLevel, source: 'lane_setting' };
  }

  private recordChange(
    lane: ReasoningEffortLane,
    scope: ReasoningOverrideScope,
    level: ModelThinkingEffort | null,
    previous: ReasoningEffortOverride | undefined,
    candidate: RoutingCandidate,
    support: CandidateReasoningSupport,
    context: RequestContext,
  ): ReasoningEffortChange {
    const change: ReasoningEffortChange = {
      lane,
      scope,
      level,
      previousLevel: previous?.level ?? null,
      provider: candidate.provider,
      model: candidate.model,
      supportedLevels: support.levels,
      ...(context?.channelId ? { channelId: context.channelId } : {}),
      ...(context?.companionId ? { companionId: context.companionId } : {}),
      timestamp: this.now(),
    };
    this.options.logger.info('Companion reasoning effort changed', { ...change, supportedLevels: [...change.supportedLevels] });
    this.options.onChange?.(change);
    return change;
  }

  private logBoundOnce(decision: ReasoningEffortDecision, support: CandidateReasoningSupport): void {
    if (decision.effective === decision.requested) return;
    const key = `${decision.provider}/${decision.model}:${decision.requested}`;
    if (this.loggedModels.has(key)) return;
    this.loggedModels.add(key);
    this.options.logger.info(
      decision.effective
        ? 'Reasoning effort bounded to the levels this model supports'
        : 'Reasoning effort ignored: the bound model cannot reason',
      {
        lane: decision.lane,
        provider: decision.provider,
        model: decision.model,
        requested: decision.requested,
        ...(decision.effective ? { effective: decision.effective } : {}),
        supportSource: support.source,
      },
    );
  }
}

function overrideKey(lane: ReasoningEffortLane, context: RequestContext): ReasoningOverrideKey {
  const sessionKey = context?.sessionId?.trim() || context?.channelId?.trim() || undefined;
  const turnId = context?.turnId?.trim() || undefined;
  return {
    lane,
    ...(sessionKey ? { sessionKey } : {}),
    ...(turnId ? { turnId } : {}),
  };
}
