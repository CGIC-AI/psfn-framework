import type { ServerResponse } from 'node:http';
import { sendJson } from '../../../channels/backplane/http/primitives.js';
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

export function sendInternalError(
  res: ServerResponse,
  error: unknown,
  fallback: string,
  headers?: Record<string, string>,
): void {
  sendJson(res, 500, { error: toSanitizedMessage(error, fallback) }, headers);
}

export interface PositiveIntegerQueryOptions {
  syntax?: 'decimal_digits' | 'number';
  blank?: 'missing' | 'invalid';
  trimBlank?: boolean;
  safe?: boolean;
  max?: number;
  invalidMessage?: string;
  maximumMessage?: string;
}

export type PositiveIntegerQueryResult =
  | { ok: true; value?: number }
  | { ok: false; error: string };

export function parsePositiveIntegerQueryParam(
  params: URLSearchParams,
  name: string,
  options: PositiveIntegerQueryOptions = {},
): PositiveIntegerQueryResult {
  const raw = params.get(name);
  if (raw === null) return { ok: true };

  const blankValue = options.trimBlank ? raw.trim() : raw;
  if (blankValue === '' && options.blank !== 'invalid') return { ok: true };

  const syntax = options.syntax ?? 'decimal_digits';
  const value = syntax === 'number' ? Number(raw) : Number.parseInt(raw, 10);
  const syntaxIsValid = syntax === 'number' || /^\d+$/.test(raw);
  const integerIsValid = (options.safe ?? true)
    ? Number.isSafeInteger(value)
    : Number.isInteger(value);
  const invalidMessage = options.invalidMessage ?? `${name} must be a positive integer`;
  if (!syntaxIsValid || !integerIsValid || value <= 0) {
    return { ok: false, error: invalidMessage };
  }
  if (options.max !== undefined && value > options.max) {
    return {
      ok: false,
      error: options.maximumMessage ?? `${name} must be <= ${options.max}`,
    };
  }
  return { ok: true, value };
}

export function parsePositiveIntegerQueryNumber(
  params: URLSearchParams,
  name: string,
): PositiveIntegerQueryResult {
  return parsePositiveIntegerQueryParam(params, name, {
    syntax: 'number',
    safe: false,
    trimBlank: true,
    invalidMessage: `Invalid ${name} query parameter. Expected a positive integer.`,
  });
}
