import type {
  ModelBudgetAlertDeliveryEvent,
  ModelBudgetThresholdExceededEvent,
} from './runtime.js';
import type { CompanionId } from '../routing/companion-id.js';

export interface ModelBudgetOperatorAlertIdentity {
  companionId: CompanionId;
  thresholdReason: ModelBudgetThresholdExceededEvent['reason'];
  windowKey: string;
}

export interface ModelBudgetOperatorAlertClaim {
  readonly attempt: number;
  /** Stable key passed to providers that can collapse an ambiguous retry. */
  readonly providerIdempotencyKey: string;
  /** True when this claim resumes a dispatch committed before process loss. */
  readonly recovered: boolean;
  recordDelivery(event: ModelBudgetAlertDeliveryEvent): Promise<void>;
  release(): Promise<void>;
}

export interface ModelBudgetOperatorAlertClaimStorePort {
  claimModelBudgetOperatorAlert(
    identity: ModelBudgetOperatorAlertIdentity,
  ): Promise<ModelBudgetOperatorAlertClaim | null>;
}

export interface ModelBudgetOperatorAlertEvidenceQueryPort {
  listModelBudgetOperatorAlertEvidence(
    identity: ModelBudgetOperatorAlertIdentity,
  ): Promise<ModelBudgetAlertDeliveryEvent[]>;
}

export interface ModelBudgetOperatorAlertStorePort
  extends ModelBudgetOperatorAlertClaimStorePort,
  ModelBudgetOperatorAlertEvidenceQueryPort {}

export function modelBudgetOperatorAlertDedupeKey(
  identity: ModelBudgetOperatorAlertIdentity,
): string {
  return `${identity.companionId}:${identity.thresholdReason}:${identity.windowKey}`;
}
