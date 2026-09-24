import { randomUUID } from 'node:crypto';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import { executeQuery, queryRows } from '../../../persistence/postgres.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type {
  ScratchpadAddResult,
  ScratchpadEntry,
  ScratchpadEntryCreateOptions,
  ScratchpadEntryReplaceOptions,
} from '../memory-store-port.js';
import type { ScratchpadRow } from './rows.js';
import { parsePgNumber } from './rows.js';
import { clampLimit } from './utils.js';
import type { PostgresMemoryStoreCollaboratorContext } from './collaborator-context.js';

const SCRATCHPAD_TTL_MS = 24 * 60 * 60 * 1000;
const SCRATCHPAD_MAX_ENTRIES = 64;
const log = createComponentLogger('PostgresMemoryStore');

/**
 * Scratchpad entries for PostgresMemoryStore: a small, TTL-pruned, capacity-
 * bounded note set persisted in `scratchpad_entries` and optionally mirrored
 * to a JSON file. Pool-direct writes ride the facade persist chain; scratchpad
 * state is never part of a memory-store transaction.
 */
export class PostgresScratchpadStore {
  private readonly entries = new Map<string, ScratchpadEntry>();

  constructor(
    private readonly ctx: Pick<PostgresMemoryStoreCollaboratorContext, 'pool' | 'persist'>,
    private readonly mirrorPath: string | null,
  ) {}

  async hydrate(): Promise<void> {
    const scratchpadEntries = await queryRows<ScratchpadRow>(this.ctx.pool, `
      SELECT id, content, created_at, updated_at
      FROM scratchpad_entries
      ORDER BY updated_at DESC, created_at DESC
    `);
    for (const row of scratchpadEntries) {
      this.entries.set(row.id, {
        id: row.id,
        content: row.content,
        createdAt: parsePgNumber(row.created_at, 'scratchpad_entries.created_at'),
        updatedAt: parsePgNumber(row.updated_at, 'scratchpad_entries.updated_at'),
      });
    }
    this.pruneExpiredScratchpadEntries();
  }

  private async upsertScratchpadEntry(entry: ScratchpadEntry): Promise<void> {
    await executeQuery(this.ctx.pool, `
      INSERT INTO scratchpad_entries (id, content, created_at, updated_at)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
    `, [entry.id, entry.content, entry.createdAt, entry.updatedAt]);
    this.syncScratchpadMirror();
  }

  private syncScratchpadMirror(): void {
    if (!this.mirrorPath) return;
    const payload = {
      entries: this.listScratchpadEntries(),
    };
    writeJsonAtomic(this.mirrorPath, payload);
  }

  private collectExpiredScratchpadEntryIds(now = Date.now()): string[] {
    const cutoff = now - SCRATCHPAD_TTL_MS;
    return Array.from(this.entries.values())
      .filter(entry => entry.updatedAt < cutoff)
      .map(entry => entry.id);
  }

  private pruneExpiredScratchpadEntries(now = Date.now()): string[] {
    const expiredIds = this.collectExpiredScratchpadEntryIds(now);
    if (expiredIds.length === 0) {
      return [];
    }

    for (const id of expiredIds) {
      this.entries.delete(id);
    }

    void this.ctx.persist(async () => {
      for (const id of expiredIds) {
        await executeQuery(this.ctx.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [id]);
      }
    }).catch((error: unknown) => {
      log.warn('Failed to prune expired scratchpad entries', { error: String(error) });
    });
    this.syncScratchpadMirror();
    return expiredIds;
  }

  async addScratchpadEntry(
    content: string,
    options: ScratchpadEntryCreateOptions = {},
  ): Promise<ScratchpadAddResult> {
    const normalized = content.trim();
    if (!normalized) throw new Error('Scratchpad content is required');
    const now = options.now ?? Date.now();
    const id = options.id?.trim() || randomUUID();
    const entry: ScratchpadEntry = { id, content: normalized, createdAt: now, updatedAt: now };
    await this.ctx.persist(() => this.upsertScratchpadEntry(entry));
    this.entries.set(id, entry);
    const evictedIds = await this.pruneScratchpadEntries();
    const current = this.entries.get(id);
    if (!current) throw new Error(`Failed to load scratchpad entry after insert: ${id}`);
    return { entry: current, evictedIds };
  }

  async replaceScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const existing = this.entries.get(normalizedId);
    if (!existing) return null;
    const updated = {
      ...existing,
      content: content.trim(),
      updatedAt: options.now ?? Date.now(),
    };
    await this.ctx.persist(() => this.upsertScratchpadEntry(updated));
    this.entries.set(normalizedId, updated);
    return updated;
  }

  async appendScratchpadEntry(
    id: string,
    content: string,
    options: ScratchpadEntryReplaceOptions = {},
  ): Promise<ScratchpadEntry | null> {
    const normalizedId = id.trim();
    if (!normalizedId) return null;
    const existing = this.entries.get(normalizedId);
    if (!existing) return null;
    const appendix = content.trim();
    if (!appendix) {
      throw new Error('Scratchpad content is required');
    }

    const separator = existing.content.length > 0 ? '\n' : '';
    const updated = {
      ...existing,
      content: `${existing.content}${separator}${appendix}`,
      updatedAt: options.now ?? Date.now(),
    };
    await this.ctx.persist(() => this.upsertScratchpadEntry(updated));
    this.entries.set(normalizedId, updated);
    return updated;
  }

  async removeScratchpadEntry(id: string): Promise<boolean> {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    if (!this.entries.has(normalizedId)) return false;
    await this.ctx.persist(async () => {
      await executeQuery(this.ctx.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [normalizedId]);
    });
    this.entries.delete(normalizedId);
    this.syncScratchpadMirror();
    return true;
  }

  async getScratchpadEntry(id: string): Promise<ScratchpadEntry | undefined> {
    this.pruneExpiredScratchpadEntries();
    return this.entries.get(id.trim());
  }

  listScratchpadEntries(limit: number = 64): ScratchpadEntry[] {
    this.pruneExpiredScratchpadEntries();
    return Array.from(this.entries.values())
      .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
      .slice(0, clampLimit(limit, SCRATCHPAD_MAX_ENTRIES, 1, SCRATCHPAD_MAX_ENTRIES));
  }

  private async pruneScratchpadEntries(): Promise<string[]> {
    this.pruneExpiredScratchpadEntries();
    const maxEntries = SCRATCHPAD_MAX_ENTRIES;
    const ordered = Array.from(this.entries.values())
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt);
    const overflow = Math.max(0, ordered.length - maxEntries);
    const evicted = ordered.slice(0, overflow).map(entry => entry.id);
    if (evicted.length > 0) {
      await this.ctx.persist(async () => {
        for (const id of evicted) {
          await executeQuery(this.ctx.pool, 'DELETE FROM scratchpad_entries WHERE id = $1', [id]);
        }
      });
      for (const id of evicted) {
        this.entries.delete(id);
      }
    }
    this.syncScratchpadMirror();
    return evicted;
  }
}
