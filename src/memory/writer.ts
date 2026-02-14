// ── Memory Writer ──
// Shared write/dedup/contradiction logic used by both MemoryExtractor and tools.

import { v4 as uuidv4 } from 'uuid';
import type { EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from './store.js';
import type { PurrMemory, MemoryType } from './types.js';
import { DEDUP_THRESHOLD, MEMORY_CONFIG, VALID_MEMORY_TYPES } from './types.js';
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
      sourceRef = 'tool:memory_write',
    } = opts;

    // Validate type
    if (!VALID_MEMORY_TYPES.includes(type)) {
      throw new Error(`Invalid memory type: ${type}. Must be one of: ${VALID_MEMORY_TYPES.join(', ')}`);
    }

    const embedding = await this.embeddingService.embed(text);

    // 1. Check for exact duplicates (high threshold per type)
    const duplicates = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type],
      3,
    );

    const sameTypeDups = duplicates.filter(d => d.type === type);
    if (sameTypeDups.length > 0) {
      // Duplicate found -- bump access count and salience
      const existing = sameTypeDups[0];
      this.memoryStore.updateMemory(existing.id, {
        lastAccessed: Date.now(),
        accessCount: existing.accessCount + 1,
        salience: Math.min(1, existing.salience + MEMORY_CONFIG.salienceBumpOnAccess),
      });
      log.debug('Deduplicated memory', { existingId: existing.id, text: text.slice(0, 60) });
      return { action: 'deduplicated', memory: existing, existingId: existing.id };
    }

    // 2. Check for contradictions (lower threshold)
    const broader = this.memoryStore.searchByEmbedding(
      embedding,
      DEDUP_THRESHOLD[type] - MEMORY_CONFIG.contradictionThresholdOffset,
      5,
    );

    let didSupersede = false;
    const sameTypeBroader = broader.filter(b => b.type === type);
    for (const old of sameTypeBroader) {
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
    const memory: PurrMemory = {
      id: uuidv4(),
      text,
      type,
      importance,
      confidence,
      emotionalValence,
      salience: importance, // Initial salience = importance
      sourceRef,
      extractedAt: now,
      lastAccessed: now,
      accessCount: 1,
      tags,
    };

    this.memoryStore.insertMemory(memory, embedding);
    log.debug('Created memory', { id: memory.id, type, text: text.slice(0, 60) });

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
