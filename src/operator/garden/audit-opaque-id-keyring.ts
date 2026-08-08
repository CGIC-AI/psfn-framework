import { createHmac } from 'node:crypto';
import { GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN_ENV } from '../../boundary/gateway/companion-auth.js';

const ROLE_BOUND_PROOF_PATTERN = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u;
const AUDIT_OPAQUE_ID_KEY_CONTEXT = 'psfn-garden-audit-opaque-id-key-v1';

export interface AuditOpaqueIdKeyring {
  activeVersion: string;
  keys: Readonly<Record<string, string>>;
}

/**
 * Derive an audit-only key from the agent's existing role-bound worker proof.
 *
 * The proof is already delegated to the agent. Treating its HMAC digest as
 * pseudorandom key material and applying a Garden-specific context gives the
 * audit surface a stable opaque-ID key without delegating the gateway root
 * key that can mint companion or role proofs.
 */
export function requireAuditOpaqueIdKeyring(
  sessionIntegrityAuthToken: string | undefined,
): AuditOpaqueIdKeyring {
  const match = sessionIntegrityAuthToken?.trim().match(ROLE_BOUND_PROOF_PATTERN);
  if (!match) {
    throw new Error(
      `A valid ${GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN_ENV} is required for Garden audit opaque IDs.`,
    );
  }
  const version = match[1];
  const proofDigest = match[2];
  if (version === undefined || proofDigest === undefined) {
    throw new Error(
      `A valid ${GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN_ENV} is required for Garden audit opaque IDs.`,
    );
  }
  const auditKey = createHmac('sha256', Buffer.from(proofDigest, 'hex'))
    .update(AUDIT_OPAQUE_ID_KEY_CONTEXT, 'utf8')
    .update('\0')
    .update(version, 'utf8')
    .digest('base64url');
  return {
    activeVersion: version,
    keys: { [version]: auditKey },
  };
}
