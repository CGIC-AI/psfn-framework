import { Type, type TProperties, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { JSONRPCErrorCode, JSONRPCErrorException } from 'json-rpc-2.0';

import type { AgentMethods, GatewayMethods } from '../../protocol.js';
import { CHANNEL_TYPES } from '../../../../shared/contracts/channel-types.js';
import type { RpcParamsDecoder } from '../../rpc-param-decoder.js';

type GatewayParams<K extends keyof GatewayMethods> = GatewayMethods[K][0];
type AgentParams<K extends keyof AgentMethods> = AgentMethods[K][0];
export type NamedRpcParamsDecoder<K extends keyof GatewayMethods> =
  RpcParamsDecoder<GatewayMethods[K][0]>;

export const stringArray = Type.Array(Type.String());
export const unknownRecord = Type.Record(Type.String(), Type.Unknown());
export const stringRecord = Type.Record(Type.String(), Type.String());
export const optionalString = Type.Optional(Type.String());
export const optionalNumber = Type.Optional(Type.Number());
export const optionalInteger = Type.Optional(Type.Integer());
export const optionalBoolean = Type.Optional(Type.Boolean());
export const nonEmptyCanonicalString = Type.String({
  minLength: 1,
  pattern: '^\\S(?:.*\\S)?$',
});
export const nonNegativeInteger = Type.Integer({ minimum: 0 });

export function strictObject(properties: TProperties): TSchema {
  return Type.Object(properties, { additionalProperties: false });
}

export function enumSchema<const T extends readonly string[]>(values: T): TSchema {
  return Type.Union(values.map(value => Type.Literal(value)));
}

export function checkedDecoder<P>(method: string, schema: TSchema): RpcParamsDecoder<P> {
  return (params: unknown): P => {
    if (!Value.Check(schema, params)) {
      throw new JSONRPCErrorException(
        `${method} received invalid params`,
        JSONRPCErrorCode.InvalidParams,
      );
    }
    return params as P;
  };
}

export function gatewayDecoder<K extends keyof GatewayMethods>(
  method: K,
  schema: TSchema,
): RpcParamsDecoder<GatewayParams<K>> {
  return checkedDecoder<GatewayParams<K>>(method, schema);
}

export function agentDecoder<K extends keyof AgentMethods>(
  method: K,
  schema: TSchema,
): RpcParamsDecoder<AgentParams<K>> {
  return checkedDecoder<AgentParams<K>>(method, schema);
}

export const emptyParams = strictObject({});
export const correlationProperties = {
  companionId: optionalString,
  sessionId: optionalString,
  turnId: optionalString,
  requestId: optionalString,
  channelId: optionalString,
  channelType: Type.Optional(enumSchema(CHANNEL_TYPES)),
  callType: Type.Optional(enumSchema(['chat', 'tool', 'memory', 'summary', 'background', 'scheduled'])),
  originType: Type.Optional(enumSchema(['chat', 'tool', 'memory', 'summary', 'background', 'scheduled'])),
  originStage: optionalString,
  toolName: optionalString,
  toolCallId: optionalString,
  purpose: optionalString,
  telemetryVisibility: Type.Optional(enumSchema(['operator_visible', 'companion_private'])),
  service: optionalString,
  process: optionalString,
  chargeLane: Type.Optional(enumSchema([
    'interactive', 'companion_social', 'background', 'maintenance', 'subagent', 'shard',
  ])),
  chargeSurface: Type.Optional(enumSchema([
    'localImageGeneration',
    'paidImageGeneration',
    'analysisWorkbenchExtensionBand',
    'subagentLaunch',
    'shardLaunch',
    'externalModelConsult',
    'moaRoundBase',
    'companionSocialContinuation',
  ])),
  chargeEventId: optionalString,
  chargeRunId: optionalString,
  chargeRootRunId: optionalString,
  chargeParentRunId: optionalString,
  shardId: optionalString,
  subagentId: optionalString,
  conversationId: optionalString,
  rootInitiationId: optionalString,
  workloadType: optionalString,
  workloadId: optionalString,
  icpCorrelation: Type.Optional(strictObject({
    conversationId: Type.String(),
    rootInitiationId: Type.String(),
    initiatedByCompanionId: Type.String(),
    localCompanionId: Type.String(),
    peerCompanionId: Type.String(),
    peerContactId: Type.String(),
    channelId: Type.String(),
    turnId: Type.String(),
    messageId: Type.String(),
    requestId: Type.String(),
    chargeLane: enumSchema(['interactive', 'companion_social']),
    surface: enumSchema(['companion_dm', 'companion_room']),
    costPurpose: enumSchema(['conversation_turn', 'tool', 'summary', 'extraction', 'sidecar']),
    costOriginStage: enumSchema(['initiation', 'reply', 'post_turn', 'maintenance']),
    fatigueDecision: enumSchema(['allow', 'allow_overcharge', 'suppress', 'not_evaluated']),
    fatigueReasonCode: optionalString,
  })),
};

export function correlatedParams(properties: TProperties = {}): TSchema {
  return strictObject({ ...correlationProperties, ...properties });
}

export const attachment = strictObject({
  url: Type.String(),
  contentType: Type.String(),
  name: Type.String(),
  localPath: optionalString,
  dataBase64: optionalString,
  parsedTextPath: optionalString,
});

export function optionalCanonicalUuid(): TSchema {
  return Type.Optional(Type.String({
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  }));
}
