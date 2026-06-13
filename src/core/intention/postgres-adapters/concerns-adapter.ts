import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import type { ConcernStorePortBackend } from '../concern-store-port.js';
import type {
  ActiveConcern,
  ActiveConcernCreateInput,
  ActiveConcernListOptions,
  ActiveConcernRecentResolutionOptions,
  ActiveConcernResolveOptions,
} from '../concerns.js';
import {
  CONCERN_DUPLICATE_SIMILARITY_THRESHOLD,
  DEFAULT_CONCERN_LIST_LIMIT,
  DEFAULT_RECENT_RESOLUTION_LIMIT,
  MAX_CONCERN_RESOLUTION_CHARS,
  MAX_CONCERN_TEXT_CHARS,
  ActiveConcernRow,
  clampListLimit,
  mapActiveConcernRow,
  normalizeContactId,
  normalizeIsoTimestamp,
  normalizeOptionalText,
  normalizePriority,
  normalizeRecentResolutionWindowMs,
  normalizeRequiredText,
  normalizeSource,
  scoreConcernSimilarity,
  serializeFormationVAD,
} from './shared.js';

export class PostgresActiveConcernStore implements ConcernStorePortBackend {
  private activeConcernCache = new Map<string, ActiveConcern>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
  ) {}

  snapshotActiveConcerns(contactId?: string): ActiveConcern[] {
    const normalizedContactId = normalizeContactId(contactId);
    const asOfMs = this.now().getTime();
    return [...this.activeConcernCache.values()]
      .filter((concern) => {
        if (concern.resolvedAt) return false;
        if (Date.parse(concern.expiresAt) <= asOfMs) return false;
        if (!normalizedContactId) return true;
        return !concern.contactId || concern.contactId === normalizedContactId;
      })
      .sort((left, right) => (
        Date.parse(left.expiresAt) - Date.parse(right.expiresAt)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
  }

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
      `,
    );
    this.activeConcernCache = new Map(
      rows.map((row) => {
        const concern = mapActiveConcernRow(row);
        return [concern.id, concern] as const;
      }),
    );
  }

  async create(input: ActiveConcernCreateInput): Promise<ActiveConcern> {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const priority = normalizePriority(input.priority ?? 'medium');
    const source = normalizeSource(input.source ?? 'agent');
    const createdAt = input.createdAt ? normalizeIsoTimestamp(input.createdAt, 'createdAt') : this.now().toISOString();
    const createdAtMs = Date.parse(createdAt);
    const expiresAt = input.expiresAt
      ? normalizeIsoTimestamp(input.expiresAt, 'expiresAt')
      : new Date(createdAtMs + this.resolveConcernTtlMs(priority)).toISOString();
    if (Date.parse(expiresAt) <= createdAtMs) {
      throw new Error('Active concern expiresAt must be after createdAt');
    }

    const contactId = normalizeContactId(input.contactId);
    const formationVAD = serializeFormationVAD(input.formationVAD);
    const activeDuplicate = this.snapshotActiveConcerns(contactId)
      .find(concern => scoreConcernSimilarity(concern.text, text) >= CONCERN_DUPLICATE_SIMILARITY_THRESHOLD);
    if (activeDuplicate) {
      return activeDuplicate;
    }
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        INSERT INTO active_concerns (
          id, text, priority, source, created_at, expires_at, contact_id, formation_vad
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        RETURNING
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
      `,
      [id, text, priority, source, createdAt, expiresAt, contactId ?? null, formationVAD],
    );

    if (!row) {
      throw new Error(`Failed to insert active concern "${id}"`);
    }
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
  }

  async getById(id: string): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        WHERE id = $1
      `,
      [normalizedId],
    );
    if (!row) return null;
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
  }

  async getActiveConcerns(contactId?: string): Promise<ActiveConcern[]> {
    return await this.list({
      contactId,
      includeResolved: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  async list(options: ActiveConcernListOptions = {}): Promise<ActiveConcern[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const includeResolved = options.includeResolved === true;
    const includeExpired = options.includeExpired === true;
    const normalizedContactId = normalizeContactId(options.contactId);
    const limit = clampListLimit(options.limit, DEFAULT_CONCERN_LIST_LIMIT);
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (!includeResolved) whereClauses.push('resolved_at IS NULL');
    if (!includeExpired) {
      params.push(asOf);
      whereClauses.push(`expires_at > $${params.length}`);
    }
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    params.push(limit);

    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY
          CASE priority
            WHEN 'high' THEN 0
            WHEN 'medium' THEN 1
            ELSE 2
          END ASC,
          expires_at ASC,
          created_at ASC,
          id ASC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapActiveConcernRow);
  }

  async listRecentlyResolvedConcerns(
    contactId?: string,
    options: ActiveConcernRecentResolutionOptions = {},
  ): Promise<ActiveConcern[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const normalizedContactId = normalizeContactId(contactId);
    const limit = clampListLimit(options.limit ?? DEFAULT_RECENT_RESOLUTION_LIMIT, DEFAULT_RECENT_RESOLUTION_LIMIT);
    const withinMs = normalizeRecentResolutionWindowMs(options.withinMs);
    const resolvedAfter = new Date(Date.parse(asOf) - withinMs).toISOString();
    const params: unknown[] = [resolvedAfter];
    const whereClauses = ['resolved_at IS NOT NULL', 'resolved_at >= $1'];
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    params.push(limit);

    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY resolved_at DESC, created_at DESC, id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapActiveConcernRow);
  }

  async findRecentlyResolvedSimilarConcern(input: {
    text: string;
    contactId?: string;
    withinMs?: number;
    asOf?: string;
  }): Promise<ActiveConcern | null> {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const recentResolved = await this.listRecentlyResolvedConcerns(input.contactId, {
      withinMs: input.withinMs,
      asOf: input.asOf,
      limit: DEFAULT_RECENT_RESOLUTION_LIMIT,
    });

    let bestMatch: ActiveConcern | null = null;
    let bestScore = 0;
    for (const concern of recentResolved) {
      const score = scoreConcernSimilarity(text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) continue;
      bestMatch = concern;
      bestScore = score;
    }
    return bestMatch;
  }

  async resolveConcern(id: string, options: ActiveConcernResolveOptions = {}): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const outcome = normalizeOptionalText(options.outcome, 'outcome', MAX_CONCERN_RESOLUTION_CHARS);
    const resolvedAt = options.resolvedAt ? normalizeIsoTimestamp(options.resolvedAt, 'resolvedAt') : this.now().toISOString();

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        UPDATE active_concerns
        SET resolved_at = $2, resolution_outcome = $3
        WHERE id = $1 AND resolved_at IS NULL
        RETURNING
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
      `,
      [normalizedId, resolvedAt, outcome ?? null],
    );
    return row ? mapActiveConcernRow(row) : null;
  }

  private resolveConcernTtlMs(priority: 'high' | 'medium' | 'low'): number {
    switch (priority) {
      case 'high':
        return 48 * 60 * 60 * 1000;
      case 'medium':
        return 24 * 60 * 60 * 1000;
      case 'low':
        return 8 * 60 * 60 * 1000;
    }
  }
}
