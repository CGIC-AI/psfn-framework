import { Type, type TProperties, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { JSONRPCErrorCode, JSONRPCErrorException } from 'json-rpc-2.0';

import type { AgentMethods, GatewayMethods } from '../protocol.js';
import type { SatelliteResponseEligibilityRpcParams } from '../../../channels/api/types.js';
import { CHANNEL_TYPES } from '../../../shared/contracts/channel-types.js';
import type { RpcParamsDecoder } from '../rpc-param-decoder.js';

type GatewayParams<K extends keyof GatewayMethods> = GatewayMethods[K][0];
type AgentParams<K extends keyof AgentMethods> = AgentMethods[K][0];
type NamedRpcParamsDecoder<K extends keyof GatewayMethods> =
  RpcParamsDecoder<GatewayMethods[K][0]>;

const stringArray = Type.Array(Type.String());
const unknownRecord = Type.Record(Type.String(), Type.Unknown());
const stringRecord = Type.Record(Type.String(), Type.String());
const optionalString = Type.Optional(Type.String());
const optionalNumber = Type.Optional(Type.Number());
const optionalInteger = Type.Optional(Type.Integer());
const optionalBoolean = Type.Optional(Type.Boolean());

function strictObject(properties: TProperties): TSchema {
  return Type.Object(properties, { additionalProperties: false });
}

function enumSchema<const T extends readonly string[]>(values: T): TSchema {
  return Type.Union(values.map(value => Type.Literal(value)));
}

function checkedDecoder<P>(method: string, schema: TSchema): RpcParamsDecoder<P> {
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

function gatewayDecoder<K extends keyof GatewayMethods>(
  method: K,
  schema: TSchema,
): RpcParamsDecoder<GatewayParams<K>> {
  return checkedDecoder<GatewayParams<K>>(method, schema);
}

function agentDecoder<K extends keyof AgentMethods>(
  method: K,
  schema: TSchema,
): RpcParamsDecoder<AgentParams<K>> {
  return checkedDecoder<AgentParams<K>>(method, schema);
}

const emptyParams = strictObject({});
const correlationProperties = {
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

function correlatedParams(properties: TProperties = {}): TSchema {
  return strictObject({ ...correlationProperties, ...properties });
}

const gatewayLLMContentBlock = Type.Union([
  strictObject({
    type: Type.Literal('text'),
    text: Type.String(),
    textSignature: optionalString,
  }),
  strictObject({
    type: Type.Literal('image'),
    data: Type.String(),
    mimeType: Type.String(),
  }),
  strictObject({
    type: Type.Literal('thinking'),
    thinking: Type.String(),
    thinkingSignature: optionalString,
    redacted: optionalBoolean,
  }),
  strictObject({
    type: Type.Literal('toolCall'),
    id: Type.String(),
    name: Type.String(),
    arguments: unknownRecord,
    thoughtSignature: optionalString,
  }),
  strictObject({
    type: Type.Literal('gateway_image_ref'),
    handle: Type.String(),
  }),
]);
const messageContent = Type.Union([
  Type.String(),
  Type.Array(gatewayLLMContentBlock),
]);
const gatewayMessage = strictObject({
  role: enumSchema(['user', 'assistant', 'system']),
  content: messageContent,
  provenance: Type.Optional(unknownRecord),
});
const toolSchema = strictObject({
  name: Type.String(),
  description: Type.String(),
  inputSchema: unknownRecord,
});
const accounting = strictObject({
  logicalCallId: Type.String(),
  attempt: Type.Integer(),
  retryOwner: Type.Optional(Type.Literal('caller')),
});
const llmCommon = {
  ...correlationProperties,
  cancellationId: optionalCanonicalUuid(),
  // The gateway deliberately tolerates omitted routing hints and resolves its
  // configured defaults. Several in-process and older wire callers rely on
  // that behavior even though the public protocol still declares both fields.
  model: optionalString,
  provider: optionalString,
  pin: optionalBoolean,
  slotKey: optionalString,
  messages: Type.Array(gatewayMessage),
  systemPrompt: Type.String(),
  promptCacheBoundaries: Type.Optional(unknownRecord),
  maxTokens: optionalNumber,
  contextWindow: optionalNumber,
  thinkingEnabled: optionalBoolean,
  thinkingEffort: Type.Optional(enumSchema(['minimal', 'low', 'medium', 'high', 'xhigh'])),
  temperature: optionalNumber,
  topP: optionalNumber,
  topK: optionalNumber,
  repetitionPenalty: optionalNumber,
  frequencyPenalty: optionalNumber,
  accounting: Type.Optional(accounting),
  workSpec: Type.Optional(unknownRecord),
};

const attachment = strictObject({
  url: Type.String(),
  contentType: Type.String(),
  name: Type.String(),
  localPath: optionalString,
  dataBase64: optionalString,
  parsedTextPath: optionalString,
});
const notificationSender = strictObject({
  kind: enumSchema(['companion', 'system']),
  provenance: Type.String(),
});
const journalEntry = strictObject({
  type: enumSchema(['message', 'compaction', 'marker', 'tombstone']),
  id: Type.Integer(),
  channelId: Type.String(),
  role: Type.Optional(enumSchema(['user', 'assistant', 'system', 'tool'])),
  content: optionalString,
  authorId: optionalString,
  authorName: optionalString,
  timestamp: Type.Number(),
  discordMessageId: optionalString,
  metadata: optionalString,
  originChannelId: optionalString,
  channelVisibility: optionalString,
  summary: optionalString,
  coveredUpTo: optionalNumber,
  marker: Type.Optional(enumSchema(['extraction', 'graceful_shutdown'])),
  tombstoneTargetType: Type.Optional(Type.Literal('turn')),
  tombstoneTargetId: optionalString,
  tombstoneAction: Type.Optional(enumSchema(['redact', 'restore'])),
  tombstoneActor: optionalString,
  tombstoneReason: optionalString,
  _hmac: optionalString,
  _hmacKeyVersion: optionalString,
});

const imageCommon = {
  ...correlationProperties,
  prompt: Type.String(),
  provider: Type.Optional(enumSchema(['auto', 'fal', 'comfyui'])),
  model: optionalString,
  settingsDefaults: Type.Optional(unknownRecord),
  numImages: optionalNumber,
  width: optionalNumber,
  height: optionalNumber,
  aspectRatio: optionalString,
  resolution: optionalString,
  imageSize: optionalString,
  background: optionalString,
  outputFormat: optionalString,
  seed: optionalNumber,
  sourceToolName: optionalString,
  referenceImageIds: Type.Optional(stringArray),
};

export const gatewayMethodParamDecoders = {
  'llm.chat': gatewayDecoder('llm.chat', strictObject({
    ...llmCommon,
    stream: optionalBoolean,
    tools: Type.Optional(Type.Array(toolSchema)),
    mcpOutboundSensitivity: Type.Optional(enumSchema([
      'public', 'personal', 'intimate', 'confidential',
    ])),
  })),
  'llm.complete': gatewayDecoder('llm.complete', strictObject({
    ...llmCommon,
    purpose: enumSchema([
      'chat', 'background', 'memory', 'context', 'extraction', 'summary', 'reasoning',
      'import_processing', 'vision',
    ]),
  })),
  'llm.embed': gatewayDecoder('llm.embed', correlatedParams({
    texts: Type.Array(Type.String()),
    cancellationId: optionalCanonicalUuid(),
  })),
  'llm.cancel': gatewayDecoder('llm.cancel', strictObject({
    cancellationId: Type.String(),
    companionId: optionalString,
  })),
  'llm.discover_models': gatewayDecoder('llm.discover_models', emptyParams),
  'llm.invalidate_model_discovery': gatewayDecoder('llm.invalidate_model_discovery', emptyParams),
  'discord.send': gatewayDecoder('discord.send', strictObject({
    channelId: Type.String(), content: Type.String(), companionId: optionalString,
  })),
  'discord.sendMedia': gatewayDecoder('discord.sendMedia', strictObject({
    channelId: Type.String(), media: attachment, companionId: optionalString,
  })),
  'discord.typing': gatewayDecoder('discord.typing', strictObject({
    channelId: Type.String(), companionId: optionalString,
  })),
  'confirmation.list': gatewayDecoder('confirmation.list', emptyParams),
  'confirmation.history': gatewayDecoder('confirmation.history', emptyParams),
  'confirmation.resolve': gatewayDecoder('confirmation.resolve', strictObject({
    id: Type.String(),
    decision: enumSchema(['approve', 'deny', 'modify']),
    modifiedParams: Type.Optional(unknownRecord),
  })),
  'notify.ntfy': gatewayDecoder('notify.ntfy', strictObject({
    message: Type.String(), title: optionalString, priority: optionalNumber, topic: optionalString,
    sender: notificationSender,
  })),
  'notify.operator': gatewayDecoder('notify.operator', strictObject({
    message: Type.String(), title: optionalString, priority: optionalNumber, topic: optionalString,
    sender: notificationSender,
  })),
  'clarify.deliver': gatewayDecoder('clarify.deliver', strictObject({
    channel: enumSchema(['discord', 'telegram']),
    target: Type.String(),
    clarification: strictObject({
      id: Type.String(), question: Type.String(), choices: stringArray,
    }),
    timeoutMs: Type.Number(),
    originatingUserId: optionalString,
  })),
  'runtime.health': gatewayDecoder('runtime.health', emptyParams),
  'runtime.credential_presence': gatewayDecoder('runtime.credential_presence', emptyParams),
  'web.fetch': gatewayDecoder('web.fetch', strictObject({
    url: Type.String(), prompt: optionalString,
    lane: optionalString,
  })),
  'web.fetch_binary': gatewayDecoder('web.fetch_binary', strictObject({
    url: Type.String(),
    lane: optionalString,
    maxBytes: optionalNumber,
    headers: Type.Optional(stringRecord),
  })),
  'web.request_binary': gatewayDecoder('web.request_binary', strictObject({
    url: Type.String(),
    lane: optionalString,
    maxBytes: optionalNumber,
    headers: Type.Optional(stringRecord),
    method: optionalString,
    bodyBase64: optionalString,
  })),
  'web.search': gatewayDecoder('web.search', strictObject({
    query: Type.String(), maxResults: optionalNumber,
  })),
  'shell.exec': gatewayDecoder('shell.exec', strictObject({
    command: Type.String(), args: Type.Optional(stringArray), cwd: optionalString,
    timeoutMs: optionalNumber, maxOutputChars: optionalNumber, envVars: Type.Optional(stringArray),
  })),
  'shard.backend.request': gatewayDecoder('shard.backend.request', strictObject({
    backend: enumSchema(['container', 'orchestrated']),
    shardId: Type.String(), name: Type.String(), ownerVersion: Type.String(), grantDigest: Type.String(),
    // Legacy/spoofed authority assertions are admitted only so the existing
    // handler can ignore them and produce its capability-specific denial.
    capabilityTier: optionalString,
    customTokens: Type.Optional(stringArray),
  })),
  'vault.write': gatewayDecoder('vault.write', correlatedParams({
    name: Type.String(), content: Type.String(), folder: optionalString,
    mode: Type.Optional(enumSchema(['create', 'append', 'prepend'])),
  })),
  'vault.read': gatewayDecoder('vault.read', correlatedParams({ name: Type.String() })),
  'vault.search': gatewayDecoder('vault.search', correlatedParams({
    query: Type.String(), limit: optionalNumber,
  })),
  'vault.daily': gatewayDecoder('vault.daily', correlatedParams({ content: optionalString })),
  'fs.read': gatewayDecoder('fs.read', strictObject({
    path: Type.String(), maxBytes: optionalNumber, offsetBytes: optionalNumber,
  })),
  'fs.write': gatewayDecoder('fs.write', strictObject({ path: Type.String(), content: Type.String() })),
  'fs.list': gatewayDecoder('fs.list', strictObject({
    path: optionalString, glob: optionalString, maxEntries: optionalNumber,
    maxScannedEntries: optionalNumber,
  })),
  'fs.search': gatewayDecoder('fs.search', strictObject({
    query: Type.String(), glob: optionalString,
    mode: Type.Optional(enumSchema(['literal', 'regex'])),
    maxMatches: optionalNumber, maxFiles: optionalNumber, maxBytesPerFile: optionalNumber,
    contextLines: optionalNumber,
  })),
  'fs.edit': gatewayDecoder('fs.edit', strictObject({
    path: Type.String(), oldText: Type.String(), newText: Type.String(), replaceAll: optionalBoolean,
  })),
  'git.status': gatewayDecoder('git.status', emptyParams),
  'git.diff': gatewayDecoder('git.diff', strictObject({ staged: optionalBoolean })),
  'git.create_branch': gatewayDecoder('git.create_branch', strictObject({
    name: Type.String(), startPoint: optionalString,
  })),
  'git.apply_patch': gatewayDecoder('git.apply_patch', strictObject({
    filePath: Type.String(), content: Type.String(),
  })),
  'git.commit': gatewayDecoder('git.commit', strictObject({
    message: Type.String(), intent: Type.String(), scope: optionalString,
  })),
  'git.open_pr': gatewayDecoder('git.open_pr', strictObject({
    title: Type.String(), body: Type.String(), base: optionalString,
  })),
  'beads.ready': gatewayDecoder('beads.ready', correlatedParams({ actor: optionalString, limit: optionalNumber })),
  'beads.show': gatewayDecoder('beads.show', correlatedParams({ actor: optionalString, id: Type.String() })),
  'beads.create': gatewayDecoder('beads.create', correlatedParams({
    actor: optionalString, title: Type.String(), description: optionalString, acceptance: optionalString,
    issueType: Type.Optional(enumSchema(['bug', 'feature', 'task', 'epic', 'chore'])),
    priority: optionalNumber, deps: Type.Optional(stringArray), parent: optionalString,
  })),
  'beads.update': gatewayDecoder('beads.update', correlatedParams({
    actor: optionalString, id: Type.String(),
    status: Type.Optional(enumSchema(['open', 'in_progress', 'blocked', 'closed'])),
    priority: optionalNumber,
  })),
  'beads.close': gatewayDecoder('beads.close', correlatedParams({
    actor: optionalString, id: Type.String(), reason: Type.String(),
  })),
  'beads.sync': gatewayDecoder('beads.sync', correlatedParams({ actor: optionalString })),
  'image.create': gatewayDecoder('image.create', strictObject({
    ...imageCommon,
    guidanceScale: optionalNumber,
    numInferenceSteps: optionalNumber,
    acceleration: optionalString,
    enablePromptExpansion: optionalBoolean,
    enableSafetyChecker: optionalBoolean,
    negativePrompt: optionalString,
    useTurbo: optionalBoolean,
  })) as NamedRpcParamsDecoder<'image.create'>,
  'image.edit': gatewayDecoder('image.edit', strictObject({
    ...imageCommon,
    imageUrls: stringArray,
    maskImageUrl: optionalString,
    inputFidelity: optionalString,
  })) as NamedRpcParamsDecoder<'image.edit'>,
  'home_assistant.get_states': gatewayDecoder('home_assistant.get_states', correlatedParams({
    entityId: optionalString,
  })),
  'home_assistant.call_service': gatewayDecoder('home_assistant.call_service', correlatedParams({
    domain: Type.String(), service: Type.String(), placeId: Type.String(), affordanceId: Type.String(),
    reason: Type.String(),
    intent: Type.Optional(enumSchema([
      'direct', 'presence_enter', 'presence_exit', 'attention', 'sleep', 'wake',
    ])),
    entityId: optionalString, entityIds: Type.Optional(stringArray), data: Type.Optional(unknownRecord),
  })),
  'home_assistant.check_connection': gatewayDecoder('home_assistant.check_connection', correlatedParams()),
  'session.hmac.sign': gatewayDecoder('session.hmac.sign', strictObject({
    entry: journalEntry,
    previousHmac: Type.Union([Type.String(), Type.Null()]),
  })),
  'session.hmac.verify': gatewayDecoder('session.hmac.verify', strictObject({
    entry: journalEntry,
    previousHmac: Type.Union([Type.String(), Type.Null()]),
  })),
  'kube.self_management': gatewayDecoder('kube.self_management', Type.Union([
    strictObject({
      action: enumSchema(['diagnose', 'validate']),
      namespace: Type.String(),
      release: Type.String(),
    }),
    strictObject({
      action: enumSchema(['restart', 'rebuild', 'deploy', 'rollback']),
      namespace: Type.String(),
      release: Type.String(),
      sourceRevision: Type.String(),
      targetImage: Type.String(),
      helmRevision: optionalInteger,
      reason: Type.String(),
    }),
  ])),
} as const;

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

export function objectParamsDecoder(method: string): RpcParamsDecoder<Record<string, unknown>> {
  return checkedDecoder<Record<string, unknown>>(method, unknownRecord);
}

function optionalCanonicalUuid(): TSchema {
  return Type.Optional(Type.String({
    pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  }));
}
