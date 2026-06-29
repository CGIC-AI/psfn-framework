import {
  isConcernTerminalStatus,
  type ActiveConcernEvidenceRef,
  type ActiveConcernPriority,
  type ActiveConcernVAD,
} from '../concerns.js';
import type { ConcernStorePort } from '../concern-store-port.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from './types.js';

const RECENT_RESOLVED_CONCERN_WINDOW_MS = 6 * 60 * 60 * 1_000;
const RECENT_RESOLVED_CONCERN_SNAPSHOT_LIMIT = 3;

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveConcernDecisionText(decision: IntentionActionDecision): string {
  if (decision.type !== 'concern') {
    throw new Error(`Expected concern decision, received "${decision.type}"`);
  }
  if (!decision.concern) {
    throw new Error('Concern decision is missing concern payload');
  }

  const title = normalizeOptionalText(decision.concern.title);
  const summary = normalizeOptionalText(decision.concern.summary);
  if (!title && !summary) {
    throw new Error('Concern decision must include title or summary');
  }
  if (title && summary) {
    return `${title}: ${summary}`;
  }
  return title ?? summary ?? '';
}

export function toActiveConcernSnapshot(
  concern: Awaited<ReturnType<ConcernStorePort['getActiveConcerns']>>[number],
): ActiveConcernSnapshot {
  const dueAtMs = Date.parse(concern.expiresAt);
  return {
    id: concern.id,
    title: concern.text,
    status: concern.status,
    ...(Number.isFinite(dueAtMs) ? { dueAt: dueAtMs } : {}),
    priority: concern.priority,
  };
}

export function toRecentlyResolvedConcernSnapshot(
  concern: Awaited<ReturnType<ConcernStorePort['listRecentlyResolvedConcerns']>>[number],
): ActiveConcernSnapshot {
  const resolvedAtMs = concern.resolvedAt ? Date.parse(concern.resolvedAt) : Number.NaN;
  return {
    id: concern.id,
    title: concern.text,
    status: concern.status,
    priority: concern.priority,
    ...(Number.isFinite(resolvedAtMs) ? { resolvedAt: resolvedAtMs } : {}),
    ...(concern.resolutionOutcome
      ? { summary: concern.resolutionOutcome }
      : { summary: 'Resolved recently.' }),
  };
}

export async function hasRecentlyResolvedSimilarConcern(input: {
  concernStore: ConcernStorePort;
  text: string;
  contactId?: string;
}): Promise<boolean> {
  const recentMatch = await input.concernStore.findRecentlyResolvedSimilarConcern({
    text: input.text,
    ...(input.contactId ? { contactId: input.contactId } : {}),
  });
  return recentMatch !== null;
}

export async function createConcernFromDecision(input: {
  concernStore: ConcernStorePort;
  decision: IntentionActionDecision;
  contactId?: string;
  expiresAt?: string;
  formationVAD?: ActiveConcernVAD;
  sourceMessageId?: string;
}): Promise<void> {
  const text = resolveConcernDecisionText(input.decision);
  const status = input.decision.concern?.status ?? 'active';
  if (isConcernTerminalStatus(status) && !input.decision.concern?.summary) {
    return;
  }
  const evidenceRefs: ActiveConcernEvidenceRef[] = input.sourceMessageId
    ? [{ kind: 'message', ref: input.sourceMessageId }]
    : [];
  await input.concernStore.create({
    text,
    priority: (input.decision.concern?.priority ?? input.decision.priority) as ActiveConcernPriority,
    source: 'appraisal',
    status,
    ...(input.contactId ? { contactId: input.contactId } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.formationVAD ? { formationVAD: input.formationVAD } : {}),
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  });
}

export async function getActiveConcernSnapshots(input: {
  concernStore: ConcernStorePort;
  contactId?: string;
}): Promise<readonly ActiveConcernSnapshot[]> {
  return (await input.concernStore.getActiveConcerns(input.contactId))
    .map(concern => toActiveConcernSnapshot(concern));
}

export async function getRecentlyResolvedConcernSnapshots(input: {
  concernStore: ConcernStorePort;
  contactId?: string;
}): Promise<readonly ActiveConcernSnapshot[]> {
  return (await input.concernStore.listRecentlyResolvedConcerns(input.contactId, {
    withinMs: RECENT_RESOLVED_CONCERN_WINDOW_MS,
    limit: RECENT_RESOLVED_CONCERN_SNAPSHOT_LIMIT,
  }))
    .map(concern => toRecentlyResolvedConcernSnapshot(concern));
}
