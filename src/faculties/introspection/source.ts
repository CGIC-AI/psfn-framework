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
  listRecentSessions(limit?: number, offset?: number): RecentSessionSummary[];
  getRecentTurnRecords(channelId: string, limit: number, offset?: number): TurnRecord[];
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
      for (let sessionOffset = 0; ; sessionOffset += input.recentSessionLimit) {
        const sessions = reader.listRecentSessions(input.recentSessionLimit, sessionOffset);
        if (sessions.length === 0) break;
        for (const session of sessions) {
          if (!allowed.has(session.sourceChannelId)) continue;
          for (let turnOffset = 0; ; turnOffset += input.recentTurnLimit) {
            const records = reader.getRecentTurnRecords(
              session.sourceChannelId,
              input.recentTurnLimit,
              turnOffset,
            );
            if (records.length === 0) break;
            for (const record of records) {
              if (!allowed.has(record.channelId) || record.channelId !== session.sourceChannelId) continue;
              const candidate = toCandidate(record, input.maxSourceChars);
              if (candidate) candidates.push(candidate);
            }
            if (records.length < input.recentTurnLimit) break;
          }
        }
        if (sessions.length < input.recentSessionLimit) break;
      }
      return candidates
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
        .filter((candidate, index, all) => (
          all.findIndex(entry => entry.sourceRef === candidate.sourceRef) === index
        ));
    },
  };
}
