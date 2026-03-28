import type { EventBus } from '../shared/event-bus.js';
import type { EligibilityDecision } from '../system/capabilities/eligibility.js';

export interface EligibilityTelemetryLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

export function emitEligibilityDecisionTelemetry(
  eventBus: EventBus,
  decision: EligibilityDecision,
  logger: EligibilityTelemetryLogger,
): void {
  eventBus.emit('capability.eligibility', {
    operationKind: decision.operation.kind,
    operationRef: JSON.stringify(decision.operation),
    allowed: decision.allowed,
    reasonCode: decision.reasonCode,
    tier: decision.tier,
    requiredTokens: decision.requiredTokens,
    missingTokens: decision.missingTokens,
    ...(decision.minimumTier ? { minimumTier: decision.minimumTier } : {}),
    timestamp: Date.now(),
  }).catch((error) => {
    logger.warn('Failed to emit capability eligibility telemetry', { error: String(error) });
  });
}
