// ── Memory Writer ──
// Shared write/dedup/contradiction logic used by both MemoryExtractor and tools.

import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from './store.js';
import type {
  PurrMemory,
  MemoryType,
  SensitivityLevel,
  ConsentFlags,
  MemoryRetentionClass,
} from './types.js';
import {
  DEDUP_THRESHOLD,
  DURABLE_RETENTION_TAG,
  MEMORY_CONFIG,
  VALID_MEMORY_TYPES,
  inferMemoryRetentionClass,
  isDurableMemory,
  normalizeMemoryTags,
} from './types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('MemoryWriter');

export interface MemoryWriteOptions {
  text: string;
  type: MemoryType;
  importance?: number;       // default 0.5
  emotionalValence?: number; // default 0
  confidence?: number;       // default 0.8
  tags?: string[];
  sourceRef?: string;        // default 'tool:memory_write'
  sensitivity?: SensitivityLevel;    // default 'personal'
  consentFlags?: ConsentFlags;       // default {}
  retentionClass?: MemoryRetentionClass;
  contactId?: string;
}

export interface WriteResult {
  action: 'created' | 'deduplicated' | 'superseded';
  memory: PurrMemory;
  /** If deduplicated, the existing memory that was bumped */
  existingId?: string;
}

export interface BatchImportResult {
  written: number;
  deduplicated: number;
  superseded: number;
  errors: number;
  results: WriteResult[];
}

function applyRetentionSemantics(input: {
  type: MemoryType;
  importance: number;
  tags: readonly string[];
  retentionClass?: MemoryRetentionClass;
}): {
  tags: string[];
  retentionClass?: MemoryRetentionClass;
} {
  const tags = normalizeMemoryTags(input.tags);
  const inferred = inferMemoryRetentionClass({
    type: input.type,
    importance: input.importance,
    tags,
    retentionClass: input.retentionClass,
  });

  if (inferred === 'durable' && !tags.includes(DURABLE_RETENTION_TAG)) {
    tags.push(DURABLE_RETENTION_TAG);
  }

  return {
    tags,
    retentionClass: inferred === 'durable' ? 'durable' : undefined,
  };
}

function normalizeSourceRef(sourceRef: string | undefined, fallback: string): string {
  const trimmed = sourceRef?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

export class MemoryWriter {
  constructor(
    private memoryStore: MemoryStore,
    private embeddingService: EmbeddingService,
  ) {}

  /**
   * Write a single memory with dedup/contradiction handling.
   *
   * 1. Embed the text
   * 2. Check for duplicates at type-specific threshold -- if found, bump salience
   * 3. Check for contradictions at lower threshold -- if found and new confidence > old, supersede
   * 4. Insert new memory
   */
  async write(opts: MemoryWriteOptions): Promise<WriteResult> {
    const {
      text,
      type,
      importance = 0.5,
      emotionalValence = 0,
      confidence = 0.8,
      tags = [],
      sourceRef,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
    } = opts;

    // Validate type
    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      type,
      importance,
      tags,
      retentionClass,
    });

    const embedding = await this.embeddingService.embed(text);

    // 1. Check for exact duplicates (high threshold per type)
    const duplicates = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type],
      3,
    );

    const sameTypeDups = duplicates.filter(d => (
      d.type === type && (
        !contactId
        || d.contactId === contactId
      )
    ));
    if (sameTypeDups.length > 0) {
      // Duplicate found -- bump access count and salience
      const existing = sameTypeDups[0];
      const updates: {
        lastAccessed: number;
        accessCount: number;
        salience: number;
        tags?: string[];
      } = {
        lastAccessed: Date.now(),
        accessCount: existing.accessCount + 1,
        salience: Math.min(1, existing.salience + MEMORY_CONFIG.salienceBumpOnAccess),
      };

      // If this write is durable, upgrade duplicate memory tags so durability survives persistence.
      if (retention.retentionClass === 'durable' && !isDurableMemory(existing)) {
        updates.tags = normalizeMemoryTags([...existing.tags, ...retention.tags, DURABLE_RETENTION_TAG]);
      }

      this.memoryStore.updateMemory(existing.id, updates);
      log.debug('Deduplicated memory', { existingId: existing.id, text: text.slice(0, 60) });
      return {
        action: 'deduplicated',
        memory: {
          ...existing,
          lastAccessed: updates.lastAccessed,
          accessCount: updates.accessCount,
          salience: updates.salience,
          tags: updates.tags ?? existing.tags,
          retentionClass: retention.retentionClass ?? existing.retentionClass,
        },
        existingId: existing.id,
      };
    }

    // 2. Check for contradictions (lower threshold)
    const broader = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type] - MEMORY_CONFIG.contradictionThresholdOffset,
      5,
    );

    let didSupersede = false;
    const sameTypeBroader = broader.filter(b => b.type === type);
    const sameContactBroader = contactId
      ? sameTypeBroader.filter(b => b.contactId === contactId)
      : sameTypeBroader;
    for (const old of sameContactBroader) {
      if (confidence > old.confidence) {
        this.memoryStore.updateMemory(old.id, {
          supersededBy: uuidv4(),
        });
        didSupersede = true;
        log.debug('Superseded memory', { oldId: old.id, text: text.slice(0, 60) });
      }
    }

    // 3. Insert new memory
    const now = Date.now();
    const normalizedSourceRef = normalizeSourceRef(sourceRef, 'tool:memory_write');
    const memory: PurrMemory = {
      id: uuidv4(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      salience: importance, // Initial salience = importance
      sourceRef: normalizedSourceRef,
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags: retention.tags,
      retentionClass: retention.retentionClass,
      sensitivity,
      consentFlags,
      contactId,
    };

    this.memoryStore.insertMemory(memory, embedding);
    log.debug('Created memory', { id: memory.id, type, text: text.slice(0, 60) });

    return {
      action: didSupersede ? 'superseded' : 'created',
      memory,
    };
  }

  /**
   * Upsert a memory: if a similar memory of the same type exists, supersede it
   * and create a new one with updated content. Unlike write() which bumps salience
   * on dedup, upsert always replaces the old memory.
   */
  async upsert(opts: MemoryWriteOptions): Promise<WriteResult> {
    const {
      text,
      type,
      importance = 0.5,
      emotionalValence = 0,
      confidence = 0.8,
      tags = [],
      sourceRef,
      sensitivity = 'personal',
      consentFlags,
      retentionClass,
      contactId,
    } = opts;

    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const retention = applyRetentionSemantics({
      type,
      importance,
      tags,
      retentionClass,
    });

    const embedding = await this.embeddingService.embed(text);

    // Find similar memories of the same type at the dedup threshold
    const similar = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type] - MEMORY_CONFIG.contradictionThresholdOffset,
      5,
    );

    let didSupersede = false;
    const sameType = similar.filter(s => (
      s.type === type && (
        !contactId
        || s.contactId === contactId
      )
    ));
    for (const old of sameType) {
      this.memoryStore.updateMemory(old.id, { supersededBy: uuidv4() });
      didSupersede = true;
      log.debug('Upsert superseded memory', { oldId: old.id, text: text.slice(0, 60) });
    }

    // Always insert the new memory
    const now = Date.now();
    const normalizedSourceRef = normalizeSourceRef(sourceRef, 'tool:memory_upsert');
    const memory: PurrMemory = {
      id: uuidv4(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      salience: importance,
      sourceRef: normalizedSourceRef,
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags: retention.tags,
      retentionClass: retention.retentionClass,
      sensitivity,
      consentFlags,
      contactId,
    };

    this.memoryStore.insertMemory(memory, embedding);
    log.debug('Upsert created memory', { id: memory.id, type, superseded: didSupersede, text: text.slice(0, 60) });

    return {
      action: didSupersede ? 'superseded' : 'created',
      memory,
    };
  }

  /**
   * Import a batch of memories. Processes sequentially to allow dedup between items.
   * For large batches, this avoids overwhelming the embedding service.
   */
  async importBatch(records: MemoryWriteOptions[]): Promise<BatchImportResult> {
    const results: WriteResult[] = [];
    let written = 0;
    let deduplicated = 0;
    let superseded = 0;
    let errors = 0;

    for (const record of records) {
      try {
        const result = await this.write(record);
        results.push(result);

        switch (result.action) {
          case 'created':
            written++;
            break;
          case 'deduplicated':
            deduplicated++;
            break;
          case 'superseded':
            written++;
            superseded++;
            break;
        }
      } catch (err) {
        errors++;
        log.error('Error importing memory', { error: String(err), text: record.text?.slice(0, 60) });
      }
    }

    log.info('Batch import complete', { written, deduplicated, superseded, errors, total: records.length });
    return { written, deduplicated, superseded, errors, results };
  }
}
