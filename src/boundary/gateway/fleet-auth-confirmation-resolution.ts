import type {
  ConfirmationResolveRequest,
  ConfirmationResolveResult,
  ConfirmationResolverIdentity,
} from '../../system/capabilities/confirmation-queue.js';
import {
  GatewayChildAssertionDeniedError,
  type GatewayFleetAuthChildAssertionBroker,
  type GatewayOperatorEffectInput,
} from './fleet-auth-child-assertions.js';
import { parseOperatorConfirmationParams } from './operator-confirmation-params.js';

const CONFIRMATION_RESOLVE_ROUTE = Object.freeze({
  method: 'POST',
  canonicalPath: '/api/admin/confirmations/resolve',
  action: 'confirmations.manage',
});

interface FleetConfirmationOwnerPort {
  resolveForOwner(
    companionId: string,
    params: ConfirmationResolveRequest,
    resolver: ConfirmationResolverIdentity,
  ): Promise<ConfirmationResolveResult>;
}

export class GatewayFleetConfirmationInvalidError extends Error {
  constructor() {
    super('Fleet confirmation resolution request is invalid');
    this.name = 'GatewayFleetConfirmationInvalidError';
  }
}

/**
 * Fleet Garden resolution of gateway-owned approvals. The approval queue lives
 * in the gateway, so an agent child capability cannot reach it. The operator
 * process instead presents the exact admitted parent capability for the
 * canonical Garden resolve route; the gateway verifies, consumes and
 * reauthorizes it once, then resolves only the signed body against the
 * capability's own companion with the signed human principal as resolver.
 */
export class GatewayFleetConfirmationResolution {
  constructor(private readonly options: {
    readonly parentAuthority: Pick<GatewayFleetAuthChildAssertionBroker, 'authorizeGatewayEffect'>;
    readonly confirmations: FleetConfirmationOwnerPort;
  }) {}

  async resolve(input: GatewayOperatorEffectInput): Promise<ConfirmationResolveResult> {
    const target = input.parent.target;
    if (target.method !== CONFIRMATION_RESOLVE_ROUTE.method
      || target.canonicalPath !== CONFIRMATION_RESOLVE_ROUTE.canonicalPath
      || target.canonicalQuery !== ''
      || target.action !== CONFIRMATION_RESOLVE_ROUTE.action
      || target.authorization.requirements.confirmation !== 'explicit') {
      throw new GatewayChildAssertionDeniedError();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(target.body).toString('utf8')) as unknown;
    } catch {
      throw new GatewayFleetConfirmationInvalidError();
    }
    const params = parseOperatorConfirmationParams(body);
    if (!params) throw new GatewayFleetConfirmationInvalidError();

    const { verified } = await this.options.parentAuthority.authorizeGatewayEffect(input);
    const actor = verified.authContext;
    if (verified.companionId !== target.companionId
      || actor.companionId !== target.companionId
      || actor.role === 'guest') {
      throw new GatewayChildAssertionDeniedError();
    }
    return await this.options.confirmations.resolveForOwner(target.companionId, params, {
      kind: 'operator',
      id: `fleet-garden:${target.companionId}:${actor.provider}:${actor.principalId}`,
    });
  }
}
