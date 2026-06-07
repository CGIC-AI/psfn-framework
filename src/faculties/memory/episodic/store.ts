import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  serializeEpisode,
  serializeEpisodeArc,
  type Episode,
  type EpisodeArc,
  type EpisodeArcKind,
} from '../../../shared/contracts/episodic-memory.js';

export type EpisodeCreateInput = Omit<
  Episode,
  'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type EpisodeArcWriteInput = Omit<
  EpisodeArc,
  'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface EpisodeListOptions {
  limit?: number;
  offset?: number;
}

export interface EpisodeTimeSearchOptions extends EpisodeListOptions {
  from?: string;
  to?: string;
}

export interface EpisodeArcListOptions {
  direction?: 'incoming' | 'outgoing' | 'both';
  arcKind?: EpisodeArcKind;
  limit?: number;
}

export interface EpisodicStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export type EpisodicStoreResult<T> = T | Promise<T>;

export interface EpisodicStorePort {
  createEpisode(input: EpisodeCreateInput): EpisodicStoreResult<Episode>;
  getEpisode(id: string): EpisodicStoreResult<Episode | undefined>;
  listEpisodes(options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  searchByTime(options?: EpisodeTimeSearchOptions): EpisodicStoreResult<Episode[]>;
  searchByThread(threadId: string, options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  writeEpisodeArc(input: EpisodeArcWriteInput): EpisodicStoreResult<EpisodeArc>;
  listEpisodeArcsForEpisode(
    episodeId: string,
    options?: EpisodeArcListOptions,
  ): EpisodicStoreResult<EpisodeArc[]>;
}

interface EpisodeRow {
  id: string;
  episode_json: string;
}

interface EpisodeArcRow {
  id: string;
  arc_json: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function createEpisodicSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS l01_episodes (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      channel_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      salience_score REAL NOT NULL,
      episode_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_started_at
      ON l01_episodes(started_at, ended_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_thread
      ON l01_episodes(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_channel
      ON l01_episodes(channel_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_salience
      ON l01_episodes(salience_score DESC, started_at DESC);

    CREATE TABLE IF NOT EXISTS l01_episode_arcs (
      id TEXT PRIMARY KEY,
      source_episode_id TEXT NOT NULL,
      target_episode_id TEXT NOT NULL,
      arc_kind TEXT NOT NULL,
      salience_score REAL NOT NULL,
      confidence REAL NOT NULL,
      arc_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (source_episode_id <> target_episode_id),
      FOREIGN KEY (source_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_source
      ON l01_episode_arcs(source_episode_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_target
      ON l01_episode_arcs(target_episode_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_kind
      ON l01_episode_arcs(arc_kind, updated_at DESC);
  `);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return offset;
}

function normalizeInstant(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!ISO_INSTANT_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC instant`);
  }
  return trimmed;
}

function parseEpisodeJson(raw: string, id: string): Episode {
  try {
    return parseEpisode(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode "${id}": ${String(error)}`);
  }
}

function parseArcJson(raw: string, id: string): EpisodeArc {
  try {
    return parseEpisodeArc(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode arc "${id}": ${String(error)}`);
  }
}

function mapEpisodeRow(row: EpisodeRow): Episode {
  const episode = parseEpisodeJson(row.episode_json, row.id);
  if (episode.id !== row.id) {
    throw new Error(`malformed persisted episode "${row.id}": JSON id mismatch`);
  }
  return episode;
}

function mapArcRow(row: EpisodeArcRow): EpisodeArc {
  const arc = parseArcJson(row.arc_json, row.id);
  if (arc.id !== row.id) {
    throw new Error(`malformed persisted episode arc "${row.id}": JSON id mismatch`);
  }
  return arc;
}

function parseRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

export class EpisodicStore implements EpisodicStorePort {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(db: Database.Database, options: EpisodicStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.db.pragma('foreign_keys = ON');
    createEpisodicSchema(this.db);
  }

  createEpisode(input: EpisodeCreateInput): Episode {
    const now = this.now().toISOString();
    const episode = parseEpisode({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    this.db.prepare(`
      INSERT INTO l01_episodes (
        id,
        thread_id,
        channel_id,
        started_at,
        ended_at,
        salience_score,
        episode_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      episode.salience.score,
      serializeEpisode(episode),
      episode.createdAt,
      episode.updatedAt,
    );

    return episode;
  }

  listEpisodes(options: EpisodeListOptions = {}): Episode[] {
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      ORDER BY started_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(normalizeLimit(options.limit), normalizeOffset(options.offset)) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  getEpisode(id: string): Episode | undefined {
    const normalizedId = parseRequiredText(id, 'episode id');
    const row = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as EpisodeRow | undefined;
    return row ? mapEpisodeRow(row) : undefined;
  }

  searchByTime(options: EpisodeTimeSearchOptions = {}): Episode[] {
    const from = normalizeInstant(options.from, 'from');
    const to = normalizeInstant(options.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must be before or equal to to');
    }

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (from !== undefined) {
      where.push('ended_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('started_at <= ?');
      params.push(to);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      ${whereClause}
      ORDER BY started_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(
      ...params,
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  searchByThread(threadId: string, options: EpisodeListOptions = {}): Episode[] {
    const normalizedThreadId = parseRequiredText(threadId, 'threadId');
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE thread_id = ?
      ORDER BY started_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(
      normalizedThreadId,
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  writeEpisodeArc(input: EpisodeArcWriteInput): EpisodeArc {
    this.assertEpisodeExists(input.sourceEpisodeId, 'sourceEpisodeId');
    this.assertEpisodeExists(input.targetEpisodeId, 'targetEpisodeId');

    const now = this.now().toISOString();
    const arc = parseEpisodeArc({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    this.db.prepare(`
      INSERT INTO l01_episode_arcs (
        id,
        source_episode_id,
        target_episode_id,
        arc_kind,
        salience_score,
        confidence,
        arc_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_episode_id = excluded.source_episode_id,
        target_episode_id = excluded.target_episode_id,
        arc_kind = excluded.arc_kind,
        salience_score = excluded.salience_score,
        confidence = excluded.confidence,
        arc_json = excluded.arc_json,
        updated_at = excluded.updated_at
    `).run(
      arc.id,
      arc.sourceEpisodeId,
      arc.targetEpisodeId,
      arc.arcKind,
      arc.salience,
      arc.confidence,
      serializeEpisodeArc(arc),
      arc.createdAt,
      arc.updatedAt,
    );

    return arc;
  }

  getEpisodeArc(id: string): EpisodeArc | undefined {
    const normalizedId = parseRequiredText(id, 'episode arc id');
    const row = this.db.prepare(`
      SELECT id, arc_json
      FROM l01_episode_arcs
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as EpisodeArcRow | undefined;
    return row ? mapArcRow(row) : undefined;
  }

  listEpisodeArcsForEpisode(episodeId: string, options: EpisodeArcListOptions = {}): EpisodeArc[] {
    const normalizedEpisodeId = parseRequiredText(episodeId, 'episodeId');
    const direction = options.direction ?? 'both';

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (direction === 'incoming') {
      where.push('target_episode_id = ?');
      params.push(normalizedEpisodeId);
    } else if (direction === 'outgoing') {
      where.push('source_episode_id = ?');
      params.push(normalizedEpisodeId);
    } else {
      where.push('(source_episode_id = ? OR target_episode_id = ?)');
      params.push(normalizedEpisodeId, normalizedEpisodeId);
    }

    if (options.arcKind !== undefined) {
      where.push('arc_kind = ?');
      params.push(options.arcKind);
    }

    const rows = this.db.prepare(`
      SELECT id, arc_json
      FROM l01_episode_arcs
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `).all(...params, normalizeLimit(options.limit)) as EpisodeArcRow[];
    return rows.map(mapArcRow);
  }

  private assertEpisodeExists(id: string, field: string): void {
    const normalizedId = parseRequiredText(id, `episodeArc.${field}`);
    const row = this.db.prepare(`
      SELECT id
      FROM l01_episodes
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`episodeArc.${field} references unknown episode "${normalizedId}"`);
    }
  }
}
