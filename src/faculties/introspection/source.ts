import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type {
  IntrospectionAuditCandidate,
  IntrospectionAuditSourcePort,
} from './contracts.js';

interface RecentSessionSummary {
  sessionId: string;
  sourceChannelId: string;
}

export interface IntrospectionTurnRecordReader {
  listRecentSessions(limit?: number): RecentSessionSummary[];
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[];
}

function toCandidate(record: TurnRecord, maxSourceChars: number): IntrospectionAuditCandidate | null {
  if (
    record.status !== 'completed'
    || record.auditPrivacy?.contentMode !== 'verbatim_public'
    || record.auditPrivacy.channelPrivacy !== 'public'
    || record.auditPrivacy.contentSensitivity !== 'non_intimate'
    || record.auditPrivacy.reason !== 'explicit_public_non_dm'
    || record.userMessage.role !== 'user'
    || !record.assistantMessage
    || record.assistantMessage.role !== 'assistant'
  ) {
    return null;
  }
  const publicStimulus = record.userMessage.content.trim();
  const actualReply = record.assistantMessage.content.trim();
  if (
    publicStimulus.length === 0
    || actualReply.length === 0
    || publicStimulus.length + actualReply.length > maxSourceChars
  ) {
    return null;
  }
  return {
    sourceRef: `turn:${record.turnId}`,
    turnId: record.turnId,
    channelId: record.channelId,
    occurredAt: new Date(record.completedAt).toISOString(),
    publicStimulus,
    actualReply,
    provenanceRefs: [...new Set([
      `turn:${record.turnId}`,
      `request:${record.requestId}`,
      ...(record.sessionId ? [`session:${record.sessionId}`] : []),
      ...record.provenanceRefs,
    ])],
  };
}

export function createTurnRecordIntrospectionSource(
  reader: IntrospectionTurnRecordReader,
): IntrospectionAuditSourcePort {
  return {
    listCandidates: (input) => {
      const allowed = new Set(input.allowedPublicChannelIds);
      const candidates: IntrospectionAuditCandidate[] = [];
      for (const session of reader.listRecentSessions(input.recentSessionLimit)) {
        if (!allowed.has(session.sourceChannelId)) continue;
        for (const record of reader.getRecentTurnRecords(session.sourceChannelId, input.recentTurnLimit)) {
          if (!allowed.has(record.channelId) || record.channelId !== session.sourceChannelId) continue;
          const candidate = toCandidate(record, input.maxSourceChars);
          if (candidate) candidates.push(candidate);
        }
      }
      return candidates
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
        .filter((candidate, index, all) => (
          all.findIndex(entry => entry.sourceRef === candidate.sourceRef) === index
        ));
    },
  };
}
