import { ensureActiveTimezone } from '../../shared/time/active-timezone.js';
import { createComponentLogger } from '../../shared/logger.js';
import { loadOperatorConfig } from '../../system/config/load-config.js';
import { hydrateJsonBackedRuntimeConfig } from '../../system/config/runtime-config.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import { createSignalShutdownHandler, registerProcessErrorHandlers } from '../startup/support/signal-shutdown.js';
import { runShutdownSequence } from '../startup/support/shutdown-helpers.js';
import { isExplicitTrue } from '../startup/support/env-parsing.js';
import {
  resolveAdminTransportClientEndpoint,
} from '../../operator/garden/transport-paths.js';
import { GardenOperatorSurface } from '../../operator/garden/operator-surface.js';
import { assertFleetAuthLegacySurfacesUnavailable } from '../../system/config/fleet-auth-legacy-surface-guard.js';
import { createGatewayOperatorConfirmationClient } from '../startup/support/gateway-operator-confirmation-client.js';
import { createGardenFleetChildAssertionClient } from '../../operator/garden/fleet-child-assertion-client.js';
import { resolveFleetSsoGardenTls } from '../../boundary/fleet-auth/fleet-sso-transport.js';
import { requireLifecycleKubernetesSettings } from '../../system/lifecycle/lifecycle-kubernetes-settings.js';
import {
  deriveFleetGardenTargets,
  FleetGardenTargetRegistry,
} from '../../operator/garden/fleet-garden-target-registry.js';
import { FleetGardenControlPlane } from '../../operator/garden/fleet-garden-control-plane.js';
import { AtomicRequestCapabilityReplayPort } from '../../operator/garden/atomic-request-capability-replay.js';
import { createRequestCapabilityVerifier } from '../../boundary/fleet-auth/request-capability.js';
import { FleetGardenDirectDatabase } from '../../operator/garden/fleet-garden-direct-database.js';
import { FleetGardenAdminTransportProxy } from '../../operator/garden/fleet-transport-client.js';
import { FleetModelUsageService } from '../../operator/garden/services/fleet-model-usage-service.js';

const log = createComponentLogger('OperatorSurface');
const DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS = 15_000;

ensureActiveTimezone();

async function main(): Promise<void> {
  const config = hydrateJsonBackedRuntimeConfig(loadOperatorConfig());
  const lifecycleKubernetes = requireLifecycleKubernetesSettings(config);
  assertFleetAuthLegacySurfacesUnavailable({
    fleetAuthEnabled: config.fleetAuthVerifier !== undefined,
    processMode: 'operator',
    env: process.env,
    principalAuthenticationWired: config.fleetAuthVerifier !== undefined,
  });
  const adminPort = parseOptionalPositiveIntEnv(process.env.ADMIN_PORT);
  if (!adminPort) {
    throw new Error('ADMIN_PORT is required for the operator Garden surface');
  }

  // The operator process owns ADMIN_TOKEN and resolves operator-only gateway
  // confirmations directly against the gateway, so the credential never
  // traverses the agent (x5rt.10).
  const operatorConfirmationBaseUrl = process.env.GATEWAY_OPERATOR_API_BASE_URL?.trim();
  const fleetSsoTls = config.fleetAuthVerifier
    ? resolveFleetSsoGardenTls(process.env)
    : undefined;
  let fleetControlPlane: FleetGardenControlPlane | undefined;
  let fleetDirectDatabase: FleetGardenDirectDatabase | undefined;
  let fleetTransport: FleetGardenAdminTransportProxy | undefined;
  let fleetModelUsage: FleetModelUsageService | undefined;
  if (config.multiCompanion === true) {
    if (!config.companionFleet || !config.fleetAuthVerifier) {
      throw new Error(
        'Fleet Garden startup requires the complete companions registry and Fleet Auth verifier',
      );
    }
    const registry = new FleetGardenTargetRegistry(
      deriveFleetGardenTargets(config.companionFleet, process.env),
    );
    fleetControlPlane = new FleetGardenControlPlane({
      registry,
      verifier: createRequestCapabilityVerifier(
        config.fleetAuthVerifier.requestCapabilities,
      ),
      replay: new AtomicRequestCapabilityReplayPort(),
    });
    fleetTransport = new FleetGardenAdminTransportProxy(registry);
    fleetModelUsage = new FleetModelUsageService({ registry, transport: fleetTransport });
    fleetDirectDatabase = new FleetGardenDirectDatabase({
      config,
      companionIds: config.companionFleet.companions.map(companion => companion.companionId),
    });
  }
  if (fleetControlPlane && !operatorConfirmationBaseUrl) {
    throw new Error(
      'Fleet Garden startup requires GATEWAY_OPERATOR_API_BASE_URL for child assertions',
    );
  }
  const surface = new GardenOperatorSurface({
    port: adminPort,
    host: process.env.ADMIN_HOST || undefined,
    token: process.env.ADMIN_TOKEN || undefined,
    allowInsecureWithoutToken: isExplicitTrue(process.env.ADMIN_ALLOW_INSECURE),
    config,
    ...(fleetControlPlane
      ? { fleetControlPlane, fleetDirectDatabase, fleetTransport, fleetModelUsage }
      : { transportEndpoint: resolveAdminTransportClientEndpoint(process.env) }),
    ...(fleetSsoTls ? { fleetSsoTls } : {}),
    ...(operatorConfirmationBaseUrl
      ? {
          operatorConfirmationResolver:
            createGatewayOperatorConfirmationClient(operatorConfirmationBaseUrl, {
              requestTimeoutMs: lifecycleKubernetes.operatorConfirmationRequestTimeoutMs,
            }),
        }
      : {}),
    ...(config.fleetAuthVerifier && operatorConfirmationBaseUrl
      ? { fleetChildAssertions: createGardenFleetChildAssertionClient(operatorConfirmationBaseUrl) }
      : {}),
  });
  await surface.init();
  await surface.start();

  const stop = async (): Promise<void> => {
    await runShutdownSequence([
      { step: 'stop Garden operator surface', action: () => surface.stop() },
    ], log);
    log.info('Stopped');
  };

  const shutdown = createSignalShutdownHandler({
    logger: log,
    runGracefulShutdown: stop,
    exit: (code) => { process.exit(code); },
    forceExitTimeoutMs: DEFAULT_SHUTDOWN_FORCE_EXIT_TIMEOUT_MS,
  });

  process.on('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => {
      log.error('Unhandled SIGINT shutdown error', { error: String(error) });
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => {
      log.error('Unhandled SIGTERM shutdown error', { error: String(error) });
      process.exit(1);
    });
  });

  registerProcessErrorHandlers({
    logger: log,
    requestShutdown: () => {
      void shutdown('uncaughtException').catch(() => process.exit(1));
    },
  });
}

main().catch((error) => {
  log.error('Fatal error', { error: String(error) });
  process.exit(1);
});
