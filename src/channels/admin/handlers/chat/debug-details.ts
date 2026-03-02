import type { AdminChatDebugDetailValue } from '../../types.js';
import { toDebugDetailValue, truncateDebugText } from '../../utils.js';
import { MAX_DEBUG_DETAILS } from './constants.js';

export function compactDebugDetails(
  details: Record<string, unknown>,
): Record<string, AdminChatDebugDetailValue> | undefined {
  const compact: Record<string, AdminChatDebugDetailValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined || count >= MAX_DEBUG_DETAILS) continue;
    const normalizedValue = toDebugDetailValue(value);
    if (normalizedValue === undefined) continue;
    compact[key] = normalizedValue;
    count += 1;
  }
  return count > 0 ? compact : undefined;
}

export function extractDebugExtras(
  data: Record<string, unknown>,
  excludedKeys: string[],
): Record<string, AdminChatDebugDetailValue> | undefined {
  const excluded = new Set(excludedKeys);
  const extras: Record<string, AdminChatDebugDetailValue> = {};
  let count = 0;
  for (const [key, value] of Object.entries(data)) {
    if (excluded.has(key) || count >= MAX_DEBUG_DETAILS) continue;
    const normalized = toDebugDetailValue(value);
    if (normalized === undefined) continue;
    extras[key] = normalized;
    count += 1;
  }
  return count > 0 ? extras : undefined;
}

export function formatRejectionBreakdown(breakdown?: Record<string, number>): string | undefined {
  if (!breakdown) return undefined;
  const entries = Object.entries(breakdown);
  if (entries.length === 0) return undefined;
  const summary = entries
    .slice(0, 4)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ');
  return truncateDebugText(summary, 160);
}
