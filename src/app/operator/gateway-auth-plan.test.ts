import { describe, expect, it } from 'vitest';
import { resolveGatewayAuthPlan } from './gateway-auth-plan.js';

describe('resolveGatewayAuthPlan', () => {
  it('uses the gateway URL for SSO child assertions without requiring ADMIN_TOKEN', () => {
    expect(resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
      gatewayBaseUrl: 'https://gateway.internal/v1',
    })).toEqual({
      fleetChildAssertionsBaseUrl: 'https://gateway.internal/v1',
    });
  });

  it('uses ADMIN_TOKEN for non-SSO operator confirmation routing', () => {
    expect(resolveGatewayAuthPlan({
      fleetSsoEnabled: false,
      gatewayBaseUrl: 'https://gateway.internal/v1',
      adminToken: 'admin-token',
    })).toEqual({
      tokenConfirmation: {
        baseUrl: 'https://gateway.internal/v1',
        token: 'admin-token',
      },
    });
  });

  it('rejects non-SSO operator confirmation routing without ADMIN_TOKEN', () => {
    expect(() => resolveGatewayAuthPlan({
      fleetSsoEnabled: false,
      gatewayBaseUrl: 'https://gateway.internal/v1',
    })).toThrow(
      'Garden operator confirmation routing requires ADMIN_TOKEN for the internal gateway hop',
    );
  });

  it('requires the gateway URL when SSO child assertions are selected', () => {
    expect(() => resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
    })).toThrow(
      'Fleet Garden startup requires GATEWAY_OPERATOR_API_BASE_URL for child assertions',
    );
  });
});
