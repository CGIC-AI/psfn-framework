import { randomUUID } from 'node:crypto';
import { assertNoUnknownKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import type {
  OperatorAccountRequest,
  OperatorAccountResult,
} from '../../persistence/postgres/fleet-auth/operator-account-authority.js';
import { FleetAuthLifecycleCeremonyError } from './lifecycle-ceremony.js';

export const FLEET_AUTH_ACCOUNT_COMPLETE_PATH = '/v1/fleet-auth/lifecycle/account/complete';

/**
 * The audited ADMIN_TOKEN operator's direct account authority
 * (psfn-framework-aol3m, key-or-SSO ruling): reinstate a quarantined
 * (restored) account or companion, and disable or re-enable an account. There
 * is no Discord, OAuth or SSO step anywhere on this path. The gateway first
 * writes a durable `admin_token_operator` approval bound to the exact action,
 * companion and audit event; the bounded database procedure then proves that
 * row in the same transaction, honours the non-restored authority floor, and
 * appends its own audit event. Anything missing, stale or foreign fails closed.
 */
export interface OperatorAccountAuthorityPorts {
  recordApproval(input: {
    decisionId: string;
    ceremonyId: string;
    companionId: string;
    lifecycleAction: OperatorAccountRequest['action'];
  }): Promise<{ authorizationEventId: string }>;
  execute(input: {
    request: OperatorAccountRequest;
    approvalEventId: string;
    auditEventId: string;
  }): Promise<OperatorAccountResult>;
  /** The authoritative non-restored floor file; the database projection is rechecked too. */
  isAccountAuthorityTombstoned(
    kind: 'principal' | 'companion' | 'contact_binding' | 'role_grant',
    resourceId: string,
  ): boolean;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) throw new Error(`${field} is invalid`);
  return value;
}

export function parseOperatorAccountRequest(
  input: unknown,
): OperatorAccountRequest & { ceremonyId: string } {
  if (!isRecord(input)) throw new Error('Operator account request must be an object');
  const ceremonyId = uuid(input.ceremonyId, 'ceremonyId');
  const companionId = uuid(input.companionId, 'companionId');
  switch (input.action) {
    case 'principal.reinstate':
      assertNoUnknownKeys(input, [
        'action', 'ceremonyId', 'companionId', 'principalId', 'bindingId', 'roleGrantId',
      ], 'operatorAccount');
      return {
        action: input.action,
        ceremonyId,
        companionId,
        principalId: uuid(input.principalId, 'principalId'),
        bindingId: uuid(input.bindingId, 'bindingId'),
        roleGrantId: uuid(input.roleGrantId, 'roleGrantId'),
      };
    case 'companion.reinstate':
      assertNoUnknownKeys(input, ['action', 'ceremonyId', 'companionId', 'companionVersion'], 'operatorAccount');
      if (!Number.isSafeInteger(input.companionVersion) || Number(input.companionVersion) < 1) {
        throw new Error('companionVersion is invalid');
      }
      return {
        action: input.action,
        ceremonyId,
        companionId,
        companionVersion: Number(input.companionVersion),
      };
    case 'principal.suspend':
    case 'principal.reactivate':
      assertNoUnknownKeys(input, ['action', 'ceremonyId', 'companionId', 'principalId'], 'operatorAccount');
      return {
        action: input.action,
        ceremonyId,
        companionId,
        principalId: uuid(input.principalId, 'principalId'),
      };
    default:
      throw new Error('Operator account action is unknown');
  }
}

export class GatewayOperatorAccountAuthorityService {
  private readonly origin: string;

  constructor(private readonly options: {
    canonicalOrigin: string;
    ports: OperatorAccountAuthorityPorts;
  }) {
    const origin = new URL(options.canonicalOrigin);
    if (origin.protocol !== 'https:' || origin.origin !== options.canonicalOrigin) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'Account authority origin is invalid');
    }
    this.origin = origin.origin;
  }

  async complete(input: { requestOrigin: string; request: unknown }): Promise<OperatorAccountResult> {
    if (input.requestOrigin !== this.origin) {
      throw new FleetAuthLifecycleCeremonyError('origin_mismatch', 'Account authority origin is invalid');
    }
    let parsed: OperatorAccountRequest & { ceremonyId: string };
    try {
      parsed = parseOperatorAccountRequest(input.request);
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError('invalid_request', 'Account authority request is malformed', {
        cause: error,
      });
    }
    const { ceremonyId, ...request } = parsed;
    // Account reinstatement is subordinate to the authoritative non-restored
    // floor file. Companion reinstatement is checked against the floor's
    // database projection inside the procedure, where a re-added lineage
    // (whose removal is itself a tombstone) is admitted only on its exact
    // lineage record.
    if (request.action === 'principal.reinstate') {
      const resources: Array<[
        Parameters<OperatorAccountAuthorityPorts['isAccountAuthorityTombstoned']>[0],
        string,
      ]> = [
        ['companion', request.companionId],
        ['principal', request.principalId],
        ['contact_binding', request.bindingId],
        ['role_grant', request.roleGrantId],
      ];
      if (resources.some(([kind, id]) => this.options.ports.isAccountAuthorityTombstoned(kind, id))) {
        throw new FleetAuthLifecycleCeremonyError(
          'lifecycle_denied',
          'Account authority is permanently tombstoned by non-restored authority',
        );
      }
    }
    const auditEventId = randomUUID();
    let approval: { authorizationEventId: string };
    try {
      approval = await this.options.ports.recordApproval({
        decisionId: auditEventId,
        ceremonyId,
        companionId: request.companionId,
        lifecycleAction: request.action,
      });
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError(
        'operator_approval_unavailable',
        'Administrator account approval could not be recorded',
        { cause: error },
      );
    }
    try {
      return await this.options.ports.execute({
        request,
        approvalEventId: approval.authorizationEventId,
        auditEventId,
      });
    } catch (error) {
      throw new FleetAuthLifecycleCeremonyError(
        'lifecycle_denied',
        'Account authority transition was denied',
        { cause: error },
      );
    }
  }
}
