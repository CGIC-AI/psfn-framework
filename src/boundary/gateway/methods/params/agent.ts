import { Type } from '@sinclair/typebox';

import type { SatelliteResponseEligibilityRpcParams } from '../../../../channels/api/types.js';
import { CHANNEL_TYPES } from '../../../../shared/contracts/channel-types.js';
import {
  agentDecoder,
  attachment,
  checkedDecoder,
  emptyParams,
  enumSchema,
  optionalBoolean,
  optionalNumber,
  optionalString,
  strictObject,
  stringRecord,
  unknownRecord,
} from './schema.js';

const voiceFrame = {
  correlationId: Type.String(),
  streamId: Type.String(),
  sequence: Type.Integer(),
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
  'memory.deletion.snapshot': agentDecoder('memory.deletion.snapshot', strictObject({ proposalId: Type.String() })),
  'memory.deletion.partner_alerted': agentDecoder('memory.deletion.partner_alerted', strictObject({ proposalId: Type.String() })),
  'memory.deletion.resolve': agentDecoder('memory.deletion.resolve', strictObject({
    proposalId: Type.String(), decision: enumSchema(['approve', 'deny']), operatorId: Type.String(),
  })),
  'contact.authority.snapshot': agentDecoder('contact.authority.snapshot', strictObject({
    contactId: Type.String(), providerSubjectId: Type.String(),
  })),
  'voice.handleMessage': agentDecoder('voice.handleMessage', strictObject({ message: substrateMessage })),
  'voice.stream.start': agentDecoder('voice.stream.start', strictObject({ ...voiceFrame, message: substrateMessage })),
  'voice.stream.chunk': agentDecoder('voice.stream.chunk', strictObject({ ...voiceFrame, text: Type.String() })),
  'voice.stream.end': agentDecoder('voice.stream.end', strictObject(voiceFrame)),
  'voice.stream.cancel': agentDecoder('voice.stream.cancel', strictObject({ ...voiceFrame, reason: optionalString })),
  'api.chat.completion': agentDecoder('api.chat.completion', strictObject({
    requestId: Type.String(), request: unknownRecord, principal: apiPrincipal, headers: stringRecord,
    clientCert: Type.Optional(unknownRecord), hubDevicePrincipal: Type.Optional(unknownRecord),
    hubDeviceAttachment: Type.Optional(unknownRecord), companionUiCapability: Type.Optional(unknownRecord),
    timeoutMs: optionalNumber, performance: Type.Optional(strictObject({
      receivedMonotonicAtMs: Type.Number(), receivedTimestampMs: Type.Number(),
    })),
  })),
  'api.chat.cancel': agentDecoder('api.chat.cancel', strictObject({ requestId: Type.String() })),
  'api.companion-ui.shard.action': agentDecoder('api.companion-ui.shard.action', strictObject({
    requestId: Type.String(), principal: apiPrincipal, headers: stringRecord,
    clientCert: Type.Optional(unknownRecord), hubDevicePrincipal: unknownRecord,
    hubDeviceAttachment: unknownRecord, companionUiCapability: unknownRecord,
  })),
  'shard.directory.owner': agentDecoder('shard.directory.owner', strictObject({ shardId: Type.String() })),
  'api.telemetry.ingest': agentDecoder('api.telemetry.ingest', strictObject({ event: unknownRecord })),
  'api.health': agentDecoder('api.health', emptyParams),
  'satellite.response.eligibility': checkedDecoder<SatelliteResponseEligibilityRpcParams>(
    'satellite.response.eligibility', strictObject({
    canonicalContactId: Type.String(), channelId: Type.String(),
    }),
  ),
  'telemetry.turn.performance': agentDecoder('telemetry.turn.performance', strictObject({
    event: unknownRecord,
  })),
} as const;
