import { describe, expect, it } from 'vitest';
import {
  deriveCompanionAuthToken,
  verifyCompanionAuthToken,
} from '../../boundary/gateway/companion-auth.js';
import { requireAuditOpaqueIdKeyring } from './audit-opaque-id-keyring.js';

describe('requireAuditOpaqueIdKeyring', () => {
  it('derives the audit-only key through a stable domain-separated vector', () => {
    expect(requireAuditOpaqueIdKeyring(`v1.${'b'.repeat(64)}`)).toEqual({
      activeVersion: 'v1',
      keys: {
        v1: 'IHuMF5zXad9vrTAYLNI8o5El4ghNG4GVXjUL7wbhOfE',
      },
    });
  });

  it.each([undefined, '', 'gateway-root-key', 'v1.not-a-proof'])(
    'fails closed for an absent or malformed role-bound proof: %s',
    (token) => {
      expect(() => requireAuditOpaqueIdKeyring(token)).toThrow(
        'A valid GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN is required for Garden audit opaque IDs.',
      );
    },
  );

  it('cannot use the derived audit key to mint a gateway-accepted role proof', () => {
    const gatewayRootKeyring = {
      activeVersion: 'v1',
      keys: { v1: 'gateway-root-key' },
    };
    const workerProof = deriveCompanionAuthToken(
      'companion-a',
      'internal_session_integrity',
      gatewayRootKeyring,
    );
    const auditKeyring = requireAuditOpaqueIdKeyring(workerProof);
    const forged = deriveCompanionAuthToken('companion-a', 'agent', auditKeyring);

    expect(verifyCompanionAuthToken(
      'companion-a',
      'agent',
      forged,
      gatewayRootKeyring,
    )).toBe(false);
  });
});
