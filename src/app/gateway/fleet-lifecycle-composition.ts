import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import { openFleetLifecycleRuntime } from '../../system/fleet-lifecycle/composition.js';
import {
  createFleetLifecycleService,
  type FleetLifecycleCommandPort,
} from '../../system/fleet-lifecycle/service.js';

/**
 * h248l.6: the gateway's Fleet lifecycle commands drive the same reconciler
 * and plan store as the CLI. A Kubernetes gateway is not granted the cluster
 * reads the Helm workload adapter needs, so there it serves plans and progress
 * and refuses apply with an explicit pointer to the CLI.
 */
export function createGatewayFleetLifecycle(input: {
  readonly systemDataDir: string;
  readonly runtimeRootDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fleetAuthConfig: FleetAuthConfig;
}): FleetLifecycleCommandPort {
  return createFleetLifecycleService({
    applyMode: input.env.KUBERNETES_SERVICE_HOST?.trim() ? 'cli_only' : 'local',
    openRuntime: () => openFleetLifecycleRuntime({
      systemDataDir: input.systemDataDir,
      persistenceRoot: input.runtimeRootDir,
      env: input.env,
      fleetAuthConfig: input.fleetAuthConfig,
      deployment: { kind: 'local' },
    }),
  });
}
