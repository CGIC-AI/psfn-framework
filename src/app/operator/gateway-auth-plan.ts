export interface GatewayAuthPlanInput {
  fleetSsoEnabled: boolean;
  gatewayBaseUrl?: string;
  adminToken?: string;
}

export interface GatewayAuthPlan {
  tokenConfirmation?: {
    baseUrl: string;
    token: string;
  };
  fleetChildAssertionsBaseUrl?: string;
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
        'Fleet Garden startup requires GATEWAY_OPERATOR_API_BASE_URL for child assertions',
      );
    }
    return { fleetChildAssertionsBaseUrl: baseUrl };
  }

  if (baseUrl && !adminToken) {
    throw new Error(
      'Garden operator confirmation routing requires ADMIN_TOKEN for the internal gateway hop',
    );
  }

  return baseUrl && adminToken
    ? { tokenConfirmation: { baseUrl, token: adminToken } }
    : {};
}
