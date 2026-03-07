import type { CapabilityTier } from '../types.js';
import type { CapabilityAccess, CapabilityAccessProvider } from './access.js';
import type { CapabilityToken } from './tokens.js';

export type RuntimeTier = CapabilityTier;
export type EligibilityLLMPurpose = 'chat' | 'background' | 'reasoning' | 'import_processing';
export type EligibilityPluginType = 'channel' | 'stt' | 'tts';

export type EligibilityOperation =
  | { kind: 'tool.execute'; toolName: string }
  | { kind: 'llm.purpose'; purpose: string }
  | { kind: 'scheduler.task'; taskId: string; taskName: string; taskType: 'every' | 'one-shot' }
  | { kind: 'post_turn.action'; actionKind: string; actionId?: string }
  | { kind: 'plugin.activate'; pluginType: EligibilityPluginType; pluginId: string }
  | { kind: 'plugin.action'; pluginType: EligibilityPluginType; pluginId: string; action: string };

export type EligibilityReasonCode =
  | 'allowed'
  | 'missing_capability_tokens'
  | 'tier_below_minimum'
  | 'custom_tier_minimum_unsupported'
  | 'unsupported_operation';

export interface EligibilityRequirements {
  requiredTokens?: readonly CapabilityToken[];
  minimumTier?: Exclude<RuntimeTier, 'custom'>;
}

export interface EligibilityDecision {
  allowed: boolean;
  reasonCode: EligibilityReasonCode;
  operation: EligibilityOperation;
  tier: RuntimeTier;
  requiredTokens: CapabilityToken[];
  missingTokens: CapabilityToken[];
  minimumTier?: Exclude<RuntimeTier, 'custom'>;
}

export type EligibilityDecisionReporter = (decision: EligibilityDecision) => void;

const DEFAULT_LLM_PURPOSE_REQUIREMENTS: Readonly<Record<EligibilityLLMPurpose, EligibilityRequirements>> = {
  chat: {},
  background: { requiredTokens: ['memory.write'] },
  reasoning: {},
  import_processing: { requiredTokens: ['memory.write'] },
};

const TIER_ORDER: Readonly<Record<Exclude<RuntimeTier, 'custom'>, number>> = {
  nursery: 0,
  apprentice: 1,
  autonomous: 2,
};

export class EligibilityDeniedError extends Error {
  readonly code = 'eligibility_denied';
  readonly decision: EligibilityDecision;

  constructor(decision: EligibilityDecision) {
    const descriptor = describeOperation(decision.operation);
    const detail = decision.reasonCode === 'missing_capability_tokens'
      ? `missing tokens: ${decision.missingTokens.join(', ')}`
      : decision.reasonCode === 'tier_below_minimum'
        ? `minimum tier: ${decision.minimumTier}`
        : decision.reasonCode;
    super(`Eligibility denied for ${descriptor} (${detail})`);
    this.name = 'EligibilityDeniedError';
    this.decision = decision;
  }
}

export class EligibilityGate {
  private readonly getAccess: CapabilityAccessProvider;
  private readonly reporter?: EligibilityDecisionReporter;

  constructor(getAccess: CapabilityAccessProvider, reporter?: EligibilityDecisionReporter) {
    this.getAccess = getAccess;
    this.reporter = reporter;
  }

  evaluate(
    operation: EligibilityOperation,
    requirements?: EligibilityRequirements,
  ): EligibilityDecision {
    const decision = evaluateEligibilityDecision(
      this.getAccess(),
      operation,
      requirements,
    );
    this.reporter?.(decision);
    return decision;
  }

  requireAllowed(
    operation: EligibilityOperation,
    requirements?: EligibilityRequirements,
  ): EligibilityDecision {
    const decision = this.evaluate(operation, requirements);
    if (!decision.allowed) {
      throw new EligibilityDeniedError(decision);
    }
    return decision;
  }
}

export function createEligibilityGate(
  getAccess: CapabilityAccessProvider,
  reporter?: EligibilityDecisionReporter,
): EligibilityGate {
  return new EligibilityGate(getAccess, reporter);
}

export function evaluateEligibilityDecision(
  access: CapabilityAccess,
  operation: EligibilityOperation,
  explicitRequirements?: EligibilityRequirements,
): EligibilityDecision {
  const tier = access.getTier();
  const resolvedRequirements = explicitRequirements ?? defaultRequirementsForOperation(operation);
  if (!resolvedRequirements) {
    return {
      allowed: false,
      reasonCode: 'unsupported_operation',
      operation,
      tier,
      requiredTokens: [],
      missingTokens: [],
    };
  }

  const requiredTokens = [...new Set((resolvedRequirements.requiredTokens ?? []).filter(Boolean))];
  const missingTokens = requiredTokens.filter(token => !access.has(token));
  if (missingTokens.length > 0) {
    return {
      allowed: false,
      reasonCode: 'missing_capability_tokens',
      operation,
      tier,
      requiredTokens,
      missingTokens,
      ...(resolvedRequirements.minimumTier ? { minimumTier: resolvedRequirements.minimumTier } : {}),
    };
  }

  if (resolvedRequirements.minimumTier) {
    const minimumTier = resolvedRequirements.minimumTier;
    if (tier === 'custom') {
      return {
        allowed: false,
        reasonCode: 'custom_tier_minimum_unsupported',
        operation,
        tier,
        requiredTokens,
        missingTokens: [],
        minimumTier,
      };
    }
    if (TIER_ORDER[tier] < TIER_ORDER[minimumTier]) {
      return {
        allowed: false,
        reasonCode: 'tier_below_minimum',
        operation,
        tier,
        requiredTokens,
        missingTokens: [],
        minimumTier,
      };
    }
  }

  return {
    allowed: true,
    reasonCode: 'allowed',
    operation,
    tier,
    requiredTokens,
    missingTokens: [],
    ...(resolvedRequirements.minimumTier ? { minimumTier: resolvedRequirements.minimumTier } : {}),
  };
}

function defaultRequirementsForOperation(
  operation: EligibilityOperation,
): EligibilityRequirements | undefined {
  switch (operation.kind) {
    case 'llm.purpose': {
      const purpose = operation.purpose;
      if (!isEligibilityLLMPurpose(purpose)) return undefined;
      return DEFAULT_LLM_PURPOSE_REQUIREMENTS[purpose];
    }
    case 'plugin.activate':
    case 'plugin.action':
      return undefined;
    default:
      return {};
  }
}

export function isEligibilityLLMPurpose(value: string): value is EligibilityLLMPurpose {
  return value in DEFAULT_LLM_PURPOSE_REQUIREMENTS;
}

function describeOperation(operation: EligibilityOperation): string {
  switch (operation.kind) {
    case 'tool.execute':
      return `tool "${operation.toolName}"`;
    case 'llm.purpose':
      return `LLM purpose "${operation.purpose}"`;
    case 'scheduler.task':
      return `scheduler task "${operation.taskId}"`;
    case 'post_turn.action':
      return `post-turn action "${operation.actionKind}"`;
    case 'plugin.activate':
      return `${operation.pluginType} plugin "${operation.pluginId}" activation`;
    case 'plugin.action':
      return `${operation.pluginType} plugin "${operation.pluginId}" action "${operation.action}"`;
    default:
      return '';
  }
}
