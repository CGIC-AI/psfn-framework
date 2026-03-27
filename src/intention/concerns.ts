import { randomUUID } from 'node:crypto';
import type { DatabaseAdapter } from '../persistence/db-adapter.js';
import { formatActiveDateTimeLabel } from '../time/active-timezone.js';

export const ACTIVE_CONCERN_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ActiveConcernPriority = typeof ACTIVE_CONCERN_PRIORITIES[number];

export const ACTIVE_CONCERN_SOURCES = ['appraisal', 'agent', 'heartbeat'] as const;
export type ActiveConcernSource = typeof ACTIVE_CONCERN_SOURCES[number];

export interface ActiveConcernVAD {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface ActiveConcern {
  id: string;
  text: string;
  priority: ActiveConcernPriority;
  source: ActiveConcernSource;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  resolutionOutcome?: string;
  contactId?: string;
  formationVAD?: ActiveConcernVAD;
}

export interface ActiveConcernCreateInput {
  text: string;
  priority?: ActiveConcernPriority;
  source?: ActiveConcernSource;
  contactId?: string;
  formationVAD?: ActiveConcernVAD;
  createdAt?: string;
  expiresAt?: string;
}

export interface ActiveConcernResolveOptions {
  outcome?: string;
  resolvedAt?: string;
}

export interface ActiveConcernRecentResolutionOptions {
  withinMs?: number;
  asOf?: string;
  limit?: number;
}

export interface ActiveConcernListOptions {
  contactId?: string;
  includeResolved?: boolean;
  includeExpired?: boolean;
  asOf?: string;
  limit?: number;
}

export interface ActiveConcernStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  ttlMsByPriority?: Partial<Record<ActiveConcernPriority, number>>;
}

export interface ActiveConcernContextProvider {
  getActiveConcerns(contactId?: string): Promise<ActiveConcern[]>;
}

interface ActiveConcernRow {
  id: string;
  text: string;
  priority: string;
  source: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolution_outcome: string | null;
  contact_id: string | null;
  formation_vad: string | null;
}

const MAX_CONCERN_TEXT_CHARS = 500;
const MAX_CONCERN_RESOLUTION_CHARS = 400;
const DEFAULT_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;
const DEFAULT_RUNTIME_CONTEXT_LIMIT = 6;
const MAX_RUNTIME_CONTEXT_TEXT_CHARS = 180;
const DEFAULT_RECENT_RESOLUTION_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RECENT_RESOLUTION_LIMIT = 8;
const CONCERN_DUPLICATE_SIMILARITY_THRESHOLD = 0.72;

export const DEFAULT_CONCERN_TTL_MS_BY_PRIORITY: Record<ActiveConcernPriority, number> = {
  high: 48 * 60 * 60 * 1000,
  medium: 24 * 60 * 60 * 1000,
  low: 8 * 60 * 60 * 1000,
};

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Active concern ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Active concern ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  if (!normalized) return undefined;
  if (normalized.length > maxChars) {
    throw new Error(`Active concern optional text exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const raw = value.trim();
  if (!raw) {
    throw new Error(`Active concern ${fieldName} is required`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Active concern ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  if (!normalized) return undefined;
  return normalized;
}

function normalizePriority(
  value: ActiveConcernPriority | undefined,
): ActiveConcernPriority {
  const normalized = value ?? 'medium';
  if (!ACTIVE_CONCERN_PRIORITIES.includes(normalized)) {
    throw new Error(`Unsupported active concern priority: ${String(normalized)}`);
  }
  return normalized;
}

function normalizeSource(value: ActiveConcernSource | undefined): ActiveConcernSource {
  const normalized = value ?? 'agent';
  if (!ACTIVE_CONCERN_SOURCES.includes(normalized)) {
    throw new Error(`Unsupported active concern source: ${String(normalized)}`);
  }
  return normalized;
}

function normalizeSignedUnit(value: number, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Active concern ${fieldName} must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`Active concern ${fieldName} must be between -1 and 1`);
  }
  return value;
}

function normalizeFormationVAD(
  value: ActiveConcernVAD | undefined,
): ActiveConcernVAD | undefined {
  if (!value) return undefined;
  return {
    valence: normalizeSignedUnit(value.valence, 'formationVAD.valence'),
    arousal: normalizeSignedUnit(value.arousal, 'formationVAD.arousal'),
    dominance: normalizeSignedUnit(value.dominance, 'formationVAD.dominance'),
  };
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function normalizeRecentResolutionWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RECENT_RESOLUTION_WINDOW_MS;
  }
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new Error('Active concern recent resolution window must be a positive number');
  }
  return floored;
}

function normalizeConcernSimilarityText(value: string): string {
  return compactWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function tokenizeConcernSimilarityText(value: string): string[] {
  const normalized = normalizeConcernSimilarityText(value);
  if (!normalized) {
    return [];
  }
  return Array.from(new Set(normalized.split(' ').filter(token => token.length >= 3)));
}

function scoreConcernTextSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeConcernSimilarityText(left);
  const normalizedRight = normalizeConcernSimilarityText(right);
  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }
  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = tokenizeConcernSimilarityText(normalizedLeft);
  const rightTokens = tokenizeConcernSimilarityText(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  if (intersection === 0) {
    return 0;
  }

  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

function serializeFormationVAD(value: ActiveConcernVAD | undefined): string | null {
  if (!value) return null;
  return JSON.stringify(value);
}

function parseFormationVAD(raw: string | null): ActiveConcernVAD | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid active concern formation_vad JSON: ${String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid active concern formation_vad payload');
  }
  const candidate = parsed as Partial<ActiveConcernVAD>;
  if (
    typeof candidate.valence !== 'number'
    || typeof candidate.arousal !== 'number'
    || typeof candidate.dominance !== 'number'
  ) {
    throw new Error('Invalid active concern formation_vad fields');
  }
  return normalizeFormationVAD({
    valence: candidate.valence,
    arousal: candidate.arousal,
    dominance: candidate.dominance,
  });
}

function mapPriority(priority: string): ActiveConcernPriority {
  if (!ACTIVE_CONCERN_PRIORITIES.includes(priority as ActiveConcernPriority)) {
    throw new Error(`Invalid concern priority in storage: ${priority}`);
  }
  return priority as ActiveConcernPriority;
}

function mapSource(source: string): ActiveConcernSource {
  if (!ACTIVE_CONCERN_SOURCES.includes(source as ActiveConcernSource)) {
    throw new Error(`Invalid concern source in storage: ${source}`);
  }
  return source as ActiveConcernSource;
}

function mapRow(row: ActiveConcernRow): ActiveConcern {
  const createdAt = normalizeIsoTimestamp(row.created_at, 'created_at');
  const expiresAt = normalizeIsoTimestamp(row.expires_at, 'expires_at');
  const resolvedAt = row.resolved_at === null ? undefined : normalizeIsoTimestamp(row.resolved_at, 'resolved_at');
  const resolutionOutcome = row.resolution_outcome === null
    ? undefined
    : normalizeOptionalText(row.resolution_outcome, MAX_CONCERN_RESOLUTION_CHARS);
  const contactId = row.contact_id === null ? undefined : normalizeOptionalId(row.contact_id);
  const formationVAD = parseFormationVAD(row.formation_vad);

  return {
    id: row.id,
    text: row.text,
    priority: mapPriority(row.priority),
    source: mapSource(row.source),
    createdAt,
    expiresAt,
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionOutcome ? { resolutionOutcome } : {}),
    ...(contactId ? { contactId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
  };
}

function resolveConcernTtlByPriority(
  overrides: Partial<Record<ActiveConcernPriority, number>> | undefined,
): Record<ActiveConcernPriority, number> {
  const resolved: Record<ActiveConcernPriority, number> = { ...DEFAULT_CONCERN_TTL_MS_BY_PRIORITY };
  if (!overrides) return resolved;

  for (const priority of ACTIVE_CONCERN_PRIORITIES) {
    const override = overrides[priority];
    if (override === undefined) continue;
    if (!Number.isFinite(override) || override <= 0) {
      throw new Error(`TTL override for "${priority}" must be a positive number`);
    }
    resolved[priority] = Math.floor(override);
  }
  return resolved;
}

export function formatActiveConcernsContextBlock(
  concerns: readonly ActiveConcern[],
  limit = DEFAULT_RUNTIME_CONTEXT_LIMIT,
): string {
  if (concerns.length === 0) return '';
  const normalizedLimit = clampListLimit(limit);
  const selected = concerns.slice(0, normalizedLimit);
  const lines = [
    '[Active Concerns]',
  ];

  for (const concern of selected) {
    const text = concern.text.length > MAX_RUNTIME_CONTEXT_TEXT_CHARS
      ? `${concern.text.slice(0, MAX_RUNTIME_CONTEXT_TEXT_CHARS - 3)}...`
      : concern.text;
    const contactDescriptor = concern.contactId ? `contact=${concern.contactId}` : 'contact=global';
    const expiresAtMs = Date.parse(concern.expiresAt);
    const expiresAtLabel = Number.isFinite(expiresAtMs)
      ? formatActiveDateTimeLabel(new Date(expiresAtMs))
      : concern.expiresAt;
    lines.push(
      `- (${concern.priority}, ${concern.source}, ${contactDescriptor}, expires=${expiresAtLabel}) ${text}`,
    );
  }

  const omitted = concerns.length - selected.length;
  if (omitted > 0) {
    lines.push(`- (${omitted} additional concerns omitted for context budget)`);
  }

  return lines.join('\n');
}

export class ActiveConcernStore implements ActiveConcernContextProvider {
  private readonly adapter: DatabaseAdapter;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly ttlMsByPriority: Record<ActiveConcernPriority, number>;

  constructor(adapter: DatabaseAdapter, options: ActiveConcernStoreOptions = {}) {
    this.adapter = adapter;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.ttlMsByPriority = resolveConcernTtlByPriority(options.ttlMsByPriority);
  }

  async init(): Promise<void> {
    await this.initializeSchema();
  }

  async create(input: ActiveConcernCreateInput): Promise<ActiveConcern> {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const source = normalizeSource(input.source);
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const createdAtMs = Date.parse(createdAt);
    const expiresAt = input.expiresAt
      ? normalizeIsoTimestamp(input.expiresAt, 'expiresAt')
      : new Date(createdAtMs + this.ttlMsByPriority[priority]).toISOString();
    if (Date.parse(expiresAt) <= createdAtMs) {
      throw new Error('Active concern expiresAt must be after createdAt');
    }

    const contactId = normalizeOptionalId(input.contactId);
    const formationVAD = normalizeFormationVAD(input.formationVAD);
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);

    await this.adapter.run(
      `INSERT INTO active_concerns (
        id,
        text,
        priority,
        source,
        created_at,
        expires_at,
        contact_id,
        formation_vad
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        text,
        priority,
        source,
        createdAt,
        expiresAt,
        contactId ?? null,
        serializeFormationVAD(formationVAD),
      ],
    );

    return this.requireById(id);
  }

  async getById(id: string): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const row = await this.adapter.queryOne<ActiveConcernRow>(
      `SELECT
        id,
        text,
        priority,
        source,
        created_at,
        expires_at,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad
      FROM active_concerns
      WHERE id = ?`,
      [normalizedId],
    );
    if (!row) return null;
    return mapRow(row);
  }

  async getActiveConcerns(contactId?: string): Promise<ActiveConcern[]> {
    return this.list({
      contactId,
      includeResolved: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  async list(options: ActiveConcernListOptions = {}): Promise<ActiveConcern[]> {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const includeResolved = options.includeResolved === true;
    const includeExpired = options.includeExpired === true;
    const normalizedContactId = normalizeOptionalId(options.contactId);
    const limit = clampListLimit(options.limit);

    const whereClauses: string[] = [];
    const params: unknown[] = [];
    if (!includeResolved) {
      whereClauses.push('resolved_at IS NULL');
    }
    if (!includeExpired) {
      whereClauses.push('expires_at > ?');
      params.push(asOf);
    }
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = ?)');
      params.push(normalizedContactId);
    }

    const whereSql = whereClauses.length > 0
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    const rows = await this.adapter.query<ActiveConcernRow>(
      `SELECT
        id,
        text,
        priority,
        source,
        created_at,
        expires_at,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad
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
      LIMIT ?`,
      [...params, limit],
    );

    return rows.map(mapRow);
  }

  async listRecentlyResolvedConcerns(
    contactId?: string,
    options: ActiveConcernRecentResolutionOptions = {},
  ): Promise<ActiveConcern[]> {
    const asOf = options.asOf
      ? normalizeIsoTimestamp(options.asOf, 'asOf')
      : this.now().toISOString();
    const normalizedContactId = normalizeOptionalId(contactId);
    const limit = clampListLimit(options.limit ?? DEFAULT_RECENT_RESOLUTION_LIMIT);
    const withinMs = normalizeRecentResolutionWindowMs(options.withinMs);
    const resolvedAfter = new Date(Date.parse(asOf) - withinMs).toISOString();

    const whereClauses = [
      'resolved_at IS NOT NULL',
      'resolved_at >= ?',
    ];
    const params: unknown[] = [resolvedAfter];
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = ?)');
      params.push(normalizedContactId);
    }

    const rows = await this.adapter.query<ActiveConcernRow>(
      `SELECT
        id,
        text,
        priority,
        source,
        created_at,
        expires_at,
        resolved_at,
        resolution_outcome,
        contact_id,
        formation_vad
      FROM active_concerns
      WHERE ${whereClauses.join(' AND ')}
      ORDER BY resolved_at DESC, created_at DESC, id DESC
      LIMIT ?`,
      [...params, limit],
    );

    return rows.map(mapRow);
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
      const score = scoreConcernTextSimilarity(text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) {
        continue;
      }
      bestMatch = concern;
      bestScore = score;
    }

    return bestMatch;
  }

  async resolveConcern(id: string, options: ActiveConcernResolveOptions = {}): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const outcome = normalizeOptionalText(options.outcome, MAX_CONCERN_RESOLUTION_CHARS);
    const resolvedAt = options.resolvedAt
      ? normalizeIsoTimestamp(options.resolvedAt, 'resolvedAt')
      : this.now().toISOString();

    const result = await this.adapter.run(
      `UPDATE active_concerns
      SET
        resolved_at = ?,
        resolution_outcome = ?
      WHERE
        id = ?
        AND resolved_at IS NULL`,
      [resolvedAt, outcome ?? null, normalizedId],
    );

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  private async requireById(id: string): Promise<ActiveConcern> {
    const concern = await this.getById(id);
    if (!concern) {
      throw new Error(`Failed to load active concern "${id}" after write`);
    }
    return concern;
  }

  private async initializeSchema(): Promise<void> {
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS active_concerns (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        priority TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution_outcome TEXT,
        contact_id TEXT,
        formation_vad TEXT,
        CHECK (priority IN ('high', 'medium', 'low')),
        CHECK (source IN ('appraisal', 'agent', 'heartbeat'))
      );

      CREATE INDEX IF NOT EXISTS idx_active_concerns_active
      ON active_concerns (resolved_at, expires_at, priority, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_active_concerns_contact
      ON active_concerns (contact_id, resolved_at, expires_at, created_at, id);
    `);

    const hasResolutionOutcome = await this.adapter.hasColumn('active_concerns', 'resolution_outcome');
    if (!hasResolutionOutcome) {
      await this.adapter.exec('ALTER TABLE active_concerns ADD COLUMN resolution_outcome TEXT');
    }
  }
}
