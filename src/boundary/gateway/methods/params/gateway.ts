import { Type } from '@sinclair/typebox';

import {
  attachment,
  correlationProperties,
  correlatedParams,
  emptyParams,
  enumSchema,
  gatewayDecoder,
  type NamedRpcParamsDecoder,
  optionalBoolean,
  optionalInteger,
  optionalNumber,
  optionalString,
  strictObject,
  stringArray,
  stringRecord,
  unknownRecord,
} from './schema.js';

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
  provider: Type.Optional(enumSchema(['auto', 'fal', 'comfyui', 'comfyui_mcp'])),
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

export const gatewayOperationalParamDecoders = {
  'channel.send': gatewayDecoder('channel.send', strictObject({
    channelType: enumSchema(['buzz']), channelId: Type.String(), content: Type.String(),
  })),
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
    idempotencyKey: optionalString,
    sender: notificationSender,
  })),
  'notify.operator': gatewayDecoder('notify.operator', strictObject({
    message: Type.String(), title: optionalString, priority: optionalNumber, topic: optionalString,
    idempotencyKey: optionalString,
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
