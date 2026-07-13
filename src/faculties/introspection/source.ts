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
  isSessionRetiredOrQuarantined(sessionId: string): boolean;
  isSourceTurnRecordEligible(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
  ): boolean;
}

function toCandidate(
  record: TurnRecord,
  ownerSessionId: string,
  maxSourceChars: number,
): IntrospectionAuditCandidate | null {
  if (
    record.status !== 'completed'
    || record.auditPrivacy?.contentMode !== 'verbatim_public'
    || record.auditPrivacy.channelPrivacy !== 'public'
    || record.auditPrivacy.contentSensitivity !== 'non_intimate'
    || record.auditPrivacy.contentSensitivityActor?.kind !== 'companion'
    || record.auditPrivacy.contentSensitivityActor.turnId !== record.turnId
    || record.auditPrivacy.contentSensitivityActor.requestId !== record.requestId
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
    ownerSessionId,
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
  let sessionOffset = 0;
  const turnOffsets = new Map<string, number>();

  const readSessionPage = (limit: number): RecentSessionSummary[] => {
    let sessions = reader.listRecentSessions(limit, sessionOffset);
    if (sessions.length === 0 && sessionOffset > 0) {
      sessionOffset = 0;
      sessions = reader.listRecentSessions(limit, sessionOffset);
    }
    sessionOffset = sessions.length < limit ? 0 : sessionOffset + sessions.length;
    return sessions;
  };

  const readTurnPage = (channelId: string, limit: number): TurnRecord[] => {
    let offset = turnOffsets.get(channelId) ?? 0;
    let records = reader.getRecentTurnRecords(channelId, limit, offset);
    if (records.length === 0 && offset > 0) {
      offset = 0;
      records = reader.getRecentTurnRecords(channelId, limit, offset);
    }
    turnOffsets.set(channelId, records.length < limit ? 0 : offset + records.length);
    return records;
  };

  return {
    listCandidates: (input) => {
      const allowed = new Set(input.allowedPublicChannelIds);
      const candidates: IntrospectionAuditCandidate[] = [];
      for (const session of readSessionPage(input.recentSessionLimit)) {
        if (!allowed.has(session.sourceChannelId)) continue;
        for (const record of readTurnPage(session.sourceChannelId, input.recentTurnLimit)) {
          if (!allowed.has(record.channelId) || record.channelId !== session.sourceChannelId) continue;
          const ownerSessionId = record.sessionId ?? session.sourceChannelId;
          if (reader.isSessionRetiredOrQuarantined(ownerSessionId)) continue;
          const candidate = toCandidate(record, ownerSessionId, input.maxSourceChars);
          if (candidate) candidates.push(candidate);
        }
      }
      return candidates
        .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
        .filter((candidate, index, all) => (
          all.findIndex(entry => entry.sourceRef === candidate.sourceRef) === index
        ));
    },
    isCandidateStillEligible: candidate => (
      !reader.isSessionRetiredOrQuarantined(candidate.ownerSessionId)
      && reader.isSourceTurnRecordEligible(
        candidate.channelId,
        candidate.ownerSessionId,
        candidate.turnId,
      )
    ),
  };
}
