import { describe, expect, it } from 'vitest';
import { createOperatorGatewayClients, resolveGatewayAuthPlan } from './gateway-auth-plan.js';

describe('resolveGatewayAuthPlan', () => {
  it('selects capability exchange for Fleet Garden without requiring ADMIN_TOKEN', () => {
    expect(resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
      gatewayBaseUrl: 'https://gateway.internal/v1',
    })).toEqual({ kind: 'fleet_capability', baseUrl: 'https://gateway.internal/v1' });
  });

  it('never selects the ADMIN_TOKEN hop for Fleet Garden even when the token is present', () => {
    expect(resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
      gatewayBaseUrl: 'https://gateway.internal/v1',
      adminToken: 'admin-token',
    })).toEqual({ kind: 'fleet_capability', baseUrl: 'https://gateway.internal/v1' });
  });

  it('uses ADMIN_TOKEN for non-SSO operator confirmation routing', () => {
    expect(resolveGatewayAuthPlan({
      fleetSsoEnabled: false,
      gatewayBaseUrl: 'https://gateway.internal/v1',
      adminToken: 'admin-token',
    })).toEqual({
      kind: 'operator_token',
      baseUrl: 'https://gateway.internal/v1',
      token: 'admin-token',
    });
  });

  it('selects no gateway hop without a gateway URL outside Fleet Garden', () => {
    expect(resolveGatewayAuthPlan({ fleetSsoEnabled: false })).toEqual({ kind: 'none' });
  });

  it('rejects non-SSO operator confirmation routing without ADMIN_TOKEN', () => {
    expect(() => resolveGatewayAuthPlan({
      fleetSsoEnabled: false,
      gatewayBaseUrl: 'https://gateway.internal/v1',
    })).toThrow(
      'Garden operator confirmation routing requires ADMIN_TOKEN for the internal gateway hop',
    );
  });

  it('requires the gateway URL when Fleet Garden is selected', () => {
    expect(() => resolveGatewayAuthPlan({
      fleetSsoEnabled: true,
    })).toThrow(
      'Fleet Garden startup requires GATEWAY_OPERATOR_API_BASE_URL for gateway capability exchange',
    );
  });
});

describe('createOperatorGatewayClients', () => {
  it('wires both capability clients for Fleet Garden', () => {
    const clients = createOperatorGatewayClients(
      { kind: 'fleet_capability', baseUrl: 'https://gateway.internal/v1' },
      { confirmationRequestTimeoutMs: 5_000 },
    );
    expect(clients.operatorConfirmationResolver).toBeDefined();
    expect(clients.fleetChildAssertions).toBeDefined();
  });

  it('wires only the token confirmation client for standalone Garden', () => {
    const clients = createOperatorGatewayClients(
      { kind: 'operator_token', baseUrl: 'https://gateway.internal/v1', token: 'admin-token' },
      { confirmationRequestTimeoutMs: 5_000 },
    );
    expect(clients.operatorConfirmationResolver).toBeDefined();
    expect(clients.fleetChildAssertions).toBeUndefined();
  });

  it('wires nothing without a gateway hop', () => {
    expect(createOperatorGatewayClients(
      { kind: 'none' },
      { confirmationRequestTimeoutMs: 5_000 },
    )).toEqual({});
  });
});
