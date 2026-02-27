import { resolve } from 'node:path';
import { MODULE_REGISTRY_PATH } from '../security/policy-constants.js';

export interface GatewayPolicyEnv {
  [key: string]: string | undefined;
  ALLOWED_READ_PATHS?: string;
  MODULE_REGISTRY_TRUSTED_READ?: string;
  MODULE_REGISTRY_PATH?: string;
}

function parseBooleanTrue(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === 'true';
}

function splitAllowedReadPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(':')
    .map(entry => entry.trim())
    .filter(Boolean);
}

export function resolveAllowedReadPathsFromEnv(
  env: GatewayPolicyEnv,
  workspacePath: string,
): string[] | undefined {
  const allowedReadPaths = splitAllowedReadPaths(env.ALLOWED_READ_PATHS);

  const trustedModuleRegistryPath = resolveTrustedModuleRegistryPathFromEnv(env, workspacePath);
  if (trustedModuleRegistryPath) {
    allowedReadPaths.push(trustedModuleRegistryPath);
  }

  if (allowedReadPaths.length === 0) {
    return undefined;
  }

  return [...new Set(allowedReadPaths)];
}

export function resolveTrustedModuleRegistryPathFromEnv(
  env: GatewayPolicyEnv,
  workspacePath: string,
): string | undefined {
  if (!parseBooleanTrue(env.MODULE_REGISTRY_TRUSTED_READ)) {
    return undefined;
  }
  const moduleRegistryPath = env.MODULE_REGISTRY_PATH?.trim() || MODULE_REGISTRY_PATH;
  return resolve(workspacePath, moduleRegistryPath);
}
