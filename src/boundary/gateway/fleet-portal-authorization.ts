import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type { FleetAuthorizationDenialReason } from './fleet-authorization-context.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';

export interface FleetPortalAuthorizationBatchRequest {
  readonly sessionToken: string;
}

export interface FleetPortalAuthorizedCompanion {
  readonly companionId: string;
  readonly gardenLinkEligible: boolean;
}

export interface FleetPortalAuthorizationBatch {
  readonly companions: readonly FleetPortalAuthorizedCompanion[];
}

export type FleetPortalAuthorizationBatchStoreDecision =
  | {
      readonly decision: 'allow';
      readonly companions: readonly FleetPortalAuthorizedCompanion[];
    }
  | {
      readonly decision: 'deny';
      readonly reasonCode: FleetAuthorizationDenialReason;
    };

export interface FleetPortalAuthorizationBatchStore {
  resolveBatch(
    request: FleetPortalAuthorizationBatchRequest,
  ): Promise<FleetPortalAuthorizationBatchStoreDecision>;
}

export interface FleetPortalAuthorizationBatchPort {
  resolve(input: unknown): Promise<FleetPortalAuthorizationBatch>;
}

function parseRequest(input: unknown): FleetPortalAuthorizationBatchRequest {
  if (!isRecord(input)
    || Object.keys(input).length !== 1
    || !Object.hasOwn(input, 'sessionToken')
    || typeof input.sessionToken !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(input.sessionToken)) {
    throw new FleetAuthorizationDeniedError('malformed_request');
  }
  return { sessionToken: input.sessionToken };
}

/**
 * Validates the narrow output of the authoritative store. The store is an
 * internal boundary, but validating here prevents an accidental future query
 * widening from becoming a browser-visible fleet enumeration surface.
 */
export class GatewayFleetPortalAuthorizationBatchResolver
implements FleetPortalAuthorizationBatchPort {
  private readonly knownCompanionIds: ReadonlySet<string>;

  constructor(
    private readonly store: FleetPortalAuthorizationBatchStore,
    knownCompanionIds: readonly string[],
  ) {
    if (knownCompanionIds.length === 0
      || knownCompanionIds.length > 256
      || knownCompanionIds.some(companionId => !isRfc4122Uuid(companionId))) {
      throw new Error('Fleet portal authorization requires 1-256 RFC-4122 companion IDs');
    }
    this.knownCompanionIds = new Set(knownCompanionIds);
    if (this.knownCompanionIds.size !== knownCompanionIds.length) {
      throw new Error('Fleet portal authorization companion IDs must be unique');
    }
  }

  async resolve(input: unknown): Promise<FleetPortalAuthorizationBatch> {
    const decision = await this.store.resolveBatch(parseRequest(input));
    if (decision.decision === 'deny') {
      throw new FleetAuthorizationDeniedError(decision.reasonCode);
    }
    if (!Array.isArray(decision.companions)
      || decision.companions.length > this.knownCompanionIds.size) {
      throw new Error('Fleet portal authorization store returned an invalid result size');
    }
    const seen = new Set<string>();
    const companions: FleetPortalAuthorizedCompanion[] = [];
    for (const companion of decision.companions) {
      if (!isRecord(companion)
        || Object.keys(companion).length !== 2
        || !Object.hasOwn(companion, 'companionId')
        || !Object.hasOwn(companion, 'gardenLinkEligible')
        || !isRfc4122Uuid(companion.companionId)
        || !this.knownCompanionIds.has(companion.companionId)
        || typeof companion.gardenLinkEligible !== 'boolean') {
        throw new Error('Fleet portal authorization store returned an invalid or unknown companion');
      }
      if (seen.has(companion.companionId)) {
        throw new Error('Fleet portal authorization store returned a duplicate companion');
      }
      seen.add(companion.companionId);
      companions.push(Object.freeze({
        companionId: companion.companionId,
        gardenLinkEligible: companion.gardenLinkEligible,
      }));
    }
    companions.sort((left, right) => left.companionId.localeCompare(right.companionId));
    return Object.freeze({ companions: Object.freeze(companions) });
  }
}
