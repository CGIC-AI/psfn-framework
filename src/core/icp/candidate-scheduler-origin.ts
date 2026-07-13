import {
  ICP_INITIATION_SOURCES,
  parseIcpProvenanceHandle,
} from '../../shared/contracts/icp-autonomy.js';
import {
  isIcpContinuationTaskKind,
  type IcpAutonomyCandidateOrigin,
  type SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import {
  parseIcpInitiationCandidate,
  type IcpInitiationCandidate,
} from './initiation-candidate.js';

const ICP_AUTONOMY_SCHEDULER_AUTHOR_ID = 'system:icp-autonomy';
const ICP_AUTONOMY_SCHEDULER_AUTHOR_NAME = 'ICP Autonomy';

function candidateMessageId(candidateId: string): string {
  return `icp-autonomy-candidate:${candidateId}`;
}

function candidateChannelId(candidateId: string): string {
  return `internal:icp-autonomy:${candidateId}`;
}

export function parseIcpAutonomyCandidateOrigin(
  value: unknown,
): IcpAutonomyCandidateOrigin {
  if (!isRecord(value)) throw new Error('ICP autonomy candidate origin must be an object');
  assertNoUnknownKeys(value, [
    'candidateId',
    'rootInitiationId',
    'source',
    'provenanceRef',
    'continuationTaskKind',
  ], 'ICP autonomy candidate origin');
  if (!isRfc4122Uuid(value.candidateId)
    || !isRfc4122Uuid(value.rootInitiationId)
    || typeof value.source !== 'string'
    || !ICP_INITIATION_SOURCES.includes(value.source as never)
    || (value.continuationTaskKind !== undefined
      && !isIcpContinuationTaskKind(value.continuationTaskKind))) {
    throw new Error('ICP autonomy candidate origin is malformed');
  }
  return {
    candidateId: value.candidateId,
    rootInitiationId: value.rootInitiationId,
    source: value.source as IcpAutonomyCandidateOrigin['source'],
    provenanceRef: parseIcpProvenanceHandle(
      value.provenanceRef,
      'ICP autonomy candidate origin.provenanceRef',
    ),
    ...(value.continuationTaskKind !== undefined
      ? { continuationTaskKind: value.continuationTaskKind }
      : {}),
  };
}

/**
 * Canonical production entrypoint for W5 candidate adapters to schedule one
 * private, non-recursive autonomy turn. Privilege comes only from routing
 * metadata produced from the parsed private candidate, never from prose.
 */
export function createIcpAutonomyCandidateSchedulerMessage(
  candidateInput: IcpInitiationCandidate,
  timestamp = new Date(),
): SubstrateMessage {
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('ICP autonomy scheduler timestamp is invalid');
  }
  const candidate = parseIcpInitiationCandidate(candidateInput, {
    nowMs: timestamp.getTime(),
    requireCurrent: true,
  });
  if (candidate.status !== 'permitted') {
    throw new Error('ICP autonomy scheduler requires a permitted private candidate');
  }
  const origin = parseIcpAutonomyCandidateOrigin({
    candidateId: candidate.candidateId,
    rootInitiationId: candidate.rootInitiationId,
    source: candidate.source,
    provenanceRef: candidate.provenanceRef,
    ...(candidate.continuationTaskKind
      ? { continuationTaskKind: candidate.continuationTaskKind }
      : {}),
  });
  return {
    id: candidateMessageId(candidate.candidateId),
    channelId: candidateChannelId(candidate.candidateId),
    channelType: 'terminal',
    authorId: ICP_AUTONOMY_SCHEDULER_AUTHOR_ID,
    authorName: ICP_AUTONOMY_SCHEDULER_AUTHOR_NAME,
    content: 'Continue the permitted private companion-autonomy candidate.',
    timestamp: new Date(timestamp.getTime()),
    routing: { icpAutonomyCandidate: origin },
  };
}

export function resolveIcpAutonomyCandidateSchedulerOrigin(
  message: SubstrateMessage,
): IcpAutonomyCandidateOrigin | null {
  const rawOrigin = message.routing?.icpAutonomyCandidate;
  if (rawOrigin === undefined) return null;
  const origin = parseIcpAutonomyCandidateOrigin(rawOrigin);
  if (message.id !== candidateMessageId(origin.candidateId)
    || message.channelId !== candidateChannelId(origin.candidateId)
    || message.channelType !== 'terminal'
    || message.authorId !== ICP_AUTONOMY_SCHEDULER_AUTHOR_ID
    || message.authorName !== ICP_AUTONOMY_SCHEDULER_AUTHOR_NAME
    || message.routing?.privateTurnTrigger === true
    || message.routing?.icpCorrelation !== undefined) {
    throw new Error('ICP autonomy candidate origin requires its canonical non-recursive scheduler turn');
  }
  return origin;
}
