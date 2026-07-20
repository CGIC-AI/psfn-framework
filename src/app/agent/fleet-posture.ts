import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { ChargePolicyConfig } from '../../shared/contracts/charge-policy.js';
import type { FatigueBudgetHistoryPort } from '../../core/agent/fatigue/fatigue-budget.js';
import {
  buildFleetCompanionPosture,
  type FleetCompanionPostureSummary,
} from '../../shared/telemetry/fleet-posture.js';
import { getRunChargeRollingWindowSnapshot } from '../../shared/telemetry/run-charge.js';

export function createAgentFleetPostureProvider(input: {
  readonly companionId: CompanionId;
  readonly chargePolicy: ChargePolicyConfig;
  readonly fatigueHistory: FatigueBudgetHistoryPort;
  readonly now?: () => number;
}): () => FleetCompanionPostureSummary {
  const now = input.now ?? (() => Date.now());
  return () => {
    const nowMs = now();
    return buildFleetCompanionPosture({
      companionId: input.companionId,
      chargePolicy: input.chargePolicy,
      rollingCharge: getRunChargeRollingWindowSnapshot(nowMs),
      fatigueEvents: input.fatigueHistory.listFatigueEvents({
        localCompanionId: input.companionId,
        dayKey: new Date(nowMs).toISOString().slice(0, 10),
      }),
      nowMs,
    });
  };
}
