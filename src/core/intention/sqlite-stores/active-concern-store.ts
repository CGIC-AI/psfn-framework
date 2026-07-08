import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { ActiveConcernContextProvider } from '../concern-store-port.js';
import {
  ACTIVE_CONCERN_STATUSES,
  CONCERN_DUPLICATE_SIMILARITY_THRESHOLD,
  DEFAULT_RECENT_RESOLUTION_LIMIT,
  MAX_ACTIVE_CONCERNS,
  MAX_ACTIVE_CONCERN_LIFETIME_MS,
  MAX_CONCERN_RESOLUTION_CHARS,
  MAX_CONCERN_TEXT_CHARS,
  MAX_LIST_LIMIT,
  chooseEarlierOptionalConcernTimestamp,
  chooseHigherConcernPriority,
  chooseLaterConcernTimestamp,
  clampConcernExpiresAt,
  clampListLimit,
  isConcernAttentionStatus,
  isConcernPastHardLifetime,
  isConcernTerminalStatus,
  mapRow,
  mergeConcernEvidenceRefs,
  mergeConcernSensitivity,
  mergeConcernStatus,
  mergeConcernStringLists,
  normalizeConcernEvidenceRefs,
  normalizeConcernStatus,
  normalizeFormationVAD,
  normalizeIsoTimestamp,
  normalizeOptionalId,
  normalizeOptionalIsoTimestamp,
  normalizeOptionalText,
  normalizeOwner,
  normalizePriority,
  normalizeRecentResolutionWindowMs,
  normalizeRequiredText,
  normalizeSalience,
  normalizeSensitivity,
  normalizeSource,
  normalizeStringList,
  resolveConcernTtlByPriority,
  scoreConcernTextSimilarity,
  serializeEvidenceRefs,
  serializeFormationVAD,
  serializeStringList,
  validateConcernStatusTransition,
} from '../concerns.js';
import type {
  ActiveConcern,
  ActiveConcernCreateInput,
  ActiveConcernEvidenceRef,
  ActiveConcernListOptions,
  ActiveConcernOwner,
  ActiveConcernPriority,
  ActiveConcernRecentResolutionOptions,
  ActiveConcernResolveOptions,
  ActiveConcernRow,
  ActiveConcernSensitivity,
  ActiveConcernStaleResolutionOptions,
  ActiveConcernStatus,
  ActiveConcernStoreOptions,
  ActiveConcernTransitionOptions,
} from '../concerns.js';

export class ActiveConcernStore implements ActiveConcernContextProvider {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly ttlMsByPriority: Record<ActiveConcernPriority, number>;

  constructor(db: Database.Database, options: ActiveConcernStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.ttlMsByPriority = resolveConcernTtlByPriority(options.ttlMsByPriority);
    this.initializeSchema();
  }

  create(input: ActiveConcernCreateInput): ActiveConcern {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const source = normalizeSource(input.source);
    const status = normalizeConcernStatus(input.status);
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const createdAtMs = Date.parse(createdAt);
    const expiresAt = input.expiresAt
      ? normalizeIsoTimestamp(input.expiresAt, 'expiresAt')
      : new Date(createdAtMs + this.ttlMsByPriority[priority]).toISOString();
    const boundedExpiresAt = clampConcernExpiresAt(expiresAt, createdAt);
    if (Date.parse(boundedExpiresAt) <= createdAtMs) {
      throw new Error('Active concern expiresAt must be after createdAt');
    }

    const contactId = normalizeOptionalId(input.contactId);
    const formationVAD = normalizeFormationVAD(input.formationVAD);
    const salience = normalizeSalience(input.salience);
    const sensitivity = normalizeSensitivity(input.sensitivity);
    const owner = normalizeOwner(input.owner);
    const evidenceRefs = normalizeConcernEvidenceRefs(input.evidenceRefs);
    const resolutionEvidenceRefs = normalizeConcernEvidenceRefs(input.resolutionEvidenceRefs, 'resolutionEvidenceRefs');
    const lastReviewedAt = normalizeOptionalIsoTimestamp(input.lastReviewedAt, 'lastReviewedAt') ?? createdAt;
    const nextReviewAt = normalizeOptionalIsoTimestamp(input.nextReviewAt, 'nextReviewAt');
    const mergedFromIds = normalizeStringList(input.mergedFromIds, 'mergedFromIds');
    const splitFromId = normalizeOptionalId(input.splitFromId);

    if (isConcernAttentionStatus(status)) {
      this.resolveStaleConcerns({
        asOf: createdAt,
        limit: MAX_LIST_LIMIT,
        evidenceRefs: [{ kind: 'runtime', ref: `concern-create-stale-sweep:${createdAt}` }],
      });
      const activeDuplicate = this.findActiveSimilarConcern({
        text,
        contactId,
        asOf: createdAt,
      });
      if (activeDuplicate) {
        return this.mergeConcern(activeDuplicate, {
          priority,
          status,
          expiresAt: boundedExpiresAt,
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

      const recentlyResolved = this.findRecentlyResolvedSimilarConcern({
        text,
        ...(contactId ? { contactId } : {}),
        asOf: createdAt,
      });
      if (recentlyResolved) {
        if (input.reopenResolved === true) {
          const reopened = this.transitionConcernStatus(recentlyResolved.id, {
            status,
            transitionedAt: createdAt,
            evidenceRefs,
            ...(nextReviewAt ? { nextReviewAt } : {}),
            salience,
          });
          if (!reopened) {
            throw new Error(`Failed to reopen active concern "${recentlyResolved.id}"`);
          }
          return this.mergeConcern(reopened, {
            priority,
            status,
            expiresAt: boundedExpiresAt,
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

      const activeCount = this.list({
        includeResolved: false,
        includeExpired: false,
        asOf: createdAt,
        limit: MAX_ACTIVE_CONCERNS + 1,
      }).filter(concern => isConcernAttentionStatus(concern.status)).length;
      if (activeCount >= MAX_ACTIVE_CONCERNS) {
        throw new Error(`Active concern cap reached (${MAX_ACTIVE_CONCERNS})`);
      }
    }

    const id = normalizeRequiredText(this.idFactory(), 'id', 128);
    const terminalAt = isConcernTerminalStatus(status) ? createdAt : null;

    this.db.prepare(`
      INSERT INTO active_concerns (
        id,
        text,
        priority,
        source,
        status,
        created_at,
        expires_at,
        salience,
        sensitivity,
        owner,
        evidence_refs,
        resolution_evidence_refs,
        resolved_at,
        contact_id,
        formation_vad,
        last_reviewed_at,
        next_review_at,
        merged_from_ids,
        split_from_id
      ) VALUES (
        @id,
        @text,
        @priority,
        @source,
        @status,
        @created_at,
        @expires_at,
        @salience,
        @sensitivity,
        @owner,
        @evidence_refs,
        @resolution_evidence_refs,
        @resolved_at,
        @contact_id,
        @formation_vad,
        @last_reviewed_at,
        @next_review_at,
        @merged_from_ids,
        @split_from_id
      )
    `).run({
      id,
      text,
      priority,
      source,
      status,
      created_at: createdAt,
      expires_at: boundedExpiresAt,
      salience,
      sensitivity,
      owner,
      evidence_refs: serializeEvidenceRefs(evidenceRefs),
      resolution_evidence_refs: serializeEvidenceRefs(resolutionEvidenceRefs),
      resolved_at: terminalAt,
      contact_id: contactId ?? null,
      formation_vad: serializeFormationVAD(formationVAD),
      last_reviewed_at: lastReviewedAt,
      next_review_at: nextReviewAt ?? null,
      merged_from_ids: serializeStringList(mergedFromIds),
      split_from_id: splitFromId ?? null,
    });

    return this.requireById(id);
  }

  getById(id: string): ActiveConcern | null {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const row = this.db.prepare(`
      SELECT
        id,
        text,
        priority,
        source,
        status,
        created_at,
        expires_at,
        salience,
        sensitivity,
        owner,
        evidence_refs,
        resolution_evidence_refs,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad,
        last_reviewed_at,
        next_review_at,
        merged_from_ids,
        split_from_id
      FROM active_concerns
      WHERE id = @id
    `).get({ id: normalizedId }) as ActiveConcernRow | undefined;
    if (!row) return null;
    return mapRow(row);
  }

  getActiveConcerns(contactId?: string): ActiveConcern[] {
    return this.list({
      contactId,
      includeResolved: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  list(options: ActiveConcernListOptions = {}): ActiveConcern[] {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const includeResolved = options.includeResolved === true;
    const includeExpired = options.includeExpired === true;
    const normalizedContactId = normalizeOptionalId(options.contactId);
    const limit = clampListLimit(options.limit);

    const whereClauses: string[] = [];
    if (!includeResolved) {
      whereClauses.push("resolved_at IS NULL");
      whereClauses.push("COALESCE(status, 'active') NOT IN ('resolved', 'dismissed', 'suppressed')");
    }
    if (!includeExpired) {
      whereClauses.push('expires_at > @asOf');
      whereClauses.push('created_at > @activeAfter');
    }
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = @contactId)');
    }

    const whereSql = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const rows = this.db.prepare(`
      SELECT
        id,
        text,
        priority,
        source,
        status,
        created_at,
        expires_at,
        salience,
        sensitivity,
        owner,
        evidence_refs,
        resolution_evidence_refs,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad,
        last_reviewed_at,
        next_review_at,
        merged_from_ids,
        split_from_id
      FROM active_concerns
      ${whereSql}
      ORDER BY
        CASE priority
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          ELSE 2
        END ASC,
        expires_at ASC,
        created_at ASC,
        id ASC
      LIMIT @limit
    `).all({
      asOf,
      activeAfter: new Date(Date.parse(asOf) - MAX_ACTIVE_CONCERN_LIFETIME_MS).toISOString(),
      contactId: normalizedContactId ?? null,
      limit,
    }) as ActiveConcernRow[];

    return rows.map(mapRow);
  }

  listRecentlyResolvedConcerns(
    contactId?: string,
    options: ActiveConcernRecentResolutionOptions = {},
  ): ActiveConcern[] {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const normalizedContactId = normalizeOptionalId(contactId);
    const limit = clampListLimit(options.limit ?? DEFAULT_RECENT_RESOLUTION_LIMIT);
    const withinMs = normalizeRecentResolutionWindowMs(options.withinMs);
    const resolvedAfter = new Date(Date.parse(asOf) - withinMs).toISOString();

    const whereClauses = [
      'resolved_at IS NOT NULL',
      'resolved_at >= @resolvedAfter',
    ];
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = @contactId)');
    }

    const rows = this.db.prepare(`
      SELECT
        id,
        text,
        priority,
        source,
        status,
        created_at,
        expires_at,
        salience,
        sensitivity,
        owner,
        evidence_refs,
        resolution_evidence_refs,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad,
        last_reviewed_at,
        next_review_at,
        merged_from_ids,
        split_from_id
      FROM active_concerns
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY resolved_at DESC, created_at DESC, id DESC
      LIMIT @limit
    `).all({
      resolvedAfter,
      contactId: normalizedContactId ?? null,
      limit,
    }) as ActiveConcernRow[];

    return rows.map(mapRow);
  }

  findRecentlyResolvedSimilarConcern(input: {
    text: string;
    contactId?: string;
    withinMs?: number;
    asOf?: string;
  }): ActiveConcern | null {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const recentResolved = this.listRecentlyResolvedConcerns(input.contactId, {
      withinMs: input.withinMs,
      asOf: input.asOf,
      limit: DEFAULT_RECENT_RESOLUTION_LIMIT,
    });

    let bestMatch: ActiveConcern | null = null;
    let bestScore = 0;
    for (const concern of recentResolved) {
      const score = scoreConcernTextSimilarity(text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) {
        continue;
      }
      bestMatch = concern;
      bestScore = score;
    }

    return bestMatch;
  }

  transitionConcernStatus(id: string, options: ActiveConcernTransitionOptions): ActiveConcern | null {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const current = this.getById(normalizedId);
    if (!current) {
      return null;
    }
    const status = normalizeConcernStatus(options.status);
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

    const outcome = normalizeOptionalText(options.outcome, MAX_CONCERN_RESOLUTION_CHARS);
    const nextReviewAt = options.clearNextReview || isConcernTerminalStatus(status)
      ? undefined
      : normalizeOptionalIsoTimestamp(options.nextReviewAt, 'nextReviewAt') ?? current.nextReviewAt;
    const salience = options.salience === undefined
      ? current.salience
      : normalizeSalience(options.salience);
    const updatedEvidenceRefs = mergeConcernEvidenceRefs(current.evidenceRefs, evidenceRefs);
    const terminal = isConcernTerminalStatus(status);
    const updatedResolutionEvidenceRefs = terminal
      ? mergeConcernEvidenceRefs(
        current.resolutionEvidenceRefs,
        resolutionEvidenceRefs.length > 0 ? resolutionEvidenceRefs : evidenceRefs,
      )
      : current.resolutionEvidenceRefs;

    const result = this.db.prepare(`
      UPDATE active_concerns
      SET
        status = @status,
        resolved_at = @resolved_at,
        resolution_outcome = @resolution_outcome,
        last_reviewed_at = @last_reviewed_at,
        next_review_at = @next_review_at,
        salience = @salience,
        evidence_refs = @evidence_refs,
        resolution_evidence_refs = @resolution_evidence_refs
      WHERE id = @id
    `).run({
      id: normalizedId,
      status,
      resolved_at: terminal ? transitionedAt : null,
      resolution_outcome: terminal ? outcome ?? null : null,
      last_reviewed_at: transitionedAt,
      next_review_at: nextReviewAt ?? null,
      salience,
      evidence_refs: serializeEvidenceRefs(updatedEvidenceRefs),
      resolution_evidence_refs: serializeEvidenceRefs(updatedResolutionEvidenceRefs),
    });

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  resolveConcern(id: string, options: ActiveConcernResolveOptions = {}): ActiveConcern | null {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const current = this.getById(normalizedId);
    if (!current || isConcernTerminalStatus(current.status) || current.resolvedAt) {
      return null;
    }
    return this.transitionConcernStatus(normalizedId, {
      status: 'resolved',
      ...(options.outcome ? { outcome: options.outcome } : {}),
      ...(options.resolvedAt ? { transitionedAt: options.resolvedAt } : {}),
      ...(options.evidenceRefs ? { evidenceRefs: options.evidenceRefs, resolutionEvidenceRefs: options.evidenceRefs } : {}),
    });
  }

  resolveStaleConcerns(options: ActiveConcernStaleResolutionOptions = {}): ActiveConcern[] {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const limit = clampListLimit(options.limit);
    const statuses = options.statuses === undefined
      ? ACTIVE_CONCERN_STATUSES.filter(isConcernAttentionStatus)
      : options.statuses.map(status => normalizeConcernStatus(status));
    const statusSet = new Set(statuses);
    const candidates = this.list({
      includeResolved: false,
      includeExpired: true,
      asOf,
      limit: MAX_LIST_LIMIT,
    }).filter(concern => (
      statusSet.has(concern.status)
      && (
        Date.parse(concern.expiresAt) <= Date.parse(asOf)
        || isConcernPastHardLifetime(concern, Date.parse(asOf))
      )
    )).slice(0, limit);

    const resolved: ActiveConcern[] = [];
    for (const concern of candidates) {
      const next = this.transitionConcernStatus(concern.id, {
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

  private requireById(id: string): ActiveConcern {
    const concern = this.getById(id);
    if (!concern) {
      throw new Error(`Failed to load active concern "${id}" after write`);
    }
    return concern;
  }

  private findActiveSimilarConcern(input: {
    text: string;
    contactId?: string;
    asOf: string;
  }): ActiveConcern | null {
    const activeConcerns = this.list({
      contactId: input.contactId,
      includeResolved: false,
      includeExpired: false,
      asOf: input.asOf,
      limit: MAX_LIST_LIMIT,
    });
    let bestMatch: ActiveConcern | null = null;
    let bestScore = 0;
    for (const concern of activeConcerns) {
      const score = scoreConcernTextSimilarity(input.text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) {
        continue;
      }
      bestMatch = concern;
      bestScore = score;
    }
    return bestMatch;
  }

  private mergeConcern(
    existing: ActiveConcern,
    input: {
      priority: ActiveConcernPriority;
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
  ): ActiveConcern {
    if (isConcernTerminalStatus(existing.status)) {
      throw new Error(`Cannot merge into terminal concern "${existing.id}"`);
    }
    const status = mergeConcernStatus(existing.status, input.status);
    validateConcernStatusTransition({
      from: existing.status,
      to: status,
      evidenceRefs: input.evidenceRefs,
    });
    const boundedExpiresAt = clampConcernExpiresAt(input.expiresAt, existing.createdAt);
    const nextReviewAt = chooseEarlierOptionalConcernTimestamp(existing.nextReviewAt, input.nextReviewAt);
    this.db.prepare(`
      UPDATE active_concerns
      SET
        priority = @priority,
        status = @status,
        expires_at = @expires_at,
        salience = @salience,
        sensitivity = @sensitivity,
        owner = @owner,
        evidence_refs = @evidence_refs,
        last_reviewed_at = @last_reviewed_at,
        next_review_at = @next_review_at,
        merged_from_ids = @merged_from_ids,
        split_from_id = @split_from_id
      WHERE id = @id
    `).run({
      id: existing.id,
      priority: chooseHigherConcernPriority(existing.priority, input.priority),
      status,
      expires_at: clampConcernExpiresAt(
        chooseLaterConcernTimestamp(existing.expiresAt, boundedExpiresAt),
        existing.createdAt,
      ),
      salience: Math.max(existing.salience, input.salience),
      sensitivity: mergeConcernSensitivity(existing.sensitivity, input.sensitivity),
      owner: input.owner,
      evidence_refs: serializeEvidenceRefs(mergeConcernEvidenceRefs(existing.evidenceRefs, input.evidenceRefs)),
      last_reviewed_at: input.lastReviewedAt,
      next_review_at: nextReviewAt ?? null,
      merged_from_ids: serializeStringList(mergeConcernStringLists(existing.mergedFromIds ?? [], input.mergedFromIds)),
      split_from_id: input.splitFromId ?? existing.splitFromId ?? null,
    });
    return this.requireById(existing.id);
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_concerns (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        priority TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        salience REAL NOT NULL DEFAULT 0.5,
        sensitivity TEXT NOT NULL DEFAULT 'personal',
        owner TEXT NOT NULL DEFAULT 'companion',
        evidence_refs TEXT NOT NULL DEFAULT '[]',
        resolution_evidence_refs TEXT NOT NULL DEFAULT '[]',
        resolved_at TEXT,
        resolution_outcome TEXT,
        contact_id TEXT,
        formation_vad TEXT,
        last_reviewed_at TEXT,
        next_review_at TEXT,
        merged_from_ids TEXT NOT NULL DEFAULT '[]',
        split_from_id TEXT,
        CHECK (priority IN ('high', 'medium', 'low')),
        CHECK (source IN ('appraisal', 'agent', 'heartbeat')),
        CHECK (status IN ('candidate', 'active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed')),
        CHECK (sensitivity IN ('public', 'personal', 'intimate', 'confidential', 'redacted')),
        CHECK (owner IN ('companion', 'operator', 'system')),
        CHECK (salience >= 0 AND salience <= 1)
      );

      CREATE INDEX IF NOT EXISTS idx_active_concerns_active
      ON active_concerns (resolved_at, expires_at, priority, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_active_concerns_contact
      ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_active_concerns_lifecycle
      ON active_concerns (status, next_review_at, expires_at, last_reviewed_at, id);
    `);

    const columns = this.db.prepare('PRAGMA table_info(active_concerns)')
      .all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map(column => column.name));
    const addColumn = (name: string, sql: string): void => {
      if (!columnNames.has(name)) {
        this.db.exec(sql);
        columnNames.add(name);
      }
    };
    addColumn('status', "ALTER TABLE active_concerns ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
    addColumn('salience', 'ALTER TABLE active_concerns ADD COLUMN salience REAL NOT NULL DEFAULT 0.5');
    addColumn('sensitivity', "ALTER TABLE active_concerns ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'personal'");
    addColumn('owner', "ALTER TABLE active_concerns ADD COLUMN owner TEXT NOT NULL DEFAULT 'companion'");
    addColumn('evidence_refs', "ALTER TABLE active_concerns ADD COLUMN evidence_refs TEXT NOT NULL DEFAULT '[]'");
    addColumn(
      'resolution_evidence_refs',
      "ALTER TABLE active_concerns ADD COLUMN resolution_evidence_refs TEXT NOT NULL DEFAULT '[]'",
    );
    addColumn('resolution_outcome', 'ALTER TABLE active_concerns ADD COLUMN resolution_outcome TEXT');
    addColumn('last_reviewed_at', 'ALTER TABLE active_concerns ADD COLUMN last_reviewed_at TEXT');
    addColumn('next_review_at', 'ALTER TABLE active_concerns ADD COLUMN next_review_at TEXT');
    addColumn('merged_from_ids', "ALTER TABLE active_concerns ADD COLUMN merged_from_ids TEXT NOT NULL DEFAULT '[]'");
    addColumn('split_from_id', 'ALTER TABLE active_concerns ADD COLUMN split_from_id TEXT');

    this.db.exec(`
      UPDATE active_concerns
      SET status = 'resolved'
      WHERE resolved_at IS NOT NULL AND COALESCE(status, 'active') = 'active';

      UPDATE active_concerns
      SET last_reviewed_at = created_at
      WHERE last_reviewed_at IS NULL;
    `);

    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_active_concerns_lifecycle
        ON active_concerns (status, next_review_at, expires_at, last_reviewed_at, id);
      `);
    } catch (error) {
      throw new Error(`Failed to initialize active concern lifecycle index: ${String(error)}`);
    }
  }
}
