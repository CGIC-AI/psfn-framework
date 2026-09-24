import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CompanionFleetEntry } from '../config/companions-config.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { FleetLifecycleError } from './contracts.js';
import type { FleetWorkloadPort } from './ports.js';

const execFileAsync = promisify(execFile);
const KUBE_NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/u;
const SECRET_KEY_PATTERN = /^[-._a-zA-Z0-9]+$/u;
// Mirrors the chart's fleetAgentDeploymentName helper prefix truncation.
const CHART_AGENT_PREFIX_MAX_LENGTH = 26;

/** Read-only cluster view. No method may create, patch, scale, or delete. */
export interface KubernetesReadExecutor {
  /** Data keys of a Secret, or null when the Secret does not exist. */
  secretKeys(name: string): Promise<readonly string[] | null>;
  pvcExists(name: string): Promise<boolean>;
  deploymentExists(name: string): Promise<boolean>;
}

/** One `fleet.companions[]` chart values entry: workload wiring, never secret values. */
export interface KubernetesFleetWorkloadBinding {
  readonly companionId: string;
  readonly postgresSchema: string;
  readonly databaseUrlSecretKey: string;
  readonly companionDataClaim: string;
  readonly workspaceClaim: string;
  readonly authSecret: Readonly<{ name: string; sessionIntegrityKey: string; companionAuthKey: string }>;
}

function kubeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !KUBE_NAME_PATTERN.test(value)) {
    throw new FleetLifecycleError('invalid_request', `${field} must be a Kubernetes object name`);
  }
  return value;
}

function secretKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SECRET_KEY_PATTERN.test(value)) {
    throw new FleetLifecycleError('invalid_request', `${field} must be a Secret data key`);
  }
  return value;
}

export function parseKubernetesFleetWorkloadBinding(value: unknown): KubernetesFleetWorkloadBinding {
  if (!isRecord(value) || !isRecord(value.authSecret) || !isRfc4122Uuid(value.companionId)
    || typeof value.postgresSchema !== 'string') {
    throw new FleetLifecycleError('invalid_request', 'Kubernetes workload binding is malformed');
  }
  return Object.freeze({
    companionId: value.companionId,
    postgresSchema: value.postgresSchema,
    databaseUrlSecretKey: secretKey(value.databaseUrlSecretKey, 'databaseUrlSecretKey'),
    companionDataClaim: kubeName(value.companionDataClaim, 'companionDataClaim'),
    workspaceClaim: kubeName(value.workspaceClaim, 'workspaceClaim'),
    authSecret: Object.freeze({
      name: kubeName(value.authSecret.name, 'authSecret.name'),
      sessionIntegrityKey: secretKey(value.authSecret.sessionIntegrityKey, 'authSecret.sessionIntegrityKey'),
      companionAuthKey: secretKey(value.authSecret.companionAuthKey, 'authSecret.companionAuthKey'),
    }),
  });
}

export function chartFleetAgentDeploymentName(chartFullname: string, companionId: string): string {
  const prefix = `${chartFullname}-agent`.slice(0, CHART_AGENT_PREFIX_MAX_LENGTH).replace(/-$/u, '');
  return `${prefix}-${companionId}`;
}

/**
 * Helm-owned workloads: the chart (driven from the operator's reviewed values)
 * is the only writer. This adapter verifies prerequisites and drain with
 * read-only cluster queries and reports the Helm upgrade the operator runs.
 */
export function createKubernetesFleetWorkloadPort(input: {
  readonly executor: KubernetesReadExecutor;
  readonly chartFullname: string;
  readonly appSecretName: string;
  /** Required for an add; absent for a remove. */
  readonly binding?: KubernetesFleetWorkloadBinding;
}): FleetWorkloadPort {
  return {
    async verifyPrerequisites(entry: CompanionFleetEntry) {
      const binding = input.binding;
      if (!binding || binding.companionId !== entry.companionId
        || binding.postgresSchema !== entry.postgresSchema) {
        throw new FleetLifecycleError(
          'workload_prerequisite_missing',
          'An add requires the matching fleet.companions workload binding',
        );
      }
      const appKeys = await input.executor.secretKeys(input.appSecretName);
      const authKeys = await input.executor.secretKeys(binding.authSecret.name);
      if (!appKeys?.includes(binding.databaseUrlSecretKey)
        || !authKeys?.includes(binding.authSecret.sessionIntegrityKey)
        || !authKeys.includes(binding.authSecret.companionAuthKey)) {
        throw new FleetLifecycleError('workload_prerequisite_missing', 'Workload Secret keys are not provisioned');
      }
      for (const claim of [binding.companionDataClaim, binding.workspaceClaim]) {
        if (!await input.executor.pvcExists(claim)) {
          throw new FleetLifecycleError('workload_prerequisite_missing', `PersistentVolumeClaim ${claim} is missing`);
        }
      }
      return 'helm_upgrade_required';
    },
    async drain(companionId: string) {
      const deployment = chartFleetAgentDeploymentName(input.chartFullname, companionId);
      if (await input.executor.deploymentExists(deployment)) {
        throw new FleetLifecycleError(
          'workload_still_running',
          `Remove the fleet.companions entry and run the Helm upgrade, then resume (${deployment} still exists)`,
        );
      }
      return 'already_satisfied';
    },
  };
}

function isNotFound(error: unknown): boolean {
  return isRecord(error) && typeof error.stderr === 'string' && /\bNotFound\b/u.test(error.stderr);
}

/** kubectl-backed read executor with an explicit context and namespace; `get` only. */
export function createKubectlReadExecutor(input: {
  readonly context: string;
  readonly namespace: string;
}): KubernetesReadExecutor {
  const base = ['--context', input.context, '--namespace', kubeName(input.namespace, 'namespace')];
  // Output formats print names/keys only, so no Secret value is ever read.
  const get = async (kind: string, name: string, output: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync('kubectl', [...base, 'get', kind, kubeName(name, kind), '-o', output]);
      return stdout;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  };
  return {
    async secretKeys(name) {
      const stdout = await get('secret', name, 'go-template={{range $key, $_ := .data}}{{$key}}{{"\\n"}}{{end}}');
      if (stdout === null) return null;
      return stdout.split('\n').filter(key => key.length > 0);
    },
    pvcExists: async name => (await get('persistentvolumeclaim', name, 'name')) !== null,
    deploymentExists: async name => (await get('deployment', name, 'name')) !== null,
  };
}
