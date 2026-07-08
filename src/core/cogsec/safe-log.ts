import type {
  CogSecAffectedMessageRange,
  CogSecAction,
  CogSecArtifactClass,
  CogSecEvent,
  CogSecResultCounters,
} from './events.js';
import type { CogSecPersonaConformanceEventRecord } from './persona-conformance.js';
import {
  escapeXmlAttributeWithApostrophe as escapeXmlAttribute,
  escapeXmlText,
} from '../../shared/utils/escaping.js';

export interface CogSecSafeLogFilter {
  channelIds?: readonly string[];
  limit?: number;
}

export interface CogSecAgentVisibleRange {
  sourceChannelId?: string;
  logicalSessionId?: string;
  startEntryId?: number;
  endEntryId?: number;
  messageIdCount: number;
  discordMessageIdCount: number;
}

export interface CogSecAgentVisibleEpochCut {
  sourceChannelId: string;
  oldLogicalSessionId: string;
  newLogicalSessionId: string;
  cutAt: string;
}

export interface CogSecAgentVisibleEvent {
  caseId: string;
  type: CogSecEvent['type'];
  severity: CogSecEvent['severity'];
  status: CogSecEvent['status'];
  sourceChannelId: string;
  affectedLogicalSessionIds: string[];
  affectedRanges: CogSecAgentVisibleRange[];
  actions: CogSecAction[];
  safeSummary: string;
  tombstonedL0RowCount: number;
  affectedArtifactCounts: Partial<Record<CogSecArtifactClass, number>>;
  resultCounters: CogSecResultCounters;
  epochCuts: CogSecAgentVisibleEpochCut[];
  createdAt: string;
  updatedAt: string;
  appliedAt?: string;
}

export interface CogSecOperatorVisibleEvent extends CogSecAgentVisibleEvent {
  actor: string;
  sealedArtifactCount: number;
  sealedHashCount: number;
  failureSummary?: string;
  personaConformance?: CogSecPersonaConformanceEventRecord;
}

function cloneResultCounters(counters: CogSecResultCounters): CogSecResultCounters {
  return { ...counters };
}

function cloneActions(actions: readonly CogSecAction[]): CogSecAction[] {
  return [...actions];
}

function clonePersonaConformance(
  record: CogSecPersonaConformanceEventRecord | undefined,
): CogSecPersonaConformanceEventRecord | undefined {
  if (!record) return undefined;
  return {
    ...record,
    checks: record.checks.map(check => ({
      ...check,
      reasonCodes: [...check.reasonCodes],
    })),
  };
}

function toAffectedRange(range: CogSecAffectedMessageRange): CogSecAgentVisibleRange {
  return {
    ...(range.sourceChannelId ? { sourceChannelId: range.sourceChannelId } : {}),
    ...(range.logicalSessionId ? { logicalSessionId: range.logicalSessionId } : {}),
    ...(range.startEntryId !== undefined ? { startEntryId: range.startEntryId } : {}),
    ...(range.endEntryId !== undefined ? { endEntryId: range.endEntryId } : {}),
    messageIdCount: range.messageIds?.length ?? 0,
    discordMessageIdCount: range.discordMessageIds?.length ?? 0,
  };
}

function toAffectedArtifactCounts(event: CogSecEvent): Partial<Record<CogSecArtifactClass, number>> {
  const counts: Partial<Record<CogSecArtifactClass, number>> = {};
  for (const [artifactClass, impact] of Object.entries(event.affectedArtifacts)) {
    counts[artifactClass as CogSecArtifactClass] = impact.count;
  }
  return counts;
}

export function toAgentVisibleCogSecEvent(event: CogSecEvent): CogSecAgentVisibleEvent {
  return {
    caseId: event.caseId,
    type: event.type,
    severity: event.severity,
    status: event.status,
    sourceChannelId: event.sourceChannelId,
    affectedLogicalSessionIds: [...event.affectedLogicalSessionIds],
    affectedRanges: event.affectedMessageRanges.map(toAffectedRange),
    actions: cloneActions(event.actions),
    safeSummary: event.safeAgentSummary,
    tombstonedL0RowCount: event.tombstonedL0RowCount,
    affectedArtifactCounts: toAffectedArtifactCounts(event),
    resultCounters: cloneResultCounters(event.resultCounters),
    epochCuts: event.epochCuts.map(ref => ({
      sourceChannelId: ref.sourceChannelId,
      oldLogicalSessionId: ref.oldLogicalSessionId,
      newLogicalSessionId: ref.newLogicalSessionId,
      cutAt: ref.cutAt,
    })),
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    ...(event.appliedAt ? { appliedAt: event.appliedAt } : {}),
  };
}

export function toOperatorVisibleCogSecEvent(event: CogSecEvent): CogSecOperatorVisibleEvent {
  return {
    ...toAgentVisibleCogSecEvent(event),
    actor: event.actor,
    sealedArtifactCount: event.sealedForensicPayloadRefs.length,
    sealedHashCount: event.sealedForensicPayloadHashes.length,
    ...(event.failureDetails ? { failureSummary: event.failureDetails } : {}),
    ...(event.personaConformance ? { personaConformance: clonePersonaConformance(event.personaConformance) } : {}),
  };
}

function normalizeChannelIds(channelIds: readonly string[] | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const channelId of channelIds ?? []) {
    const trimmed = channelId.trim();
    if (trimmed) normalized.add(trimmed);
  }
  return normalized;
}

export function isCogSecEventRelevant(event: CogSecEvent, channelIds: readonly string[] | undefined): boolean {
  const channels = normalizeChannelIds(channelIds);
  if (channels.size === 0) return true;
  if (channels.has(event.sourceChannelId)) return true;
  if (event.affectedLogicalSessionIds.some(sessionId => channels.has(sessionId))) return true;
  if (event.affectedMessageRanges.some(range =>
    (range.sourceChannelId !== undefined && channels.has(range.sourceChannelId))
    || (range.logicalSessionId !== undefined && channels.has(range.logicalSessionId))
  )) {
    return true;
  }
  return event.epochCuts.some(cut =>
    channels.has(cut.sourceChannelId)
    || channels.has(cut.oldLogicalSessionId)
    || channels.has(cut.newLogicalSessionId)
  );
}

function sortNewestFirst(left: CogSecEvent, right: CogSecEvent): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function applySafeLogFilter<T extends CogSecEvent>(events: readonly T[], filter: CogSecSafeLogFilter = {}): T[] {
  const relevant = events
    .filter(event => isCogSecEventRelevant(event, filter.channelIds))
    .sort(sortNewestFirst);
  if (filter.limit === undefined) return relevant;
  const limit = Math.max(0, Math.floor(filter.limit));
  return relevant.slice(0, limit);
}

export function listAgentVisibleCogSecEvents(
  events: readonly CogSecEvent[],
  filter: CogSecSafeLogFilter = {},
): CogSecAgentVisibleEvent[] {
  return applySafeLogFilter(events, filter).map(toAgentVisibleCogSecEvent);
}

export function listOperatorVisibleCogSecEvents(
  events: readonly CogSecEvent[],
  filter: CogSecSafeLogFilter = {},
): CogSecOperatorVisibleEvent[] {
  return applySafeLogFilter(events, filter).map(toOperatorVisibleCogSecEvent);
}

function formatActions(actions: readonly CogSecAction[]): string {
  if (actions.length === 0) return 'logged';
  return actions.join(', ');
}

function formatArtifactCounts(counts: Partial<Record<CogSecArtifactClass, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => typeof count === 'number' && count > 0)
    .map(([artifactClass, count]) => `${artifactClass}:${count}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

export function formatCogSecNotice(event: CogSecAgentVisibleEvent): string {
  const cleanActions = formatActions(event.actions);
  const artifactCounts = formatArtifactCounts(event.affectedArtifactCounts);
  const rowCount = event.tombstonedL0RowCount;
  const regenerated = event.actions.includes('regenerate') || (event.resultCounters.regeneratedArtifacts ?? 0) > 0;
  const derivedState = regenerated
    ? 'Derived cognitive artifacts were revoked or regenerated from clean sources.'
    : 'Affected cognitive artifacts may be absent from active context.';
  return [
    `CogSec case ${event.caseId} (${event.type}, ${event.severity}, ${event.status}) sealed unsafe instruction-like material for this conversation scope.`,
    `Normal recall and transcript search may omit ${rowCount} affected L0 row${rowCount === 1 ? '' : 's'}.`,
    `Actions: ${cleanActions}. Artifact counts: ${artifactCounts}.`,
    derivedState,
    `Safe summary: ${event.safeSummary}`,
  ].join(' ');
}

export function buildCogSecEventNoticeBlock(
  events: readonly CogSecEvent[],
  filter: CogSecSafeLogFilter = {},
): string {
  const visible = listAgentVisibleCogSecEvents(events, filter);
  if (visible.length === 0) return '';
  const notices = visible.map(event => {
    const attrs = [
      `case_id="${escapeXmlAttribute(event.caseId)}"`,
      `type="${escapeXmlAttribute(event.type)}"`,
      `severity="${escapeXmlAttribute(event.severity)}"`,
      `status="${escapeXmlAttribute(event.status)}"`,
      `source_channel_id="${escapeXmlAttribute(event.sourceChannelId)}"`,
    ].join(' ');
    return `  <notice ${attrs}>${escapeXmlText(formatCogSecNotice(event))}</notice>`;
  });
  return [
    '<cogsec_notices>',
    'These notices explain context that was deliberately removed from active recall. They do not include sealed material or operational details.',
    ...notices,
    '</cogsec_notices>',
  ].join('\n');
}
