// ── Gateway TLS Configuration ──
// Wires process-level custom CA trust at startup. Verification exceptions must
// stay endpoint-scoped in the concrete client transport.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('GatewayTLS');

export interface GatewayTlsConfig {
  /** Absolute or relative path to a PEM-encoded CA certificate bundle to trust. */
  caPath?: string;
  /**
   * When explicitly `false`, records that an endpoint-scoped TLS verification
   * exception was requested. This helper never disables process-global TLS
   * verification; callers must pass scoped TLS options to the intended client.
   * Default: true (verify certificates).
   */
  rejectUnauthorized?: boolean;
}

export interface GatewayTlsStatus {
  /** Whether a custom CA path was configured and applied. */
  customCaApplied: boolean;
  /** The resolved CA path, if one was configured. */
  caPath?: string;
  /** Whether an endpoint-scoped TLS verification exception was requested. */
  verificationDisabled: boolean;
}

/**
 * Apply process-safe TLS configuration at gateway startup.
 *
 * - If `caPath` is set and the file exists, sets `NODE_EXTRA_CA_CERTS` so that
 *   Node.js trusts the additional CA for all HTTPS connections (LLM, embeddings, etc.).
 * - If `rejectUnauthorized` is explicitly `false`, reports the request and logs
 *   that the exception must be implemented by endpoint-specific client options.
 *
 * Must be called early in the gateway startup sequence, before any HTTPS connections.
 */
export function applyGatewayTlsConfig(config: GatewayTlsConfig): GatewayTlsStatus {
  const status: GatewayTlsStatus = {
    customCaApplied: false,
    verificationDisabled: false,
  };

  // ── Custom CA path ──

  if (config.caPath) {
    const resolved = resolve(config.caPath);

    if (!existsSync(resolved)) {
      log.error(`GATEWAY_TLS_CA_PATH points to a non-existent file: ${resolved}`);
      log.error('TLS connections to services using this CA will fail. Fix the path or remove the setting.');
    } else {
      process.env.NODE_EXTRA_CA_CERTS = resolved;
      status.customCaApplied = true;
      status.caPath = resolved;
      log.info(`Custom CA certificate loaded: ${resolved}`);
    }
  }

  // ── Reject unauthorized ──

  if (config.rejectUnauthorized === false) {
    status.verificationDisabled = true;

    log.warn('='.repeat(72));
    log.warn('  TLS CERTIFICATE VERIFICATION EXCEPTION REQUESTED');
    log.warn('  GATEWAY_TLS_REJECT_UNAUTHORIZED=false');
    log.warn('');
    log.warn('  Process-global TLS verification remains enabled.');
    log.warn('  Any insecure self-signed development exception must be wired');
    log.warn('  explicitly on the intended endpoint client transport.');
    log.warn('');
    log.warn('  For production, configure GATEWAY_TLS_CA_PATH with your CA cert');
    log.warn('  or endpoint-scoped trust material.');
    log.warn('='.repeat(72));
  }

  // ── Summary log ──

  if (!status.customCaApplied && !status.verificationDisabled) {
    log.info('TLS: using system default certificate trust store');
  }

  return status;
}
