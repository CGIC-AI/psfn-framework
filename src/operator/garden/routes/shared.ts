import { escapeHtml } from '../../../shared/utils/escaping.js';

export const ADMIN_DYNAMIC_JSON_HEADERS = { 'Cache-Control': 'no-store' } as const;

// `no-cache` (not `no-store`) so the browser may store the response but must
// revalidate before reuse. Combined with the weak ETag emitted by the shared
// JSON responder (see channels/backplane/http/primitives.ts), the high-churn
// queue endpoints that admin-ui polls on an interval revalidate cheaply via
// If-None-Match => 304 instead of re-downloading a byte-identical payload every
// tick. Scoped to the polled queues (confirmations, contact/graph approvals,
// cogsec quarantine); other dynamic reads keep no-store. Mutation responses
// never receive an ETag, so this header does not cache them.
export const ADMIN_POLLED_QUEUE_JSON_HEADERS = { 'Cache-Control': 'no-cache' } as const;

export function toSanitizedMessage(value: unknown, fallback: string): string {
  const normalized = typeof value === 'string'
    ? value.trim()
    : (value instanceof Error ? value.message.trim() : String(value ?? '').trim());
  return escapeHtml(normalized || fallback);
}
