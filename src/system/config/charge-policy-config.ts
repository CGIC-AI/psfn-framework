import { join } from 'node:path';
import {
  loadRequiredJson,
  loadSeedJson,
} from './load-or-seed.js';
import {
  assertNoUnknownKeys as assertNoUnknownConfigKeys,
  assertPositiveInteger,
} from './validators.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { OWNER_FILE_MODE_COMPANION_POLICY } from './owner-file-modes.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SEED_FILE_NAME,
  CHARGE_POLICY_SURFACE_VALUES,
  ICP_COST_PURPOSE_VALUES,
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  HUMAN_ATTENTION_RELATIONSHIP_VALUES,
  HUMAN_ATTENTION_TRUST_LEVEL_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRationaleMap,
  type FatiguePolicyActivityThresholds,
  type FatiguePolicyChannelSettingLimit,
  type FatiguePolicyConfig,
  type FatiguePolicyIntentMultiplier,
  type FatiguePolicyOverchargeConfig,
  type FatiguePolicyResponseBudget,
  type FatiguePolicyStateThresholds,
  type FatigueRoomEpisodeCircuitBreakerConfig,
  type FatigueRoomEpisodePressureConfig,
  type FatigueSocialPotConfig,
  type HumanAttentionPressureConfig,
  type IcpCostBreakerConfig,
} from '../../shared/contracts/charge-policy.js';

export {
  CHARGE_POLICY_FILE_NAME,
  CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SEED_FILE_NAME,
  CHARGE_POLICY_SURFACE_VALUES,
  ICP_COST_PURPOSE_VALUES,
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  HUMAN_ATTENTION_RELATIONSHIP_VALUES,
  HUMAN_ATTENTION_TRUST_LEVEL_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRationaleMap,
  type ChargePolicyReferenceModelClass,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
  type FatiguePolicyChannelSetting,
  type FatiguePolicyConfig,
  type FatiguePolicyIntent,
  type FatiguePolicyRelationshipClass,
  type FatiguePolicyState,
  type HumanAttentionPressureConfig,
  type IcpCostBreakerConfig,
  type IcpCostPurpose,
} from '../../shared/contracts/charge-policy.js';

interface ChargePolicyLoadOptions {
  seedDir?: string;
}

const MAX_FATIGUE_OVERCHARGE_RESERVE_RESPONSES = 10;
const CHARGE_POLICY_ERROR_PREFIX = 'Invalid charge policy';

function resolveSeedDir(seedDir?: string): string {
  const resolved = (seedDir ?? process.env.CONFIG_DIR ?? './config').trim();
  if (!resolved) {
    throw new Error('Charge policy seed directory is required');
  }
  return resolved;
}

function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldPath: string,
): void {
  assertNoUnknownConfigKeys(value, allowedKeys, fieldPath, { errorPrefix: CHARGE_POLICY_ERROR_PREFIX });
}

function parseNonNegativeNumber(
  value: unknown,
  fieldPath: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite number >= 0`);
  }
  return value;
}

function parsePositiveNumber(value: unknown, fieldPath: string): number {
  const parsed = parseNonNegativeNumber(value, fieldPath);
  if (parsed === 0) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite number > 0`);
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: unknown,
  fieldPath: string,
): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || !Number.isInteger(value)
    || value < 0
  ) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a finite integer >= 0`);
  }
  return value;
}

function parsePositiveInteger(
  value: unknown,
  fieldPath: string,
  options: { max?: number } = {},
): number {
  return assertPositiveInteger(value, fieldPath, {
    min: 1,
    max: options.max,
    message: ({ fieldLabel }) => `Invalid charge policy: ${fieldLabel} must be a finite integer > 0`,
    messages: {
      aboveMax: ({ fieldLabel, max }) => `Invalid charge policy: ${fieldLabel} must be <= ${max}`,
    },
  });
}

function parseBoolean(
  value: unknown,
  fieldPath: string,
): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid charge policy: ${fieldPath} must be a boolean`);
  }
  return value;
}

function parseIcpCostBreakerConfig(
  raw: unknown,
  fieldPath: string,
): IcpCostBreakerConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  const enabled = parseBoolean(raw.enabled, `${fieldPath}.enabled`);
  if (!enabled) {
    assertNoUnknownKeys(raw, ['enabled'], fieldPath);
    return { enabled: false };
  }

  assertNoUnknownKeys(raw, [
    'enabled',
    'warningThresholdUsd',
    'hardLimitUsd',
    'finalCloseoutReserveUsd',
    'pendingReservationStaleAfterMs',
    'includedCostPurposes',
  ], fieldPath);
  const warningThresholdUsd = parsePositiveNumber(
    raw.warningThresholdUsd,
    `${fieldPath}.warningThresholdUsd`,
  );
  const hardLimitUsd = parsePositiveNumber(raw.hardLimitUsd, `${fieldPath}.hardLimitUsd`);
  const finalCloseoutReserveUsd = parsePositiveNumber(
    raw.finalCloseoutReserveUsd,
    `${fieldPath}.finalCloseoutReserveUsd`,
  );
  if (Math.abs((warningThresholdUsd + finalCloseoutReserveUsd) - hardLimitUsd) > 1e-9) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.warningThresholdUsd + `
      + `${fieldPath}.finalCloseoutReserveUsd must equal ${fieldPath}.hardLimitUsd`,
    );
  }
  const includedCostPurposes = parseFixedObjectMap(
    raw.includedCostPurposes,
    `${fieldPath}.includedCostPurposes`,
    ICP_COST_PURPOSE_VALUES,
    parseBoolean,
  );
  if (!includedCostPurposes.conversation_turn) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.includedCostPurposes.conversation_turn must be true`,
    );
  }
  return {
    enabled: true,
    warningThresholdUsd,
    hardLimitUsd,
    finalCloseoutReserveUsd,
    pendingReservationStaleAfterMs: parsePositiveInteger(
      raw.pendingReservationStaleAfterMs,
      `${fieldPath}.pendingReservationStaleAfterMs`,
    ),
    includedCostPurposes,
  };
}

/**
 * Law 38 retired surfaces (emh3p.5, hrmrq.42): selfhood and native baseline
 * processes are not charge surfaces at all, so they must not be configurable.
 * Owner files carrying the retired keys fail closed with the reason and the
 * remedy, not a bare unknown-key error.
 */
const RETIRED_SELFHOOD_CHARGE_SURFACES = [
  'memoryRead',
  'memoryWrite',
  'ownerFileInspection',
  'localFilesystem',
  'localEmbedding',
  'externalEmbedding',
] as const;

function assertNoRetiredSelfhoodSurfaces(raw: unknown, fieldPath: string): void {
  if (!isRecord(raw)) return;
  const retired = RETIRED_SELFHOOD_CHARGE_SURFACES.filter(key => key in raw);
  if (retired.length > 0) {
    throw new Error(
      `Invalid charge policy at ${fieldPath}: ${retired.join(', ')} `
      + 'are retired charge surfaces. Selfhood and native baseline processes are never metered '
      + '(charter Law 38) — delete these keys from the owner file.',
    );
  }
}

function parseFixedNumericMap<T extends string>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
): Record<T, number> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as Record<T, number>;
  for (const key of allowedKeys) {
    parsed[key] = parseNonNegativeNumber(raw[key], `${fieldPath}.${key}`);
  }
  return parsed;
}

function parseFixedObjectMap<T extends string, V>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
  parseEntry: (value: unknown, fieldPath: string) => V,
): Record<T, V> {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as Record<T, V>;
  for (const key of allowedKeys) {
    parsed[key] = parseEntry(raw[key], `${fieldPath}.${key}`);
  }
  return parsed;
}

function parseOptionalTextMap<T extends string>(
  raw: unknown,
  fieldPath: string,
  allowedKeys: readonly T[],
): ChargePolicyRationaleMap<T> | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }

  assertNoUnknownKeys(raw, allowedKeys, fieldPath);

  const parsed = {} as ChargePolicyRationaleMap<T>;
  for (const key of allowedKeys) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Invalid charge policy: ${fieldPath}.${key} must be a non-empty string`);
    }
    parsed[key] = value.trim();
  }

  return Object.keys(parsed).length > 0 ? parsed : {};
}

function assertNonZeroEntriesHaveRationales<T extends string>(
  values: Record<T, number>,
  rationales: ChargePolicyRationaleMap<T> | undefined,
  fieldPath: string,
  rationaleFieldPath: string,
): void {
  const missing = (Object.entries(values) as Array<[T, number]>)
    .filter(([, amount]) => amount > 0)
    .map(([key]) => key)
    .filter((key) => {
      if (!rationales) {
        return true;
      }
      const rationale = rationales[key];
      return !rationale || rationale.trim().length === 0;
    });

  if (missing.length > 0) {
    throw new Error(
      `Invalid charge policy: ${rationaleFieldPath} must include non-empty entries for nonzero ${fieldPath}: ${missing.join(', ')}`,
    );
  }
}

function parseFatigueResponseBudget(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyResponseBudget {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['softTarget', 'hardCap'], fieldPath);
  const softTarget = parseNonNegativeInteger(raw.softTarget, `${fieldPath}.softTarget`);
  const hardCap = parseNonNegativeInteger(raw.hardCap, `${fieldPath}.hardCap`);
  if (hardCap < softTarget) {
    throw new Error(`Invalid charge policy: ${fieldPath}.hardCap must be >= ${fieldPath}.softTarget`);
  }
  return { softTarget, hardCap };
}

function parseFatigueChannelSettingLimit(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyChannelSettingLimit {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['maxSoftTarget', 'maxHardCap'], fieldPath);
  const maxSoftTarget = parseNonNegativeInteger(raw.maxSoftTarget, `${fieldPath}.maxSoftTarget`);
  const maxHardCap = parseNonNegativeInteger(raw.maxHardCap, `${fieldPath}.maxHardCap`);
  if (maxHardCap < maxSoftTarget) {
    throw new Error(`Invalid charge policy: ${fieldPath}.maxHardCap must be >= ${fieldPath}.maxSoftTarget`);
  }
  return { maxSoftTarget, maxHardCap };
}

function parseFatigueIntentMultiplier(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyIntentMultiplier {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['softTargetMultiplier', 'hardCapMultiplier'], fieldPath);
  const softTargetMultiplier = parseNonNegativeNumber(
    raw.softTargetMultiplier,
    `${fieldPath}.softTargetMultiplier`,
  );
  const hardCapMultiplier = parseNonNegativeNumber(
    raw.hardCapMultiplier,
    `${fieldPath}.hardCapMultiplier`,
  );
  if (hardCapMultiplier < softTargetMultiplier) {
    throw new Error(`Invalid charge policy: ${fieldPath}.hardCapMultiplier must be >= ${fieldPath}.softTargetMultiplier`);
  }
  return { softTargetMultiplier, hardCapMultiplier };
}

function parseFatigueActivityThresholds(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyActivityThresholds {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    ['busyRecentMessageCount', 'busyHumanParticipantCount', 'quietRecentMessageCount'],
    fieldPath,
  );
  return {
    busyRecentMessageCount: parsePositiveInteger(
      raw.busyRecentMessageCount,
      `${fieldPath}.busyRecentMessageCount`,
    ),
    busyHumanParticipantCount: parsePositiveInteger(
      raw.busyHumanParticipantCount,
      `${fieldPath}.busyHumanParticipantCount`,
    ),
    quietRecentMessageCount: parsePositiveInteger(
      raw.quietRecentMessageCount,
      `${fieldPath}.quietRecentMessageCount`,
    ),
  };
}

function parseFatigueStateThresholds(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyStateThresholds {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['nearingLimitRemainingResponses', 'wrapUpRemainingResponses'], fieldPath);
  return {
    nearingLimitRemainingResponses: parseNonNegativeInteger(
      raw.nearingLimitRemainingResponses,
      `${fieldPath}.nearingLimitRemainingResponses`,
    ),
    wrapUpRemainingResponses: parseNonNegativeInteger(
      raw.wrapUpRemainingResponses,
      `${fieldPath}.wrapUpRemainingResponses`,
    ),
  };
}

function parseFatigueOverchargeConfig(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyOverchargeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'enabled',
      'reserveResponses',
      'recentHumanParticipationWindowMs',
      'minRecentHumanMessages',
      'minRecentHumanParticipants',
    ],
    fieldPath,
  );
  const reserveResponses = parsePositiveInteger(
    raw.reserveResponses,
    `${fieldPath}.reserveResponses`,
    { max: MAX_FATIGUE_OVERCHARGE_RESERVE_RESPONSES },
  );
  return {
    enabled: parseBoolean(raw.enabled, `${fieldPath}.enabled`),
    reserveResponses,
    recentHumanParticipationWindowMs: parsePositiveInteger(
      raw.recentHumanParticipationWindowMs,
      `${fieldPath}.recentHumanParticipationWindowMs`,
    ),
    minRecentHumanMessages: parsePositiveInteger(
      raw.minRecentHumanMessages,
      `${fieldPath}.minRecentHumanMessages`,
    ),
    minRecentHumanParticipants: parsePositiveInteger(
      raw.minRecentHumanParticipants,
      `${fieldPath}.minRecentHumanParticipants`,
    ),
  };
}

function parseFatigueRoomEpisodePressureConfig(
  raw: unknown,
  fieldPath: string,
): FatigueRoomEpisodePressureConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, [
    'halfLifeMs',
    'windowMs',
    'replyPressureUnits',
    'reactionPressureUnits',
    'elevatedThreshold',
    'wrapUpThreshold',
    'maxLeaseThresholdBias',
  ], fieldPath);
  const halfLifeMs = parsePositiveInteger(raw.halfLifeMs, `${fieldPath}.halfLifeMs`);
  const windowMs = parsePositiveInteger(raw.windowMs, `${fieldPath}.windowMs`);
  if (windowMs < halfLifeMs) {
    throw new Error(`Invalid charge policy: ${fieldPath}.windowMs must be >= ${fieldPath}.halfLifeMs`);
  }
  const replyPressureUnits = parsePositiveNumber(
    raw.replyPressureUnits,
    `${fieldPath}.replyPressureUnits`,
  );
  const reactionPressureUnits = parseNonNegativeNumber(
    raw.reactionPressureUnits,
    `${fieldPath}.reactionPressureUnits`,
  );
  if (reactionPressureUnits > replyPressureUnits) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.reactionPressureUnits must be <= ${fieldPath}.replyPressureUnits`,
    );
  }
  const elevatedThreshold = parsePositiveNumber(
    raw.elevatedThreshold,
    `${fieldPath}.elevatedThreshold`,
  );
  const wrapUpThreshold = parsePositiveNumber(
    raw.wrapUpThreshold,
    `${fieldPath}.wrapUpThreshold`,
  );
  if (wrapUpThreshold <= elevatedThreshold) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.wrapUpThreshold must be > ${fieldPath}.elevatedThreshold`,
    );
  }
  const maxLeaseThresholdBias = parsePositiveNumber(
    raw.maxLeaseThresholdBias,
    `${fieldPath}.maxLeaseThresholdBias`,
  );
  return {
    halfLifeMs,
    windowMs,
    replyPressureUnits,
    reactionPressureUnits,
    elevatedThreshold,
    wrapUpThreshold,
    maxLeaseThresholdBias,
  };
}

function parseFatigueRoomEpisodeCircuitBreakerConfig(
  raw: unknown,
  fieldPath: string,
  wrapUpThreshold: number,
): FatigueRoomEpisodeCircuitBreakerConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, ['tripThreshold', 'resetThreshold'], fieldPath);
  const tripThreshold = parsePositiveNumber(raw.tripThreshold, `${fieldPath}.tripThreshold`);
  const resetThreshold = parsePositiveNumber(raw.resetThreshold, `${fieldPath}.resetThreshold`);
  // Law 36 / charter §8.11: the breaker sits above ordinary healthy use — it may
  // only trip PAST the wrap-up band, so graceful wrap-up is always invited first.
  if (tripThreshold <= wrapUpThreshold) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.tripThreshold must be > roomEpisodePressure.wrapUpThreshold (${wrapUpThreshold})`,
    );
  }
  // Hysteresis: reset strictly below trip so the breaker cannot flap on jitter.
  if (resetThreshold >= tripThreshold) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.resetThreshold must be < ${fieldPath}.tripThreshold`,
    );
  }
  return { tripThreshold, resetThreshold };
}

function parseFatigueSocialRegulationConfig(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyConfig['socialRegulation'] {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(raw, [
    'relationshipPressureHalfLifeMs',
    'relationshipPressureWindowMs',
    'unansweredInitiationAfterMs',
    'conversationMaturingRatio',
    'marginalChargeUnits',
    'declinedPressureUnits',
    'deferredPressureUnits',
    'unansweredPressureUnits',
    'continuationEvidence',
    'roomEpisodePressure',
    'roomEpisodeCircuitBreaker',
  ], fieldPath);
  const roomEpisodePressure = parseFatigueRoomEpisodePressureConfig(
    raw.roomEpisodePressure,
    `${fieldPath}.roomEpisodePressure`,
  );
  const roomEpisodeCircuitBreaker = parseFatigueRoomEpisodeCircuitBreakerConfig(
    raw.roomEpisodeCircuitBreaker,
    `${fieldPath}.roomEpisodeCircuitBreaker`,
    roomEpisodePressure.wrapUpThreshold,
  );
  const relationshipPressureHalfLifeMs = parsePositiveInteger(
    raw.relationshipPressureHalfLifeMs,
    `${fieldPath}.relationshipPressureHalfLifeMs`,
  );
  const relationshipPressureWindowMs = parsePositiveInteger(
    raw.relationshipPressureWindowMs,
    `${fieldPath}.relationshipPressureWindowMs`,
  );
  if (relationshipPressureWindowMs < relationshipPressureHalfLifeMs) {
    throw new Error(`Invalid charge policy: ${fieldPath}.relationshipPressureWindowMs must be >= ${fieldPath}.relationshipPressureHalfLifeMs`);
  }
  const conversationMaturingRatio = parseNonNegativeNumber(
    raw.conversationMaturingRatio,
    `${fieldPath}.conversationMaturingRatio`,
  );
  if (conversationMaturingRatio <= 0 || conversationMaturingRatio >= 1) {
    throw new Error(`Invalid charge policy: ${fieldPath}.conversationMaturingRatio must be > 0 and < 1`);
  }
  const continuationEvidence = raw.continuationEvidence;
  if (!isRecord(continuationEvidence)) {
    throw new Error(`Invalid charge policy: ${fieldPath}.continuationEvidence must be an object`);
  }
  assertNoUnknownKeys(continuationEvidence, [
    'recentHumanParticipation',
    'activeWorkOrResearch',
    'explicitPeerInvitation',
  ], `${fieldPath}.continuationEvidence`);
  return {
    relationshipPressureHalfLifeMs,
    relationshipPressureWindowMs,
    unansweredInitiationAfterMs: parsePositiveInteger(
      raw.unansweredInitiationAfterMs,
      `${fieldPath}.unansweredInitiationAfterMs`,
    ),
    conversationMaturingRatio,
    marginalChargeUnits: parsePositiveInteger(
      raw.marginalChargeUnits,
      `${fieldPath}.marginalChargeUnits`,
    ),
    declinedPressureUnits: parseNonNegativeNumber(
      raw.declinedPressureUnits,
      `${fieldPath}.declinedPressureUnits`,
    ),
    deferredPressureUnits: parseNonNegativeNumber(
      raw.deferredPressureUnits,
      `${fieldPath}.deferredPressureUnits`,
    ),
    unansweredPressureUnits: parseNonNegativeNumber(
      raw.unansweredPressureUnits,
      `${fieldPath}.unansweredPressureUnits`,
    ),
    continuationEvidence: {
      recentHumanParticipation: parseBoolean(
        continuationEvidence.recentHumanParticipation,
        `${fieldPath}.continuationEvidence.recentHumanParticipation`,
      ),
      activeWorkOrResearch: parseBoolean(
        continuationEvidence.activeWorkOrResearch,
        `${fieldPath}.continuationEvidence.activeWorkOrResearch`,
      ),
      explicitPeerInvitation: parseBoolean(
        continuationEvidence.explicitPeerInvitation,
        `${fieldPath}.continuationEvidence.explicitPeerInvitation`,
      ),
    },
    roomEpisodePressure,
    roomEpisodeCircuitBreaker,
  };
}

function parseFatigueSocialPotConfig(
  raw: unknown,
  fieldPath: string,
): FatigueSocialPotConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'capUnits',
      'perChannelDrawFraction',
      'regenerationTickMs',
      'regenerationUnitsPerTick',
    ],
    fieldPath,
  );
  const capUnits = parsePositiveNumber(raw.capUnits, `${fieldPath}.capUnits`);
  const perChannelDrawFraction = parsePositiveNumber(
    raw.perChannelDrawFraction,
    `${fieldPath}.perChannelDrawFraction`,
  );
  if (perChannelDrawFraction > 1) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.perChannelDrawFraction must be <= 1`,
    );
  }
  const regenerationTickMs = parsePositiveInteger(
    raw.regenerationTickMs,
    `${fieldPath}.regenerationTickMs`,
  );
  const regenerationUnitsPerTick = parsePositiveNumber(
    raw.regenerationUnitsPerTick,
    `${fieldPath}.regenerationUnitsPerTick`,
  );
  if (regenerationUnitsPerTick > capUnits) {
    throw new Error(
      `Invalid charge policy: ${fieldPath}.regenerationUnitsPerTick must be <= ${fieldPath}.capUnits`,
    );
  }
  return {
    capUnits,
    perChannelDrawFraction,
    regenerationTickMs,
    regenerationUnitsPerTick,
  };
}

function parseHumanAttentionPressureConfig(
  raw: unknown,
  fieldPath: string,
): HumanAttentionPressureConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'enabled',
      'windowMs',
      'boundaryCooldownMs',
      'trustThresholds',
      'relationshipToleranceBonus',
      'channelWeights',
    ],
    fieldPath,
  );
  const trustThresholds = parseFixedObjectMap(
    raw.trustThresholds,
    `${fieldPath}.trustThresholds`,
    HUMAN_ATTENTION_TRUST_LEVEL_VALUES,
    parsePositiveInteger,
  );
  if (
    trustThresholds.public >= trustThresholds.regular
    || trustThresholds.regular >= trustThresholds.trusted
    || trustThresholds.trusted >= trustThresholds.primary
  ) {
    throw new Error(
      `Invalid charge policy: ${fieldPath} trust thresholds must strictly increase from public through primary`,
    );
  }
  const relationshipToleranceBonus = parseFixedObjectMap(
    raw.relationshipToleranceBonus,
    `${fieldPath}.relationshipToleranceBonus`,
    HUMAN_ATTENTION_RELATIONSHIP_VALUES,
    parseNonNegativeInteger,
  );
  if (!isRecord(raw.channelWeights)) {
    throw new Error(`Invalid charge policy: ${fieldPath}.channelWeights must be an object`);
  }
  assertNoUnknownKeys(
    raw.channelWeights,
    ['directMessage', 'directMention', 'ambientGroupMessage'],
    `${fieldPath}.channelWeights`,
  );

  const channelWeights = {
    directMessage: parsePositiveNumber(
      raw.channelWeights.directMessage,
      `${fieldPath}.channelWeights.directMessage`,
    ),
    directMention: parsePositiveNumber(
      raw.channelWeights.directMention,
      `${fieldPath}.channelWeights.directMention`,
    ),
    ambientGroupMessage: parseNonNegativeNumber(
      raw.channelWeights.ambientGroupMessage,
      `${fieldPath}.channelWeights.ambientGroupMessage`,
    ),
  };
  if (trustThresholds.primary <= Math.max(...Object.values(channelWeights))) {
    throw new Error(
      `Invalid charge policy: ${fieldPath} primary threshold must exceed every single-message channel weight`,
    );
  }

  return {
    enabled: parseBoolean(raw.enabled, `${fieldPath}.enabled`),
    windowMs: parsePositiveInteger(raw.windowMs, `${fieldPath}.windowMs`),
    boundaryCooldownMs: parsePositiveInteger(
      raw.boundaryCooldownMs,
      `${fieldPath}.boundaryCooldownMs`,
    ),
    trustThresholds,
    relationshipToleranceBonus,
    channelWeights,
  };
}

function parseFatiguePolicyConfig(
  raw: unknown,
  fieldPath: string,
): FatiguePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'relationshipBudgets',
      'channelSettingLimits',
      'intentMultipliers',
      'activityThresholds',
      'stateThresholds',
      'overcharge',
      'socialRegulation',
      'socialPot',
      'humanAttention',
    ],
    fieldPath,
  );

  return {
    relationshipBudgets: parseFixedObjectMap(
      raw.relationshipBudgets,
      `${fieldPath}.relationshipBudgets`,
      FATIGUE_POLICY_RELATIONSHIP_VALUES,
      parseFatigueResponseBudget,
    ),
    channelSettingLimits: parseFixedObjectMap(
      raw.channelSettingLimits,
      `${fieldPath}.channelSettingLimits`,
      FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
      parseFatigueChannelSettingLimit,
    ),
    intentMultipliers: parseFixedObjectMap(
      raw.intentMultipliers,
      `${fieldPath}.intentMultipliers`,
      FATIGUE_POLICY_INTENT_VALUES,
      parseFatigueIntentMultiplier,
    ),
    activityThresholds: parseFatigueActivityThresholds(
      raw.activityThresholds,
      `${fieldPath}.activityThresholds`,
    ),
    stateThresholds: parseFatigueStateThresholds(
      raw.stateThresholds,
      `${fieldPath}.stateThresholds`,
    ),
    overcharge: parseFatigueOverchargeConfig(
      raw.overcharge,
      `${fieldPath}.overcharge`,
    ),
    socialRegulation: parseFatigueSocialRegulationConfig(
      raw.socialRegulation,
      `${fieldPath}.socialRegulation`,
    ),
    socialPot: parseFatigueSocialPotConfig(
      raw.socialPot,
      `${fieldPath}.socialPot`,
    ),
    humanAttention: parseHumanAttentionPressureConfig(
      raw.humanAttention,
      `${fieldPath}.humanAttention`,
    ),
  };
}

export function validateChargePolicyConfig(
  raw: unknown,
  sourcePath: string,
): ChargePolicyConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid charge policy at ${sourcePath}: expected object`);
  }

  assertNoUnknownKeys(
    raw,
    [
      'schemaVersion',
      'runChargeQuotaByLane',
      'surfaceCosts',
      'surfaceRationales',
      'moa',
      'referenceModelClassPricing',
      'referenceModelClassPricingRationales',
      'icpCostBreaker',
      'fatigue',
    ],
    sourcePath,
  );

  if (raw.schemaVersion !== 1) {
    throw new Error(`Invalid charge policy at ${sourcePath}: schemaVersion must equal 1`);
  }

  if (!isRecord(raw.moa)) {
    throw new Error(`Invalid charge policy at ${sourcePath}: moa must be an object`);
  }
  assertNoUnknownKeys(raw.moa, ['perRoundMultiplierByReferenceModelClass'], `${sourcePath}.moa`);

  const runChargeQuotaByLane = parseFixedNumericMap(
    raw.runChargeQuotaByLane,
    `${sourcePath}.runChargeQuotaByLane`,
    CHARGE_POLICY_RUNTIME_LANE_VALUES,
  );
  assertNoRetiredSelfhoodSurfaces(raw.surfaceCosts, `${sourcePath}.surfaceCosts`);
  assertNoRetiredSelfhoodSurfaces(raw.surfaceRationales, `${sourcePath}.surfaceRationales`);
  const surfaceCosts = parseFixedNumericMap(
    raw.surfaceCosts,
    `${sourcePath}.surfaceCosts`,
    CHARGE_POLICY_SURFACE_VALUES,
  );
  const surfaceRationales = parseOptionalTextMap(
    raw.surfaceRationales,
    `${sourcePath}.surfaceRationales`,
    CHARGE_POLICY_SURFACE_VALUES,
  );
  const referenceModelClassPricing = parseFixedNumericMap(
    raw.referenceModelClassPricing,
    `${sourcePath}.referenceModelClassPricing`,
    CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  );
  const referenceModelClassPricingRationales = parseOptionalTextMap(
    raw.referenceModelClassPricingRationales,
    `${sourcePath}.referenceModelClassPricingRationales`,
    CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
  );

  assertNonZeroEntriesHaveRationales(
    surfaceCosts,
    surfaceRationales,
    `${sourcePath}.surfaceCosts`,
    `${sourcePath}.surfaceRationales`,
  );
  assertNonZeroEntriesHaveRationales(
    referenceModelClassPricing,
    referenceModelClassPricingRationales,
    `${sourcePath}.referenceModelClassPricing`,
    `${sourcePath}.referenceModelClassPricingRationales`,
  );
  const fatigue = parseFatiguePolicyConfig(raw.fatigue, `${sourcePath}.fatigue`);
  const icpCostBreaker = parseIcpCostBreakerConfig(
    raw.icpCostBreaker,
    `${sourcePath}.icpCostBreaker`,
  );
  if (
    fatigue.socialRegulation.marginalChargeUnits !==
    surfaceCosts.companionSocialContinuation
  ) {
    throw new Error(
      `Invalid charge policy at ${sourcePath}: fatigue.socialRegulation.marginalChargeUnits must equal surfaceCosts.companionSocialContinuation`,
    );
  }

  return {
    schemaVersion: 1,
    runChargeQuotaByLane,
    surfaceCosts,
    ...(surfaceRationales !== undefined ? { surfaceRationales } : {}),
    moa: {
      perRoundMultiplierByReferenceModelClass: parseFixedNumericMap(
        raw.moa.perRoundMultiplierByReferenceModelClass,
        `${sourcePath}.moa.perRoundMultiplierByReferenceModelClass`,
        CHARGE_POLICY_REFERENCE_MODEL_CLASS_VALUES,
      ),
    },
    referenceModelClassPricing,
    ...(referenceModelClassPricingRationales !== undefined
      ? { referenceModelClassPricingRationales }
      : {}),
    icpCostBreaker,
    fatigue,
  };
}

export function loadChargePolicyConfig(
  dataDir: string,
  options: ChargePolicyLoadOptions = {},
): ChargePolicyConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadRequiredJson({
    dataPath: join(dataDir, CHARGE_POLICY_FILE_NAME),
    examplePath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
    validate: validateChargePolicyConfig,
  });
}

export function loadChargePolicySeedDefaults(
  options: ChargePolicyLoadOptions = {},
): ChargePolicyConfig {
  const seedDir = resolveSeedDir(options.seedDir);
  return loadSeedJson({
    seedPath: join(seedDir, CHARGE_POLICY_SEED_FILE_NAME),
    validate: validateChargePolicyConfig,
  });
}

export function saveChargePolicyConfig(
  dataDir: string,
  nextConfig: unknown,
): ChargePolicyConfig {
  const validated = validateChargePolicyConfig(nextConfig, CHARGE_POLICY_FILE_NAME);
  writeJsonAtomic(join(dataDir, CHARGE_POLICY_FILE_NAME), validated, {
    mode: OWNER_FILE_MODE_COMPANION_POLICY,
  });
  return validated;
}
