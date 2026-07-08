import {
  SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY,
  SETTINGS_GARDEN_RAW_EDITOR_KEYS,
  SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY,
  type GardenSettingsRawEditorKey,
} from '$lib/settings-garden-contract';
import type { SettingsSimpleSectionId } from '$lib/components/settings/navigation';

export const DISABLED_PROVIDER_ID = 'disabled';
export const COMPOSITIONAL_TIER_OPTIONS = ['nursery', 'apprentice', 'autonomous', 'custom'] as const;
export const COMPOSITIONAL_CHANNEL_TYPE_OPTIONS = ['discord', 'terminal', 'api', 'telegram'] as const;
export const COMPOSITIONAL_PURPOSE_OPTIONS = [
  'extraction',
  'retrieval',
  'appraisal',
  'analysis_workbench',
  'shard_context',
] as const;

export const DELEGATED_WORKSPACES = [
  {
    label: 'Models',
    href: '/models',
    description: 'Purpose slots, rosters, context windows',
  },
  {
    label: 'Prompts',
    href: '/prompts',
    description: 'Prompt layers and authoring',
  },
  {
    label: 'Scheduler',
    href: '/scheduler',
    description: 'Heartbeat, timers, maintenance work',
  },
  {
    label: 'Theme',
    href: '/theme',
    description: 'Garden appearance controls',
  },
  {
    label: 'Tools',
    href: '/tools',
    description: 'Tool registry, health, failures',
  },
  {
    label: 'Prompt Monitor',
    href: '/prompt-monitor',
    description: 'Prompt assembly and turn observability',
  },
] as const;

export type CompositionalListKey = 'allowedTiers' | 'allowedChannelTypes' | 'allowedPurposes';

export interface CompositionalPolicyFormValue {
  enabled: boolean;
  allowedTiers: string[];
  allowedChannelTypes: string[];
  allowedPurposes: string[];
}

const ENUM_LABELS_BY_FIELD: Record<string, Record<string, string>> = {
  importProcessingRouteMode: {
    background: 'Background Routing (default)',
    openrouter_zdr: 'OpenRouter ZDR-only',
    local_endpoint: 'Local Endpoint Only',
  },
  sessionRestartBehavior: {
    reuse_latest_session: 'Reuse latest session',
    new_session: 'Always start a new session',
  },
};

export const SYSTEM_PROMPT_ESTIMATE_TOKENS = 2_500;

export const SIMPLE_SECTION_ORDER: readonly SettingsSimpleSectionId[] = [
  'models',
  'providers',
  'prompting',
  'memory-budget',
  'memory-extraction',
  'memory-tuning',
  'memory-profile',
  'memory-sessions',
  'tools-analysis-workbench',
  'runtime-llm',
  'runtime-import',
  'runtime-fetch',
  'advanced-fields',
  'integrations-voice',
  'integrations-obsidian',
  'channels',
  'advanced-trust',
  'advanced-secrets',
  'advanced-backup',
  'owner-files',
];

export type RawEditorKey = GardenSettingsRawEditorKey;
export type RawSettingsEditorKey = Exclude<RawEditorKey, 'settings' | 'models'>;
export type RawEditorSubsystemId =
  (typeof SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY)[RawEditorKey];

export const RAW_EDITORS = SETTINGS_GARDEN_RAW_EDITOR_KEYS
  .filter(
    (key): key is RawSettingsEditorKey => (
      key !== 'settings' && key !== 'models'
    ),
  )
  .map((key) => ({ key }));

export function buildRawEditorJsonMap(
  resolveValue: (key: RawEditorKey) => string,
): Record<RawEditorKey, string> {
  return Object.fromEntries(
    SETTINGS_GARDEN_RAW_EDITOR_KEYS.map((key) => [key, resolveValue(key)]),
  ) as Record<RawEditorKey, string>;
}

export function listDirtyRawEditorKeys(
  current: Record<RawEditorKey, string>,
  initial: Record<RawEditorKey, string>,
): RawEditorKey[] {
  return SETTINGS_GARDEN_RAW_EDITOR_KEYS.filter(
    key => current[key] !== initial[key],
  );
}

export function resolveRawEditorOwnerFile(
  key: RawEditorKey,
  resolveSubsystemOwnerFile: (subsystemId: RawEditorSubsystemId) => string | undefined,
): string {
  const subsystemId = SETTINGS_GARDEN_RAW_EDITOR_SUBSYSTEM_BY_KEY[key];
  return resolveSubsystemOwnerFile(subsystemId) ?? SETTINGS_GARDEN_RAW_EDITOR_FALLBACK_FILE_BY_KEY[key];
}

export function humanizeSettingValue(value: string): string {
  return value
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatSettingOptionLabel(field: string, value: string): string {
  return ENUM_LABELS_BY_FIELD[field]?.[value] ?? humanizeSettingValue(value);
}

export function settingControlId(key: string, suffix = 'input'): string {
  return `settings-${key.replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase()}-${suffix}`;
}

export function settingLabelId(key: string): string {
  return settingControlId(key, 'label');
}

export function summarizeCompositionalPolicy(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Disabled';
  }

  const policy = value as {
    enabled?: unknown;
    allowedTiers?: unknown;
    allowedChannelTypes?: unknown;
    allowedPurposes?: unknown;
  };
  if (policy.enabled !== true) {
    return 'Disabled';
  }

  const tierCount = Array.isArray(policy.allowedTiers) ? policy.allowedTiers.length : 0;
  const channelCount = Array.isArray(policy.allowedChannelTypes) ? policy.allowedChannelTypes.length : 0;
  const purposeCount = Array.isArray(policy.allowedPurposes) ? policy.allowedPurposes.length : 0;

  return `Enabled, ${tierCount} tier${tierCount === 1 ? '' : 's'}, `
    + `${channelCount} channel${channelCount === 1 ? '' : 's'}, `
    + `${purposeCount} purpose${purposeCount === 1 ? '' : 's'}`;
}

export function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0),
  )];
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function tryPrettyPrint(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
}

export function stringFromConfigValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .join(', ');
  }
  return typeof value === 'string' ? value : String(value ?? '');
}

export function numberFromConfigValue(value: unknown, fallback: number): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return String(n);
}

export function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function splitCsv(str: string): string[] {
  return str.split(',').map(s => s.trim()).filter(Boolean);
}

export function normalizeDiscordListenWindowSeconds(value: number): number {
  if (!Number.isFinite(value)) return 120;
  return clamp(Math.round(value), 10, 600);
}
