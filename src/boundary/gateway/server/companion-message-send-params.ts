// Fail-closed parameter decoding for the inter-companion `companion.message.send` RPC.
import { assertNoUnknownKeys, isRecord } from '../../../shared/utils/types.js';
import {
  parseIcpConversationCorrelation,
  type IcpConversationCorrelation,
} from '../../../shared/contracts/icp-autonomy.js';
import type { CompanionMessageSendParams } from '../protocol.js';

const COMPANION_MESSAGE_MAX_CONTENT_CHARS = 65_536;
const COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS = 200;
const COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS = 256;

/**
 * Fail-closed validation for companion.message.send params. Note the sender
 * identity is NOT read from params — it always comes from the connection's
 * bound companionId (a params.companionId that disagrees with the binding is
 * already treated as spoofing by enforceCompanionFrameIdentity).
 */
export function parseCompanionMessageSendParams(params: unknown): {
  channelId: string;
  content: string;
  authorName?: string;
  messageId?: string;
  initiation?: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  };
  continuation?: {
    dyadId: string;
    deliveryId: string;
    recipientCompanionId: string;
    peerContactId: string;
    correlation: IcpConversationCorrelation;
  };
  correlation?: IcpConversationCorrelation;
  replyToMessageId?: string;
  humanRelay?: NonNullable<CompanionMessageSendParams['humanRelay']>;
} {
  if (!isRecord(params)) {
    throw new Error('companion.message.send requires an object params payload');
  }
  const channelId = typeof params.channelId === 'string' ? params.channelId.trim() : '';
  if (!channelId) {
    throw new Error('companion.message.send requires a non-empty channelId');
  }
  const content = typeof params.content === 'string' ? params.content : '';
  if (!content.trim()) {
    throw new Error('companion.message.send requires non-empty content');
  }
  if (content.length > COMPANION_MESSAGE_MAX_CONTENT_CHARS) {
    throw new Error(
      `companion.message.send content exceeds ${COMPANION_MESSAGE_MAX_CONTENT_CHARS} characters`,
    );
  }
  let authorName: string | undefined;
  if (params.authorName !== undefined) {
    if (typeof params.authorName !== 'string') {
      throw new Error('companion.message.send authorName must be a string when provided');
    }
    authorName = params.authorName.trim();
    if (!authorName || authorName.length > COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS) {
      throw new Error(
        `companion.message.send authorName must be 1-${COMPANION_MESSAGE_MAX_AUTHOR_NAME_CHARS} characters`,
      );
    }
  }
  let messageId: string | undefined;
  if (params.messageId !== undefined) {
    if (typeof params.messageId !== 'string' || !params.messageId.trim()) {
      throw new Error('companion.message.send messageId must be a non-empty string when provided');
    }
    messageId = params.messageId.trim();
  }
  let initiation: {
    permitId: string;
    conversationId: string;
    recipientCompanionId: string;
    correlation: IcpConversationCorrelation;
  } | undefined;
  if (params.initiation !== undefined) {
    if (!isRecord(params.initiation)) {
      throw new Error('companion.message.send initiation must be an object');
    }
    assertNoUnknownKeys(
      params.initiation,
      ['permitId', 'conversationId', 'recipientCompanionId', 'correlation'] as const,
      'companion.message.send initiation',
    );
    const permitId = typeof params.initiation.permitId === 'string'
      ? params.initiation.permitId.trim()
      : '';
    const conversationId = typeof params.initiation.conversationId === 'string'
      ? params.initiation.conversationId.trim()
      : '';
    const recipientCompanionId = typeof params.initiation.recipientCompanionId === 'string'
      ? params.initiation.recipientCompanionId.trim()
      : '';
    if (!permitId || !conversationId || !recipientCompanionId) {
      throw new Error(
        'companion.message.send initiation requires permitId, conversationId, and recipientCompanionId',
      );
    }
    initiation = {
      permitId,
      conversationId,
      recipientCompanionId,
      correlation: parseIcpConversationCorrelation(params.initiation.correlation),
    };
  }
  let continuation: {
    dyadId: string;
    deliveryId: string;
    recipientCompanionId: string;
    peerContactId: string;
    correlation: IcpConversationCorrelation;
  } | undefined;
  if (params.continuation !== undefined) {
    if (!isRecord(params.continuation)) {
      throw new Error('companion.message.send continuation must be an object');
    }
    assertNoUnknownKeys(params.continuation, [
      'dyadId', 'deliveryId', 'recipientCompanionId', 'peerContactId', 'correlation',
    ] as const, 'companion.message.send continuation');
    const dyadId = typeof params.continuation.dyadId === 'string'
      ? params.continuation.dyadId.trim()
      : '';
    const deliveryId = typeof params.continuation.deliveryId === 'string'
      ? params.continuation.deliveryId.trim()
      : '';
    const recipientCompanionId = typeof params.continuation.recipientCompanionId === 'string'
      ? params.continuation.recipientCompanionId.trim()
      : '';
    const peerContactId = typeof params.continuation.peerContactId === 'string'
      ? params.continuation.peerContactId.trim()
      : '';
    if (!dyadId || !deliveryId || !recipientCompanionId || !peerContactId) {
      throw new Error('companion.message.send continuation binding is incomplete');
    }
    continuation = {
      dyadId,
      deliveryId,
      recipientCompanionId,
      peerContactId,
      correlation: parseIcpConversationCorrelation(params.continuation.correlation),
    };
  }
  if ([initiation, continuation, params.correlation].filter(value => value !== undefined).length > 1) {
    throw new Error('companion.message.send cannot combine initiation, continuation, and reply correlation');
  }
  const correlation = params.correlation === undefined
    ? undefined
    : parseIcpConversationCorrelation(params.correlation);
  let humanRelay: NonNullable<CompanionMessageSendParams['humanRelay']> | undefined;
  if (params.humanRelay !== undefined) {
    if (!isRecord(params.humanRelay)) {
      throw new Error('companion.message.send humanRelay must be an object');
    }
    assertNoUnknownKeys(
      params.humanRelay,
      ['requestCapsule', 'responseCapsule'] as const,
      'companion.message.send humanRelay',
    );
    const requestCapsule = params.humanRelay.requestCapsule;
    const responseCapsule = params.humanRelay.responseCapsule;
    if (!isRecord(requestCapsule)
      || requestCapsule.capsuleKind !== 'human_relay_intent'
      || !isRecord(requestCapsule.source)
      || !isRecord(requestCapsule.target)
      || (responseCapsule !== undefined
        && (!isRecord(responseCapsule)
          || responseCapsule.capsuleKind !== 'human_relay_response'
          || !isRecord(responseCapsule.response)
          || !isRecord(responseCapsule.destination)))) {
      throw new Error('companion.message.send humanRelay capsule shape is malformed');
    }
    humanRelay = params.humanRelay as unknown as NonNullable<CompanionMessageSendParams['humanRelay']>;
  }
  if ((initiation !== undefined || continuation !== undefined || correlation !== undefined)
    !== (messageId !== undefined)) {
    throw new Error('companion.message.send correlated transports require a deterministic messageId');
  }
  let replyToMessageId: string | undefined;
  if (params.replyToMessageId !== undefined) {
    if (typeof params.replyToMessageId !== 'string') {
      throw new Error('companion.message.send replyToMessageId must be a string when provided');
    }
    replyToMessageId = params.replyToMessageId.trim();
    if (!replyToMessageId || replyToMessageId.length > COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS) {
      throw new Error(
        'companion.message.send replyToMessageId must be '
        + `1-${COMPANION_MESSAGE_MAX_REPLY_TO_ID_CHARS} characters`,
      );
    }
  }
  return {
    channelId,
    content,
    ...(authorName ? { authorName } : {}),
    ...(messageId ? { messageId } : {}),
    ...(initiation ? { initiation } : {}),
    ...(continuation ? { continuation } : {}),
    ...(correlation ? { correlation } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
    ...(humanRelay ? { humanRelay } : {}),
  };
}
