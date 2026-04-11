import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, resolve } from 'node:path';
import { resolveRequiredModuleRegistryPath } from '../security/policy-constants.js';
import { isRecord } from '../../shared/utils/types.js';
import type { ModuleRecord } from './types.js';

function toErrorCode(error: unknown): string | undefined {
  if (isRecord(error) && 'code' in error) {
    const code = error.code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

export function isModuleRecord(value: unknown): value is ModuleRecord {
  if (!isRecord(value)) return false;

  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.source === 'string'
    && typeof value.enabled === 'boolean'
    && typeof value.installedAt === 'number'
    && typeof value.updatedAt === 'number'
    && typeof value.version === 'number';
}

export function resolveModuleRegistryPath(
  pathOverride?: string,
  cwd = process.cwd(),
): string {
  const candidate = pathOverride?.trim() || resolveRequiredModuleRegistryPath();
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

export function resolveModuleRegistryPathFromWorkspace(
  workspaceRoot: string,
  pathOverride?: string,
): string {
  const candidate = pathOverride?.trim() || resolveRequiredModuleRegistryPath();
  return isAbsolute(candidate) ? candidate : resolve(workspaceRoot, candidate);
}

export function parseModuleRegistry(raw: string): ModuleRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is ModuleRecord => isModuleRecord(entry));
}

/**
 * Ensure the registry file exists on disk. Creates parent directories and
 * seeds an empty JSON array if the file is missing. This is safe to call
 * repeatedly — it is a no-op when the file already exists.
 */
export function ensureRegistryFile(registryPath: string): void {
  if (existsSync(registryPath)) {
    return;
  }
  mkdirSync(dirname(registryPath), { recursive: true });
  writeFileSync(registryPath, '[]\n', 'utf-8');
}

export async function readModuleRegistry(registryPath: string): Promise<ModuleRecord[]> {
  try {
    const raw = await readFile(registryPath, 'utf-8');
    return parseModuleRegistry(raw);
  } catch (error) {
    const code = toErrorCode(error);
    if (code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

export async function writeModuleRegistry(
  registryPath: string,
  records: ModuleRecord[],
): Promise<void> {
  await mkdir(dirname(registryPath), { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(records, null, 2), 'utf-8');
  await rename(tempPath, registryPath);
}
