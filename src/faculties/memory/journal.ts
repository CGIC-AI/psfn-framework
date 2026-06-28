// ── Memory Journal ──
// Append-only JSONL mirror of every memory mutation (insert / soft-delete / restore).
// This is an audit/export aid, not the authoritative L2 restore primitive:
// embeddings, evolution links, and Postgres-only memory tables are restored
// from encrypted database backups.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import type { PurrMemory } from './types.js';
import type { MemoryDeleteVersion } from './memory-store-port.js';

const log = createComponentLogger('MemoryJournal');

export type MemoryJournalEventKind = 'insert' | 'soft_delete' | 'restore';

export interface MemoryJournalInsertEvent {
  kind: 'insert';
  ts: number;
  memory: PurrMemory;
}

export interface MemoryJournalSoftDeleteEvent {
  kind: 'soft_delete';
  ts: number;
  memoryId: string;
  deleteId: string;
  deletedBy: string;
  reason?: string;
  snapshot: PurrMemory;
}

export interface MemoryJournalRestoreEvent {
  kind: 'restore';
  ts: number;
  memoryId: string;
  deleteId: string;
  restoredBy: string;
}

export type MemoryJournalEvent =
  | MemoryJournalInsertEvent
  | MemoryJournalSoftDeleteEvent
  | MemoryJournalRestoreEvent;

export class MemoryJournal {
  private readonly path: string;
  private dirEnsured = false;

  constructor(journalPath: string) {
    this.path = journalPath;
  }

  append(event: MemoryJournalEvent): void {
    try {
      if (!this.dirEnsured) {
        mkdirSync(dirname(this.path), { recursive: true });
        this.dirEnsured = true;
      }
      appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      log.warn('Failed to append to memory journal', {
        path: this.path,
        kind: event.kind,
        error: String(err),
      });
    }
  }

  onInsert(memory: PurrMemory): void {
    this.append({ kind: 'insert', ts: Date.now(), memory });
  }

  onSoftDelete(version: MemoryDeleteVersion): void {
    this.append({
      kind: 'soft_delete',
      ts: Date.now(),
      memoryId: version.memoryId,
      deleteId: version.deleteId,
      deletedBy: version.deletedBy,
      ...(version.deleteReason ? { reason: version.deleteReason } : {}),
      snapshot: version.snapshot,
    });
  }

  onRestore(version: MemoryDeleteVersion): void {
    this.append({
      kind: 'restore',
      ts: Date.now(),
      memoryId: version.memoryId,
      deleteId: version.deleteId,
      restoredBy: version.restoredBy ?? 'unknown',
    });
  }
}
