// ── Gateway TLS Configuration ──
// Wires process-level TLS trust settings at startup so the gateway can trust
// local/custom CA certificates when connecting to LiteLLM, embedding services,
// and other HTTPS endpoints.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('GatewayTLS');

export interface GatewayTlsConfig {
  /** Absolute or relative path to a PEM-encoded CA certificate bundle to trust. */
  caPath?: string;
  /**
   * When explicitly `false`, disables TLS certificate verification globally.
   * This is equivalent to NODE_TLS_REJECT_UNAUTHORIZED=0.
   * DANGEROUS — only use for local development with self-signed certs.
   * Default: true (verify certificates).
   */
  rejectUnauthorized?: boolean;
}

export interface GatewayTlsStatus {
  /** Whether a custom CA path was configured and applied. */
  customCaApplied: boolean;
  /** The resolved CA path, if one was configured. */
  caPath?: string;
  /** Whether TLS verification is disabled (rejectUnauthorized=false). */
  verificationDisabled: boolean;
}

/**
 * Apply process-level TLS configuration at gateway startup.
 *
 * - If `caPath` is set and the file exists, sets `NODE_EXTRA_CA_CERTS` so that
 *   Node.js trusts the additional CA for all HTTPS connections (LLM, embeddings, etc.).
 * - If `rejectUnauthorized` is explicitly `false`, sets `NODE_TLS_REJECT_UNAUTHORIZED=0`
 *   with prominent warning logs.
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
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    status.verificationDisabled = true;

    log.warn('='.repeat(72));
    log.warn('  TLS CERTIFICATE VERIFICATION DISABLED');
    log.warn('  GATEWAY_TLS_REJECT_UNAUTHORIZED=false');
    log.warn('');
    log.warn('  All outbound HTTPS connections will skip certificate validation.');
    log.warn('  This is INSECURE and should ONLY be used for local development');
    log.warn('  with self-signed certificates.');
    log.warn('');
    log.warn('  For production, configure GATEWAY_TLS_CA_PATH with your CA cert.');
    log.warn('='.repeat(72));
  }

  // ── Summary log ──

  if (!status.customCaApplied && !status.verificationDisabled) {
    log.info('TLS: using system default certificate trust store');
  }

  return status;
}
