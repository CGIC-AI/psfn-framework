import { parseBooleanEnv, parseEnvList } from '../../../shared/utils/env.js';

export const ALL_VAULT_ACTIONS = ['write', 'read', 'search', 'daily'] as const;
export type VaultAction = (typeof ALL_VAULT_ACTIONS)[number];

/** Shared policy/registration switch for the gateway and isolated agent. */
export function resolveVaultToolsEnabled(value: string | undefined): boolean {
  return parseBooleanEnv(value) ?? false;
}

export function requireEnabledVaultName(value: string | undefined): string {
  const vaultName = value?.trim();
  if (!vaultName) {
    throw new Error(
      'VAULT_TOOLS_ENABLED is true but obsidianVaultName is not configured in settings.',
    );
  }
  return vaultName;
}

export function parseVaultActionsEnv(value: string | undefined): VaultAction[] | undefined {
  const parsed = parseEnvList(value, { separators: [','] });
  if (!parsed) {
    return value === undefined ? undefined : [];
  }

  const valid = new Set<string>(ALL_VAULT_ACTIONS);
  return parsed
    .map(entry => entry.toLowerCase())
    .filter((entry): entry is VaultAction => valid.has(entry));
}
