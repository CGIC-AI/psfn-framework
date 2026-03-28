import type { SubstrateConfig, TurnID } from '../types.js';
import type { SessionRoleEnvelopePreview } from '../internal-role-envelopes/projections.js';
import { countTokens } from '../llm/tokens.js';
import { SESSION_HISTORY_MIN_MESSAGES } from '../shared/context-budget.js';
import type { ChannelVisibility, TrustLevel } from '../trust/types.js';
import type { ChannelMeta } from '../trust/policy.js';
import { COMPACTION_REFUSAL_PATTERNS, matchesRefusalPatterns } from '../system/security/refusal-patterns.js';
import type { SessionEntry } from './types.js';

/** Default number of cross-channel continuity messages to include in context. */
export const DEFAULT_CONTINUITY_CONTEXT_LIMIT = 10;

/**
 * Resolve a display name for a message role.
 * Maps 'assistant' to the configured character name and 'user' to the configured user name.
 * The actual message role field (sent to LLMs) is never changed — this is purely for display.
 */
export function resolveRoleName(
  role: string,
  config: { charName?: string; userName?: string },
): string {
  if (role === 'assistant') return config.charName?.trim() || 'Assistant';
  if (role === 'user') return config.userName?.trim() || 'User';
  return role;
}
export const DEFAULT_SESSION_MIRROR_MAX_CHARS = 220;
export const DEFAULT_SESSION_MIRROR_ACTIVE_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_IMPORT_BOOTSTRAP_MAX_TOKENS = 50_000;
const MIN_IMPORT_BOOTSTRAP_MAX_TOKENS = 1;

type CompactionPreservedTag = 'refusal' | 'boundary' | 'emotional';

interface TaggedCompactionEntry {
  tag: CompactionPreservedTag;
  messageId: number;
  speaker: string;
  content: string;
  emotionalWeight?: number;
}

interface EmotionalPatternWeight {
  pattern: RegExp;
  weight: number;
}

const BOUNDARY_PATTERNS = [
  /\bboundar(?:y|ies)\b/i,
  /\b(not comfortable|too personal|too private)\b/i,
  /\bplease\s+(do not|don't)\b/i,
  /\blet'?s\s+keep\b/i,
  /\bi(?:'m| am)\s+not\s+going\s+to\b/i,
];

const STRONG_EMOTIONAL_PATTERNS: EmotionalPatternWeight[] = [
  { pattern: /\b(i|we)\s+(love|adore|need|miss)\s+you\b/i, weight: 0.95 },
  {
    pattern: /\b(i|we)\s+(am|are|'m|feel|felt)(?:\s+\w+){0,3}\s+(heartbroken|devastated|terrified|grieving|betrayed|overwhelmed)\b/i,
    weight: 0.9,
  },
  { pattern: /\b(thank\s+you\s+for\s+being\s+here|you\s+mean\s+so\s+much\s+to\s+me)\b/i, weight: 0.82 },
];

const MODERATE_EMOTIONAL_PATTERNS: EmotionalPatternWeight[] = [
  {
    pattern: /\b(i|we)\s+(am|are|'m|feel|felt)(?:\s+\w+){0,3}\s+(sad|happy|afraid|scared|anxious|lonely|angry|grateful|thankful|relieved|ashamed|hurt)\b/i,
    weight: 0.58,
  },
  { pattern: /\b(i|we)\s+(need|needed)\s+support\b/i, weight: 0.55 },
  { pattern: /\b(this|that)\s+(hurt|matters|mattered)\s+to\s+me\b/i, weight: 0.52 },
];

const EMOTIONAL_KEYWORDS = new Set([
  'love',
  'adore',
  'heartbroken',
  'devastated',
  'grief',
  'grieving',
  'sad',
  'happy',
  'afraid',
  'scared',
  'anxious',
  'lonely',
  'angry',
  'thankful',
  'grateful',
  'hurt',
  'betrayed',
  'overwhelmed',
  'crying',
  'tears',
]);

const DEFAULT_EMOTIONAL_SALIENCE_THRESHOLD_PCT = 75;
const MAX_PRESERVED_SAFETY_TAGS = 8;
const MAX_PRESERVED_EMOTIONAL_ENTRIES = 6;
const MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS = 240;

export interface SessionMessageRecordOptions {
  trustLevel?: TrustLevel;
  mirror?: boolean;
  turnId?: TurnID;
  requestId?: string;
  sourceMessageId?: string;
  metadata?: string;
  roleEnvelopePreview?: SessionRoleEnvelopePreview;
  channelMeta?: ChannelMeta;
}

export interface MirrorEntryMetadata {
  type: 'mirror';
  sourceChannelId: string;
  sourceRole: 'user' | 'assistant';
  sourceAuthorName?: string;
  sourceVisibility: ChannelVisibility;
  trustLevel: TrustLevel;
  mirroredAt: number;
  truncated: boolean;
}

export interface RecentEntryStoreLike {
  getRecent(channelId: string, limit: number): SessionEntry[];
}

export interface BudgetedRecentEntries {
  entries: SessionEntry[];
  sourceCount: number;
}

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
}

interface RetryCallbacks {
  onRetry?: (params: { attempt: number; delayMs: number; error: Error }) => Promise<void> | void;
}

export async function withRetry<T>(
  task: () => Promise<T>,
  config: RetryConfig,
  callbacks?: RetryCallbacks,
): Promise<T> {
  const maxRetries = Math.max(0, config.maxRetries);
  const baseDelayMs = Math.max(0, config.baseDelayMs);

  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= maxRetries) throw error;

      const err = error instanceof Error ? error : new Error(String(error));
      const retryAttempt = attempt + 1;
      const delayMs = baseDelayMs * (2 ** attempt);
      await callbacks?.onRetry?.({
        attempt: retryAttempt,
        delayMs,
        error: err,
      });

      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
}

export function trimRecentEntriesToTokenBudget(entries: SessionEntry[], tokenBudget: number): SessionEntry[] {
  if (entries.length === 0) return [];
  if (tokenBudget <= 0) {
    return entries.slice(-SESSION_HISTORY_MIN_MESSAGES);
  }

  let usedTokens = 0;
  const selected: SessionEntry[] = [];

  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    const entryTokens = Math.max(1, countTokens(entry.content));
    if (selected.length >= SESSION_HISTORY_MIN_MESSAGES && usedTokens + entryTokens > tokenBudget) {
      break;
    }
    selected.push(entry);
    usedTokens += entryTokens;
  }

  return selected.reverse();
}

export function collectRecentEntriesWithinTokenBudget(params: {
  store: RecentEntryStoreLike;
  channelId: string;
  estimatedCount: number;
  tokenBudget: number;
}): BudgetedRecentEntries {
  let limit = Math.max(SESSION_HISTORY_MIN_MESSAGES, Math.floor(params.estimatedCount));
  let previousFetchedCount = -1;

  for (;;) {
    const recent = params.store.getRecent(params.channelId, limit);
    const trimmed = trimRecentEntriesToTokenBudget(recent, params.tokenBudget);
    if (recent.length < limit || trimmed.length < recent.length || recent.length === previousFetchedCount) {
      return {
        entries: trimmed,
        sourceCount: recent.length,
      };
    }

    previousFetchedCount = recent.length;
    limit = Math.max(limit + 1, limit * 2);
  }
}

export function normalizeImportBootstrapMaxTokens(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_IMPORT_BOOTSTRAP_MAX_TOKENS;
  }
  return Math.max(MIN_IMPORT_BOOTSTRAP_MAX_TOKENS, Math.floor(value));
}

function classifyCompactionTag(content: string): CompactionPreservedTag | null {
  if (!content) return null;
  if (matchesRefusalPatterns(content, COMPACTION_REFUSAL_PATTERNS)) return 'refusal';
  if (BOUNDARY_PATTERNS.some(pattern => pattern.test(content))) return 'boundary';
  return null;
}

function normalizeTaggedContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_PRESERVED_SAFETY_TAG_CONTENT_CHARS - 3)}...`;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function resolveEmotionalSalienceThreshold(config: SubstrateConfig): number {
  const thresholdPct = config.compactionEmotionalSalienceThresholdPct
    ?? DEFAULT_EMOTIONAL_SALIENCE_THRESHOLD_PCT;
  return clampUnit(thresholdPct / 100);
}

function applyWeightedPatterns(content: string, patterns: EmotionalPatternWeight[]): number {
  let score = 0;
  for (const candidate of patterns) {
    if (candidate.pattern.test(content)) score += candidate.weight;
  }
  return score;
}

function scoreEmotionalSalience(content: string): number {
  const normalized = content.toLowerCase().trim();
  if (!normalized) return 0;

  let score = 0;
  score += applyWeightedPatterns(normalized, STRONG_EMOTIONAL_PATTERNS);
  score += applyWeightedPatterns(normalized, MODERATE_EMOTIONAL_PATTERNS);

  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 1);
  const keywordHits = tokens.reduce(
    (count, token) => count + (EMOTIONAL_KEYWORDS.has(token) ? 1 : 0),
    0,
  );
  if (keywordHits > 0) {
    score += Math.min(0.36, keywordHits * 0.12);
  }

  if (/[!?]{2,}/.test(content)) {
    score += 0.08;
  }
  if (/\b(very|really|so|extremely|deeply)\b/.test(normalized) && keywordHits > 0) {
    score += 0.08;
  }
  if (/\b(i|we)\s+(am|are|'m|feel|felt)\b/.test(normalized) && keywordHits > 0) {
    score += 0.12;
  }

  return clampUnit(score);
}

function scanCompactionSafetyEntries(entries: SessionEntry[]): TaggedCompactionEntry[] {
  const preserved: TaggedCompactionEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.role === 'user' || entry.role === 'tool') continue;

    const normalizedContent = normalizeTaggedContent(entry.content);
    if (!normalizedContent) continue;

    const tag = classifyCompactionTag(normalizedContent);
    if (!tag) continue;

    const dedupeKey = `${tag}:${normalizedContent.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    preserved.push({
      tag,
      messageId: entry.id,
      speaker: entry.authorName ?? entry.role,
      content: normalizedContent,
    });
  }

  return preserved.slice(-MAX_PRESERVED_SAFETY_TAGS);
}

function scanCompactionEmotionalEntries(
  entries: SessionEntry[],
  emotionalThreshold: number,
): TaggedCompactionEntry[] {
  const threshold = clampUnit(emotionalThreshold);
  const candidates: TaggedCompactionEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (entry.role === 'tool') continue;
    const verbatimContent = entry.content.trim();
    if (!verbatimContent) continue;

    const emotionalWeight = scoreEmotionalSalience(verbatimContent);
    if (emotionalWeight < threshold) continue;

    const dedupeKey = `${entry.role}:${verbatimContent.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      tag: 'emotional',
      messageId: entry.id,
      speaker: entry.authorName ?? entry.role,
      content: verbatimContent,
      emotionalWeight,
    });
  }

  const selected = candidates
    .sort((left, right) => {
      const weightDelta = (right.emotionalWeight ?? 0) - (left.emotionalWeight ?? 0);
      if (weightDelta !== 0) return weightDelta;
      return right.messageId - left.messageId;
    })
    .slice(0, MAX_PRESERVED_EMOTIONAL_ENTRIES);

  selected.sort((left, right) => left.messageId - right.messageId);
  return selected;
}

function escapeTaggedValue(content: string): string {
  return content
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function buildCompactionPreservedTagBlock(
  entries: SessionEntry[],
  emotionalThreshold: number,
): string {
  const preserved = [
    ...scanCompactionSafetyEntries(entries),
    ...scanCompactionEmotionalEntries(entries, emotionalThreshold),
  ];

  if (preserved.length === 0) return '';

  const taggedLines = preserved.map((entry) => {
    const salienceScoreAttr = entry.tag === 'emotional' && entry.emotionalWeight !== undefined
      ? ` salience_score="${entry.emotionalWeight.toFixed(2)}"`
      : '';
    return (
      `<${entry.tag} message_id="${entry.messageId}" speaker="${escapeTaggedValue(entry.speaker)}"${salienceScoreAttr}>`
      + `${escapeTaggedValue(entry.content)}</${entry.tag}>`
    );
  });

  return ['[Preserved refusal, boundary, and emotional entries]', ...taggedLines].join('\n');
}

export function appendCompactionMetadataBlocks(summary: string, blocks: string[]): string {
  const trimmedSummary = summary.trim();
  const normalizedBlocks = blocks
    .map(block => block.trim())
    .filter(block => block.length > 0);
  if (normalizedBlocks.length === 0) return trimmedSummary;
  if (!trimmedSummary) return normalizedBlocks.join('\n\n');
  return `${trimmedSummary}\n\n${normalizedBlocks.join('\n\n')}`;
}

export function parseChannelVisibility(value?: string): ChannelVisibility | undefined {
  switch (value) {
    case 'private':
    case 'semi_private':
    case 'public':
    case 'broadcast':
      return value;
    default:
      return undefined;
  }
}

export function isUntrustedVisibility(visibility: ChannelVisibility): boolean {
  return visibility === 'public' || visibility === 'broadcast';
}

export function wrapUntrustedContext(content: string, source: 'public' = 'public'): string {
  return `<untrusted_context source="${source}">\n${content}\n</untrusted_context>`;
}

export function normalizeMirrorText(content: string, maxChars: number): { text: string; truncated: boolean } {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (!normalized) return { text: '', truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  return { text: `${normalized.slice(0, Math.max(1, maxChars - 3))}...`, truncated: true };
}

export function parseMirrorMetadata(value?: string): MirrorEntryMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MirrorEntryMetadata>;
    if (parsed.type !== 'mirror') return null;
    if (parsed.sourceRole !== 'user' && parsed.sourceRole !== 'assistant') return null;
    if (
      parsed.sourceVisibility !== 'private'
      && parsed.sourceVisibility !== 'semi_private'
      && parsed.sourceVisibility !== 'public'
      && parsed.sourceVisibility !== 'broadcast'
    ) {
      return null;
    }
    if (
      parsed.trustLevel !== 'primary'
      && parsed.trustLevel !== 'trusted'
      && parsed.trustLevel !== 'regular'
      && parsed.trustLevel !== 'public'
    ) {
      return null;
    }
    if (typeof parsed.sourceChannelId !== 'string' || !parsed.sourceChannelId.trim()) return null;
    if (typeof parsed.mirroredAt !== 'number' || !Number.isFinite(parsed.mirroredAt)) return null;

    return {
      type: 'mirror',
      sourceChannelId: parsed.sourceChannelId,
      sourceRole: parsed.sourceRole,
      sourceAuthorName: typeof parsed.sourceAuthorName === 'string' ? parsed.sourceAuthorName : undefined,
      sourceVisibility: parsed.sourceVisibility,
      trustLevel: parsed.trustLevel,
      mirroredAt: parsed.mirroredAt,
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}
