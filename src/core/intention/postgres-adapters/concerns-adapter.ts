import type { Pool } from 'pg';
import { queryOne, queryRows } from './connection.js';
import type { ConcernStorePortBackend } from '../concern-store-port.js';
import {
  ACTIVE_CONCERN_STATUSES,
  chooseEarlierOptionalConcernTimestamp,
  chooseHigherConcernPriority,
  chooseLaterConcernTimestamp,
  isConcernAttentionStatus,
  isConcernTerminalStatus,
  mergeConcernEvidenceRefs,
  mergeConcernSensitivity,
  mergeConcernStatus,
  mergeConcernStringLists,
  normalizeConcernEvidenceRefs,
  validateConcernStatusTransition,
} from '../concerns.js';
import type {
  ActiveConcern,
  ActiveConcernCreateInput,
  ActiveConcernEvidenceRef,
  ActiveConcernListOptions,
  ActiveConcernOwner,
  ActiveConcernRecentResolutionOptions,
  ActiveConcernResolveOptions,
  ActiveConcernSensitivity,
  ActiveConcernStaleResolutionOptions,
  ActiveConcernStatus,
  ActiveConcernTransitionOptions,
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
  normalizeStatus,
  normalizeSensitivity,
  normalizeOwner,
  normalizeSalience,
  scoreConcernSimilarity,
  serializeConcernEvidenceRefs,
  serializeFormationVAD,
  serializeStringList,
} from './shared.js';

const ACTIVE_CONCERN_SELECT_COLUMNS = `
  id, text, priority, source, status, created_at, expires_at,
  salience, sensitivity, owner, evidence_refs, resolution_evidence_refs,
  resolved_at, resolution_outcome, contact_id, formation_vad,
  last_reviewed_at, next_review_at, merged_from_ids, split_from_id
`;

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
        if (concern.resolvedAt || isConcernTerminalStatus(concern.status)) return false;
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
        SELECT ${ACTIVE_CONCERN_SELECT_COLUMNS}
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
    const status = normalizeStatus(input.status);
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
    const salience = normalizeSalience(input.salience);
    const sensitivity = normalizeSensitivity(input.sensitivity);
    const owner = normalizeOwner(input.owner);
    const evidenceRefs = normalizeConcernEvidenceRefs(input.evidenceRefs);
    const resolutionEvidenceRefs = normalizeConcernEvidenceRefs(
      input.resolutionEvidenceRefs,
      'resolutionEvidenceRefs',
    );
    const lastReviewedAt = input.lastReviewedAt
      ? normalizeIsoTimestamp(input.lastReviewedAt, 'lastReviewedAt')
      : createdAt;
    const nextReviewAt = input.nextReviewAt
      ? normalizeIsoTimestamp(input.nextReviewAt, 'nextReviewAt')
      : undefined;
    const mergedFromIds = input.mergedFromIds ? [...new Set(input.mergedFromIds)] : [];
    const splitFromId = normalizeContactId(input.splitFromId);

    if (isConcernAttentionStatus(status)) {
      const activeDuplicate = this.findActiveSimilarConcern({
        text,
        contactId,
        asOf: createdAt,
      });
      if (activeDuplicate) {
        return await this.mergeConcern(activeDuplicate, {
          priority,
          status,
          expiresAt,
          salience,
          sensitivity,
          owner,
          evidenceRefs,
          lastReviewedAt,
          nextReviewAt,
          mergedFromIds,
          splitFromId,
        });
      }

      const recentlyResolved = await this.findRecentlyResolvedSimilarConcern({
        text,
        ...(contactId ? { contactId } : {}),
        asOf: createdAt,
      });
      if (recentlyResolved) {
        if (input.reopenResolved === true) {
          const reopened = await this.transitionConcernStatus(recentlyResolved.id, {
            status,
            transitionedAt: createdAt,
            evidenceRefs,
            ...(nextReviewAt ? { nextReviewAt } : {}),
            salience,
          });
          if (!reopened) {
            throw new Error(`Failed to reopen active concern "${recentlyResolved.id}"`);
          }
          return await this.mergeConcern(reopened, {
            priority,
            status,
            expiresAt,
            salience,
            sensitivity,
            owner,
            evidenceRefs,
            lastReviewedAt,
            nextReviewAt,
            mergedFromIds,
            splitFromId,
          });
        }
        return recentlyResolved;
      }
    }
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);
    const terminalAt = isConcernTerminalStatus(status) ? createdAt : null;

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        INSERT INTO active_concerns (
          id, text, priority, source, status, created_at, expires_at,
          salience, sensitivity, owner, evidence_refs, resolution_evidence_refs,
          resolved_at, contact_id, formation_vad, last_reviewed_at, next_review_at,
          merged_from_ids, split_from_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb,
          $13, $14, $15::jsonb, $16, $17, $18::jsonb, $19
        )
        RETURNING ${ACTIVE_CONCERN_SELECT_COLUMNS}
      `,
      [
        id,
        text,
        priority,
        source,
        status,
        createdAt,
        expiresAt,
        salience,
        sensitivity,
        owner,
        serializeConcernEvidenceRefs(evidenceRefs),
        serializeConcernEvidenceRefs(resolutionEvidenceRefs),
        terminalAt,
        contactId ?? null,
        formationVAD,
        lastReviewedAt,
        nextReviewAt ?? null,
        serializeStringList(mergedFromIds),
        splitFromId ?? null,
      ],
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
        SELECT ${ACTIVE_CONCERN_SELECT_COLUMNS}
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

    if (!includeResolved) {
      whereClauses.push('resolved_at IS NULL');
      whereClauses.push("COALESCE(status, 'active') NOT IN ('resolved', 'dismissed', 'suppressed')");
    }
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
        SELECT ${ACTIVE_CONCERN_SELECT_COLUMNS}
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
        SELECT ${ACTIVE_CONCERN_SELECT_COLUMNS}
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

  async transitionConcernStatus(id: string, options: ActiveConcernTransitionOptions): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const current = await this.getById(normalizedId);
    if (!current) {
      return null;
    }
    const status = normalizeStatus(options.status);
    const transitionedAt = options.transitionedAt
      ? normalizeIsoTimestamp(options.transitionedAt, 'transitionedAt')
      : this.now().toISOString();
    const evidenceRefs = normalizeConcernEvidenceRefs(options.evidenceRefs);
    const resolutionEvidenceRefs = normalizeConcernEvidenceRefs(
      options.resolutionEvidenceRefs,
      'resolutionEvidenceRefs',
    );
    validateConcernStatusTransition({
      from: current.status,
      to: status,
      evidenceRefs,
    });
    const outcome = normalizeOptionalText(options.outcome, 'outcome', MAX_CONCERN_RESOLUTION_CHARS);
    const nextReviewAt = options.clearNextReview || isConcernTerminalStatus(status)
      ? undefined
      : (options.nextReviewAt ? normalizeIsoTimestamp(options.nextReviewAt, 'nextReviewAt') : current.nextReviewAt);
    const salience = options.salience === undefined ? current.salience : normalizeSalience(options.salience);
    const updatedEvidenceRefs = mergeConcernEvidenceRefs(current.evidenceRefs, evidenceRefs);
    const terminal = isConcernTerminalStatus(status);
    const updatedResolutionEvidenceRefs = terminal
      ? mergeConcernEvidenceRefs(
        current.resolutionEvidenceRefs,
        resolutionEvidenceRefs.length > 0 ? resolutionEvidenceRefs : evidenceRefs,
      )
      : current.resolutionEvidenceRefs;

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        UPDATE active_concerns
        SET
          status = $2,
          resolved_at = $3,
          resolution_outcome = $4,
          last_reviewed_at = $5,
          next_review_at = $6,
          salience = $7,
          evidence_refs = $8::jsonb,
          resolution_evidence_refs = $9::jsonb
        WHERE id = $1
        RETURNING ${ACTIVE_CONCERN_SELECT_COLUMNS}
      `,
      [
        normalizedId,
        status,
        terminal ? transitionedAt : null,
        terminal ? outcome ?? null : null,
        transitionedAt,
        nextReviewAt ?? null,
        salience,
        serializeConcernEvidenceRefs(updatedEvidenceRefs),
        serializeConcernEvidenceRefs(updatedResolutionEvidenceRefs),
      ],
    );
    if (!row) {
      this.activeConcernCache.delete(normalizedId);
      return null;
    }
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
  }

  async resolveConcern(id: string, options: ActiveConcernResolveOptions = {}): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const current = await this.getById(normalizedId);
    if (!current || isConcernTerminalStatus(current.status) || current.resolvedAt) {
      return null;
    }
    return await this.transitionConcernStatus(normalizedId, {
      status: 'resolved',
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.resolvedAt ? { transitionedAt: options.resolvedAt } : {}),
      ...(options.evidenceRefs ? { evidenceRefs: options.evidenceRefs, resolutionEvidenceRefs: options.evidenceRefs } : {}),
    });
  }

  async resolveStaleConcerns(options: ActiveConcernStaleResolutionOptions = {}): Promise<ActiveConcern[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const statuses = options.statuses === undefined
      ? ACTIVE_CONCERN_STATUSES.filter(isConcernAttentionStatus)
      : options.statuses.map(status => normalizeStatus(status));
    const statusSet = new Set(statuses);
    const candidates = (await this.list({
      includeResolved: false,
      includeExpired: true,
      asOf,
      limit: clampListLimit(options.limit, DEFAULT_CONCERN_LIST_LIMIT),
    })).filter(concern => (
      statusSet.has(concern.status)
      && Date.parse(concern.expiresAt) <= Date.parse(asOf)
    ));

    const resolved: ActiveConcern[] = [];
    for (const concern of candidates) {
      const next = await this.transitionConcernStatus(concern.id, {
        status: 'resolved',
        transitionedAt: asOf,
        outcome: options.outcome ?? 'Resolved as stale after review window elapsed.',
        ...(options.evidenceRefs ? { evidenceRefs: options.evidenceRefs, resolutionEvidenceRefs: options.evidenceRefs } : {}),
      });
      if (next) {
        resolved.push(next);
      }
    }
    return resolved;
  }

  private findActiveSimilarConcern(input: {
    text: string;
    contactId?: string;
    asOf: string;
  }): ActiveConcern | null {
    const asOfMs = Date.parse(input.asOf);
    const activeConcerns = this.snapshotActiveConcerns(input.contactId)
      .filter(concern => Date.parse(concern.expiresAt) > asOfMs);
    let bestMatch: ActiveConcern | null = null;
    let bestScore = 0;
    for (const concern of activeConcerns) {
      const score = scoreConcernSimilarity(input.text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) continue;
      bestMatch = concern;
      bestScore = score;
    }
    return bestMatch;
  }

  private async mergeConcern(
    existing: ActiveConcern,
    input: {
      priority: ActiveConcern['priority'];
      status: ActiveConcernStatus;
      expiresAt: string;
      salience: number;
      sensitivity: ActiveConcernSensitivity;
      owner: ActiveConcernOwner;
      evidenceRefs: readonly ActiveConcernEvidenceRef[];
      lastReviewedAt: string;
      nextReviewAt?: string;
      mergedFromIds: readonly string[];
      splitFromId?: string;
    },
  ): Promise<ActiveConcern> {
    if (isConcernTerminalStatus(existing.status)) {
      throw new Error(`Cannot merge into terminal concern "${existing.id}"`);
    }
    const status = mergeConcernStatus(existing.status, input.status);
    validateConcernStatusTransition({
      from: existing.status,
      to: status,
      evidenceRefs: input.evidenceRefs,
    });
    const nextReviewAt = chooseEarlierOptionalConcernTimestamp(existing.nextReviewAt, input.nextReviewAt);
    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        UPDATE active_concerns
        SET
          priority = $2,
          status = $3,
          expires_at = $4,
          salience = $5,
          sensitivity = $6,
          owner = $7,
          evidence_refs = $8::jsonb,
          last_reviewed_at = $9,
          next_review_at = $10,
          merged_from_ids = $11::jsonb,
          split_from_id = $12
        WHERE id = $1
        RETURNING ${ACTIVE_CONCERN_SELECT_COLUMNS}
      `,
      [
        existing.id,
        chooseHigherConcernPriority(existing.priority, input.priority),
        status,
        chooseLaterConcernTimestamp(existing.expiresAt, input.expiresAt),
        Math.max(existing.salience, input.salience),
        mergeConcernSensitivity(existing.sensitivity, input.sensitivity),
        input.owner,
        serializeConcernEvidenceRefs(mergeConcernEvidenceRefs(existing.evidenceRefs, input.evidenceRefs)),
        input.lastReviewedAt,
        nextReviewAt ?? null,
        serializeStringList(mergeConcernStringLists(existing.mergedFromIds ?? [], input.mergedFromIds)),
        input.splitFromId ?? existing.splitFromId ?? null,
      ],
    );
    if (!row) {
      throw new Error(`Failed to merge active concern "${existing.id}"`);
    }
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
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
