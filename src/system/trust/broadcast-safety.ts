import { classifyChannelEnvelope, type ChannelMeta } from './policy.js';

export type BroadcastVisibilityScope = 'public_only' | 'approved_private_context';
export type BroadcastRiskSignal = 'sensitive' | 'private' | 'off_brand';

export interface BroadcastApprovalOptions {
  approvedTokens?: readonly string[];
}

export interface BroadcastClassification {
  risky: boolean;
  signals: BroadcastRiskSignal[];
  matches: Record<BroadcastRiskSignal, string[]>;
}

const DEFAULT_APPROVAL_PREFIX = 'approve:';
const MIN_APPROVAL_TOKEN_SUFFIX_LENGTH = 8;
const MAX_MATCHES_PER_SIGNAL = 3;

const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /\bself[-\s]?harm\b/i,
  /\bsuicid(?:e|al)\b/i,
  /\bdiagnos(?:is|e|ed)\b/i,
  /\bmedical\b/i,
  /\blegal advice\b/i,
  /\bpolitic(?:s|al)\b/i,
];

const PRIVATE_PATTERNS: readonly RegExp[] = [
  /\bconfidential\b/i,
  /\bprivate\b/i,
  /\boff the record\b/i,
  /\bbetween us\b/i,
  /\bdo not share\b/i,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /\b(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/,
];

const OFF_BRAND_PATTERNS: readonly RegExp[] = [
  /\bfuck(?:ing)?\b/i,
  /\bshut up\b/i,
  /\byou(?:'|’)re an idiot\b/i,
  /\byou are an idiot\b/i,
  /\bstupid\b/i,
  /\bhate you\b/i,
];

function normalizeTokens(rawTokens: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const token of rawTokens) {
    const normalized = token.trim();
    if (!normalized) continue;
    seen.add(normalized);
  }
  return [...seen];
}

function resolveDefaultApprovedTokens(): string[] {
  const combined = [
    process.env.BROADCAST_APPROVAL_TOKENS,
    process.env.BROADCAST_APPROVAL_TOKEN,
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join(',');

  if (!combined) return [];
  return normalizeTokens(combined.split(','));
}

function collectMatches(content: string, patterns: readonly RegExp[]): string[] {
  if (!content.trim()) return [];
  const matches: string[] = [];

  for (const pattern of patterns) {
    const found = content.match(pattern);
    if (!found || found.length === 0 || !found[0]) continue;
    const excerpt = found[0].trim();
    if (!excerpt || matches.includes(excerpt)) continue;
    matches.push(excerpt);
    if (matches.length >= MAX_MATCHES_PER_SIGNAL) break;
  }

  return matches;
}

export function classifyBroadcastDraft(content: string): BroadcastClassification {
  const normalized = content.trim();
  const matches: Record<BroadcastRiskSignal, string[]> = {
    sensitive: collectMatches(normalized, SENSITIVE_PATTERNS),
    private: collectMatches(normalized, PRIVATE_PATTERNS),
    off_brand: collectMatches(normalized, OFF_BRAND_PATTERNS),
  };

  const signals = (Object.keys(matches) as BroadcastRiskSignal[])
    .filter((signal) => matches[signal].length > 0);

  return {
    risky: signals.length > 0,
    signals,
    matches,
  };
}

export function isExplicitBroadcastApprovalToken(
  token: string | undefined,
  options: BroadcastApprovalOptions = {},
): boolean {
  const normalized = token?.trim();
  if (!normalized) return false;

  const approvedTokens = normalizeTokens(options.approvedTokens ?? resolveDefaultApprovedTokens());
  if (approvedTokens.length > 0) {
    return approvedTokens.includes(normalized);
  }

  if (!normalized.startsWith(DEFAULT_APPROVAL_PREFIX)) return false;
  const suffix = normalized.slice(DEFAULT_APPROVAL_PREFIX.length).trim();
  return suffix.length >= MIN_APPROVAL_TOKEN_SUFFIX_LENGTH;
}

export function resolveBroadcastVisibilityScope(
  channelId: string,
  meta?: ChannelMeta,
  options: BroadcastApprovalOptions = {},
): BroadcastVisibilityScope | null {
  if (!classifyChannelEnvelope(channelId, meta).broadcast) return null;
  return isExplicitBroadcastApprovalToken(meta?.broadcastApprovalToken, options)
    ? 'approved_private_context'
    : 'public_only';
}
