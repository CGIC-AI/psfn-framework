import type { AdminSettingsData, SettingsContractData } from '../types/index.js';
import type { ContextBudgetPreviewData } from './context-budget-preview.js';

export interface SettingAuthorityInfo {
  sourceLabel: string;
  detail: string;
  effectiveValue?: string;
  precedence?: string;
}

interface SchedulerEditorConfig {
  salienceDecayIntervalMs?: unknown;
}

interface CapabilitiesEditorConfig {
  tier?: unknown;
  customTokens?: unknown;
}

interface ModelCatalogEntryLike {
  contextWindow?: unknown;
}

interface ModelRosterEntryLike {
  contextWindow?: unknown;
}

interface ModelsEditorConfig {
  modelCatalog?: Record<string, ModelCatalogEntryLike> | undefined;
  modelRoleAssignments?: Record<string, string> | undefined;
  modelRoster?: Record<string, ModelRosterEntryLike> | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function summarizeList(values: readonly string[], limit = 3): string | undefined {
  if (values.length === 0) return undefined;
  if (values.length <= limit) return values.join(', ');
  return `${values.slice(0, limit).join(', ')} +${values.length - limit} more`;
}

function resolveSourceLabel(
  data: AdminSettingsData | null,
  schema: SettingsContractData | null,
  key: string,
): string {
  const ownerFile = schema?.fields?.[key]?.ownerFile;
  if (ownerFile) return ownerFile;
  if (data && key in data.config) return 'settings.json';
  return 'default';
}

function defaultAuthority(
  data: AdminSettingsData | null,
  schema: SettingsContractData | null,
  key: string,
): SettingAuthorityInfo {
  const sourceLabel = resolveSourceLabel(data, schema, key);
  if (sourceLabel === 'default') {
    return {
      sourceLabel,
      detail: 'Using the runtime default because there is no persisted override for this setting.',
    };
  }

  return {
    sourceLabel,
    detail: `Authoritative source: ${sourceLabel}. Garden saves this setting back through that owner file.`,
  };
}

export function resolveSettingAuthority(
  data: AdminSettingsData | null,
  schema: SettingsContractData | null,
  key: string,
): SettingAuthorityInfo {
  const fallback = defaultAuthority(data, schema, key);

  if (key === 'maintenanceIntervalMs') {
    const scheduler = (data?.editors?.scheduler as SchedulerEditorConfig | undefined) ?? {};
    const effectiveMs = asInteger(scheduler.salienceDecayIntervalMs)
      ?? asInteger(asRecord(data?.config)?.maintenanceIntervalMs);
    return {
      sourceLabel: fallback.sourceLabel,
      ...(effectiveMs !== undefined ? { effectiveValue: `${effectiveMs.toLocaleString()} ms` } : {}),
      detail:
        'Authoritative source: scheduler.json > salienceDecayIntervalMs. Saving here writes scheduler.json, and the runtime mirror updates from that file.',
      precedence:
        'scheduler.json wins. The runtime maintenanceIntervalMs value shown in admin is a mirror, not an independently owned knob.',
    };
  }

  if (key === 'capabilityTier') {
    const capabilities = (data?.editors?.capabilities as CapabilitiesEditorConfig | undefined) ?? {};
    const effectiveTier = asString(capabilities.tier) ?? asString(asRecord(data?.config)?.capabilityTier);
    return {
      sourceLabel: fallback.sourceLabel,
      ...(effectiveTier ? { effectiveValue: effectiveTier } : {}),
      detail:
        'Authoritative source: capability-tier.json > tier. Saving here writes capability-tier.json; runtime capability gating reads the persisted tier from there.',
      precedence:
        'capability-tier.json wins over any stale runtime copy, so Garden should be read as the owner-file view for this control.',
    };
  }

  if (key === 'customTokens') {
    const capabilities = (data?.editors?.capabilities as CapabilitiesEditorConfig | undefined) ?? {};
    const effectiveTier = asString(capabilities.tier) ?? asString(asRecord(data?.config)?.capabilityTier);
    const tokens = asStringArray(capabilities.customTokens);
    return {
      sourceLabel: fallback.sourceLabel,
      ...(summarizeList(tokens) ? { effectiveValue: summarizeList(tokens) } : {}),
      detail:
        'Authoritative source: capability-tier.json > customTokens. Saving here writes capability-tier.json instead of settings.json.',
      precedence: effectiveTier === 'custom'
        ? 'These tokens are active because the current tier is custom.'
        : `These tokens stay dormant until the tier is set to custom${effectiveTier ? ` (current: ${effectiveTier})` : ''}.`,
    };
  }

  return fallback;
}

export function resolveBudgetContextWindowAuthority(
  data: AdminSettingsData | null,
  preview: ContextBudgetPreviewData | null,
): SettingAuthorityInfo | null {
  if (!preview) return null;

  const models = (data?.editors?.models as ModelsEditorConfig | undefined) ?? {};
  const chatAssignment = asString(models.modelRoleAssignments?.chat);
  const assignedCatalogEntry = chatAssignment ? models.modelCatalog?.[chatAssignment] : undefined;
  const chatCatalogEntry = models.modelCatalog?.chat;
  const rosterChat = models.modelRoster?.chat;

  const assignedCatalogWindow = asInteger(assignedCatalogEntry?.contextWindow);
  const chatCatalogWindow = asInteger(chatCatalogEntry?.contextWindow);
  const rosterWindow = asInteger(rosterChat?.contextWindow);

  let detail = 'Garden is using the runtime fallback chat context window because models.json does not set one for the effective chat slot.';
  let sourceLabel = 'runtime fallback';
  if (assignedCatalogWindow !== undefined) {
    sourceLabel = 'models.json';
    detail = `Garden is using models.json > modelCatalog.${chatAssignment}.contextWindow for the chat slot preview.`;
  } else if (chatCatalogWindow !== undefined) {
    sourceLabel = 'models.json';
    detail = 'Garden is using models.json > modelCatalog.chat.contextWindow for the chat slot preview.';
  } else if (rosterWindow !== undefined) {
    sourceLabel = 'models.json';
    detail = 'Garden is using models.json > modelRoster.chat.contextWindow for the chat slot preview.';
  }

  const modelLabel = [preview.resolvedChatProvider, preview.resolvedChatModel].filter(Boolean).join(' / ');
  return {
    sourceLabel,
    effectiveValue: `${preview.contextWindow.toLocaleString()} tokens${modelLabel ? ` · ${modelLabel}` : ''}`,
    detail,
    precedence:
      'Runtime resolution is per-turn: explicit modelSelection.contextWindow wins first, then the assigned/matching catalog slot, then modelRoster.chat, then the runtime fallback.',
  };
}
