import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { formatActiveDateTimeLabel } from '../../shared/time/active-timezone.js';
import { getConcernSofteningConfig } from './concern-softening.js';
import type { ActiveConcernContextProvider } from './concern-store-port.js';

export const ACTIVE_CONCERN_PRIORITIES = ['high', 'medium', 'low'] as const;
export type ActiveConcernPriority = typeof ACTIVE_CONCERN_PRIORITIES[number];

export const ACTIVE_CONCERN_SOURCES = ['appraisal', 'agent', 'heartbeat'] as const;
export type ActiveConcernSource = typeof ACTIVE_CONCERN_SOURCES[number];

export const ACTIVE_CONCERN_STATUSES = [
  'candidate',
  'active',
  'watching',
  'deferred',
  'blocked',
  'resolved',
  'dismissed',
  'suppressed',
] as const;
export type ActiveConcernStatus = typeof ACTIVE_CONCERN_STATUSES[number];

export const ACTIVE_CONCERN_TERMINAL_STATUSES = ['resolved', 'dismissed', 'suppressed'] as const;
export type ActiveConcernTerminalStatus = typeof ACTIVE_CONCERN_TERMINAL_STATUSES[number];

export const ACTIVE_CONCERN_SENSITIVITIES = [
  'public',
  'personal',
  'intimate',
  'confidential',
  'redacted',
] as const;
export type ActiveConcernSensitivity = typeof ACTIVE_CONCERN_SENSITIVITIES[number];

export const ACTIVE_CONCERN_OWNERS = ['companion', 'operator', 'system'] as const;
export type ActiveConcernOwner = typeof ACTIVE_CONCERN_OWNERS[number];

export const ACTIVE_CONCERN_EVIDENCE_KINDS = [
  'message',
  'turn',
  'appraisal',
  'audit_landmark',
  'operator',
  'runtime',
  'redacted',
] as const;
export type ActiveConcernEvidenceKind = typeof ACTIVE_CONCERN_EVIDENCE_KINDS[number];

export interface ActiveConcernEvidenceRef {
  kind: ActiveConcernEvidenceKind;
  ref: string;
  sensitivity?: ActiveConcernSensitivity;
  redacted?: boolean;
  hash?: string;
}

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
  status: ActiveConcernStatus;
  createdAt: string;
  expiresAt: string;
  salience: number;
  sensitivity: ActiveConcernSensitivity;
  owner: ActiveConcernOwner;
  evidenceRefs: ActiveConcernEvidenceRef[];
  resolutionEvidenceRefs: ActiveConcernEvidenceRef[];
  resolvedAt?: string;
  resolutionOutcome?: string;
  contactId?: string;
  formationVAD?: ActiveConcernVAD;
  lastReviewedAt?: string;
  nextReviewAt?: string;
  mergedFromIds?: string[];
  splitFromId?: string;
}

export interface ActiveConcernCreateInput {
  text: string;
  priority?: ActiveConcernPriority;
  source?: ActiveConcernSource;
  status?: ActiveConcernStatus;
  contactId?: string;
  formationVAD?: ActiveConcernVAD;
  salience?: number;
  sensitivity?: ActiveConcernSensitivity;
  owner?: ActiveConcernOwner;
  evidenceRefs?: readonly ActiveConcernEvidenceRef[];
  resolutionEvidenceRefs?: readonly ActiveConcernEvidenceRef[];
  lastReviewedAt?: string;
  nextReviewAt?: string;
  mergedFromIds?: readonly string[];
  splitFromId?: string;
  reopenResolved?: boolean;
  createdAt?: string;
  expiresAt?: string;
}

export interface ActiveConcernResolveOptions {
  outcome?: string;
  resolvedAt?: string;
  evidenceRefs?: readonly ActiveConcernEvidenceRef[];
}

export interface ActiveConcernTransitionOptions {
  status: ActiveConcernStatus;
  transitionedAt?: string;
  outcome?: string;
  evidenceRefs?: readonly ActiveConcernEvidenceRef[];
  resolutionEvidenceRefs?: readonly ActiveConcernEvidenceRef[];
  nextReviewAt?: string;
  clearNextReview?: boolean;
  salience?: number;
}

export interface ActiveConcernStaleResolutionOptions {
  asOf?: string;
  outcome?: string;
  statuses?: readonly ActiveConcernStatus[];
  limit?: number;
  evidenceRefs?: readonly ActiveConcernEvidenceRef[];
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

export interface ActiveConcernRuntimeData {
  totalCount: number;
  topLines: string[];
  topPriorities: ActiveConcernPriority[];
  omittedCount: number;
}

interface ActiveConcernRow {
  id: string;
  text: string;
  priority: string;
  source: string;
  status: string | null;
  created_at: string;
  expires_at: string;
  salience: number | null;
  sensitivity: string | null;
  owner: string | null;
  evidence_refs: string | null;
  resolution_evidence_refs: string | null;
  resolved_at: string | null;
  resolution_outcome: string | null;
  contact_id: string | null;
  formation_vad: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  merged_from_ids: string | null;
  split_from_id: string | null;
}

const MAX_CONCERN_TEXT_CHARS = 500;
const MAX_CONCERN_RESOLUTION_CHARS = 400;
const DEFAULT_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;
const DEFAULT_RUNTIME_CONTEXT_LIMIT = 3;
const MAX_CONCERN_REF_CHARS = 240;
const DEFAULT_RECENT_RESOLUTION_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RECENT_RESOLUTION_LIMIT = 8;
const CONCERN_DUPLICATE_SIMILARITY_THRESHOLD = 0.72;
const DEFAULT_CONCERN_SALIENCE = 0.5;
export const MAX_ACTIVE_CONCERNS = 7;
export const MAX_ACTIVE_CONCERN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

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

function clampConcernExpiresAt(expiresAt: string, createdAt: string): string {
  const createdAtMs = Date.parse(createdAt);
  const expiresAtMs = Date.parse(expiresAt);
  const maxExpiresAtMs = createdAtMs + MAX_ACTIVE_CONCERN_LIFETIME_MS;
  return new Date(Math.min(expiresAtMs, maxExpiresAtMs)).toISOString();
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

export function normalizeConcernStatus(
  value: unknown,
  fieldName = 'status',
): ActiveConcernStatus {
  const normalized = value ?? 'active';
  if (typeof normalized !== 'string' || !ACTIVE_CONCERN_STATUSES.includes(normalized as ActiveConcernStatus)) {
    throw new Error(`Unsupported active concern ${fieldName}: ${String(normalized)}`);
  }
  return normalized as ActiveConcernStatus;
}

function normalizeSensitivity(
  value: ActiveConcernSensitivity | undefined,
): ActiveConcernSensitivity {
  const normalized = value ?? 'personal';
  if (!ACTIVE_CONCERN_SENSITIVITIES.includes(normalized)) {
    throw new Error(`Unsupported active concern sensitivity: ${String(normalized)}`);
  }
  return normalized;
}

function normalizeOwner(value: ActiveConcernOwner | undefined): ActiveConcernOwner {
  const normalized = value ?? 'companion';
  if (!ACTIVE_CONCERN_OWNERS.includes(normalized)) {
    throw new Error(`Unsupported active concern owner: ${String(normalized)}`);
  }
  return normalized;
}

function normalizeEvidenceKind(value: unknown): ActiveConcernEvidenceKind {
  if (typeof value !== 'string' || !ACTIVE_CONCERN_EVIDENCE_KINDS.includes(value as ActiveConcernEvidenceKind)) {
    throw new Error(`Unsupported active concern evidence kind: ${String(value)}`);
  }
  return value as ActiveConcernEvidenceKind;
}

function normalizeSalience(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_CONCERN_SALIENCE;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Active concern salience must be a finite number');
  }
  if (value < 0 || value > 1) {
    throw new Error('Active concern salience must be between 0 and 1');
  }
  return value;
}

function normalizeOptionalIsoTimestamp(
  value: string | undefined,
  fieldName: string,
): string | undefined {
  return value === undefined ? undefined : normalizeIsoTimestamp(value, fieldName);
}

export function isConcernTerminalStatus(status: ActiveConcernStatus): status is ActiveConcernTerminalStatus {
  return ACTIVE_CONCERN_TERMINAL_STATUSES.includes(status as ActiveConcernTerminalStatus);
}

export function isConcernAttentionStatus(status: ActiveConcernStatus): boolean {
  return !isConcernTerminalStatus(status);
}

function normalizeConcernEvidenceRef(
  value: unknown,
  fieldName: string,
): ActiveConcernEvidenceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Active concern ${fieldName} must be an object`);
  }
  const candidate = value as Partial<ActiveConcernEvidenceRef>;
  const kind = normalizeEvidenceKind(candidate.kind);
  if (typeof candidate.ref !== 'string') {
    throw new Error(`Active concern ${fieldName}.ref must be a string`);
  }
  const ref = normalizeRequiredText(candidate.ref, `${fieldName}.ref`, MAX_CONCERN_REF_CHARS);
  const sensitivity = candidate.sensitivity === undefined
    ? undefined
    : normalizeSensitivity(candidate.sensitivity);
  const hash = normalizeOptionalText(candidate.hash, MAX_CONCERN_REF_CHARS);
  const redacted = candidate.redacted === true || kind === 'redacted' || sensitivity === 'redacted';
  return {
    kind,
    ref,
    ...(sensitivity ? { sensitivity } : {}),
    ...(redacted ? { redacted: true } : {}),
    ...(hash ? { hash } : {}),
  };
}

export function normalizeConcernEvidenceRefs(
  value: readonly ActiveConcernEvidenceRef[] | undefined,
  fieldName = 'evidenceRefs',
): ActiveConcernEvidenceRef[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Active concern ${fieldName} must be an array`);
  }
  const refs = value.map((ref, index) => normalizeConcernEvidenceRef(ref, `${fieldName}[${index}]`));
  const deduped = new Map<string, ActiveConcernEvidenceRef>();
  for (const ref of refs) {
    deduped.set(`${ref.kind}:${ref.ref}:${ref.hash ?? ''}`, ref);
  }
  return [...deduped.values()];
}

function serializeEvidenceRefs(value: readonly ActiveConcernEvidenceRef[] | undefined): string {
  return JSON.stringify(normalizeConcernEvidenceRefs(value));
}

function parseEvidenceRefs(raw: string | null, fieldName: string): ActiveConcernEvidenceRef[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid active concern ${fieldName} JSON: ${String(error)}`);
  }
  return normalizeConcernEvidenceRefs(parsed as ActiveConcernEvidenceRef[], fieldName);
}

function normalizeStringList(
  value: readonly string[] | undefined,
  fieldName: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Active concern ${fieldName} must be an array`);
  }
  const normalized = value
    .map((item, index) => normalizeRequiredText(item, `${fieldName}[${index}]`, 128));
  return [...new Set(normalized)];
}

function serializeStringList(value: readonly string[] | undefined): string {
  return JSON.stringify(normalizeStringList(value, 'ids'));
}

function parseStringList(raw: string | null, fieldName: string): string[] {
  if (raw === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid active concern ${fieldName} JSON: ${String(error)}`);
  }
  return normalizeStringList(parsed as string[], fieldName);
}

export function mergeConcernEvidenceRefs(
  left: readonly ActiveConcernEvidenceRef[],
  right: readonly ActiveConcernEvidenceRef[],
): ActiveConcernEvidenceRef[] {
  return normalizeConcernEvidenceRefs([...left, ...right]);
}

export function mergeConcernStringLists(left: readonly string[], right: readonly string[]): string[] {
  return normalizeStringList([...left, ...right], 'mergedFromIds');
}

const STATUS_MERGE_RANK: Record<ActiveConcernStatus, number> = {
  blocked: 0,
  active: 1,
  watching: 2,
  deferred: 3,
  candidate: 4,
  resolved: 5,
  dismissed: 6,
  suppressed: 7,
};

export function mergeConcernStatus(
  left: ActiveConcernStatus,
  right: ActiveConcernStatus,
): ActiveConcernStatus {
  return STATUS_MERGE_RANK[right] < STATUS_MERGE_RANK[left] ? right : left;
}

const SENSITIVITY_RANK: Record<ActiveConcernSensitivity, number> = {
  public: 0,
  personal: 1,
  intimate: 2,
  confidential: 3,
  redacted: 4,
};

export function mergeConcernSensitivity(
  left: ActiveConcernSensitivity,
  right: ActiveConcernSensitivity,
): ActiveConcernSensitivity {
  return SENSITIVITY_RANK[right] > SENSITIVITY_RANK[left] ? right : left;
}

export function chooseHigherConcernPriority(
  left: ActiveConcernPriority,
  right: ActiveConcernPriority,
): ActiveConcernPriority {
  const priorityRank: Record<ActiveConcernPriority, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  return priorityRank[right] < priorityRank[left] ? right : left;
}

export function chooseLaterConcernTimestamp(left: string, right: string): string {
  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function chooseEarlierOptionalConcernTimestamp(
  left: string | undefined,
  right: string | undefined,
): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) < Date.parse(left) ? right : left;
}

const ALLOWED_CONCERN_STATUS_TRANSITIONS: Record<ActiveConcernStatus, readonly ActiveConcernStatus[]> = {
  candidate: ['active', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  active: ['candidate', 'watching', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  watching: ['active', 'deferred', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  deferred: ['active', 'watching', 'blocked', 'resolved', 'dismissed', 'suppressed'],
  blocked: ['active', 'deferred', 'watching', 'resolved', 'dismissed', 'suppressed'],
  resolved: ['candidate', 'active', 'watching'],
  dismissed: ['candidate', 'active'],
  suppressed: [],
};

export function validateConcernStatusTransition(input: {
  from: ActiveConcernStatus;
  to: ActiveConcernStatus;
  evidenceRefs?: readonly ActiveConcernEvidenceRef[];
}): void {
  if (input.from === input.to) {
    return;
  }
  const allowed = ALLOWED_CONCERN_STATUS_TRANSITIONS[input.from];
  if (!allowed.includes(input.to)) {
    throw new Error(`Invalid active concern transition: ${input.from} -> ${input.to}`);
  }
  if (isConcernTerminalStatus(input.from) && isConcernAttentionStatus(input.to)) {
    const evidenceRefs = normalizeConcernEvidenceRefs(input.evidenceRefs);
    if (evidenceRefs.length === 0) {
      throw new Error(`Reopening ${input.from} concern requires new safe evidence refs`);
    }
  }
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

// Concern wording rewrites are operator-tunable data (E2.5 purity rule):
// config/concern-softening.json owns the rules; the shipped default matches
// the previous hardcoded behavior byte-for-byte.
function softenConcernText(value: string): string {
  const config = getConcernSofteningConfig();
  let normalized = compactWhitespace(value);
  for (const rule of config.rewriteRules) {
    normalized = normalized.replace(rule.pattern, rule.replacement);
  }
  if (normalized.length <= config.maxTextChars) {
    return normalized;
  }
  return `${normalized.slice(0, config.maxTextChars - 3)}...`;
}

function dedupeConcernsForRuntime(concerns: readonly ActiveConcern[]): ActiveConcern[] {
  const selected: ActiveConcern[] = [];
  for (const concern of concerns) {
    const isDuplicate = selected.some(existing => (
      scoreConcernTextSimilarity(existing.text, concern.text) >= CONCERN_DUPLICATE_SIMILARITY_THRESHOLD
    ));
    if (!isDuplicate) {
      selected.push(concern);
    }
  }
  return selected;
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

function mapStatus(status: string | null): ActiveConcernStatus {
  return normalizeConcernStatus(status ?? 'active');
}

function mapSensitivity(sensitivity: string | null): ActiveConcernSensitivity {
  return normalizeSensitivity((sensitivity ?? 'personal') as ActiveConcernSensitivity);
}

function mapOwner(owner: string | null): ActiveConcernOwner {
  return normalizeOwner((owner ?? 'companion') as ActiveConcernOwner);
}

function mapSalience(salience: number | null): number {
  return normalizeSalience(salience ?? DEFAULT_CONCERN_SALIENCE);
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
  const lastReviewedAt = row.last_reviewed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.last_reviewed_at, 'last_reviewed_at');
  const nextReviewAt = row.next_review_at === null
    ? undefined
    : normalizeIsoTimestamp(row.next_review_at, 'next_review_at');
  const mergedFromIds = parseStringList(row.merged_from_ids, 'merged_from_ids');
  const splitFromId = row.split_from_id === null ? undefined : normalizeOptionalId(row.split_from_id);

  return {
    id: row.id,
    text: row.text,
    priority: mapPriority(row.priority),
    source: mapSource(row.source),
    status: mapStatus(row.status),
    createdAt,
    expiresAt,
    salience: mapSalience(row.salience),
    sensitivity: mapSensitivity(row.sensitivity),
    owner: mapOwner(row.owner),
    evidenceRefs: parseEvidenceRefs(row.evidence_refs, 'evidence_refs'),
    resolutionEvidenceRefs: parseEvidenceRefs(row.resolution_evidence_refs, 'resolution_evidence_refs'),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionOutcome ? { resolutionOutcome } : {}),
    ...(contactId ? { contactId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
    ...(lastReviewedAt ? { lastReviewedAt } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    ...(mergedFromIds.length > 0 ? { mergedFromIds } : {}),
    ...(splitFromId ? { splitFromId } : {}),
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

function isConcernPastHardLifetime(concern: ActiveConcern, asOfMs: number): boolean {
  return Date.parse(concern.createdAt) + MAX_ACTIVE_CONCERN_LIFETIME_MS <= asOfMs;
}

export function buildActiveConcernsPromptVariables(
  runtimeData: ActiveConcernRuntimeData,
): Record<string, string> {
  return {
    runtime_concerns_count: String(runtimeData.totalCount),
    runtime_concerns_top_lines: runtimeData.topLines.join('\n'),
    runtime_concerns_top_priorities: runtimeData.topPriorities.join(', '),
    runtime_concerns_omitted_count: String(runtimeData.omittedCount),
    runtime_concerns_omitted_plural_suffix: runtimeData.omittedCount === 1 ? '' : 's',
  };
}

export function buildActiveConcernsRuntimeData(
  concerns: readonly ActiveConcern[],
  limit = DEFAULT_RUNTIME_CONTEXT_LIMIT,
): ActiveConcernRuntimeData {
  if (concerns.length === 0) {
    return {
      totalCount: 0,
      topLines: [],
      topPriorities: [],
      omittedCount: 0,
    };
  }

  const normalizedLimit = clampListLimit(limit);
  const deduped = dedupeConcernsForRuntime(concerns);
  const selected = deduped.slice(0, normalizedLimit);
  const topLines = selected.map((concern) => {
    const expiresAtMs = Date.parse(concern.expiresAt);
    const expiresAtLabel = Number.isFinite(expiresAtMs)
      ? formatActiveDateTimeLabel(new Date(expiresAtMs))
      : concern.expiresAt;
    return `- ${softenConcernText(concern.text)} [${concern.priority}; revisit before ${expiresAtLabel}]`;
  });

  return {
    totalCount: deduped.length,
    topLines,
    topPriorities: selected.map(concern => concern.priority),
    omittedCount: Math.max(0, deduped.length - selected.length),
  };
}

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
