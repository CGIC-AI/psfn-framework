import {
  isAudienceKnowledge,
  isAudienceScope,
  isChannelPrivacy,
} from '../../../../../src/system/trust/context-envelope.js';
import { assertNoUnknownKeys } from '../../../../../src/shared/utils/types.js';
import type {
  AdminAuthenticityProvenance,
  AdminPromptPlanBlock,
  AdminPromptPlanData,
  AdminPromptSectionCacheability,
  AdminTurnPromptContextMessage,
  AdminTurnPromptSnapshotData,
  AdminTurnToolSchema,
} from '../../types';
import {
  optionalNonNegativeInteger,
  optionalString,
  parseArray,
  parseJsonRecord,
  parseNumberArray,
  parseStringArray,
  reject,
  requireBoolean,
  requireExactRecord,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requirePlainRecord,
  requireString,
} from './primitives';

function requirePromptRole(
  value: unknown,
  path: string,
): AdminTurnPromptContextMessage['role'] {
  const result = requireString(value, path);
  if (result !== 'user' && result !== 'assistant' && result !== 'system') {
    reject(path, `contains unsupported role ${JSON.stringify(result)}`);
  }
  return result;
}

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const result = requireString(value, path);
  if (!(allowed as readonly string[]).includes(result)) {
    reject(path, `contains unsupported value ${JSON.stringify(result)}`);
  }
  return result as T;
}

function requirePlanLayer(value: unknown, path: string): AdminPromptPlanBlock['layer'] {
  switch (value) {
    case 'prompt_stack':
    case 'runtime':
    case 'session':
    case 'provider':
      return value;
    default:
      return reject(path, `contains unsupported layer ${JSON.stringify(value)}`);
  }
}

function requirePlanVolatility(
  value: unknown,
  path: string,
): AdminPromptPlanBlock['volatility'] {
  switch (value) {
    case 'static':
    case 'session_stable':
    case 'turn':
      return value;
    default:
      return reject(path, `contains unsupported volatility ${JSON.stringify(value)}`);
  }
}

export function parsePromptCacheability(
  value: unknown,
  path: string,
): AdminPromptSectionCacheability {
  const source = requireExactRecord(value, path, [
    'section',
    'cacheability',
    'cacheBreakers',
    'reason',
  ]);
  return {
    section: requireCacheSection(source.section, `${path}.section`),
    cacheability: requireCacheability(source.cacheability, `${path}.cacheability`),
    cacheBreakers: parseArray(
      source.cacheBreakers,
      `${path}.cacheBreakers`,
      requireCacheBreaker,
    ),
    reason: requireString(source.reason, `${path}.reason`),
  };
}

function requireCacheSection(
  value: unknown,
  path: string,
): AdminPromptSectionCacheability['section'] {
  switch (value) {
    case 'staticPrefixTemplate':
    case 'dynamicSuffixTemplate':
    case 'renderedStaticPrefix':
    case 'renderedDynamicSuffix':
    case 'runtimeContext':
    case 'memoryContextBlock':
    case 'scratchpadContext':
    case 'assembledPrompt':
    case 'finalSystemPrompt':
    case 'messages':
      return value;
    default:
      return reject(path, `contains unsupported value ${JSON.stringify(value)}`);
  }
}

function requireCacheability(
  value: unknown,
  path: string,
): AdminPromptSectionCacheability['cacheability'] {
  switch (value) {
    case 'static':
    case 'session_stable':
    case 'append_only':
    case 'volatile':
      return value;
    default:
      return reject(path, `contains unsupported value ${JSON.stringify(value)}`);
  }
}

function requireCacheBreaker(
  value: unknown,
  path: string,
): AdminPromptSectionCacheability['cacheBreakers'][number] {
  switch (value) {
    case 'prompt_layer':
    case 'runtime':
    case 'channel':
    case 'task':
    case 'macro':
    case 'tool':
    case 'retrieval':
    case 'scratchpad':
    case 'session_history':
      return value;
    default:
      return reject(path, `contains unsupported value ${JSON.stringify(value)}`);
  }
}

export function parsePromptSnapshot(
  value: unknown,
  path: string,
): AdminTurnPromptSnapshotData {
  const source = requireExactRecord(value, path, [
    'staticPrefixTemplate',
    'dynamicSuffixTemplate',
    'dynamicSuffixSections',
    'staticHash',
    'versionPointer',
    'sectionCacheability',
  ]);
  const dynamicSuffixSections = source.dynamicSuffixSections === undefined
    ? undefined
    : parseArray(source.dynamicSuffixSections, `${path}.dynamicSuffixSections`, (item, itemPath) => {
      const section = requireExactRecord(item, itemPath, ['identifier', 'required', 'content']);
      return {
        identifier: requireString(section.identifier, `${itemPath}.identifier`),
        required: requireBoolean(section.required, `${itemPath}.required`),
        content: requireString(section.content, `${itemPath}.content`),
      };
    });
  const sectionCacheability = source.sectionCacheability === undefined
    ? undefined
    : parseArray(source.sectionCacheability, `${path}.sectionCacheability`, parsePromptCacheability);
  return {
    staticPrefixTemplate: requireString(source.staticPrefixTemplate, `${path}.staticPrefixTemplate`),
    dynamicSuffixTemplate: requireString(source.dynamicSuffixTemplate, `${path}.dynamicSuffixTemplate`),
    ...(dynamicSuffixSections !== undefined ? { dynamicSuffixSections } : {}),
    staticHash: requireNonEmptyString(source.staticHash, `${path}.staticHash`),
    versionPointer: requireNonEmptyString(source.versionPointer, `${path}.versionPointer`),
    ...(sectionCacheability !== undefined ? { sectionCacheability } : {}),
  };
}

function requireProvenanceKind(
  value: unknown,
  path: string,
): AdminAuthenticityProvenance['kind'] {
  switch (value) {
    case 'user_direct':
    case 'companion_direct':
    case 'compaction_summary':
    case 'system_note':
    case 'system_injection':
    case 'memory_retrieval':
    case 'extraction_artifact':
    case 'projection':
    case 'search_result':
    case 'tool_result':
    case 'redacted_transformed':
      return value;
    default:
      return reject(path, `contains unsupported kind ${JSON.stringify(value)}`);
  }
}

export function parseProvenance(value: unknown, path: string): AdminAuthenticityProvenance {
  const source = requireExactRecord(value, path, [
    'schemaVersion',
    'kind',
    'sourceAuthor',
    'transformedBy',
    'wording',
    'directSpeech',
    'detailLoss',
    'emotionalTexture',
    'safeAsPartnerSpeech',
    'sourceSpanCount',
    'sourceEntryIds',
    'notes',
  ]);
  if (source.schemaVersion !== 1) reject(`${path}.schemaVersion`, 'must equal 1');
  const sourceAuthor = requireOneOf(source.sourceAuthor, `${path}.sourceAuthor`, [
    'partner', 'companion', 'system', 'tool', 'memory', 'mixed', 'unknown',
  ] as const);
  const transformedBy = requireOneOf(source.transformedBy, `${path}.transformedBy`, [
    'none', 'runtime', 'compaction', 'retrieval', 'extraction', 'projection', 'redaction', 'tool',
    'system',
  ] as const);
  const wording = requireOneOf(source.wording, `${path}.wording`, [
    'direct', 'derived', 'transformed', 'redacted',
  ] as const);
  const detailLoss = requireOneOf(source.detailLoss, `${path}.detailLoss`, [
    'none', 'possible', 'likely',
  ] as const);
  const emotionalTexture = requireOneOf(source.emotionalTexture, `${path}.emotionalTexture`, [
    'preserved', 'may_be_flattened', 'unknown',
  ] as const);
  const sourceSpanCount = optionalNonNegativeInteger(source, 'sourceSpanCount', path);
  const sourceEntryIds = source.sourceEntryIds === undefined
    ? undefined
    : parseNumberArray(source.sourceEntryIds, `${path}.sourceEntryIds`);
  const notes = source.notes === undefined
    ? undefined
    : parseStringArray(source.notes, `${path}.notes`);
  return {
    schemaVersion: 1,
    kind: requireProvenanceKind(source.kind, `${path}.kind`),
    sourceAuthor,
    transformedBy,
    wording,
    directSpeech: requireBoolean(source.directSpeech, `${path}.directSpeech`),
    detailLoss,
    emotionalTexture,
    safeAsPartnerSpeech: requireBoolean(source.safeAsPartnerSpeech, `${path}.safeAsPartnerSpeech`),
    ...(sourceSpanCount !== undefined ? { sourceSpanCount } : {}),
    ...(sourceEntryIds !== undefined ? { sourceEntryIds } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseContextMessage(
  value: unknown,
  path: string,
): AdminTurnPromptContextMessage {
  const source = requireExactRecord(value, path, ['role', 'content', 'provenance']);
  const provenance = source.provenance === undefined
    ? undefined
    : parseProvenance(source.provenance, `${path}.provenance`);
  return {
    role: requirePromptRole(source.role, `${path}.role`),
    content: requireString(source.content, `${path}.content`),
    ...(provenance !== undefined ? { provenance } : {}),
  };
}

export function parseToolSchema(value: unknown, path: string): AdminTurnToolSchema {
  const source = requireExactRecord(value, path, ['name', 'description', 'inputSchema']);
  return {
    name: requireNonEmptyString(source.name, `${path}.name`),
    description: requireString(source.description, `${path}.description`),
    inputSchema: parseJsonRecord(source.inputSchema, `${path}.inputSchema`),
  };
}

function parsePlanBlock(value: unknown, path: string): AdminPromptPlanBlock {
  const source = requireExactRecord(value, path, [
    'id',
    'layer',
    'volatility',
    'producer',
    'scopeKey',
    'renderedText',
    'tokensEst',
  ]);
  const scopeKey = optionalString(source, 'scopeKey', path);
  return {
    id: requireNonEmptyString(source.id, `${path}.id`),
    layer: requirePlanLayer(source.layer, `${path}.layer`),
    volatility: requirePlanVolatility(source.volatility, `${path}.volatility`),
    producer: requireNonEmptyString(source.producer, `${path}.producer`),
    ...(scopeKey !== undefined ? { scopeKey } : {}),
    renderedText: requireString(source.renderedText, `${path}.renderedText`),
    tokensEst: requireNonNegativeInteger(source.tokensEst, `${path}.tokensEst`),
  };
}

function parsePlanVariables(value: unknown, path: string): Record<string, string> {
  const source = requirePlainRecord(value, path);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    Object.defineProperty(result, key, {
      value: requireString(item, `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function requireDmScopeKey(value: unknown, path: string): `dm:${string}` {
  const key = requireNonEmptyString(value, path);
  if (!key.startsWith('dm:')) reject(path, 'must start with dm:');
  return `dm:${key.slice(3)}`;
}

function requireRoomScopeKey(value: unknown, path: string): `room:${string}` {
  const key = requireNonEmptyString(value, path);
  if (!key.startsWith('room:')) reject(path, 'must start with room:');
  return `room:${key.slice(5)}`;
}

function parseScope(value: unknown, path: string): AdminPromptPlanData['scope'] {
  const base = requirePlainRecord(value, path);
  const rawKind = requireString(base.kind, `${path}.kind`);
  const kind = rawKind === 'dm' || rawKind === 'group'
    ? rawKind
    : reject(`${path}.kind`, `contains unsupported value ${JSON.stringify(rawKind)}`);
  const allowed = kind === 'dm'
    ? ['kind', 'channelId', 'envelope', 'recentSpeakers', 'key', 'contact']
    : ['kind', 'channelId', 'envelope', 'recentSpeakers', 'key', 'roomName', 'memberCountHint'];
  assertNoUnknownKeys(base, allowed, path, { errorPrefix: 'Malformed turn snapshot' });
  const envelope = requireExactRecord(base.envelope, `${path}.envelope`, [
    'channelPrivacy',
    'audienceScope',
    'audienceKnowledge',
    'broadcast',
  ]);
  const { channelPrivacy, audienceScope, audienceKnowledge } = envelope;
  if (!isChannelPrivacy(channelPrivacy)) reject(`${path}.envelope.channelPrivacy`, 'is unsupported');
  if (!isAudienceScope(audienceScope)) reject(`${path}.envelope.audienceScope`, 'is unsupported');
  if (!isAudienceKnowledge(audienceKnowledge)) reject(`${path}.envelope.audienceKnowledge`, 'is unsupported');
  const recentSpeakers = parseArray(base.recentSpeakers, `${path}.recentSpeakers`, (item, itemPath) => {
    const speaker = requireExactRecord(item, itemPath, ['authorId', 'name']);
    return {
      authorId: requireNonEmptyString(speaker.authorId, `${itemPath}.authorId`),
      name: requireNonEmptyString(speaker.name, `${itemPath}.name`),
    };
  });
  const channelId = requireNonEmptyString(base.channelId, `${path}.channelId`);
  const parsedEnvelope = {
    channelPrivacy,
    audienceScope,
    audienceKnowledge,
    broadcast: requireBoolean(envelope.broadcast, `${path}.envelope.broadcast`),
  };
  if (kind === 'dm') {
    const key = requireDmScopeKey(base.key, `${path}.key`);
    const contact = requireExactRecord(base.contact, `${path}.contact`, ['contactId', 'displayName']);
    const displayName = optionalString(contact, 'displayName', `${path}.contact`);
    return {
      kind,
      channelId,
      envelope: parsedEnvelope,
      recentSpeakers,
      key,
      contact: {
        contactId: requireNonEmptyString(contact.contactId, `${path}.contact.contactId`),
        ...(displayName !== undefined ? { displayName } : {}),
      },
    };
  }
  const key = requireRoomScopeKey(base.key, `${path}.key`);
  const roomName = optionalString(base, 'roomName', path);
  const memberCountHint = optionalNonNegativeInteger(base, 'memberCountHint', path);
  return {
    kind,
    channelId,
    envelope: parsedEnvelope,
    recentSpeakers,
    key,
    ...(roomName !== undefined ? { roomName } : {}),
    ...(memberCountHint !== undefined ? { memberCountHint } : {}),
  };
}

export function parsePlan(value: unknown, path: string): AdminPromptPlanData {
  const source = requireExactRecord(value, path, [
    'schemaVersion',
    'blocks',
    'variables',
    'messages',
    'toolDefinitions',
    'cachePlan',
    'scope',
  ]);
  if (source.schemaVersion !== 1) reject(`${path}.schemaVersion`, 'must equal 1');
  const cachePlan = requireExactRecord(source.cachePlan, `${path}.cachePlan`, [
    'staticBoundary',
    'sessionStableBoundary',
  ]);
  const blocks = parseArray(source.blocks, `${path}.blocks`, parsePlanBlock);
  const staticBoundary = requireNonNegativeInteger(
    cachePlan.staticBoundary,
    `${path}.cachePlan.staticBoundary`,
  );
  const sessionStableBoundary = requireNonNegativeInteger(
    cachePlan.sessionStableBoundary,
    `${path}.cachePlan.sessionStableBoundary`,
  );
  if (staticBoundary > sessionStableBoundary || sessionStableBoundary > blocks.length) {
    reject(`${path}.cachePlan`, 'contains impossible block boundaries');
  }
  return {
    schemaVersion: 1,
    blocks,
    variables: parsePlanVariables(source.variables, `${path}.variables`),
    messages: parseArray(source.messages, `${path}.messages`, parseContextMessage),
    toolDefinitions: parseArray(source.toolDefinitions, `${path}.toolDefinitions`, parseToolSchema),
    cachePlan: { staticBoundary, sessionStableBoundary },
    scope: parseScope(source.scope, `${path}.scope`),
  };
}
