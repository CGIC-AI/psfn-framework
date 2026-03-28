import { resolve } from 'node:path';
import { parseBooleanEnv, parsePathListEnv } from '../shared/utils/env.js';

export interface GatewayPolicyEnv {
  [key: string]: string | undefined;
  ALLOWED_READ_PATHS?: string;
  MODULE_REGISTRY_TRUSTED_READ?: string;
  MODULE_REGISTRY_PATH?: string;
  PSFN_RUNTIME_MODE?: string;
}

function normalizeRuntimeMode(raw: string | undefined): string {
  if (!raw) return '';
  return raw.trim().toLowerCase();
}

export function resolveAllowedReadPathsFromEnv(
  env: GatewayPolicyEnv,
  workspacePath: string,
): string[] | undefined {
  const allowedReadPaths = parsePathListEnv(env.ALLOWED_READ_PATHS) ?? [];

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
  if (parseBooleanEnv(env.MODULE_REGISTRY_TRUSTED_READ) !== true) {
    return undefined;
  }
  const moduleRegistryPath = env.MODULE_REGISTRY_PATH?.trim();
  if (!moduleRegistryPath) {
    throw new Error('MODULE_REGISTRY_TRUSTED_READ=true requires MODULE_REGISTRY_PATH');
  }
  return resolve(workspacePath, moduleRegistryPath);
}

export function resolveFullCodebaseReadRootFromEnv(
  env: GatewayPolicyEnv,
  codebaseRoot: string,
): string | undefined {
  return normalizeRuntimeMode(env.PSFN_RUNTIME_MODE) === 'yolo'
    ? resolve(codebaseRoot)
    : undefined;
}
