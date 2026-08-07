import { parseJsonBody } from '../../channels/backplane/http/primitives.js';

export function parseAdminJsonBody(body: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (body === undefined) return { ok: true, value: {} };
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) {
    return { ok: true, value: body };
  }
  const trimmed = (Buffer.isBuffer(body) ? body.toString('utf8') : body).trim();
  if (!trimmed) return { ok: true, value: {} };
  const result = parseJsonBody(trimmed);
  if (!result.ok) return { ok: false, error: 'Invalid JSON payload' };
  return { ok: true, value: result.value };
}
