import { createComponentLogger } from '../../shared/logger.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import type { StartupConfigHydrationDiagnostics } from '../startup/support/bootstrap-helpers.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';
import {
  AGENT_EGRESS_ISOLATION_ENV,
  proveAgentEgressIsolation,
  type EgressProbeOptions,
} from './network-isolation-probe.js';

const log = createComponentLogger('Agent');
const NETWORK_ISOLATION_PROBE_TIMEOUT_MS = 2_000;

export function logStartupHydrationDiagnostics(
  diagnostics: StartupConfigHydrationDiagnostics,
): void {
  if (diagnostics.legacySettingsKeys.length > 0) {
    log.error('Startup rejected cross-domain keys in settings.json', {
      keys: diagnostics.legacySettingsKeys,
    });
  }
}

export async function enforceNetworkIsolationOnStartup(
  env: NodeJS.ProcessEnv = process.env,
  probeOverrides: Pick<EgressProbeOptions, 'targets' | 'fetchImpl'> = {},
): Promise<void> {
  const allowOutboundNetwork = isExplicitTrue(env.ALLOW_AGENT_OUTBOUND_NETWORK);
  if (allowOutboundNetwork) {
    log.warn(
      'DEGRADED: ALLOW_AGENT_OUTBOUND_NETWORK=true set; startup network-isolation guard is bypassed by explicit operator override.',
    );
    return;
  }

  const timeoutMs = parsePositiveIntEnv(
    env.NETWORK_ISOLATION_PROBE_TIMEOUT_MS,
    NETWORK_ISOLATION_PROBE_TIMEOUT_MS,
  );
  const verdict = await proveAgentEgressIsolation({ env, timeoutMs, ...probeOverrides });
  const probes = verdict.probes.map(probe => `${probe.target}=${probe.kind}(${probe.detail})`);

  if (verdict.status === 'isolated') {
    log.info('Agent egress isolation proven', { mechanism: verdict.mechanism, probes });
    return;
  }

  const error = verdict.status === 'reachable'
    ? new Error(
      `Outbound network access is reachable from the agent container (probes: ${probes.join('; ')}).`,
    )
    : new Error(
      `Agent egress isolation is unproven: ${verdict.reason} (probes: ${probes.join('; ')}). `
      + `Declare the launcher's isolation mechanism with ${AGENT_EGRESS_ISOLATION_ENV}, or set the `
      + 'explicit ALLOW_AGENT_OUTBOUND_NETWORK=true override.',
    );
  log.error(`CRITICAL: ${error.message}`, {
    allowOutboundNetwork,
    verdict: verdict.status,
  });
  throw error;
}
