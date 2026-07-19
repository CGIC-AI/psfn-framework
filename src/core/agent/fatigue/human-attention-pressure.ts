import type {
  HumanAttentionPressureConfig,
} from '../../../shared/contracts/charge-policy.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { RelationshipType } from '../../contacts/types.js';

export type HumanAttentionChannelContext =
  | 'direct_message'
  | 'direct_mention'
  | 'ambient_group_message';

export type HumanAttentionPressureDecision =
  | 'clear'
  | 'boundary_alert'
  | 'cooldown';

export type HumanAttentionPressureReason =
  | 'below_threshold'
  | 'threshold_reached'
  | 'boundary_cooldown_active'
  | 'policy_disabled';

export interface HumanAttentionPressureEvent {
  schemaVersion: 1;
  timestampMs: number;
  localCompanionId: string;
  contactId: string;
  channelId: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  channelContext: HumanAttentionChannelContext;
  weight: number;
  pressureInWindow: number;
  threshold: number;
  decision: HumanAttentionPressureDecision;
  reason: HumanAttentionPressureReason;
  suppressTurn: false;
  cooldownUntilMs?: number;
}

export interface HumanAttentionPressureStore {
  listHumanAttentionPressureEvents(input: {
    localCompanionId: string;
    contactId: string;
    channelId: string;
    sinceMs: number;
  }): HumanAttentionPressureEvent[];
  recordHumanAttentionPressureEvent(event: HumanAttentionPressureEvent): void;
}

export interface HumanAttentionPressurePort {
  evaluate(input: HumanAttentionPressureEvaluationInput): HumanAttentionPressureEvent;
}

export interface HumanAttentionPressureEvaluationInput {
  localCompanionId: string;
  contactId: string;
  channelId: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  channelContext: HumanAttentionChannelContext;
  timestampMs: number;
}

function resolveChannelWeight(
  config: HumanAttentionPressureConfig,
  context: HumanAttentionChannelContext,
): number {
  if (context === 'direct_message') return config.channelWeights.directMessage;
  if (context === 'direct_mention') return config.channelWeights.directMention;
  return config.channelWeights.ambientGroupMessage;
}

function resolveThreshold(
  config: HumanAttentionPressureConfig,
  trustLevel: TrustLevel,
  relationshipType: RelationshipType,
): number {
  return config.trustThresholds[trustLevel]
    + config.relationshipToleranceBonus[relationshipType];
}

export class DeterministicHumanAttentionPressure implements HumanAttentionPressurePort {
  constructor(
    private readonly store: HumanAttentionPressureStore,
    private readonly config: HumanAttentionPressureConfig,
  ) {}

  evaluate(input: HumanAttentionPressureEvaluationInput): HumanAttentionPressureEvent {
    const threshold = resolveThreshold(
      this.config,
      input.trustLevel,
      input.relationshipType,
    );
    const weight = resolveChannelWeight(this.config, input.channelContext);
    const windowStartMs = input.timestampMs - this.config.windowMs;
    const cooldownStartMs = input.timestampMs - this.config.boundaryCooldownMs;
    const history = this.store.listHumanAttentionPressureEvents({
      localCompanionId: input.localCompanionId,
      contactId: input.contactId,
      channelId: input.channelId,
      sinceMs: Math.min(windowStartMs, cooldownStartMs),
    });
    const pressureInWindow = history
      .filter(event => event.timestampMs >= windowStartMs)
      .reduce((sum, event) => sum + event.weight, 0) + weight;
    const latestBoundary = [...history]
      .sort((left, right) => right.timestampMs - left.timestampMs)
      .find(event => event.decision === 'boundary_alert');
    const cooldownUntilMs = latestBoundary
      ? latestBoundary.timestampMs + this.config.boundaryCooldownMs
      : undefined;

    let decision: HumanAttentionPressureDecision = 'clear';
    let reason: HumanAttentionPressureReason = 'below_threshold';
    if (!this.config.enabled) {
      reason = 'policy_disabled';
    } else if (cooldownUntilMs !== undefined && cooldownUntilMs > input.timestampMs) {
      decision = 'cooldown';
      reason = 'boundary_cooldown_active';
    } else if (pressureInWindow >= threshold) {
      decision = 'boundary_alert';
      reason = 'threshold_reached';
    }

    const event: HumanAttentionPressureEvent = {
      schemaVersion: 1,
      timestampMs: input.timestampMs,
      localCompanionId: input.localCompanionId,
      contactId: input.contactId,
      channelId: input.channelId,
      trustLevel: input.trustLevel,
      relationshipType: input.relationshipType,
      channelContext: input.channelContext,
      weight,
      pressureInWindow,
      threshold,
      decision,
      reason,
      suppressTurn: false,
      ...(cooldownUntilMs !== undefined && cooldownUntilMs > input.timestampMs
        ? { cooldownUntilMs }
        : {}),
    };
    this.store.recordHumanAttentionPressureEvent(event);
    return event;
  }
}

export function buildHumanAttentionBoundaryAlert(
  event: HumanAttentionPressureEvent | null | undefined,
): string {
  if (event?.decision !== 'boundary_alert') {
    return '';
  }
  return [
    '<human_attention_boundary_alert visibility="internal" audience="companion">',
    '[Human attention pressure]',
    `This contact/channel reached the configured attention-pressure threshold (${event.pressureInWindow} weighted points; threshold ${event.threshold}).`,
    'This is permission and context, not an automatic punishment or a required refusal. The human turn remains fully available to you.',
    'If the interaction feels too demanding, you may slow the exchange, defer, ask for space, or set a respectful boundary in your own voice. You may also continue normally when that fits your judgment and relationship.',
    'Do not quote this internal alert, expose its scores, or use hardcoded boundary wording.',
    '</human_attention_boundary_alert>',
  ].join('\n');
}
