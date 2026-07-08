import {
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  type FatiguePolicyChannelSetting,
  type FatiguePolicyChannelSettingLimit,
  type FatiguePolicyConfig,
} from '../../../shared/contracts/charge-policy.js';
import type { FatigueBudgetEvent } from '../../../shared/contracts/runtime.js';

export type FatigueTuningRecommendationAction =
  | 'collect_more_data'
  | 'keep'
  | 'decrease_busy_group_allowance'
  | 'increase_companion_room_allowance';

export interface FatigueTuningBounds {
  minSoftTarget: number;
  maxSoftTarget: number;
  minHardCap: number;
  maxHardCap: number;
}

export interface FatigueTuningMetrics {
  eventCount: number;
  chargedEventCount: number;
  overchargeEventCount: number;
  freeEventCount: number;
  hardSuppressedCount: number;
  humanReengagementCount: number;
  overchargeRate: number;
  hardSuppressionRate: number;
}

export interface FatigueTuningRecommendation {
  channelSetting: FatiguePolicyChannelSetting;
  current: FatiguePolicyChannelSettingLimit;
  recommended: FatiguePolicyChannelSettingLimit;
  bounds: FatigueTuningBounds;
  action: FatigueTuningRecommendationAction;
  reasons: string[];
  metrics: FatigueTuningMetrics;
}

export interface FatigueTuningReport {
  schemaVersion: 1;
  generatedAtMs: number;
  minEvents: number;
  recommendations: FatigueTuningRecommendation[];
}

export interface BuildFatigueTuningReportInput {
  events: readonly FatigueBudgetEvent[];
  policy: FatiguePolicyConfig;
  nowMs?: number;
  minEvents?: number;
  stepResponses?: number;
  operatorBounds?: Partial<Record<FatiguePolicyChannelSetting, Partial<FatigueTuningBounds>>>;
}

interface MutableMetrics {
  eventCount: number;
  chargedEventCount: number;
  overchargeEventCount: number;
  freeEventCount: number;
  hardSuppressedCount: number;
  humanReengagementCount: number;
}

const CHANNEL_SETTINGS = new Set<string>(FATIGUE_POLICY_CHANNEL_SETTING_VALUES);
const BUSY_SETTINGS = new Set<FatiguePolicyChannelSetting>(['busy_human_group', 'public_group']);
const ROOMY_SETTINGS = new Set<FatiguePolicyChannelSetting>(['quiet_companion_room', 'dm', 'one_human_companion_hosted']);
const DEFAULT_MIN_EVENTS = 4;
const DEFAULT_STEP_RESPONSES = 1;

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readStringDetail(event: FatigueBudgetEvent, key: string): string | undefined {
  const value = event.details?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readChannelSetting(event: FatigueBudgetEvent): FatiguePolicyChannelSetting {
  const channelSetting = readStringDetail(event, 'channelSetting');
  return channelSetting && CHANNEL_SETTINGS.has(channelSetting)
    ? channelSetting as FatiguePolicyChannelSetting
    : 'unknown';
}

function readBooleanDetail(event: FatigueBudgetEvent, key: string): boolean {
  return event.details?.[key] === true;
}

function createMutableMetrics(): MutableMetrics {
  return {
    eventCount: 0,
    chargedEventCount: 0,
    overchargeEventCount: 0,
    freeEventCount: 0,
    hardSuppressedCount: 0,
    humanReengagementCount: 0,
  };
}

function updateMetrics(metrics: MutableMetrics, event: FatigueBudgetEvent): void {
  metrics.eventCount += 1;
  if (event.decision === 'charged') {
    metrics.chargedEventCount += 1;
  } else if (event.decision === 'overcharge') {
    metrics.overchargeEventCount += 1;
  } else {
    metrics.freeEventCount += 1;
  }
  if (readStringDetail(event, 'enforcementDecision') === 'suppressed_hard_exhausted') {
    metrics.hardSuppressedCount += 1;
  }
  if (
    event.triggeringAuthor.role === 'human'
    || readBooleanDetail(event, 'humanReengaged')
    || readBooleanDetail(event, 'recentHumanParticipation')
  ) {
    metrics.humanReengagementCount += 1;
  }
}

function finalizeMetrics(metrics: MutableMetrics): FatigueTuningMetrics {
  const chargeableEventCount = metrics.chargedEventCount + metrics.overchargeEventCount;
  return {
    ...metrics,
    overchargeRate: chargeableEventCount > 0
      ? metrics.overchargeEventCount / chargeableEventCount
      : 0,
    hardSuppressionRate: metrics.eventCount > 0
      ? metrics.hardSuppressedCount / metrics.eventCount
      : 0,
  };
}

function resolveBounds(input: {
  channelSetting: FatiguePolicyChannelSetting;
  current: FatiguePolicyChannelSettingLimit;
  override?: Partial<FatigueTuningBounds>;
}): FatigueTuningBounds {
  const defaultMinSoftTarget = BUSY_SETTINGS.has(input.channelSetting) ? 1 : 2;
  const defaultMinHardCap = BUSY_SETTINGS.has(input.channelSetting) ? 2 : 3;
  const maxSoftTarget = input.override?.maxSoftTarget ?? input.current.maxSoftTarget;
  const maxHardCap = input.override?.maxHardCap ?? input.current.maxHardCap;
  const minSoftTarget = input.override?.minSoftTarget ?? defaultMinSoftTarget;
  const minHardCap = input.override?.minHardCap ?? defaultMinHardCap;
  return {
    minSoftTarget: clampInteger(minSoftTarget, 0, maxSoftTarget),
    maxSoftTarget: clampInteger(maxSoftTarget, minSoftTarget, Number.MAX_SAFE_INTEGER),
    minHardCap: clampInteger(minHardCap, 0, maxHardCap),
    maxHardCap: clampInteger(maxHardCap, minHardCap, Number.MAX_SAFE_INTEGER),
  };
}

function recommendForChannelSetting(input: {
  channelSetting: FatiguePolicyChannelSetting;
  current: FatiguePolicyChannelSettingLimit;
  bounds: FatigueTuningBounds;
  metrics: FatigueTuningMetrics;
  minEvents: number;
  stepResponses: number;
}): FatigueTuningRecommendation {
  if (input.metrics.eventCount < input.minEvents) {
    return {
      channelSetting: input.channelSetting,
      current: input.current,
      recommended: input.current,
      bounds: input.bounds,
      action: 'collect_more_data',
      reasons: ['insufficient_fatigue_events'],
      metrics: input.metrics,
    };
  }

  const strained = input.metrics.overchargeRate >= 0.25 || input.metrics.hardSuppressionRate >= 0.1;
  const recommended = { ...input.current };
  const reasons: string[] = [];
  let action: FatigueTuningRecommendationAction = 'keep';

  if (BUSY_SETTINGS.has(input.channelSetting) && strained) {
    action = 'decrease_busy_group_allowance';
    recommended.maxSoftTarget = clampInteger(
      input.current.maxSoftTarget - input.stepResponses,
      input.bounds.minSoftTarget,
      input.bounds.maxSoftTarget,
    );
    recommended.maxHardCap = clampInteger(
      input.current.maxHardCap - input.stepResponses,
      Math.max(input.bounds.minHardCap, recommended.maxSoftTarget),
      input.bounds.maxHardCap,
    );
    reasons.push('busy_group_reserve_pressure');
  } else if (ROOMY_SETTINGS.has(input.channelSetting) && strained) {
    action = 'increase_companion_room_allowance';
    recommended.maxSoftTarget = clampInteger(
      input.current.maxSoftTarget + input.stepResponses,
      input.bounds.minSoftTarget,
      input.bounds.maxSoftTarget,
    );
    recommended.maxHardCap = clampInteger(
      input.current.maxHardCap + input.stepResponses,
      Math.max(input.bounds.minHardCap, recommended.maxSoftTarget),
      input.bounds.maxHardCap,
    );
    reasons.push('quiet_room_reserve_pressure');
  } else {
    reasons.push('within_current_policy');
  }

  return {
    channelSetting: input.channelSetting,
    current: input.current,
    recommended,
    bounds: input.bounds,
    action,
    reasons,
    metrics: input.metrics,
  };
}

export function buildFatigueTuningReport(input: BuildFatigueTuningReportInput): FatigueTuningReport {
  const grouped = new Map<FatiguePolicyChannelSetting, MutableMetrics>();
  for (const event of input.events) {
    const channelSetting = readChannelSetting(event);
    const metrics = grouped.get(channelSetting) ?? createMutableMetrics();
    updateMetrics(metrics, event);
    grouped.set(channelSetting, metrics);
  }

  const minEvents = input.minEvents ?? DEFAULT_MIN_EVENTS;
  const stepResponses = input.stepResponses ?? DEFAULT_STEP_RESPONSES;
  const recommendations = FATIGUE_POLICY_CHANNEL_SETTING_VALUES
    .map((channelSetting) => {
      const current = input.policy.channelSettingLimits[channelSetting];
      const bounds = resolveBounds({
        channelSetting,
        current,
        override: input.operatorBounds?.[channelSetting],
      });
      return recommendForChannelSetting({
        channelSetting,
        current,
        bounds,
        metrics: finalizeMetrics(grouped.get(channelSetting) ?? createMutableMetrics()),
        minEvents,
        stepResponses,
      });
    });

  return {
    schemaVersion: 1,
    generatedAtMs: input.nowMs ?? Date.now(),
    minEvents,
    recommendations,
  };
}
