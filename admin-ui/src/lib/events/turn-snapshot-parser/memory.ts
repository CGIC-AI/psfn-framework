import {
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
} from '../../../../../src/shared/contracts/episodic-memory.js';
import { GROUP_MEMORY_ADDRESS_MODES } from '../../../../../src/faculties/memory/types.js';
import type {
  AdminObservedMemory,
  AdminObservedScoredMemory,
  AdminTurnMemorySnapshotData,
  MemoryWithheldSummary,
} from '../../types';
import {
  optionalNonNegativeInteger,
  optionalString,
  parseArray,
  parseJsonValue,
  parseStringArray,
  reject,
  requireBoolean,
  requireExactRecord,
  requireFiniteNumber,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requirePlainRecord,
  requireString,
} from './primitives';

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

function requireUnitInterval(value: unknown, path: string): number {
  const result = requireFiniteNumber(value, path);
  if (result < 0 || result > 1) reject(path, 'must be between 0 and 1');
  return result;
}

function requireSignedUnitInterval(value: unknown, path: string): number {
  const result = requireFiniteNumber(value, path);
  if (result < -1 || result > 1) reject(path, 'must be between -1 and 1');
  return result;
}

function parseFormationVAD(
  value: unknown,
  path: string,
): NonNullable<AdminObservedMemory['formationVAD']> {
  const source = requireExactRecord(value, path, ['valence', 'arousal', 'dominance']);
  return {
    valence: requireSignedUnitInterval(source.valence, `${path}.valence`),
    arousal: requireSignedUnitInterval(source.arousal, `${path}.arousal`),
    dominance: requireSignedUnitInterval(source.dominance, `${path}.dominance`),
  };
}

const MEMORY_PROVENANCE_KEYS = [
  'channelId',
  'turnId',
  'requestId',
  'toolName',
  'toolCallId',
  'templateId',
  'templateName',
  'sessionId',
  'mode',
  'shardId',
  'actor',
  'reason',
  'triggerContactId',
  'routedContactId',
  'sourceContactId',
  'sourceAuthorId',
  'sourceSpeakerName',
  'subjectContactId',
  'subjectContactIds',
  'subjectName',
  'addressMode',
  'routingReason',
  'sourceMessageIds',
  'sourceSpanStartMessageId',
  'sourceSpanEndMessageId',
] as const;

function parseMemoryProvenance(
  value: unknown,
  path: string,
): NonNullable<AdminObservedMemory['provenance']> {
  const source = requireExactRecord(value, path, MEMORY_PROVENANCE_KEYS);
  const result: NonNullable<AdminObservedMemory['provenance']> = {};
  for (const key of [
    'channelId',
    'turnId',
    'requestId',
    'toolName',
    'toolCallId',
    'templateId',
    'templateName',
    'sessionId',
    'mode',
    'shardId',
    'reason',
    'triggerContactId',
    'routedContactId',
    'sourceContactId',
    'sourceAuthorId',
    'sourceSpeakerName',
    'subjectContactId',
    'subjectName',
    'routingReason',
  ] as const) {
    const parsed = optionalString(source, key, path);
    if (parsed !== undefined) result[key] = parsed;
  }
  if (source.actor !== undefined) {
    result.actor = requireOneOf(source.actor, `${path}.actor`, [
      'companion', 'operator', 'system', 'shard', 'repl',
    ] as const);
  }
  if (source.addressMode !== undefined) {
    result.addressMode = requireOneOf(
      source.addressMode,
      `${path}.addressMode`,
      GROUP_MEMORY_ADDRESS_MODES,
    );
  }
  if (source.subjectContactIds !== undefined) {
    result.subjectContactIds = parseStringArray(
      source.subjectContactIds,
      `${path}.subjectContactIds`,
    );
  }
  if (source.sourceMessageIds !== undefined) {
    result.sourceMessageIds = parseArray(
      source.sourceMessageIds,
      `${path}.sourceMessageIds`,
      requireNonNegativeInteger,
    );
  }
  const sourceSpanStartMessageId = optionalNonNegativeInteger(
    source,
    'sourceSpanStartMessageId',
    path,
  );
  const sourceSpanEndMessageId = optionalNonNegativeInteger(
    source,
    'sourceSpanEndMessageId',
    path,
  );
  if (sourceSpanStartMessageId !== undefined) {
    result.sourceSpanStartMessageId = sourceSpanStartMessageId;
  }
  if (sourceSpanEndMessageId !== undefined) {
    result.sourceSpanEndMessageId = sourceSpanEndMessageId;
  }
  return result;
}

function parseMemoryScopeRef(
  value: unknown,
  path: string,
): NonNullable<AdminObservedMemory['scopeRef']> {
  const source = requireExactRecord(value, path, ['kind', 'id', 'label']);
  const label = optionalString(source, 'label', path);
  return {
    kind: requireOneOf(source.kind, `${path}.kind`, [
      'conversation', 'contact', 'project', 'north_star', 'task_worker', 'shard', 'system',
    ] as const),
    id: requireNonEmptyString(source.id, `${path}.id`),
    ...(label !== undefined ? { label } : {}),
  };
}

function parseConsentFlags(
  value: unknown,
  path: string,
): NonNullable<AdminObservedMemory['consentFlags']> {
  const source = requireExactRecord(value, path, [
    'allowRecall',
    'allowAbstraction',
    'deleteOnRequest',
    'redactionBehavior',
  ]);
  const result: NonNullable<AdminObservedMemory['consentFlags']> = {};
  for (const key of ['allowRecall', 'allowAbstraction', 'deleteOnRequest'] as const) {
    if (source[key] !== undefined) result[key] = requireBoolean(source[key], `${path}.${key}`);
  }
  if (source.redactionBehavior !== undefined) {
    result.redactionBehavior = requireOneOf(
      source.redactionBehavior,
      `${path}.redactionBehavior`,
      ['delete', 'abstract'] as const,
    );
  }
  return result;
}

function parseMemory(value: unknown, path: string, scored: false): AdminObservedMemory;
function parseMemory(value: unknown, path: string, scored: true): AdminObservedScoredMemory;
function parseMemory(
  value: unknown,
  path: string,
  scored: boolean,
): AdminObservedMemory | AdminObservedScoredMemory {
  const source = requireExactRecord(value, path, [
    'id', 'text', 'type', 'importance', 'confidence', 'emotionalValence', 'formationVAD',
    'salience', 'salienceDecayAnchorAt', 'sourceRef', 'sourceType', 'provenance', 'extractedAt',
    'lastAccessed', 'accessCount', 'supersededBy', 'tags', 'scopeRef', 'scopeTags',
    'provenanceRefs', 'retentionClass', 'sensitivity', 'consentFlags', 'contactId', 'deletedAt',
    'deletedBy', 'deleteReason', ...(scored ? ['similarity'] : []),
  ]);
  const type = requireOneOf(source.type, `${path}.type`, [
    'episodic', 'semantic', 'emotional', 'procedural', 'boundary', 'reflection', 'relational',
  ] as const);
  const sensitivity = requireOneOf(source.sensitivity, `${path}.sensitivity`, [
    'public', 'personal', 'intimate', 'confidential',
  ] as const);
  const sourceType = source.sourceType === undefined
    ? undefined
    : requireOneOf(source.sourceType, `${path}.sourceType`, [
      'unknown', 'turn', 'reflection', 'heartbeat', 'compaction_summary', 'shard',
      'tool_write', 'autonomous_action',
    ] as const);
  const retentionClass = source.retentionClass === undefined
    ? undefined
    : requireOneOf(source.retentionClass, `${path}.retentionClass`, ['standard', 'durable'] as const);
  const formationVAD = source.formationVAD === undefined
    ? undefined
    : parseFormationVAD(source.formationVAD, `${path}.formationVAD`);
  const provenance = source.provenance === undefined
    ? undefined
    : parseMemoryProvenance(source.provenance, `${path}.provenance`);
  const scopeRef = source.scopeRef === undefined
    ? undefined
    : parseMemoryScopeRef(source.scopeRef, `${path}.scopeRef`);
  const consentFlags = source.consentFlags === undefined
    ? undefined
    : parseConsentFlags(source.consentFlags, `${path}.consentFlags`);
  const salienceDecayAnchorAt = optionalNonNegativeInteger(source, 'salienceDecayAnchorAt', path);
  const supersededBy = optionalString(source, 'supersededBy', path);
  const scopeTags = source.scopeTags === undefined
    ? undefined
    : parseStringArray(source.scopeTags, `${path}.scopeTags`);
  const provenanceRefs = source.provenanceRefs === undefined
    ? undefined
    : parseStringArray(source.provenanceRefs, `${path}.provenanceRefs`);
  const contactId = optionalString(source, 'contactId', path);
  const deletedAt = optionalNonNegativeInteger(source, 'deletedAt', path);
  const deletedBy = optionalString(source, 'deletedBy', path);
  const deleteReason = optionalString(source, 'deleteReason', path);
  const base: AdminObservedMemory = {
    id: requireNonEmptyString(source.id, `${path}.id`),
    text: requireString(source.text, `${path}.text`),
    type,
    importance: requireUnitInterval(source.importance, `${path}.importance`),
    confidence: requireUnitInterval(source.confidence, `${path}.confidence`),
    emotionalValence: requireSignedUnitInterval(
      source.emotionalValence,
      `${path}.emotionalValence`,
    ),
    ...(formationVAD !== undefined ? { formationVAD } : {}),
    salience: requireUnitInterval(source.salience, `${path}.salience`),
    ...(salienceDecayAnchorAt !== undefined ? { salienceDecayAnchorAt } : {}),
    sourceRef: requireString(source.sourceRef, `${path}.sourceRef`),
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    extractedAt: requireNonNegativeInteger(source.extractedAt, `${path}.extractedAt`),
    lastAccessed: requireNonNegativeInteger(source.lastAccessed, `${path}.lastAccessed`),
    accessCount: requireNonNegativeInteger(source.accessCount, `${path}.accessCount`),
    ...(supersededBy !== undefined ? { supersededBy } : {}),
    tags: parseStringArray(source.tags, `${path}.tags`),
    ...(scopeRef !== undefined ? { scopeRef } : {}),
    ...(scopeTags !== undefined ? { scopeTags } : {}),
    ...(provenanceRefs !== undefined ? { provenanceRefs } : {}),
    ...(retentionClass !== undefined ? { retentionClass } : {}),
    sensitivity,
    ...(consentFlags !== undefined ? { consentFlags } : {}),
    ...(contactId !== undefined ? { contactId } : {}),
    ...(deletedAt !== undefined ? { deletedAt } : {}),
    ...(deletedBy !== undefined ? { deletedBy } : {}),
    ...(deleteReason !== undefined ? { deleteReason } : {}),
  };
  if (!scored) return base;
  return {
    ...base,
    similarity: requireSignedUnitInterval(source.similarity, `${path}.similarity`),
  };
}

function parseContactProfile(
  value: unknown,
  path: string,
): NonNullable<AdminTurnMemorySnapshotData['profile']> {
  const source = requireExactRecord(value, path, [
    'contactId', 'summary', 'sourceMemoryIds', 'confidenceScore', 'noveltyScore', 'updatedAt',
  ]);
  return {
    contactId: requireNonEmptyString(source.contactId, `${path}.contactId`),
    summary: requireString(source.summary, `${path}.summary`),
    sourceMemoryIds: parseStringArray(source.sourceMemoryIds, `${path}.sourceMemoryIds`),
    confidenceScore: requireUnitInterval(source.confidenceScore, `${path}.confidenceScore`),
    noveltyScore: requireUnitInterval(source.noveltyScore, `${path}.noveltyScore`),
    updatedAt: requireNonNegativeInteger(source.updatedAt, `${path}.updatedAt`),
  };
}

function parseEmotionalSnapshot(
  value: unknown,
  path: string,
): NonNullable<AdminTurnMemorySnapshotData['emotionalSnapshot']> {
  const source = requireExactRecord(value, path, [
    'baselineValence',
    'moodValence',
    'moodDrift',
    'moodSamples',
    'lastMoodUpdateEpochMs',
  ]);
  const lastMoodUpdateEpochMs = optionalNonNegativeInteger(
    source,
    'lastMoodUpdateEpochMs',
    path,
  );
  return {
    baselineValence: requireSignedUnitInterval(source.baselineValence, `${path}.baselineValence`),
    moodValence: requireSignedUnitInterval(source.moodValence, `${path}.moodValence`),
    moodDrift: requireSignedUnitInterval(source.moodDrift, `${path}.moodDrift`),
    moodSamples: requireNonNegativeInteger(source.moodSamples, `${path}.moodSamples`),
    ...(lastMoodUpdateEpochMs !== undefined ? { lastMoodUpdateEpochMs } : {}),
  };
}

function parseCanonicalEpisode(value: unknown, path: string): Episode {
  const cloned = parseJsonValue(value, path, new WeakSet<object>());
  try {
    return parseEpisode(cloned);
  } catch (cause) {
    return reject(path, cause instanceof Error ? cause.message : 'is not a canonical episode');
  }
}

function parseCanonicalEpisodeArc(value: unknown, path: string): EpisodeArc {
  const cloned = parseJsonValue(value, path, new WeakSet<object>());
  try {
    return parseEpisodeArc(cloned);
  } catch (cause) {
    return reject(path, cause instanceof Error ? cause.message : 'is not a canonical episode arc');
  }
}

function parseEpisodicChain(
  value: unknown,
  path: string,
): NonNullable<AdminTurnMemorySnapshotData['episodicChains']>[number] {
  const source = requireExactRecord(value, path, [
    'rootEpisodeId', 'episodes', 'arcs', 'score', 'matchedTerms',
  ]);
  return {
    rootEpisodeId: requireNonEmptyString(source.rootEpisodeId, `${path}.rootEpisodeId`),
    episodes: parseArray(source.episodes, `${path}.episodes`, parseCanonicalEpisode),
    arcs: parseArray(source.arcs, `${path}.arcs`, parseCanonicalEpisodeArc),
    score: requireFiniteNumber(source.score, `${path}.score`),
    matchedTerms: parseStringArray(source.matchedTerms, `${path}.matchedTerms`),
  };
}

function parseCountRecord(value: unknown, path: string): Record<string, number> {
  const source = requirePlainRecord(value, path);
  const result: Record<string, number> = {};
  for (const [key, item] of Object.entries(source)) {
    Object.defineProperty(result, key, {
      value: requireNonNegativeInteger(item, `${path}.${key}`),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function parseWithheldSummary(value: unknown, path: string): MemoryWithheldSummary {
  const source = requireExactRecord(value, path, ['totalCount', 'reasonCounts', 'relevanceBands']);
  const relevanceBands = source.relevanceBands === undefined
    ? undefined
    : parseCountRecord(source.relevanceBands, `${path}.relevanceBands`);
  return {
    totalCount: requireNonNegativeInteger(source.totalCount, `${path}.totalCount`),
    reasonCounts: parseCountRecord(source.reasonCounts, `${path}.reasonCounts`),
    ...(relevanceBands !== undefined ? { relevanceBands } : {}),
  };
}

export function parseMemoryContext(
  value: unknown,
  path: string,
): AdminTurnMemorySnapshotData {
  const source = requireExactRecord(value, path, [
    'channelId', 'profile', 'emotionalSnapshot', 'contactEmotionalMemories', 'semanticCandidates',
    'lexicalCandidates', 'episodicChains', 'proactiveCandidates', 'withheldSummary', 'versionPointer',
  ]);
  const profile = source.profile === undefined
    ? undefined
    : parseContactProfile(source.profile, `${path}.profile`);
  const emotionalSnapshot = source.emotionalSnapshot === undefined
    ? undefined
    : parseEmotionalSnapshot(source.emotionalSnapshot, `${path}.emotionalSnapshot`);
  const episodicChains = source.episodicChains === undefined
    ? undefined
    : parseArray(source.episodicChains, `${path}.episodicChains`, parseEpisodicChain);
  const withheldSummary = source.withheldSummary === undefined
    ? undefined
    : parseWithheldSummary(source.withheldSummary, `${path}.withheldSummary`);
  return {
    channelId: requireNonEmptyString(source.channelId, `${path}.channelId`),
    ...(profile !== undefined ? { profile } : {}),
    ...(emotionalSnapshot !== undefined ? { emotionalSnapshot } : {}),
    contactEmotionalMemories: parseArray(
      source.contactEmotionalMemories,
      `${path}.contactEmotionalMemories`,
      (item, itemPath) => parseMemory(item, itemPath, false),
    ),
    semanticCandidates: parseArray(
      source.semanticCandidates,
      `${path}.semanticCandidates`,
      (item, itemPath) => parseMemory(item, itemPath, true),
    ),
    lexicalCandidates: parseArray(
      source.lexicalCandidates,
      `${path}.lexicalCandidates`,
      (item, itemPath) => parseMemory(item, itemPath, true),
    ),
    ...(episodicChains !== undefined ? { episodicChains } : {}),
    proactiveCandidates: parseArray(
      source.proactiveCandidates,
      `${path}.proactiveCandidates`,
      (item, itemPath) => parseMemory(item, itemPath, false),
    ),
    ...(withheldSummary !== undefined ? { withheldSummary } : {}),
    versionPointer: requireNonEmptyString(source.versionPointer, `${path}.versionPointer`),
  };
}
