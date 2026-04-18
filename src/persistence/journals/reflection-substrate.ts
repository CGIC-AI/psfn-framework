import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { formatActiveDateTimeLabel } from '../../shared/time/active-timezone.js';
import type { EmotionalTimeSeriesPoint } from '../../core/contacts/store/emotional-baseline.js';
import { appendJsonLine } from '../jsonl.js';
import { sanitizeChannelId } from '../sessions/store-primitives.js';
import type { ValuesDeliberationMetadata } from '../../faculties/values/store.js';
import type { ReflectionJournalEntry } from './reflection-journal.js';
import { NON_CANONICAL_REFLECTION_SUBSTRATE } from './reflection-journal.js';

const log = createComponentLogger('ReflectionSubstrate');
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ReflectionExecutionSource =
  | 'manual'
  | 'scheduled'
  | 'deferred_scheduler'
  | 'deferred_post_turn';

export type ReflectionDailyJournalSource = 'heartbeat_template';
export type ReflectionProcessType = 'reflection_deliberation';
export type ReflectionProcessStage = 'started' | 'completed' | 'failed';

interface ReflectionSubstrateStoreOptions {
  now?: () => number;
}

export interface ReflectionSubstrateListOptions {
  limit?: number;
}

export interface ReflectionProcessLogListOptions extends ReflectionSubstrateListOptions {
  stages?: ReflectionProcessStage[];
}

export interface ReflectionDailyJournalAppendInput {
  source: ReflectionDailyJournalSource;
  executionSource: ReflectionExecutionSource;
  reflection: string;
  createdAt?: string;
  date?: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  mode?: 'agent' | 'deliberation';
  reflectionJournalEntryId?: string;
  processId?: string;
  tags?: string[];
}

export interface ReflectionDailyJournalEntry {
  id: string;
  kind: 'daily_journal_entry';
  source: ReflectionDailyJournalSource;
  executionSource: ReflectionExecutionSource;
  reflection: string;
  createdAt: string;
  date: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  mode?: 'agent' | 'deliberation';
  reflectionJournalEntryId?: string;
  processId?: string;
  tags?: string[];
}

export interface ReflectionProcessLogAppendInput {
  processId: string;
  processLabel: string;
  processType: ReflectionProcessType;
  stage: ReflectionProcessStage;
  executionSource: ReflectionExecutionSource;
  createdAt?: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  reflection?: string;
  error?: string;
  tags?: string[];
  deliberation?: ValuesDeliberationMetadata;
}

export interface ReflectionProcessLogEntry {
  id: string;
  kind: 'process_log_entry';
  processId: string;
  processLabel: string;
  processType: ReflectionProcessType;
  stage: ReflectionProcessStage;
  executionSource: ReflectionExecutionSource;
  createdAt: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  reflection?: string;
  error?: string;
  tags?: string[];
  deliberation?: ValuesDeliberationMetadata;
}

export interface ReflectionContextBundle {
  canonicalTruthBoundary: typeof NON_CANONICAL_REFLECTION_SUBSTRATE;
  self: string;
  relational: string;
  affect: string;
  provenanceRefs: string[];
}

export interface ReflectionSubstrateContext extends ReflectionContextBundle {}

export interface ReflectionContactRecentMessage {
  role: 'user' | 'assistant';
  content: string;
  authorName?: string;
}

export interface ReflectionContactEmotionalSnapshot {
  valence?: number;
  confidence?: number;
  observedAtMs?: number;
  [key: string]: unknown;
}

export interface ReflectionContactCurrentVAD {
  valence: number;
  arousal: number;
  dominance: number;
}

export interface ReflectionContactActiveConcern {
  id?: string;
  text?: string;
  priority?: 'high' | 'medium' | 'low';
  source?: string;
  expiresAt?: string;
}

export interface ReflectionContactPendingFollowUp {
  id?: string;
  content?: string;
  priority?: 'low' | 'medium' | 'high';
  timing?: 'immediate' | 'soon' | 'scheduled';
  dueAt?: string;
  contextSummary?: string;
  wakeConditions?: readonly string[];
}

export interface ReflectionContactContextBundleInput {
  contactId: string;
  contactDisplayName?: string;
  trustLevel?: string;
  primarySessionId?: string;
  lastSeen?: string;
  lastSeenDeltaSeconds?: number | null;
  currentVAD?: ReflectionContactCurrentVAD | null;
  emotionalSnapshot?: ReflectionContactEmotionalSnapshot | null;
  emotionalTimeSeries?: readonly EmotionalTimeSeriesPoint[];
  recentSessionMessages?: readonly ReflectionContactRecentMessage[];
  memoryBlock?: string;
  activeConcerns?: readonly ReflectionContactActiveConcern[];
  pendingFollowUps?: readonly ReflectionContactPendingFollowUp[];
  internalStateBlock?: string;
}

export interface ReflectionContactContextBundle extends ReflectionContextBundle {}

type ReflectionContextSectionKey = 'self' | 'relational' | 'affect';

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredString(value, fieldName);
}

function normalizeIsoDate(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!ISO_DATE_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must match YYYY-MM-DD`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${fieldName} must be a valid ISO date`);
  }
  return normalized;
}

function normalizeCreatedAt(value: unknown, now: () => number): string {
  if (value === undefined || value === null) {
    return new Date(now()).toISOString();
  }
  const normalized = normalizeRequiredString(value, 'createdAt');
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error('createdAt must be an ISO-8601 timestamp');
  }
  return normalized;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('tags must be an array when provided');
  }
  const normalized = [...new Set(value.map((tag, index) => normalizeRequiredString(tag, `tags[${String(index)}]`)))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDeliberationMetadata(raw: unknown): ValuesDeliberationMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('deliberation must be an object when provided');
  }
  const candidate = raw as Partial<ValuesDeliberationMetadata>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.trim().length === 0) {
    throw new Error('deliberation.sessionId must be a non-empty string');
  }
  if (typeof candidate.stopReason !== 'string' || candidate.stopReason.trim().length === 0) {
    throw new Error('deliberation.stopReason must be a non-empty string');
  }
  const numericFields: Array<keyof Pick<
    ValuesDeliberationMetadata,
    'rounds' | 'totalInputTokens' | 'totalOutputTokens' | 'totalTokens' | 'estimatedCostUsd' | 'durationMs'
  >> = [
    'rounds',
    'totalInputTokens',
    'totalOutputTokens',
    'totalTokens',
    'estimatedCostUsd',
    'durationMs',
  ];
  for (const fieldName of numericFields) {
    const value = candidate[fieldName];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`deliberation.${fieldName} must be a finite number >= 0`);
    }
  }
  const rounds = candidate.rounds as number;
  const totalInputTokens = candidate.totalInputTokens as number;
  const totalOutputTokens = candidate.totalOutputTokens as number;
  const totalTokens = candidate.totalTokens as number;
  const estimatedCostUsd = candidate.estimatedCostUsd as number;
  const durationMs = candidate.durationMs as number;
  return {
    sessionId: candidate.sessionId.trim(),
    stopReason: candidate.stopReason.trim(),
    rounds: Math.floor(rounds),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    estimatedCostUsd,
    durationMs,
  };
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer when provided`);
  }
  return value;
}

function readJsonlEntries<T>(
  filePath: string,
  normalize: (raw: unknown) => T | null,
  warningPrefix: string,
): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  if (raw.trim().length === 0) return [];

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line, index) => {
      try {
        return normalize(JSON.parse(line) as unknown);
      } catch (error) {
        log.warn(warningPrefix, {
          filePath,
          line: index + 1,
          error: String(error),
        });
        return null;
      }
    })
    .filter((entry): entry is T => entry !== null);
}

function listJsonlFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .filter(fileName => fileName.endsWith('.jsonl'))
    .map(fileName => join(rootDir, fileName));
}

function sortEntriesByCreatedAtDescending<T extends { createdAt: string; id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (timeDelta !== 0) return timeDelta;
    return right.id.localeCompare(left.id);
  });
}

function truncateReflectionText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function formatOptionalNumber(value: number | null | undefined, digits = 3): string {
  if (value === undefined || value === null || !Number.isFinite(value)) {
    return 'unknown';
  }
  return Number(value).toFixed(digits);
}

function formatOptionalDateTime(value: string | null | undefined): string {
  if (!value) return 'unknown';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return formatActiveDateTimeLabel(new Date(parsed));
}

function joinContextSections(...sections: Array<string | undefined>): string {
  return sections
    .map(section => section?.trim() ?? '')
    .filter(section => section.length > 0)
    .join('\n\n');
}

function formatRecentSessionMessagesBlock(
  messages: readonly ReflectionContactRecentMessage[] | undefined,
  primarySessionId?: string,
): { block?: string; provenanceRefs: string[] } {
  if (!messages || messages.length === 0) {
    return { provenanceRefs: [] };
  }

  const lines = [
    '[Recent Contact Session]',
    'Use the live exchange below as the freshest conversation anchor.',
  ];
  const provenanceRefs = new Set<string>();

  messages.slice(-12).forEach((message) => {
    const speaker = message.role === 'assistant'
      ? message.authorName?.trim() || 'Assistant'
      : message.authorName?.trim() || 'User';
    const content = truncateReflectionText(message.content, 240);
    lines.push(`- ${speaker}: ${content}`);
  });
  if (primarySessionId?.trim()) {
    provenanceRefs.add(`reflection_contact_session:${primarySessionId.trim()}`);
  }
  provenanceRefs.add(`reflection_contact_session_messages:${messages.length}`);

  return {
    block: lines.join('\n'),
    provenanceRefs: [...provenanceRefs],
  };
}

function formatRecentSessionTailBlock(
  messages: readonly ReflectionContactRecentMessage[] | undefined,
  primarySessionId?: string,
): { block?: string; provenanceRefs: string[] } {
  const tailMessages = messages?.slice(-4);
  if (!tailMessages || tailMessages.length === 0) {
    return { provenanceRefs: [] };
  }

  const lines = [
    '[Recent Session Tail]',
    'Memory retrieval was empty, so use this recent live tail as the fallback evidence.',
  ];
  const provenanceRefs = new Set<string>();

  tailMessages.forEach((message) => {
    const speaker = message.role === 'assistant'
      ? message.authorName?.trim() || 'Assistant'
      : message.authorName?.trim() || 'User';
    const content = truncateReflectionText(message.content, 240);
    lines.push(`- ${speaker}: ${content}`);
  });

  if (primarySessionId?.trim()) {
    provenanceRefs.add(`reflection_contact_session_tail:${primarySessionId.trim()}`);
  }
  provenanceRefs.add(`reflection_contact_session_tail_messages:${tailMessages.length}`);

  return {
    block: lines.join('\n'),
    provenanceRefs: [...provenanceRefs],
  };
}

function formatActiveConcernsBlock(
  concerns: readonly ReflectionContactActiveConcern[] | undefined,
): string | undefined {
  if (!concerns || concerns.length === 0) return undefined;

  const lines = [
    '[Active Concerns]',
    'Treat these as soft threads to revisit, not as a global alarm state.',
  ];

  for (const concern of concerns.slice(0, 8)) {
    const priority = concern.priority ?? 'medium';
    const text = truncateReflectionText(concern.text ?? '', 180);
    if (!text) continue;
    const expiresAt = formatOptionalDateTime(concern.expiresAt);
    lines.push(`- [${priority}${concern.source ? `|${concern.source}` : ''}] ${text}${expiresAt !== 'unknown' ? ` (revisit before ${expiresAt})` : ''}`);
  }

  return lines.length > 2 ? lines.join('\n') : undefined;
}

function formatPendingFollowUpsBlock(
  followUps: readonly ReflectionContactPendingFollowUp[] | undefined,
): string | undefined {
  if (!followUps || followUps.length === 0) return undefined;

  const lines = [
    '[Pending Follow-Ups]',
    'Use these as reminders of open loops, not as a queue to act on automatically.',
  ];

  for (const followUp of followUps.slice(0, 8)) {
    const content = truncateReflectionText(followUp.content ?? '', 180);
    if (!content) continue;
    const pieces: string[] = [`- [${followUp.priority ?? 'medium'}|${followUp.timing ?? 'soon'}] ${content}`];
    const dueAt = formatOptionalDateTime(followUp.dueAt);
    if (dueAt !== 'unknown') {
      pieces.push(`due ${dueAt}`);
    }
    if (followUp.contextSummary?.trim()) {
      pieces.push(`context ${truncateReflectionText(followUp.contextSummary, 120)}`);
    }
    if (followUp.wakeConditions && followUp.wakeConditions.length > 0) {
      pieces.push(`wake ${followUp.wakeConditions.join(', ')}`);
    }
    lines.push(pieces.join(' | '));
  }

  return lines.length > 2 ? lines.join('\n') : undefined;
}

function formatContactRelationalBlock(input: ReflectionContactContextBundleInput): string {
  const lines = [
    '[Reflection Contact Context]',
    `contact_id: ${input.contactId}`,
    `contact_name: ${input.contactDisplayName?.trim() || 'unknown'}`,
    `trust_level: ${input.trustLevel?.trim() || 'unknown'}`,
    `primary_session_id: ${input.primarySessionId?.trim() || 'unknown'}`,
    `last_seen: ${formatOptionalDateTime(input.lastSeen)}`,
    `last_seen_delta_seconds: ${input.lastSeenDeltaSeconds === null || input.lastSeenDeltaSeconds === undefined
      ? 'unknown'
      : Math.max(0, Math.floor(input.lastSeenDeltaSeconds)).toString()}`,
    `recent_contact_status: ${(input.recentSessionMessages?.length ?? 0) > 0 ? 'active' : 'quiet'}`,
    'guidance:',
    '- Ground the reflection in the live contact, not in a generic silence narrative.',
    '- If recent_contact_status is active, do not invent a gap or stale absence.',
  ];

  return lines.join('\n');
}

function formatContactAffectBlock(input: ReflectionContactContextBundleInput): string | undefined {
  if (!input.currentVAD && !input.emotionalSnapshot && !(input.emotionalTimeSeries?.length)) {
    return undefined;
  }

  const lines = [
    '[Reflection Affect Context]',
    'Treat these affect signals as current evidence, not as a command to intensify them.',
  ];

  if (input.currentVAD) {
    lines.push(
      `current_vad: valence=${formatOptionalNumber(input.currentVAD.valence, 3)} `
      + `arousal=${formatOptionalNumber(input.currentVAD.arousal, 3)} `
      + `dominance=${formatOptionalNumber(input.currentVAD.dominance, 3)}`,
    );
  }

  if (input.emotionalSnapshot) {
    lines.push(`emotional_snapshot: ${JSON.stringify(input.emotionalSnapshot)}`);
  }

  if (input.emotionalTimeSeries?.length) {
    lines.push('emotional_time_series:');
    for (const point of input.emotionalTimeSeries) {
      lines.push(
        `- ${new Date(point.observedAtMs).toISOString()} `
        + `valence=${formatOptionalNumber(point.valence, 3)} `
        + `confidence=${formatOptionalNumber(point.confidence, 3)}`,
      );
    }
  }

  return lines.join('\n');
}

function classifyReflectionContextSection(templateId: string | undefined): ReflectionContextSectionKey {
  switch (templateId) {
    case 'daily-review':
      return 'relational';
    case 'experiential-review':
    case 'musing':
    case 'whisper':
      return 'affect';
    default:
      return 'self';
  }
}

function buildSubstrateSection(
  title: string,
  lines: readonly string[],
): string {
  if (lines.length === 0) {
    return '';
  }

  return [
    title,
    `canonical_truth_boundary: ${NON_CANONICAL_REFLECTION_SUBSTRATE}`,
    'guidance:',
    '- Treat these append-only journal and process traces as reflective clues, not canonical truth.',
    '- Preserve cited provenance refs when carrying a pattern forward.',
    ...lines,
  ].join('\n');
}

export function assembleReflectionContactContextBundle(
  input: ReflectionContactContextBundleInput,
): ReflectionContactContextBundle {
  const selfSections: string[] = [];
  const relationalSections = [formatContactRelationalBlock(input)];
  const affectSections: string[] = [];
  const provenanceRefs = new Set<string>([
    `reflection_contact:${input.contactId}`,
  ]);

  const recentSessionBlock = formatRecentSessionMessagesBlock(input.recentSessionMessages, input.primarySessionId);
  if (recentSessionBlock.block) {
    relationalSections.push(recentSessionBlock.block);
    recentSessionBlock.provenanceRefs.forEach(ref => provenanceRefs.add(ref));
  }

  const activeConcernsBlock = formatActiveConcernsBlock(input.activeConcerns);
  if (activeConcernsBlock) {
    relationalSections.push(activeConcernsBlock);
  }

  const pendingFollowUpsBlock = formatPendingFollowUpsBlock(input.pendingFollowUps);
  if (pendingFollowUpsBlock) {
    relationalSections.push(pendingFollowUpsBlock);
  }

  if (input.internalStateBlock?.trim()) {
    selfSections.push(input.internalStateBlock.trim());
  }

  const affectBlock = formatContactAffectBlock(input);
  if (affectBlock) {
    affectSections.push(affectBlock);
  }

  const memoryBlock = input.memoryBlock?.trim();
  if (memoryBlock) {
    selfSections.push('[Reflection Memory Retrieval]', memoryBlock);
    provenanceRefs.add(`reflection_contact_memory:${input.contactId}`);
  } else {
    const tailBlock = formatRecentSessionTailBlock(input.recentSessionMessages, input.primarySessionId);
    if (tailBlock.block) {
      selfSections.push('[Reflection Memory Retrieval]', tailBlock.block);
      tailBlock.provenanceRefs.forEach(ref => provenanceRefs.add(ref));
    }
  }

  return {
    canonicalTruthBoundary: NON_CANONICAL_REFLECTION_SUBSTRATE,
    self: joinContextSections(...selfSections),
    relational: joinContextSections(...relationalSections),
    affect: joinContextSections(...affectSections),
    provenanceRefs: [...provenanceRefs],
  };
}

function normalizeDailyJournalEntry(raw: unknown): ReflectionDailyJournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ReflectionDailyJournalEntry>;
  if (
    typeof entry.id !== 'string'
    || entry.id.trim().length === 0
    || entry.kind !== 'daily_journal_entry'
    || entry.source !== 'heartbeat_template'
    || (entry.executionSource !== 'manual'
      && entry.executionSource !== 'scheduled'
      && entry.executionSource !== 'deferred_scheduler'
      && entry.executionSource !== 'deferred_post_turn')
    || typeof entry.reflection !== 'string'
    || entry.reflection.trim().length === 0
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
    || typeof entry.date !== 'string'
    || entry.date.trim().length === 0
  ) {
    return null;
  }
  try {
    return {
      id: entry.id.trim(),
      kind: 'daily_journal_entry',
      source: 'heartbeat_template',
      executionSource: entry.executionSource,
      reflection: normalizeRequiredString(entry.reflection, 'reflection'),
      createdAt: normalizeCreatedAt(entry.createdAt, Date.now),
      date: normalizeIsoDate(entry.date, 'date'),
      ...(normalizeOptionalString(entry.templateId, 'templateId') ? { templateId: normalizeOptionalString(entry.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(entry.templateName, 'templateName') ? { templateName: normalizeOptionalString(entry.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(entry.channelId, 'channelId') ? { channelId: normalizeOptionalString(entry.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(entry.prompt, 'prompt') ? { prompt: normalizeOptionalString(entry.prompt, 'prompt') } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(normalizeOptionalString(entry.reflectionJournalEntryId, 'reflectionJournalEntryId')
        ? { reflectionJournalEntryId: normalizeOptionalString(entry.reflectionJournalEntryId, 'reflectionJournalEntryId') }
        : {}),
      ...(normalizeOptionalString(entry.processId, 'processId') ? { processId: normalizeOptionalString(entry.processId, 'processId') } : {}),
      ...(normalizeTags(entry.tags) ? { tags: normalizeTags(entry.tags) } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeProcessLogEntry(raw: unknown): ReflectionProcessLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ReflectionProcessLogEntry>;
  if (
    typeof entry.id !== 'string'
    || entry.id.trim().length === 0
    || entry.kind !== 'process_log_entry'
    || typeof entry.processId !== 'string'
    || entry.processId.trim().length === 0
    || typeof entry.processLabel !== 'string'
    || entry.processLabel.trim().length === 0
    || entry.processType !== 'reflection_deliberation'
    || (entry.stage !== 'started' && entry.stage !== 'completed' && entry.stage !== 'failed')
    || (entry.executionSource !== 'manual'
      && entry.executionSource !== 'scheduled'
      && entry.executionSource !== 'deferred_scheduler'
      && entry.executionSource !== 'deferred_post_turn')
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
  ) {
    return null;
  }
  try {
    const reflection = normalizeOptionalString(entry.reflection, 'reflection');
    const error = normalizeOptionalString(entry.error, 'error');
    if (entry.stage === 'completed' && !reflection) {
      return null;
    }
    if (entry.stage === 'failed' && !error) {
      return null;
    }
    return {
      id: entry.id.trim(),
      kind: 'process_log_entry',
      processId: normalizeRequiredString(entry.processId, 'processId'),
      processLabel: normalizeRequiredString(entry.processLabel, 'processLabel'),
      processType: 'reflection_deliberation',
      stage: entry.stage,
      executionSource: entry.executionSource,
      createdAt: normalizeCreatedAt(entry.createdAt, Date.now),
      ...(normalizeOptionalString(entry.templateId, 'templateId') ? { templateId: normalizeOptionalString(entry.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(entry.templateName, 'templateName') ? { templateName: normalizeOptionalString(entry.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(entry.channelId, 'channelId') ? { channelId: normalizeOptionalString(entry.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(entry.prompt, 'prompt') ? { prompt: normalizeOptionalString(entry.prompt, 'prompt') } : {}),
      ...(reflection ? { reflection } : {}),
      ...(error ? { error } : {}),
      ...(normalizeTags(entry.tags) ? { tags: normalizeTags(entry.tags) } : {}),
      ...(normalizeDeliberationMetadata(entry.deliberation) ? { deliberation: normalizeDeliberationMetadata(entry.deliberation) } : {}),
    };
  } catch {
    return null;
  }
}

function buildEntryId(prefix: string, now: () => number): string {
  return `${prefix}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function buildReflectionProcessId(processLabel: string, now: () => number = Date.now): string {
  const slug = sanitizeChannelId(normalizeRequiredString(processLabel, 'processLabel').toLowerCase());
  return `reflection-process-${slug}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function toReflectionJournalProvenanceRef(entry: Pick<
  ReflectionJournalEntry,
  'id' | 'templateId' | 'channelId' | 'mode' | 'createdAt'
>): string {
  return `reflection_journal:${entry.id}|template:${entry.templateId}|channel:${entry.channelId}|mode:${entry.mode}|createdAt:${entry.createdAt}`;
}

export function toReflectionDailyJournalProvenanceRef(entry: Pick<
  ReflectionDailyJournalEntry,
  'id' | 'templateId' | 'date' | 'executionSource' | 'createdAt'
>): string {
  return `reflection_daily:${entry.id}|template:${entry.templateId ?? 'unknown'}|date:${entry.date}|source:${entry.executionSource}|createdAt:${entry.createdAt}`;
}

export function toReflectionProcessLogProvenanceRef(entry: Pick<
  ReflectionProcessLogEntry,
  'id' | 'processId' | 'stage' | 'templateId' | 'createdAt'
>): string {
  return `reflection_process:${entry.id}|process:${entry.processId}|stage:${entry.stage}|template:${entry.templateId ?? 'unknown'}|createdAt:${entry.createdAt}`;
}

export function assembleReflectionSubstrateContext(input: {
  recentReflectionJournalEntries?: readonly ReflectionJournalEntry[];
  recentDailyJournalEntries?: readonly ReflectionDailyJournalEntry[];
  recentProcessLogEntries?: readonly ReflectionProcessLogEntry[];
}): ReflectionSubstrateContext | null {
  const recentReflectionJournalEntries = input.recentReflectionJournalEntries ?? [];
  const recentDailyJournalEntries = input.recentDailyJournalEntries ?? [];
  const recentProcessLogEntries = input.recentProcessLogEntries ?? [];

  if (
    recentReflectionJournalEntries.length === 0
    && recentDailyJournalEntries.length === 0
    && recentProcessLogEntries.length === 0
  ) {
    return null;
  }

  const sectionLines: Record<ReflectionContextSectionKey, string[]> = {
    self: [],
    relational: [],
    affect: [],
  };
  const provenanceRefs: string[] = [];

  if (recentReflectionJournalEntries.length > 0) {
    const linesBySection: Record<ReflectionContextSectionKey, string[]> = {
      self: [],
      relational: [],
      affect: [],
    };
    for (const entry of recentReflectionJournalEntries) {
      const provenanceRef = toReflectionJournalProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      linesBySection[classifyReflectionContextSection(entry.templateId)].push(
        `- ref=${provenanceRef} template=${entry.templateId} mode=${entry.mode} reflection=${truncateReflectionText(entry.reflection)}`,
      );
    }
    for (const [sectionKey, lines] of Object.entries(linesBySection) as Array<[ReflectionContextSectionKey, string[]]>) {
      if (lines.length > 0) {
        sectionLines[sectionKey].push('[Recent Reflection Journal]', ...lines);
      }
    }
  }

  if (recentDailyJournalEntries.length > 0) {
    const linesBySection: Record<ReflectionContextSectionKey, string[]> = {
      self: [],
      relational: [],
      affect: [],
    };
    for (const entry of recentDailyJournalEntries) {
      const provenanceRef = toReflectionDailyJournalProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      linesBySection[classifyReflectionContextSection(entry.templateId)].push(
        `- ref=${provenanceRef} date=${entry.date} template=${entry.templateId ?? 'unknown'} reflection=${truncateReflectionText(entry.reflection)}`,
      );
    }
    for (const [sectionKey, lines] of Object.entries(linesBySection) as Array<[ReflectionContextSectionKey, string[]]>) {
      if (lines.length > 0) {
        sectionLines[sectionKey].push('[Recent Lived-Day Journal]', ...lines);
      }
    }
  }

  if (recentProcessLogEntries.length > 0) {
    const linesBySection: Record<ReflectionContextSectionKey, string[]> = {
      self: [],
      relational: [],
      affect: [],
    };
    for (const entry of recentProcessLogEntries) {
      const provenanceRef = toReflectionProcessLogProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      const processSummary = entry.stage === 'failed'
        ? `error=${truncateReflectionText(entry.error ?? 'unknown failure')}`
        : `reflection=${truncateReflectionText(entry.reflection ?? 'none')}`;
      linesBySection[classifyReflectionContextSection(entry.templateId)].push(
        `- ref=${provenanceRef} process=${entry.processId} stage=${entry.stage} template=${entry.templateId ?? 'unknown'} ${processSummary}`,
      );
    }
    for (const [sectionKey, lines] of Object.entries(linesBySection) as Array<[ReflectionContextSectionKey, string[]]>) {
      if (lines.length > 0) {
        sectionLines[sectionKey].push('[Recent Long-Process Trace]', ...lines);
      }
    }
  }

  return {
    canonicalTruthBoundary: NON_CANONICAL_REFLECTION_SUBSTRATE,
    self: buildSubstrateSection('[Reflection Self Substrate]', sectionLines.self),
    relational: buildSubstrateSection('[Reflection Relational Substrate]', sectionLines.relational),
    affect: buildSubstrateSection('[Reflection Affect Substrate]', sectionLines.affect),
    provenanceRefs: [...new Set(provenanceRefs)],
  };
}

export class ReflectionDailyJournalStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, options: ReflectionSubstrateStoreOptions = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? Date.now;
  }

  append(input: ReflectionDailyJournalAppendInput): ReflectionDailyJournalEntry {
    const createdAt = normalizeCreatedAt(input.createdAt, this.now);
    const date = normalizeIsoDate(input.date ?? createdAt.slice(0, 10), 'date');
    const entry: ReflectionDailyJournalEntry = {
      id: buildEntryId('daily-reflection', this.now),
      kind: 'daily_journal_entry',
      source: input.source,
      executionSource: input.executionSource,
      reflection: normalizeRequiredString(input.reflection, 'reflection'),
      createdAt,
      date,
      ...(normalizeOptionalString(input.templateId, 'templateId') ? { templateId: normalizeOptionalString(input.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(input.templateName, 'templateName') ? { templateName: normalizeOptionalString(input.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(input.channelId, 'channelId') ? { channelId: normalizeOptionalString(input.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(input.prompt, 'prompt') ? { prompt: normalizeOptionalString(input.prompt, 'prompt') } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId')
        ? { reflectionJournalEntryId: normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId') }
        : {}),
      ...(normalizeOptionalString(input.processId, 'processId') ? { processId: normalizeOptionalString(input.processId, 'processId') } : {}),
      ...(normalizeTags(input.tags) ? { tags: normalizeTags(input.tags) } : {}),
    };

    appendJsonLine(join(this.rootDir, `${date}.jsonl`), entry);
    log.debug('Persisted reflection daily journal entry', {
      date,
      source: entry.source,
      executionSource: entry.executionSource,
    });
    return entry;
  }

  listRecent(options: ReflectionSubstrateListOptions = {}): ReflectionDailyJournalEntry[] {
    const limit = normalizePositiveInteger(options.limit, 'limit');
    const entries = sortEntriesByCreatedAtDescending(
      listJsonlFiles(this.rootDir)
        .flatMap(filePath => readJsonlEntries(
          filePath,
          normalizeDailyJournalEntry,
          'Skipping unreadable reflection daily journal line',
        )),
    );
    return limit === undefined ? entries : entries.slice(0, limit);
  }
}

export class ReflectionProcessLogStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, options: ReflectionSubstrateStoreOptions = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? Date.now;
  }

  append(input: ReflectionProcessLogAppendInput): ReflectionProcessLogEntry {
    const processId = normalizeRequiredString(input.processId, 'processId');
    const reflection = normalizeOptionalString(input.reflection, 'reflection');
    const error = normalizeOptionalString(input.error, 'error');
    if (input.stage === 'completed' && !reflection) {
      throw new Error('reflection is required when process stage is "completed"');
    }
    if (input.stage === 'failed' && !error) {
      throw new Error('error is required when process stage is "failed"');
    }

    const entry: ReflectionProcessLogEntry = {
      id: buildEntryId('reflection-process', this.now),
      kind: 'process_log_entry',
      processId,
      processLabel: normalizeRequiredString(input.processLabel, 'processLabel'),
      processType: input.processType,
      stage: input.stage,
      executionSource: input.executionSource,
      createdAt: normalizeCreatedAt(input.createdAt, this.now),
      ...(normalizeOptionalString(input.templateId, 'templateId') ? { templateId: normalizeOptionalString(input.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(input.templateName, 'templateName') ? { templateName: normalizeOptionalString(input.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(input.channelId, 'channelId') ? { channelId: normalizeOptionalString(input.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(input.prompt, 'prompt') ? { prompt: normalizeOptionalString(input.prompt, 'prompt') } : {}),
      ...(reflection ? { reflection } : {}),
      ...(error ? { error } : {}),
      ...(normalizeTags(input.tags) ? { tags: normalizeTags(input.tags) } : {}),
      ...(normalizeDeliberationMetadata(input.deliberation) ? { deliberation: normalizeDeliberationMetadata(input.deliberation) } : {}),
    };

    appendJsonLine(join(this.rootDir, `${sanitizeChannelId(processId)}.jsonl`), entry);
    log.debug('Persisted reflection process log entry', {
      processId,
      stage: entry.stage,
      processType: entry.processType,
    });
    return entry;
  }

  listRecent(options: ReflectionProcessLogListOptions = {}): ReflectionProcessLogEntry[] {
    const limit = normalizePositiveInteger(options.limit, 'limit');
    const requestedStages = options.stages ? new Set(options.stages) : null;
    const entries = sortEntriesByCreatedAtDescending(
      listJsonlFiles(this.rootDir)
        .flatMap(filePath => readJsonlEntries(
          filePath,
          normalizeProcessLogEntry,
          'Skipping unreadable reflection process log line',
        ))
        .filter(entry => requestedStages === null || requestedStages.has(entry.stage)),
    );
    return limit === undefined ? entries : entries.slice(0, limit);
  }
}
