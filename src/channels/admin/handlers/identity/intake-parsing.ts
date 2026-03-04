import { readFileSync } from 'node:fs';
import type { RelationshipType } from '../../../../contacts/types.js';
import {
  estimateImportedMemoryCriticality,
  inferImportedMemoryType,
  initializeImportedMemorySalience,
  type MemoryType,
  type SensitivityLevel,
} from '../../../../memory/types.js';
import { toErrorMessage } from '../../../../utils/errors.js';
import type { IdentityIntakeChatChunk } from '../../templates/identity.js';
import {
  clampUnit,
  estimateTokens,
  inferRelationshipTypeHint,
  normalizeSensitivity,
  normalizeSessionRole,
  parseProvenanceRefs,
  parseTimestamp,
  toNonEmptyString,
  toNumber,
  toRecord,
  toStringArray,
  uniqueLowercase,
} from '../../utils.js';

export const DEFAULT_CHAT_CHUNK_TARGET_TOKENS = 50_000;
export const MIN_CHAT_CHUNK_TARGET_TOKENS = 1_000;
export const MAX_CHAT_CHUNK_TARGET_TOKENS = 200_000;

export interface StagedIntakeChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  authorId?: string;
  authorName?: string;
}

export interface ParsedRawMemoryItem {
  text: string;
  type: MemoryType;
  importance: number;
  salience: number;
  criticality: number;
  tags: string[];
  provenanceRefs: string[];
  sensitivity: SensitivityLevel;
  contactId?: string;
  extractedAt?: number;
  lastAccessed?: number;
  relationshipTypeHint?: RelationshipType;
}

export function parseJsonFileFromPath(rawPath: string, label: string): unknown {
  const path = rawPath.trim();
  if (!path) {
    throw new Error(`${label} path is required`);
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`Unable to read ${label} file "${path}": ${message}`);
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const message = toErrorMessage(error);
    throw new Error(`${label} file "${path}" is not valid JSON: ${message}`);
  }
}

export function parseChatMessagesFromPayload(payload: unknown): StagedIntakeChatMessage[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    const record = toRecord(payload);
    if (record) {
      const candidates = record.messages ?? record.chat ?? record.turns ?? record.entries;
      if (Array.isArray(candidates)) rows = candidates;
    }
  }

  const now = Date.now();
  const messages: StagedIntakeChatMessage[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (typeof row === 'string') {
      const content = row.trim();
      if (!content) continue;
      messages.push({
        role: 'user',
        content,
        timestamp: now + index,
      });
      continue;
    }

    const entry = toRecord(row);
    if (!entry) continue;
    const content = toNonEmptyString(entry.content)
      ?? toNonEmptyString(entry.text)
      ?? toNonEmptyString(entry.message)
      ?? toNonEmptyString(entry.body);
    if (!content) continue;

    messages.push({
      role: normalizeSessionRole(entry.role ?? entry.speaker ?? entry.authorRole ?? entry.type),
      content,
      timestamp: parseTimestamp(
        entry.timestamp ?? entry.createdAt ?? entry.created_at ?? entry.date,
        now + index,
      ),
      authorId: toNonEmptyString(entry.authorId) ?? toNonEmptyString(entry.userId) ?? undefined,
      authorName: toNonEmptyString(entry.authorName)
        ?? toNonEmptyString(entry.author)
        ?? toNonEmptyString(entry.name)
        ?? undefined,
    });
  }

  return messages;
}

export function chunkChatMessages(
  messages: readonly StagedIntakeChatMessage[],
  chunkTargetTokens: number,
): IdentityIntakeChatChunk[] {
  if (messages.length === 0) return [];
  const chunks: IdentityIntakeChatChunk[] = [];
  let chunkStart = 0;
  let chunkTokenCount = 0;
  let chunkIndex = 1;

  const pushChunk = (endExclusive: number, tokenCount: number): void => {
    if (endExclusive <= chunkStart) return;
    const messageCount = endExclusive - chunkStart;
    chunks.push({
      id: `chat-chunk-${chunkIndex}`,
      index: chunkIndex,
      startMessage: chunkStart + 1,
      endMessage: endExclusive,
      messageCount,
      estimatedTokens: tokenCount,
      status: 'pending',
    });
    chunkIndex += 1;
    chunkStart = endExclusive;
    chunkTokenCount = 0;
  };

  for (let idx = 0; idx < messages.length; idx++) {
    const messageTokens = estimateTokens(messages[idx].content);
    if (chunkTokenCount > 0 && chunkTokenCount + messageTokens > chunkTargetTokens) {
      pushChunk(idx, chunkTokenCount);
    }
    chunkTokenCount += messageTokens;
  }

  pushChunk(messages.length, chunkTokenCount);
  return chunks;
}

export function parseMemoryItemsFromPayload(payload: unknown, sourcePath?: string): ParsedRawMemoryItem[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    const record = toRecord(payload);
    if (record) {
      const candidates = record.memories ?? record.memory ?? record.items ?? record.entries;
      if (Array.isArray(candidates)) rows = candidates;
    }
  }

  const items: ParsedRawMemoryItem[] = [];
  for (const row of rows) {
    const entry = toRecord(row);
    if (!entry) continue;
    const text = toNonEmptyString(entry.text)
      ?? toNonEmptyString(entry.content)
      ?? toNonEmptyString(entry.memory)
      ?? toNonEmptyString(entry.summary);
    if (!text) continue;

    const tags = uniqueLowercase(
      toStringArray(entry.tags)
        .concat(toStringArray(entry.keywords))
        .concat(toStringArray(entry.labels)),
    );
    const type = inferImportedMemoryType({
      text,
      explicitType: entry.type ?? entry.memoryType,
      tags,
    });
    const importance = clampUnit(
      toNumber(entry.importance)
        ?? toNumber(entry.priority)
        ?? toNumber(entry.weight)
        ?? 0.5,
    );
    const now = Date.now();
    const extractedAt = parseTimestamp(
      entry.extractedAt
        ?? entry.extracted_at
        ?? entry.createdAt
        ?? entry.created_at
        ?? entry.timestamp
        ?? entry.date,
      now,
    );
    const lastAccessed = parseTimestamp(
      entry.lastAccessed
        ?? entry.last_accessed
        ?? entry.updatedAt
        ?? entry.updated_at
        ?? entry.last_seen
        ?? extractedAt,
      extractedAt,
    );
    const salience = initializeImportedMemorySalience({
      importance,
      salience: toNumber(entry.salience) ?? undefined,
      type,
      tags,
      text,
      extractedAt,
      lastAccessed,
    });
    const criticality = estimateImportedMemoryCriticality({
      type,
      importance,
      tags,
      text,
    });
    const fallbackRef = sourcePath
      ? `legacy:${sourcePath}#memory-${items.length + 1}`
      : `legacy:memory#${items.length + 1}`;
    const provenanceRefs = parseProvenanceRefs(entry, fallbackRef);
    const relationshipTypeHint = inferRelationshipTypeHint({
      explicitValue: entry.relationshipType ?? entry.relationship_type,
      text,
      tags,
      type,
    });

    items.push({
      text,
      type,
      importance,
      salience,
      criticality,
      tags,
      provenanceRefs,
      sensitivity: normalizeSensitivity(entry.sensitivity),
      contactId: toNonEmptyString(entry.contactId) ?? toNonEmptyString(entry.contact_id) ?? undefined,
      extractedAt,
      lastAccessed,
      relationshipTypeHint,
    });
  }
  return items;
}

export function parseLorebookItemsFromPayload(payload: unknown, sourcePath?: string): ParsedRawMemoryItem[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    const root = toRecord(payload);
    if (root) {
      const topLevel = root.entries ?? root.items ?? root.lorebook;
      if (Array.isArray(topLevel)) rows = topLevel;
      if (rows.length === 0) {
        const cardData = toRecord(root.data);
        const characterBook = toRecord(cardData?.character_book ?? root.character_book);
        if (characterBook && Array.isArray(characterBook.entries)) {
          rows = characterBook.entries;
        }
      }
    }
  }

  const items: ParsedRawMemoryItem[] = [];
  for (const row of rows) {
    const entry = toRecord(row);
    if (!entry) continue;
    const text = toNonEmptyString(entry.content)
      ?? toNonEmptyString(entry.text)
      ?? toNonEmptyString(entry.description)
      ?? toNonEmptyString(entry.comment);
    if (!text) continue;

    const keywords = toStringArray(entry.keys)
      .concat(toStringArray(entry.keywords))
      .concat(toStringArray(entry.trigger_words))
      .slice(0, 6);
    const tags = uniqueLowercase(['lorebook', ...keywords]);
    const type = inferImportedMemoryType({
      text,
      explicitType: entry.type ?? 'semantic',
      tags,
    });
    const importance = clampUnit(
      toNumber(entry.importance)
        ?? toNumber(entry.priority)
        ?? toNumber(entry.weight)
        ?? 0.55,
    );
    const now = Date.now();
    const extractedAt = parseTimestamp(
      entry.updatedAt
        ?? entry.updated_at
        ?? entry.createdAt
        ?? entry.created_at
        ?? entry.timestamp,
      now,
    );
    const lastAccessed = extractedAt;
    const salience = initializeImportedMemorySalience({
      importance,
      salience: toNumber(entry.salience) ?? undefined,
      type,
      tags,
      text,
      extractedAt,
      lastAccessed,
    });
    const criticality = estimateImportedMemoryCriticality({
      type,
      importance,
      tags,
      text,
    });
    const fallbackRef = sourcePath
      ? `legacy:${sourcePath}#lorebook-${items.length + 1}`
      : `legacy:lorebook#${items.length + 1}`;
    const provenanceRefs = parseProvenanceRefs(entry, fallbackRef);
    const relationshipTypeHint = inferRelationshipTypeHint({
      explicitValue: entry.relationshipType ?? entry.relationship_type,
      text,
      tags,
      type,
    });

    items.push({
      text,
      type,
      importance,
      salience,
      criticality,
      tags,
      provenanceRefs,
      sensitivity: normalizeSensitivity(entry.sensitivity),
      contactId: toNonEmptyString(entry.contactId) ?? toNonEmptyString(entry.contact_id) ?? undefined,
      extractedAt,
      lastAccessed,
      relationshipTypeHint,
    });
  }

  return items;
}
