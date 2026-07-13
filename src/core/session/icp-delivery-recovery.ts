import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../shared/contracts/icp-autonomy.js';
import type { AgentResponse, Attachment } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { parseIcpRecoveryResponseMetadata } from './icp-recovery-response-metadata.js';

const OBSERVATION_KEYS = new Set([
  'schemaVersion',
  'kind',
  'channelId',
  'sourceMessageId',
  'status',
  'gatewayMessageId',
  'deliveredTo',
  'permitOutcome',
  'error',
  'recoveryResponse',
  'turnCompleted',
]);

const RESPONSE_KEYS = new Set(['content', 'channelId', 'attachments', 'metadata']);
const ATTACHMENT_KEYS = new Set([
  'url',
  'contentType',
  'name',
  'localPath',
  'dataBase64',
  'parsedTextPath',
]);

export interface IcpDeliveryObservation {
  channelId: string;
  sourceMessageId: string;
  status: 'prepared' | 'delivered' | 'failed' | 'suppressed';
  gatewayMessageId?: string;
  deliveredTo?: readonly string[];
  permitOutcome?: 'consumed' | 'replayed';
  error?: string;
  recoveryResponse?: AgentResponse;
  turnCompleted?: true;
}

/** Durable recipient-side source envelope used to bind restart replay. */
export interface RecordedCompanionSourceMessage {
  channelId: string;
  sourceMessageId: string;
  content: string;
  authorId: string;
  authorName: string;
  timestampMs: number;
  correlation?: IcpConversationCorrelation;
}

export function assertIcpRecoveryStatusBinding(
  status: IcpDeliveryObservation['status'] | undefined,
  response: AgentResponse,
  label: string,
): void {
  const correlation = parseIcpConversationCorrelation(response.metadata.icpCorrelation);
  if (status === 'suppressed'
    && (response.content.trim().length > 0 || (response.attachments?.length ?? 0) > 0)) {
    throw new Error(`${label} suppressed recovery contains a deliverable response`);
  }
  if (status === 'delivered' && response.content.trim().length === 0) {
    throw new Error(`${label} delivered recovery is missing transport content`);
  }
  if (status !== undefined
    && correlation.fatigueDecision === 'suppress'
    && status !== 'suppressed') {
    throw new Error(`${label} status does not match its fatigue decision`);
  }
}

function sameCorrelation(
  left: IcpConversationCorrelation,
  right: IcpConversationCorrelation,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseRecoveryAttachments(value: unknown, label: string): Attachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((attachment, index) => {
    if (!isRecord(attachment)
      || typeof attachment.url !== 'string'
      || typeof attachment.contentType !== 'string'
      || typeof attachment.name !== 'string'
      || (attachment.localPath !== undefined && typeof attachment.localPath !== 'string')
      || (attachment.dataBase64 !== undefined && typeof attachment.dataBase64 !== 'string')
      || (attachment.parsedTextPath !== undefined && typeof attachment.parsedTextPath !== 'string')) {
      throw new Error(`${label}[${index}] is malformed`);
    }
    const unknownKeys = Object.keys(attachment).filter(key => !ATTACHMENT_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`${label}[${index}] contains unknown fields: ${unknownKeys.join(', ')}`);
    }
    return {
      url: attachment.url,
      contentType: attachment.contentType,
      name: attachment.name,
      ...(typeof attachment.localPath === 'string' ? { localPath: attachment.localPath } : {}),
      ...(typeof attachment.dataBase64 === 'string' ? { dataBase64: attachment.dataBase64 } : {}),
      ...(typeof attachment.parsedTextPath === 'string'
        ? { parsedTextPath: attachment.parsedTextPath }
        : {}),
    };
  });
}

export function parseIcpRecoveryResponse(
  value: unknown,
  options: {
    label: string;
    expectedCorrelation?: IcpConversationCorrelation;
    expectedChannelId?: string;
    expectedSourceMessageId?: string;
  },
): AgentResponse {
  if (!isRecord(value)
    || typeof value.content !== 'string'
    || typeof value.channelId !== 'string'
    || !isRecord(value.metadata)) {
    throw new Error(`${options.label} is malformed`);
  }
  const unknownResponseKeys = Object.keys(value).filter(key => !RESPONSE_KEYS.has(key));
  if (unknownResponseKeys.length > 0) {
    throw new Error(`${options.label} contains unknown fields: ${unknownResponseKeys.join(', ')}`);
  }
  const metadata = parseIcpRecoveryResponseMetadata(
    value.metadata,
    `${options.label}.metadata`,
  );
  const correlation = parseIcpConversationCorrelation(metadata.icpCorrelation);
  if ((options.expectedCorrelation && !sameCorrelation(correlation, options.expectedCorrelation))
    || value.channelId !== (options.expectedChannelId ?? correlation.channelId)
    || (options.expectedSourceMessageId !== undefined
      && correlation.messageId !== options.expectedSourceMessageId)
    || metadata.turnId !== correlation.turnId
    || metadata.requestId !== correlation.requestId) {
    throw new Error(`${options.label} does not match its durable ICP lineage`);
  }
  const attachments = parseRecoveryAttachments(value.attachments, `${options.label}.attachments`);
  if (correlation.fatigueDecision === 'suppress'
    && (value.content.trim().length > 0 || (attachments?.length ?? 0) > 0)) {
    throw new Error(`${options.label} suppressed turn contains a deliverable response`);
  }
  const response: AgentResponse = {
    content: value.content,
    channelId: value.channelId,
    ...(attachments ? { attachments } : {}),
    metadata,
  };
  return structuredClone(response);
}

export function isIcpDeliveryObservationCandidate(
  content: string,
  sourceMessageId: string,
): boolean {
  return content.startsWith('{"schemaVersion":1,"kind":"icp_delivery"')
    && content.includes(`"sourceMessageId":${JSON.stringify(sourceMessageId)}`);
}

export function parseIcpDeliveryObservation(
  content: string,
  expected: { channelId: string; sourceMessageId: string },
): IcpDeliveryObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Recorded ICP delivery observation is malformed JSON');
  }
  if (!isRecord(parsed)) throw new Error('Recorded ICP delivery observation is malformed');
  const unknownKeys = Object.keys(parsed).filter(key => !OBSERVATION_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Recorded ICP delivery observation contains unknown fields: ${unknownKeys.join(', ')}`);
  }
  const status = parsed.status;
  if (parsed.schemaVersion !== 1
    || parsed.kind !== 'icp_delivery'
    || parsed.channelId !== expected.channelId
    || parsed.sourceMessageId !== expected.sourceMessageId
    || (status !== 'prepared' && status !== 'delivered'
      && status !== 'failed' && status !== 'suppressed')
    || (parsed.gatewayMessageId !== undefined
      && (typeof parsed.gatewayMessageId !== 'string' || !parsed.gatewayMessageId.trim()))
    || (parsed.deliveredTo !== undefined
      && (!Array.isArray(parsed.deliveredTo)
        || parsed.deliveredTo.some(value => typeof value !== 'string' || !value.trim())))
    || (parsed.permitOutcome !== undefined
      && parsed.permitOutcome !== 'consumed' && parsed.permitOutcome !== 'replayed')
    || (parsed.error !== undefined && (typeof parsed.error !== 'string' || !parsed.error.trim()))
    || (parsed.turnCompleted !== undefined && parsed.turnCompleted !== true)) {
    throw new Error('Recorded ICP delivery observation is malformed');
  }
  if (status === 'delivered' && typeof parsed.gatewayMessageId !== 'string') {
    throw new Error('Delivered ICP observation is missing gatewayMessageId');
  }
  if (status !== 'delivered'
    && (parsed.gatewayMessageId !== undefined || parsed.deliveredTo !== undefined
      || parsed.permitOutcome !== undefined)) {
    throw new Error('Non-delivered ICP observation contains delivery receipt fields');
  }
  if (status === 'failed' && typeof parsed.error !== 'string') {
    throw new Error('Failed ICP observation is missing error');
  }
  if (status !== 'failed' && parsed.error !== undefined) {
    throw new Error('Non-failed ICP observation contains an error');
  }
  if (parsed.turnCompleted === true && status !== 'delivered' && status !== 'suppressed') {
    throw new Error('Incomplete ICP delivery status cannot be turnCompleted');
  }
  const recoveryResponse = parsed.recoveryResponse === undefined
    ? undefined
    : parseIcpRecoveryResponse(parsed.recoveryResponse, {
        label: 'Recorded ICP delivery recovery response',
        expectedChannelId: expected.channelId,
        expectedSourceMessageId: expected.sourceMessageId,
      });
  if (!recoveryResponse) {
    throw new Error(`Recorded ${status} ICP observation is missing recovery response`);
  }
  assertIcpRecoveryStatusBinding(status, recoveryResponse, 'Recorded ICP delivery');
  return {
    channelId: expected.channelId,
    sourceMessageId: expected.sourceMessageId,
    status,
    ...(typeof parsed.gatewayMessageId === 'string'
      ? { gatewayMessageId: parsed.gatewayMessageId.trim() }
      : {}),
    ...(Array.isArray(parsed.deliveredTo)
      ? { deliveredTo: parsed.deliveredTo.map(value => String(value).trim()) }
      : {}),
    ...(parsed.permitOutcome === 'consumed' || parsed.permitOutcome === 'replayed'
      ? { permitOutcome: parsed.permitOutcome }
      : {}),
    ...(typeof parsed.error === 'string' ? { error: parsed.error.trim() } : {}),
    recoveryResponse,
    ...(parsed.turnCompleted === true ? { turnCompleted: true as const } : {}),
  };
}

export function serializeIcpDeliveryObservation(observation: IcpDeliveryObservation): string {
  const content = JSON.stringify({ schemaVersion: 1, kind: 'icp_delivery', ...observation });
  parseIcpDeliveryObservation(content, {
    channelId: observation.channelId,
    sourceMessageId: observation.sourceMessageId,
  });
  return content;
}
