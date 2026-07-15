import { createHash } from 'node:crypto';

export const MAX_MODEL_USAGE_METADATA_BYTES = 16 * 1024;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_KEYS = 64;
const MAX_METADATA_ARRAY_ITEMS = 32;
const MAX_METADATA_STRING_CHARS = 2_048;

interface AccountingMetadataStamp {
  truncated: true;
  originalBytes: number;
  sha256: string;
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encoded = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (typeof item !== 'object' || item === null) return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);
    return item;
  });
  return typeof encoded === 'string' ? encoded : '{}';
}

function truncateValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING_CHARS
      ? `${value.slice(0, MAX_METADATA_STRING_CHARS)}…[truncated]`
      : value;
  }
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (depth >= MAX_METADATA_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map(item => truncateValue(item, depth + 1));
    if (value.length > MAX_METADATA_ARRAY_ITEMS) {
      items.push(`[${value.length - MAX_METADATA_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  if (typeof value !== 'object') return String(value);

  const entries = Object.entries(value as Record<string, unknown>);
  const bounded = Object.fromEntries(
    entries
      .slice(0, MAX_METADATA_KEYS)
      .map(([key, item]) => [key, truncateValue(item, depth + 1)]),
  ) as Record<string, unknown>;
  if (entries.length > MAX_METADATA_KEYS) {
    bounded._truncatedKeys = entries.length - MAX_METADATA_KEYS;
  }
  return bounded;
}

export function boundModelUsageMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const original = metadata ?? {};
  const originalJson = safeJson(original);
  if (Buffer.byteLength(originalJson, 'utf8') <= MAX_MODEL_USAGE_METADATA_BYTES) {
    return JSON.parse(originalJson) as Record<string, unknown>;
  }

  const stamp: AccountingMetadataStamp = {
    truncated: true,
    originalBytes: Buffer.byteLength(originalJson, 'utf8'),
    sha256: createHash('sha256').update(originalJson).digest('hex'),
  };
  const bounded = truncateValue(original, 0) as Record<string, unknown>;
  bounded._accountingMetadata = stamp;
  if (Buffer.byteLength(safeJson(bounded), 'utf8') <= MAX_MODEL_USAGE_METADATA_BYTES) {
    return bounded;
  }

  const reduced = {
    ...Object.fromEntries(
      Object.entries(bounded)
        .filter(([key]) => key !== 'rawUsage' && key !== 'malformedRawUsage')
        .slice(0, 16),
    ),
    rawUsage: '[truncated: metadata exceeded accounting limit]',
    _accountingMetadata: stamp,
  };
  if (Buffer.byteLength(safeJson(reduced), 'utf8') <= MAX_MODEL_USAGE_METADATA_BYTES) {
    return reduced;
  }
  return {
    rawUsage: '[truncated: metadata exceeded accounting limit]',
    _accountingMetadata: stamp,
  };
}
