// ── External channel protocol, version 1 (psfn-framework-pus8m) ──
//
// The gateway is the MCP server and every external bridge is an MCP client,
// exactly the direction Hermes uses for companion memory. The gateway never
// dials a bridge or awaits one, so a hung or dead bridge cannot block it.
// Each call is a stateless MCP `tools/call` on the adapter's own endpoint:
//
//   channel_hello          version handshake; returns identity and limits
//   channel_inbound        deliver one inbound message; the companion reply
//                          (if any) comes back in the same result
//   channel_pull_outbound  drain queued companion-initiated messages
//   channel_health         liveness report; returns the adapter status
//
// Every input carries `protocolVersion`; any other version is refused.
// Identity (which adapter, which companion) comes only from the endpoint and
// its bearer token — never from tool arguments.

import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const EXTERNAL_CHANNEL_PROTOCOL_VERSION = 1;

export const EXTERNAL_CHANNEL_TOOL_NAMES = {
  hello: 'channel_hello',
  inbound: 'channel_inbound',
  pullOutbound: 'channel_pull_outbound',
  health: 'channel_health',
} as const;

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const version = Type.Integer();

export const EXTERNAL_CHANNEL_TOOL_SCHEMAS = {
  hello: Type.Object({
    protocolVersion: version,
    bridge: Type.Object({ name: text, version: text }, strict),
  }, strict),
  inbound: Type.Object({
    protocolVersion: version,
    message: Type.Object({
      /** Bridge-native message id, unique within the adapter. */
      id: text,
      /** Bridge-native conversation id; replies and sends address it. */
      conversationId: text,
      conversationKind: Type.Union([Type.Literal('direct'), Type.Literal('group')]),
      senderId: text,
      senderName: text,
      text,
      /** ISO-8601 send time; the gateway receive time when absent. */
      sentAt: Type.Optional(text),
      replyToMessageId: Type.Optional(text),
      /**
       * Group conversations only: the platform marks this message as addressed
       * to the companion's own account (a mention of it, or a reply to one of
       * its messages). Absent or false in a group means ambient room chatter,
       * which the companion observes and may choose not to answer.
       */
      addressedToCompanion: Type.Optional(Type.Boolean()),
    }, strict),
  }, strict),
  pullOutbound: Type.Object({
    protocolVersion: version,
    maxItems: Type.Optional(Type.Integer({ minimum: 1 })),
  }, strict),
  health: Type.Object({
    protocolVersion: version,
    status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
    detail: Type.Optional(Type.String()),
  }, strict),
} as const;

export type ExternalChannelInboundInput = Static<typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS.inbound>;
export type ExternalChannelInboundMessage = ExternalChannelInboundInput['message'];
export type ExternalChannelPullInput = Static<typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS.pullOutbound>;
export type ExternalChannelHealthInput = Static<typeof EXTERNAL_CHANNEL_TOOL_SCHEMAS.health>;

export type ExternalChannelRejectReason =
  | 'not_running'
  | 'busy'
  | 'duplicate'
  | 'invalid'
  | 'turn_timeout'
  | 'turn_failed';

export type ExternalChannelInboundResult =
  | { status: 'replied'; reply: { conversationId: string; text: string } }
  | { status: 'no_reply' }
  | { status: 'rejected'; reason: ExternalChannelRejectReason; detail?: string };

export interface ExternalChannelOutboundMessage {
  deliveryId: string;
  conversationId: string;
  text: string;
  replyToMessageId?: string;
}

export interface ExternalChannelPullResult {
  messages: ExternalChannelOutboundMessage[];
}

export type ExternalChannelConnectionState = 'stopped' | 'awaiting_bridge' | 'connected' | 'stale';

export interface ExternalChannelStatus {
  state: ExternalChannelConnectionState;
  lastSeenAt?: string;
  bridgeReportedStatus?: 'ok' | 'degraded';
  inFlightTurns: number;
  outboundQueued: number;
  rejectedInbound: number;
  droppedOutbound: number;
}

export interface ExternalChannelHelloResult {
  protocolVersion: typeof EXTERNAL_CHANNEL_PROTOCOL_VERSION;
  instanceId: string;
  label: string;
  capabilities: {
    conversationKinds: ReadonlyArray<'direct' | 'group'>;
    media: false;
    reactions: false;
    threads: false;
  };
  limits: {
    maxTextChars: number;
    maxIdChars: number;
    maxInFlightTurns: number;
    turnTimeoutMs: number;
    outboundPullMax: number;
    heartbeatTimeoutMs: number;
  };
}

/**
 * Validate one tool input against its schema and the protocol version. Throws
 * a message safe to return to the bridge; nothing about other adapters leaks.
 */
export function parseExternalChannelToolInput<T extends TSchema>(
  schema: T,
  input: unknown,
): Static<T> {
  if (!Value.Check(schema, input)) {
    const first = Value.Errors(schema, input).First();
    throw new Error(`Invalid tool input${first ? `: ${first.path || '/'} ${first.message}` : ''}`);
  }
  const protocolVersion = (input as { protocolVersion: unknown }).protocolVersion;
  if (protocolVersion !== EXTERNAL_CHANNEL_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported external channel protocol version ${String(protocolVersion)}; `
      + `this gateway speaks version ${EXTERNAL_CHANNEL_PROTOCOL_VERSION}`,
    );
  }
  return input;
}
