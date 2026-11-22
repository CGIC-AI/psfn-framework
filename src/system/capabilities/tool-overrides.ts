import type { CapabilityAccess } from './access.js';

const TOOL_OVERRIDE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/u;
const EMPTY_DISABLED_TOOLS: ReadonlySet<string> = Object.freeze(new Set<string>());

function isValidToolOverrideName(value: unknown): value is string {
  return typeof value === 'string' && TOOL_OVERRIDE_NAME_PATTERN.test(value);
}

export function normalizeDisabledTools(
  value: unknown,
  field = 'disabledTools',
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid capability config: ${field} must be an array`);
  }

  const unique = new Set<string>();
  for (const entry of value) {
    if (!isValidToolOverrideName(entry)) {
      throw new Error(
        `Invalid capability config: ${field} contains invalid tool name "${String(entry)}"`,
      );
    }
    unique.add(entry);
  }

  return [...unique];
}

export function canonicalizeDisabledTools(
  value: unknown,
  field = 'disabledTools',
): readonly string[] {
  return Object.freeze(
    normalizeDisabledTools(value, field).sort((left, right) => left.localeCompare(right)),
  );
}

export function getDisabledToolsFromAccess(access: CapabilityAccess): ReadonlySet<string> {
  return access.getDisabledTools ? access.getDisabledTools() : EMPTY_DISABLED_TOOLS;
}

export function isToolDisabledByAccess(access: CapabilityAccess, toolName: string): boolean {
  if (access.isToolDisabled) {
    return access.isToolDisabled(toolName);
  }
  return access.getDisabledTools ? access.getDisabledTools().has(toolName) : false;
}
