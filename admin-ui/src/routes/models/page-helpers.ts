import type { DiscoveredModel } from '$lib/types';
import {
  isRecord,
  type ModelRegistryEntry,
} from '$lib/models/registry';

type NumberContainerKey = 'capabilities' | 'tuning' | 'cost';
type BooleanContainerKey = 'capabilities' | 'tuning';

export const TUNING_NUMBER_FIELDS = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, integer: false },
  { key: 'topP', label: 'Top P', min: 0, max: 1, step: 0.01, integer: false },
  { key: 'topK', label: 'Top K', min: 1, max: 500, step: 1, integer: true },
  { key: 'frequencyPenalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01, integer: false },
  { key: 'repetitionPenalty', label: 'Repetition Penalty', min: 0, max: 2, step: 0.01, integer: false },
] as const;

export const CAPABILITY_BOOLEAN_FIELDS = [
  { key: 'supportsReasoning', label: 'Supports Thinking / Reasoning' },
  { key: 'supportsVision', label: 'Supports Vision' },
] as const;

export const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export function toErrorMessage(value: unknown, fallback: string): string {
  if (value instanceof Error && value.message.trim().length > 0) {
    return value.message.trim();
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

export function parseApiErrorDetail(error: { body?: string }): string | undefined {
  const rawBody = typeof error.body === 'string' ? error.body.trim() : '';
  if (rawBody.length === 0) return undefined;
  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
  } catch {
    // Non-JSON response body; fall back to raw text
  }
  return rawBody;
}

export function discoverySearchText(model: DiscoveredModel): string {
  return [
    model.id,
    model.description,
    ...(model.providerHints ?? []),
    ...(model.zdrProviderTags ?? []),
    ...(model.zdrProviderNames ?? []),
    model.supportsVision ? 'vision image multimodal' : '',
    model.supportsReasoning ? 'reasoning thinking' : '',
    model.zdrAvailable ? 'zdr zero data retention' : 'no zdr',
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(' ')
    .toLowerCase();
}

export function discoveryLimitSummary(model: DiscoveredModel): string {
  const parts: string[] = [];
  if (model.contextLength) {
    parts.push(`ctx ${model.contextLength.toLocaleString()}`);
  }
  if (model.maxCompletionTokens) {
    parts.push(`max out ${model.maxCompletionTokens.toLocaleString()}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'limits unknown';
}

export function discoveryZdrProviderSummary(model: DiscoveredModel): string {
  const tags = model.zdrProviderTags ?? [];
  if (tags.length > 0) {
    return tags.slice(0, 3).join(', ') + (tags.length > 3 ? ` +${tags.length - 3}` : '');
  }
  const names = model.zdrProviderNames ?? [];
  if (names.length > 0) {
    return names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '');
  }
  return 'ZDR endpoint available';
}

export function toOptionalNumber(raw: string, integer = false): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric)) return undefined;
  return integer ? Math.round(numeric) : numeric;
}

export function cloneModelEntry(entry: ModelRegistryEntry): ModelRegistryEntry {
  return {
    ...entry,
    identity: {
      ...entry.identity,
      source: {
        ...entry.identity.source,
        ...(isRecord(entry.identity.source.metadata)
          ? { metadata: { ...entry.identity.source.metadata } }
          : {}),
      },
    },
    purposes: entry.purposes.map((purpose) => ({ ...purpose })),
    ...(entry.routing ? { routing: { providerOrder: [...(entry.routing.providerOrder ?? [])] } } : {}),
    ...(isRecord(entry.capabilities) ? { capabilities: { ...entry.capabilities } } : {}),
    ...(isRecord(entry.tuning) ? { tuning: { ...entry.tuning } } : {}),
    ...(isRecord(entry.cost) ? { cost: { ...entry.cost } } : {}),
    ...(isRecord(entry.metadata) ? { metadata: { ...entry.metadata } } : {}),
  };
}

export function resequenceRanks(entries: ModelRegistryEntry[]): ModelRegistryEntry[] {
  const total = entries.length;
  return entries.map((entry, index) => ({
    ...entry,
    rank: (total - index) * 10,
  }));
}

function numberFromContainer(
  entry: ModelRegistryEntry,
  containerKey: NumberContainerKey,
  field: string,
): number | undefined {
  const container = entry[containerKey];
  if (!isRecord(container)) return undefined;
  const value = container[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolFromContainer(
  entry: ModelRegistryEntry,
  containerKey: BooleanContainerKey,
  field: string,
): boolean {
  const container = entry[containerKey];
  if (!isRecord(container)) return false;
  return container[field] === true;
}

export function maxContext(entry: ModelRegistryEntry): string {
  const value = numberFromContainer(entry, 'tuning', 'contextWindow')
    ?? numberFromContainer(entry, 'capabilities', 'contextWindow');
  return value !== undefined ? value.toLocaleString() : 'unset';
}

export function maxResponse(entry: ModelRegistryEntry): string {
  const value = numberFromContainer(entry, 'tuning', 'maxOutputTokens')
    ?? numberFromContainer(entry, 'capabilities', 'maxOutputTokens');
  return value !== undefined ? value.toLocaleString() : 'unset';
}

export function summarizeThinkingFlags(entry: ModelRegistryEntry): string {
  const flags: string[] = [];
  if (boolFromContainer(entry, 'capabilities', 'supportsReasoning')) {
    flags.push('supports_reasoning');
  } else if (isRecord(entry.capabilities) && entry.capabilities.supportsReasoning === false) {
    flags.push('reasoning_off');
  }
  const tuning = isRecord(entry.tuning) ? entry.tuning : undefined;
  if (tuning && typeof tuning.reasoningEffort === 'string' && tuning.reasoningEffort.trim().length > 0) {
    flags.push(`effort:${tuning.reasoningEffort.trim()}`);
  }
  if (tuning && typeof tuning.thinkingFormat === 'string' && tuning.thinkingFormat.trim().length > 0) {
    flags.push(`format:${tuning.thinkingFormat.trim()}`);
  }
  return flags.length > 0 ? flags.join(', ') : 'none';
}

export function moveEntry(
  entries: ModelRegistryEntry[],
  fromIndex: number,
  toIndex: number,
): ModelRegistryEntry[] {
  if (fromIndex === toIndex) return entries;
  const next = [...entries];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
