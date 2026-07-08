import { escapeHtml } from '../../../shared/utils/escaping.js';

export const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function toSanitizedMessage(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string'
    ? value.trim()
    : (value instanceof Error ? value.message.trim() : String(value ?? '').trim());
  return escapeHtml(normalized || fallback);
}
