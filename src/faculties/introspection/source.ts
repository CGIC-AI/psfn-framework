import type { TurnRecord } from '../../shared/contracts/runtime.js';
import type { TurnRecordPageCursor } from '../../persistence/sessions/turn-record-store-port.js';
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
  readSourceTurnRecordPage(
    channelId: string,
    limit: number,
    cursor?: TurnRecordPageCursor,
  ): Promise<{
    records: TurnRecord[];
    nextCursor?: TurnRecordPageCursor;
    exhausted: boolean;
  }>;
  isSessionRetiredOrQuarantined(sessionId: string): boolean;
  isSourceTurnRecordEligible(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
  ): boolean | Promise<boolean>;
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
  let turnCursors = new Map<string, TurnRecordPageCursor>();

  const readSessionPage = (
    limit: number,
    currentOffset: number,
  ): { sessions: RecentSessionSummary[]; nextOffset: number } => {
    let pageOffset = currentOffset;
    let sessions = reader.listRecentSessions(limit, pageOffset);
    if (sessions.length === 0 && pageOffset > 0) {
      pageOffset = 0;
      sessions = reader.listRecentSessions(limit, pageOffset);
    }
    return {
      sessions,
      nextOffset: sessions.length < limit ? 0 : pageOffset + sessions.length,
    };
  };

  const readTurnPage = async (
    channelId: string,
    limit: number,
    stagedCursors: Map<string, TurnRecordPageCursor>,
  ): Promise<TurnRecord[]> => {
    const page = await reader.readSourceTurnRecordPage(
      channelId,
      limit,
      stagedCursors.get(channelId),
    );
    if (page.exhausted) {
      stagedCursors.delete(channelId);
    } else {
      if (!page.nextCursor) {
        throw new Error('TurnRecord page is not exhausted but supplied no continuation cursor');
      }
      stagedCursors.set(channelId, page.nextCursor);
    }
    return page.records;
  };

  const listCandidatesOnce: IntrospectionAuditSourcePort['listCandidates'] = async (input) => {
    const stagedTurnCursors = new Map(turnCursors);
    const sessionPage = readSessionPage(input.recentSessionLimit, sessionOffset);
    const allowed = new Set(input.allowedPublicChannelIds);
    const candidates: IntrospectionAuditCandidate[] = [];
    for (const session of sessionPage.sessions) {
      if (!allowed.has(session.sourceChannelId)) continue;
      for (
        const record of await readTurnPage(
          session.sourceChannelId,
          input.recentTurnLimit,
          stagedTurnCursors,
        )
      ) {
        if (!allowed.has(record.channelId) || record.channelId !== session.sourceChannelId) continue;
        const ownerSessionId = record.sessionId ?? session.sourceChannelId;
        if (reader.isSessionRetiredOrQuarantined(ownerSessionId)) continue;
        const candidate = toCandidate(record, ownerSessionId, input.maxSourceChars);
        if (candidate) candidates.push(candidate);
      }
    }
    const result = candidates
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
      .filter((candidate, index, all) => (
        all.findIndex(entry => entry.sourceRef === candidate.sourceRef) === index
      ));
    sessionOffset = sessionPage.nextOffset;
    turnCursors = stagedTurnCursors;
    return result;
  };

  // The source owns mutable cursor state. Preserve the old synchronous
  // one-at-a-time semantics when scheduler/admin callers overlap async reads.
  let pendingCandidateRead: Promise<void> = Promise.resolve();

  return {
    listCandidates: (input) => {
      const read = pendingCandidateRead.then(() => listCandidatesOnce(input));
      pendingCandidateRead = read.then(() => undefined, () => undefined);
      return read;
    },
    isCandidateStillEligible: async (candidate) => {
      if (reader.isSessionRetiredOrQuarantined(candidate.ownerSessionId)) return false;
      const eligible = await reader.isSourceTurnRecordEligible(
        candidate.channelId,
        candidate.ownerSessionId,
        candidate.turnId,
      );
      // The exact archive lookup yields. A reset/quarantine that lands during
      // it must invalidate the result before it crosses the audit boundary.
      return eligible && !reader.isSessionRetiredOrQuarantined(candidate.ownerSessionId);
    },
  };
}
