import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, dirname, resolve } from 'node:path';
import { MODULE_REGISTRY_PATH } from '../security/policy-constants.js';
import type { ModuleRecord } from './types.js';

function toErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isModuleRecord(value: unknown): value is ModuleRecord {
  const record = toRecord(value);
  if (!record) return false;

  return typeof record.id === 'string'
    && typeof record.name === 'string'
    && typeof record.source === 'string'
    && typeof record.enabled === 'boolean'
    && typeof record.installedAt === 'number'
    && typeof record.updatedAt === 'number'
    && typeof record.version === 'number';
}

export function resolveModuleRegistryPath(
  pathOverride?: string,
  cwd = process.cwd(),
): string {
  const candidate = (pathOverride?.trim() || process.env.MODULE_REGISTRY_PATH?.trim() || MODULE_REGISTRY_PATH);
  return isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
}

export function parseModuleRegistry(raw: string): ModuleRecord[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is ModuleRecord => isModuleRecord(entry));
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
  await writeFile(registryPath, JSON.stringify(records, null, 2), 'utf-8');
}
