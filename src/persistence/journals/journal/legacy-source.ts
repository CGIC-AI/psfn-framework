import { createHash } from 'node:crypto';
import { decodeStoredChannelVisibility } from '../../../system/trust/types.js';
import type {
  LegacyChatSourceRecord,
  ParsedLegacyChatSource,
} from './types.js';

function parseLegacyTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value <= 0) return null;
    if (value >= 1e12) return Math.floor(value);
    if (value >= 1e9) return Math.floor(value * 1000);
    return null;
  }

  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;

  if (/^\d+(\.\d+)?$/.test(normalized)) {
    return parseLegacyTimestamp(Number(normalized));
  }

  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function readLegacyStringValue(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length > 0) return normalized;
  }
  return undefined;
}

function normalizeLegacyRole(value: unknown): 'user' | 'assistant' | 'system' {
  if (typeof value !== 'string') return 'user';
  const normalized = value.trim().toLowerCase();
  if (!normalized) return 'user';
  if (
    normalized === 'assistant'
    || normalized === 'ai'
    || normalized === 'bot'
    || normalized === 'model'
    || normalized === 'agent'
  ) {
    return 'assistant';
  }
  if (
    normalized === 'system'
    || normalized === 'developer'
    || normalized === 'tool'
  ) {
    return 'system';
  }
  return 'user';
}

function normalizeLegacyChannelVisibility(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Legacy journal records predate the E3.1 vocabulary rename; the shared
  // decoder maps 'semi_private' to 'invite_only'.
  return decodeStoredChannelVisibility(value.trim());
}

function normalizeLegacyMetadata(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function normalizeLegacySourceRecord(
  row: unknown,
  sourceIndex: number,
): LegacyChatSourceRecord | null {
  if (!row || typeof row !== 'object') return null;
  const raw = row as Record<string, unknown>;
  const content = readLegacyStringValue(raw, ['content', 'text', 'message', 'body', 'value']);
  if (!content) return null;

  const timestamp = parseLegacyTimestamp(
    raw.timestamp
      ?? raw.createdAt
      ?? raw.created_at
      ?? raw.datetime
      ?? raw.date
      ?? raw.time,
  );
  if (timestamp == null) return null;

  const role = normalizeLegacyRole(raw.role ?? raw.speaker ?? raw.authorRole ?? raw.senderRole ?? raw.source);
  const authorName = readLegacyStringValue(raw, ['authorName', 'name', 'author', 'speakerName', 'displayName']);
  const authorId = readLegacyStringValue(raw, ['authorId', 'userId', 'senderId', 'id']);
  const originChannelId = readLegacyStringValue(raw, ['originChannelId', 'originChannel', 'sourceChannelId']);
  const channelVisibility = normalizeLegacyChannelVisibility(raw.channelVisibility ?? raw.visibility);
  const metadata = normalizeLegacyMetadata(raw.metadata ?? raw.meta ?? raw.extra);

  return {
    sourceIndex,
    role,
    content,
    timestamp,
    authorId,
    authorName,
    metadata,
    originChannelId,
    channelVisibility,
  };
}

function parseLegacySourceJsonArray(
  records: unknown[],
): LegacyChatSourceRecord[] {
  const normalized: LegacyChatSourceRecord[] = [];
  for (let index = 0; index < records.length; index++) {
    const row = normalizeLegacySourceRecord(records[index], index);
    if (row) {
      normalized.push(row);
    }
  }
  return normalized;
}

function parseLegacySourceJsonl(raw: string): LegacyChatSourceRecord[] {
  const normalized: LegacyChatSourceRecord[] = [];
  const lines = raw.split('\n');
  let sourceIndex = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as unknown;
      const normalizedRow = normalizeLegacySourceRecord(row, sourceIndex);
      if (normalizedRow) {
        normalized.push(normalizedRow);
      }
      sourceIndex += 1;
    } catch {
      sourceIndex += 1;
      continue;
    }
  }
  return normalized;
}

export function parseLegacyChatSource(raw: string): ParsedLegacyChatSource {
  const sourceHash = createHash('sha256').update(raw, 'utf8').digest('hex');
  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      format: 'jsonl',
      sourceHash,
      records: [],
    };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return {
        format: 'json-array',
        sourceHash,
        records: parseLegacySourceJsonArray(parsed),
      };
    }

    if (parsed && typeof parsed === 'object') {
      const root = parsed as Record<string, unknown>;
      if (Array.isArray(root.messages)) {
        return {
          format: 'json-messages',
          sourceHash,
          records: parseLegacySourceJsonArray(root.messages),
        };
      }
    }
  } catch {
    // Fall back to JSONL parsing.
  }

  return {
    format: 'jsonl',
    sourceHash,
    records: parseLegacySourceJsonl(raw),
  };
}
