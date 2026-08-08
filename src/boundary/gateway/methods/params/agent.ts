import { Type } from '@sinclair/typebox';

import type { SatelliteResponseEligibilityRpcParams } from '../../../../channels/api/types.js';
import { CHANNEL_TYPES } from '../../../../shared/contracts/channel-types.js';
import { parseTurnPerformanceEvent } from '../../../../shared/telemetry/turn-performance.js';
import type { TurnPerformanceIngestParams } from '../../protocol.js';
import {
  agentDecoder,
  attachment,
  checkedDecoder,
  emptyParams,
  enumSchema,
  nonEmptyCanonicalString,
  nonNegativeInteger,
  optionalBoolean,
  optionalNumber,
  optionalString,
  strictObject,
  stringRecord,
  unknownRecord,
} from './schema.js';

const voiceFrame = {
  correlationId: nonEmptyCanonicalString,
  streamId: nonEmptyCanonicalString,
  sequence: nonNegativeInteger,
  metadata: Type.Optional(unknownRecord),
};
const substrateMessage = strictObject({
  id: Type.String(),
  channelId: Type.String(),
  channelType: enumSchema(CHANNEL_TYPES),
  authorId: Type.String(),
  authorName: Type.String(),
  content: Type.String(),
  attachments: Type.Optional(Type.Array(attachment)),
  timestamp: Type.Union([Type.String(), Type.Object({}, { additionalProperties: true })]),
  isDirectMessage: optionalBoolean,
  replyToMessageId: optionalString,
  routing: Type.Optional(unknownRecord),
});
const apiPrincipal = strictObject({
  id: Type.String(),
  mode: enumSchema(['api_key', 'insecure_local']),
  scope: Type.Optional(enumSchema(['satellite', 'testing_harness'])),
});

export const agentMethodParamDecoders = {
  'memory.deletion.snapshot': agentDecoder('memory.deletion.snapshot', strictObject({ proposalId: nonEmptyCanonicalString })),
  'memory.deletion.partner_alerted': agentDecoder('memory.deletion.partner_alerted', strictObject({ proposalId: nonEmptyCanonicalString })),
  'memory.deletion.resolve': agentDecoder('memory.deletion.resolve', strictObject({
    proposalId: nonEmptyCanonicalString, decision: enumSchema(['approve', 'deny']), operatorId: nonEmptyCanonicalString,
  })),
  'contact.authority.snapshot': agentDecoder('contact.authority.snapshot', strictObject({
    contactId: nonEmptyCanonicalString, providerSubjectId: nonEmptyCanonicalString,
  })),
  'voice.handleMessage': agentDecoder('voice.handleMessage', strictObject({ message: substrateMessage })),
  'voice.stream.start': agentDecoder('voice.stream.start', strictObject({ ...voiceFrame, message: substrateMessage })),
  'voice.stream.chunk': agentDecoder('voice.stream.chunk', strictObject({ ...voiceFrame, text: Type.String() })),
  'voice.stream.end': agentDecoder('voice.stream.end', strictObject(voiceFrame)),
  'voice.stream.cancel': agentDecoder('voice.stream.cancel', strictObject({ ...voiceFrame, reason: optionalString })),
  'api.chat.completion': agentDecoder('api.chat.completion', strictObject({
    requestId: nonEmptyCanonicalString, request: unknownRecord, principal: apiPrincipal, headers: stringRecord,
    clientCert: Type.Optional(unknownRecord), hubDevicePrincipal: Type.Optional(unknownRecord),
    hubDeviceAttachment: Type.Optional(unknownRecord), companionUiCapability: Type.Optional(unknownRecord),
    timeoutMs: optionalNumber, performance: Type.Optional(strictObject({
      receivedMonotonicAtMs: Type.Number(), receivedTimestampMs: Type.Number(),
    })),
  })),
  'api.chat.cancel': agentDecoder('api.chat.cancel', strictObject({ requestId: nonEmptyCanonicalString })),
  'api.companion-ui.shard.action': agentDecoder('api.companion-ui.shard.action', strictObject({
    requestId: nonEmptyCanonicalString, principal: apiPrincipal, headers: stringRecord,
    clientCert: Type.Optional(unknownRecord), hubDevicePrincipal: unknownRecord,
    hubDeviceAttachment: unknownRecord, companionUiCapability: unknownRecord,
  })),
  'shard.directory.owner': agentDecoder('shard.directory.owner', strictObject({ shardId: nonEmptyCanonicalString })),
  'api.telemetry.ingest': agentDecoder('api.telemetry.ingest', strictObject({ event: unknownRecord })),
  'api.health': agentDecoder('api.health', emptyParams),
  'satellite.response.eligibility': checkedDecoder<SatelliteResponseEligibilityRpcParams>(
    'satellite.response.eligibility', strictObject({
    canonicalContactId: nonEmptyCanonicalString, channelId: nonEmptyCanonicalString,
    }),
  ),
  'telemetry.turn.performance': (params: unknown): TurnPerformanceIngestParams => {
    const wrapper = agentDecoder('telemetry.turn.performance', strictObject({ event: unknownRecord }))(params);
    return { event: parseTurnPerformanceEvent(wrapper.event) };
  },
} as const;
