import { parseJsonBody } from '../../channels/http/primitives.js';

export function parseAdminJsonBody(body: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = body.trim();
  if (!trimmed) return { ok: true, value: {} };
  const result = parseJsonBody(trimmed);
  if (!result.ok) return { ok: false, error: 'Invalid JSON payload' };
  return { ok: true, value: result.value };
}
