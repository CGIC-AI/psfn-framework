import type { FleetAuthConfig } from '../config/fleet-auth-config.js';
import { FleetLifecycleError } from './contracts.js';
import {
  createKubernetesFleetWorkloadPort,
  type KubernetesFleetWorkloadBinding,
  type KubernetesReadExecutor,
} from './kubernetes-adapter.js';
import {
  createFileFleetTopologyPort,
  createLocalFleetPrerequisitePort,
  createLocalFleetWorkloadPort,
} from './local-adapter.js';
import { FleetLifecyclePlanStore } from './plan-store.js';
import type { FleetLifecyclePorts } from './ports.js';
import {
  createPostgresFleetAuthAdmissionPort,
  createPostgresIcpLifecycleFencePort,
  verifyPostgresTenantSchema,
} from './postgres-ports.js';

export type FleetLifecycleDeployment =
  | Readonly<{ kind: 'local' }>
  | Readonly<{
    kind: 'kubernetes';
    executor: KubernetesReadExecutor;
    chartFullname: string;
    appSecretName: string;
    binding?: KubernetesFleetWorkloadBinding;
  }>;

export interface FleetLifecycleRuntime {
  readonly store: FleetLifecyclePlanStore;
  readonly ports: FleetLifecyclePorts;
  close(): Promise<void>;
}

function requireCredential(env: NodeJS.ProcessEnv, envName: string, label: string): string {
  const value = env[envName]?.trim();
  if (!value) {
    throw new FleetLifecycleError('secret_ref_missing', `${label} credential ${envName} is not provisioned`);
  }
  return value;
}

/**
 * One composition for every lifecycle client (CLI and Fleet UI): the roster
 * owner file, durable plan store, ICP fence over the shared schema, fleet-auth
 * admission (disabled only when fleet-auth.json is absent), and the
 * deployment's prerequisite/workload adapters.
 */
export function openFleetLifecycleRuntime(input: {
  readonly systemDataDir: string;
  readonly persistenceRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fleetAuthConfig?: FleetAuthConfig;
  readonly deployment: FleetLifecycleDeployment;
}): FleetLifecycleRuntime {
  const topology = createFileFleetTopologyPort(input.systemDataDir);
  const current = topology.read().config;
  const icpFence = createPostgresIcpLifecycleFencePort({
    sharedDatabaseUrl: requireCredential(
      input.env,
      current.postgres.sharedMigrationDatabaseUrlRef.envName,
      'Shared schema',
    ),
    rosterCompanionIds: current.companions.map(entry => entry.companionId),
  });
  const fleetAuth = input.fleetAuthConfig
    ? createPostgresFleetAuthAdmissionPort(requireCredential(
      input.env,
      input.fleetAuthConfig.credentials.runtimeDatabaseUrlRef.envName,
      'Fleet auth runtime',
    ))
    : undefined;
  const deployment = input.deployment;
  const workload = deployment.kind === 'local'
    ? createLocalFleetWorkloadPort()
    : createKubernetesFleetWorkloadPort({
      executor: deployment.executor,
      chartFullname: deployment.chartFullname,
      appSecretName: deployment.appSecretName,
      ...(deployment.binding ? { binding: deployment.binding } : {}),
    });
  return {
    store: new FleetLifecyclePlanStore(input.systemDataDir),
    ports: {
      topology,
      prerequisites: createLocalFleetPrerequisitePort({
        persistenceRoot: input.persistenceRoot,
        env: input.env,
        verifyTenantSchema: verifyPostgresTenantSchema,
      }),
      workload,
      icpFence,
      fleetAuth: fleetAuth ?? { disabled: true },
    },
    async close() {
      await icpFence.close();
      await fleetAuth?.close();
    },
  };
}
