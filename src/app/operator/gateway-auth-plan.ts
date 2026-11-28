import {
  createGatewayFleetConfirmationClient,
  createGatewayOperatorConfirmationClient,
  type GatewayOperatorConfirmationClient,
} from '../startup/support/gateway-operator-confirmation-client.js';
import {
  createGardenFleetChildAssertionClient,
  type GardenFleetChildAssertionClient,
} from '../../operator/garden/fleet-child-assertion-client.js';

export interface GatewayAuthPlanInput {
  fleetSsoEnabled: boolean;
  gatewayBaseUrl?: string;
  adminToken?: string;
}

export type GatewayAuthPlan =
  /** Fleet Garden: every gateway hop is authorized by the admitted parent capability. */
  | { readonly kind: 'fleet_capability'; readonly baseUrl: string }
  /** Standalone Garden: the operator's ADMIN_TOKEN authenticates the gateway hop. */
  | { readonly kind: 'operator_token'; readonly baseUrl: string; readonly token: string }
  | { readonly kind: 'none' };

export interface OperatorGatewayClients {
  readonly operatorConfirmationResolver?: GatewayOperatorConfirmationClient;
  readonly fleetChildAssertions?: GardenFleetChildAssertionClient;
}

/**
 * Selects the operator-to-gateway authentication path without conflating the
 * shared gateway URL with a particular authentication method.
 */
export function resolveGatewayAuthPlan(input: GatewayAuthPlanInput): GatewayAuthPlan {
  const baseUrl = input.gatewayBaseUrl?.trim();
  const adminToken = input.adminToken?.trim();

  if (input.fleetSsoEnabled) {
    if (!baseUrl) {
      throw new Error(
        'Fleet Garden startup requires GATEWAY_OPERATOR_API_BASE_URL for gateway capability exchange',
      );
    }
    return { kind: 'fleet_capability', baseUrl };
  }

  if (baseUrl && !adminToken) {
    throw new Error(
      'Garden operator confirmation routing requires ADMIN_TOKEN for the internal gateway hop',
    );
  }

  return baseUrl && adminToken
    ? { kind: 'operator_token', baseUrl, token: adminToken }
    : { kind: 'none' };
}

/**
 * Builds the operator surface's gateway clients for one plan. Operator startup
 * spreads this into the Garden surface, so this is the production wiring.
 */
export function createOperatorGatewayClients(
  plan: GatewayAuthPlan,
  options: { readonly confirmationRequestTimeoutMs: number },
): OperatorGatewayClients {
  switch (plan.kind) {
    case 'fleet_capability':
      return {
        operatorConfirmationResolver: createGatewayFleetConfirmationClient(plan.baseUrl, {
          requestTimeoutMs: options.confirmationRequestTimeoutMs,
        }),
        fleetChildAssertions: createGardenFleetChildAssertionClient(plan.baseUrl),
      };
    case 'operator_token':
      return {
        operatorConfirmationResolver: createGatewayOperatorConfirmationClient(plan.baseUrl, {
          operatorToken: plan.token,
          requestTimeoutMs: options.confirmationRequestTimeoutMs,
        }),
      };
    case 'none':
      return {};
  }
}
