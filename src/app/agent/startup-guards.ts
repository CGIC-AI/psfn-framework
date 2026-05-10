import { createComponentLogger } from '../../shared/logger.js';
import { parsePositiveIntEnv } from '../../shared/utils/env.js';
import type { StartupConfigHydrationDiagnostics } from '../startup/support/bootstrap-helpers.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';

const log = createComponentLogger('Agent');
const NETWORK_ISOLATION_PROBE_URL = 'http://1.1.1.1/cdn-cgi/trace';
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
  const probeResult = await fetch(NETWORK_ISOLATION_PROBE_URL, {
    method: 'HEAD',
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  }).then(
    (response) => ({ reachable: true as const, status: response.status }),
    () => ({ reachable: false as const, status: null }),
  );

  if (!probeResult.reachable) {
    return;
  }

  const error = new Error(
    `Outbound network access is reachable from the agent container `
    + `(probe=${NETWORK_ISOLATION_PROBE_URL}, status=${probeResult.status}).`,
  );
  log.error(`CRITICAL: ${error.message}`, {
    allowOutboundNetwork,
  });
  throw error;
}
