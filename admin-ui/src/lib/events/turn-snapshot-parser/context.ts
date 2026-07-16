import { isObservabilityCallType } from '../../../../../src/shared/contracts/observability-call-types.js';
import type {
  AdminAdaptiveToolSnapshotCounts,
  AdminAdaptiveToolSnapshotData,
  AdminAdaptiveToolSnapshotSkip,
  AdminAdaptiveToolSnapshotTool,
  AdminObservedMemory,
  AdminObservedScoredMemory,
  AdminTurnMemorySnapshotData,
  AdminTurnSessionContextSnapshotData,
  AdminTurnToolContextSnapshotData,
  MemoryWithheldSummary,
} from '../../types';
import { parseToolSchema } from './plan';
import {
  optionalNonNegativeInteger,
  optionalString,
  parseArray,
  parseJsonRecord,
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

function parseAdaptiveTool(value: unknown, path: string): AdminAdaptiveToolSnapshotTool {
  const source = requireExactRecord(value, path, ['toolName', 'source']);
  const catalogSource = requireString(source.source, `${path}.source`);
  if (catalogSource !== 'core' && catalogSource !== 'extended') {
    reject(`${path}.source`, 'contains an unsupported value');
  }
  return {
    toolName: requireNonEmptyString(source.toolName, `${path}.toolName`),
    source: catalogSource,
  };
}

function parseAdaptiveSkip(value: unknown, path: string): AdminAdaptiveToolSnapshotSkip {
  const source = requireExactRecord(value, path, [
    'toolName',
    'source',
    'reason',
    'missingTokens',
  ]);
  if (source.source !== 'extended') reject(`${path}.source`, 'must equal extended');
  const missingTokens = source.missingTokens === undefined
    ? undefined
    : parseStringArray(source.missingTokens, `${path}.missingTokens`);
  return {
    toolName: requireNonEmptyString(source.toolName, `${path}.toolName`),
    source: 'extended',
    reason: requireNonEmptyString(source.reason, `${path}.reason`),
    ...(missingTokens !== undefined ? { missingTokens } : {}),
  };
}

function parseAdaptiveCounts(value: unknown, path: string): AdminAdaptiveToolSnapshotCounts {
  const source = requireExactRecord(value, path, ['core', 'extended', 'total']);
  const core = requireNonNegativeInteger(source.core, `${path}.core`);
  const extended = requireNonNegativeInteger(source.extended, `${path}.extended`);
  const total = requireNonNegativeInteger(source.total, `${path}.total`);
  if (core + extended !== total) reject(path, 'must have core + extended equal total');
  return { core, extended, total };
}

function parseNullableString(value: unknown, path: string): string | null {
  return value === null ? null : requireString(value, path);
}

function parseAdaptiveSnapshot(value: unknown, path: string): AdminAdaptiveToolSnapshotData {
  const source = requireExactRecord(value, path, [
    'timestamp',
    'tools',
    'skipped',
    'counts',
    'taskKind',
    'intent',
    'turnId',
    'requestId',
    'channelId',
    'callType',
    'purpose',
  ]);
  const taskKind = source.taskKind === undefined
    ? undefined
    : parseNullableString(source.taskKind, `${path}.taskKind`);
  const intent = source.intent === undefined
    ? undefined
    : parseNullableString(source.intent, `${path}.intent`);
  const turnId = optionalString(source, 'turnId', path);
  const requestId = optionalString(source, 'requestId', path);
  const channelId = optionalString(source, 'channelId', path);
  const callType = optionalString(source, 'callType', path);
  if (callType !== undefined && !isObservabilityCallType(callType)) {
    reject(`${path}.callType`, 'contains an unsupported value');
  }
  const purpose = optionalString(source, 'purpose', path);
  return {
    timestamp: requireNonNegativeInteger(source.timestamp, `${path}.timestamp`),
    tools: parseArray(source.tools, `${path}.tools`, parseAdaptiveTool),
    skipped: parseArray(source.skipped, `${path}.skipped`, parseAdaptiveSkip),
    counts: parseAdaptiveCounts(source.counts, `${path}.counts`),
    ...(taskKind !== undefined ? { taskKind } : {}),
    ...(intent !== undefined ? { intent } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(channelId !== undefined ? { channelId } : {}),
    ...(callType !== undefined ? { callType } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
  };
}

export function parseToolContext(
  value: unknown,
  path: string,
): AdminTurnToolContextSnapshotData {
  const source = requireExactRecord(value, path, ['activeTools', 'adaptiveSnapshot']);
  const activeTools = source.activeTools === undefined
    ? undefined
    : parseArray(source.activeTools, `${path}.activeTools`, parseToolSchema);
  const adaptiveSnapshot = source.adaptiveSnapshot === undefined
    ? undefined
    : parseAdaptiveSnapshot(source.adaptiveSnapshot, `${path}.adaptiveSnapshot`);
  return {
    ...(activeTools !== undefined ? { activeTools } : {}),
    ...(adaptiveSnapshot !== undefined ? { adaptiveSnapshot } : {}),
  };
}

function parseSessionRole(value: unknown, path: string): 'user' | 'assistant' | 'system' | 'tool' {
  switch (value) {
    case 'user':
    case 'assistant':
    case 'system':
    case 'tool':
      return value;
    default:
      return reject(path, `contains unsupported role ${JSON.stringify(value)}`);
  }
}

function parseSessionEntry(
  value: unknown,
  path: string,
): AdminTurnSessionContextSnapshotData['recentEntries'][number] {
  const source = requireExactRecord(value, path, [
    'id',
    'channelId',
    'role',
    'content',
    'authorId',
    'authorName',
    'timestamp',
    'discordMessageId',
    'metadata',
    'originChannelId',
    'channelVisibility',
  ]);
  const authorId = optionalString(source, 'authorId', path);
  const authorName = optionalString(source, 'authorName', path);
  const discordMessageId = optionalString(source, 'discordMessageId', path);
  const metadata = optionalString(source, 'metadata', path);
  const originChannelId = optionalString(source, 'originChannelId', path);
  const channelVisibility = optionalString(source, 'channelVisibility', path);
  return {
    id: requireNonNegativeInteger(source.id, `${path}.id`),
    channelId: requireNonEmptyString(source.channelId, `${path}.channelId`),
    role: parseSessionRole(source.role, `${path}.role`),
    content: requireString(source.content, `${path}.content`),
    ...(authorId !== undefined ? { authorId } : {}),
    ...(authorName !== undefined ? { authorName } : {}),
    timestamp: requireNonNegativeInteger(source.timestamp, `${path}.timestamp`),
    ...(discordMessageId !== undefined ? { discordMessageId } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(originChannelId !== undefined ? { originChannelId } : {}),
    ...(channelVisibility !== undefined ? { channelVisibility } : {}),
  };
}

function parseContinuityArtifact(value: unknown, path: string): unknown {
  const source = requireExactRecord(value, path, [
    'id',
    'sessionId',
    'kind',
    'summary',
    'createdAt',
    'nextAnchor',
    'facets',
    'occasion',
  ]);
  const kind = requireString(source.kind, `${path}.kind`);
  if (kind !== 'checkpoint' && kind !== 'wake_return') reject(`${path}.kind`, 'is unsupported');
  const facets = parseStringArray(source.facets, `${path}.facets`);
  if (facets.some(facet => !['task', 'relational', 'life'].includes(facet))) {
    reject(`${path}.facets`, 'contains an unsupported value');
  }
  const occasion = optionalString(source, 'occasion', path);
  if (occasion !== undefined && occasion !== 'wake' && occasion !== 'return') {
    reject(`${path}.occasion`, 'contains an unsupported value');
  }
  if ((kind === 'wake_return') !== (occasion !== undefined)) {
    reject(path, 'has an invalid kind/occasion combination');
  }
  const nextAnchor = optionalString(source, 'nextAnchor', path);
  return {
    id: requireNonEmptyString(source.id, `${path}.id`),
    sessionId: requireNonEmptyString(source.sessionId, `${path}.sessionId`),
    kind,
    summary: requireString(source.summary, `${path}.summary`),
    createdAt: requireNonEmptyString(source.createdAt, `${path}.createdAt`),
    ...(nextAnchor !== undefined ? { nextAnchor } : {}),
    facets,
    ...(occasion !== undefined ? { occasion } : {}),
  };
}

function parseOrientation(value: unknown, path: string): unknown {
  const source = requireExactRecord(value, path, [
    'fired',
    'reason',
    'observedAt',
    'idleThresholdMs',
    'lastActivityAt',
    'idleGapMs',
    'noteText',
    'sessionSummary',
    'continuitySummary',
    'lastUserMessage',
    'openThreadSummary',
    'timeTexture',
    'sourceCounts',
  ]);
  const reason = requireString(source.reason, `${path}.reason`);
  if (!['idle_gap_exceeded', 'below_threshold', 'no_previous_activity', 'internal_channel'].includes(reason)) {
    reject(`${path}.reason`, 'contains an unsupported value');
  }
  const sourceCounts = requireExactRecord(source.sourceCounts, `${path}.sourceCounts`, [
    'session',
    'continuity',
    'focusKnowledge',
  ]);
  const timeTexture = source.timeTexture === undefined
    ? undefined
    : requireExactRecord(source.timeTexture, `${path}.timeTexture`, [
      'kind',
      'label',
      'elapsedMs',
      'dayBoundaryCount',
      'reconnectionWarmth',
      'guidance',
    ]);
  if (timeTexture) {
    const kind = requireString(timeTexture.kind, `${path}.timeTexture.kind`);
    if (!['short_gap', 'long_workday', 'overnight', 'multiple_days'].includes(kind)) {
      reject(`${path}.timeTexture.kind`, 'contains an unsupported value');
    }
    const warmth = requireString(timeTexture.reconnectionWarmth, `${path}.timeTexture.reconnectionWarmth`);
    if (!['low', 'medium', 'high'].includes(warmth)) {
      reject(`${path}.timeTexture.reconnectionWarmth`, 'contains an unsupported value');
    }
  }
  const result: Record<string, unknown> = {
    fired: requireBoolean(source.fired, `${path}.fired`),
    reason,
    observedAt: requireNonNegativeInteger(source.observedAt, `${path}.observedAt`),
    idleThresholdMs: requireNonNegativeInteger(source.idleThresholdMs, `${path}.idleThresholdMs`),
    sourceCounts: {
      session: requireNonNegativeInteger(sourceCounts.session, `${path}.sourceCounts.session`),
      continuity: requireNonNegativeInteger(sourceCounts.continuity, `${path}.sourceCounts.continuity`),
      focusKnowledge: requireNonNegativeInteger(
        sourceCounts.focusKnowledge,
        `${path}.sourceCounts.focusKnowledge`,
      ),
    },
  };
  for (const key of [
    'noteText',
    'sessionSummary',
    'continuitySummary',
    'lastUserMessage',
    'openThreadSummary',
  ]) {
    const parsed = optionalString(source, key, path);
    if (parsed !== undefined) result[key] = parsed;
  }
  const lastActivityAt = optionalNonNegativeInteger(source, 'lastActivityAt', path);
  const idleGapMs = optionalNonNegativeInteger(source, 'idleGapMs', path);
  if (lastActivityAt !== undefined) result.lastActivityAt = lastActivityAt;
  if (idleGapMs !== undefined) result.idleGapMs = idleGapMs;
  if (timeTexture) {
    result.timeTexture = {
      kind: timeTexture.kind,
      label: requireString(timeTexture.label, `${path}.timeTexture.label`),
      elapsedMs: requireNonNegativeInteger(timeTexture.elapsedMs, `${path}.timeTexture.elapsedMs`),
      dayBoundaryCount: requireNonNegativeInteger(
        timeTexture.dayBoundaryCount,
        `${path}.timeTexture.dayBoundaryCount`,
      ),
      reconnectionWarmth: timeTexture.reconnectionWarmth,
      guidance: requireString(timeTexture.guidance, `${path}.timeTexture.guidance`),
    };
  }
  return result;
}

export function parseSessionContext(
  value: unknown,
  path: string,
): AdminTurnSessionContextSnapshotData {
  const source = requireExactRecord(value, path, [
    'channelId',
    'recentEntries',
    'sourceEntryCount',
    'historySummaryText',
    'historySummaryEntryCount',
    'compactionSummaryTexts',
    'focusKnowledgeTexts',
    'continuityEntries',
    'wakeReturnArtifacts',
    'orientation',
    'intentionAppraisalArtifactCount',
    'compactionPromptText',
    'versionPointer',
  ]);
  const sourceEntryCount = optionalNonNegativeInteger(source, 'sourceEntryCount', path);
  const historySummaryText = optionalString(source, 'historySummaryText', path);
  const historySummaryEntryCount = optionalNonNegativeInteger(
    source,
    'historySummaryEntryCount',
    path,
  );
  const wakeReturnArtifacts = source.wakeReturnArtifacts === undefined
    ? undefined
    : parseArray(source.wakeReturnArtifacts, `${path}.wakeReturnArtifacts`, parseContinuityArtifact);
  const orientation = source.orientation === undefined
    ? undefined
    : parseOrientation(source.orientation, `${path}.orientation`);
  const intentionAppraisalArtifactCount = optionalNonNegativeInteger(
    source,
    'intentionAppraisalArtifactCount',
    path,
  );
  const compactionPromptText = optionalString(source, 'compactionPromptText', path);
  return {
    channelId: requireNonEmptyString(source.channelId, `${path}.channelId`),
    recentEntries: parseArray(source.recentEntries, `${path}.recentEntries`, parseSessionEntry),
    ...(sourceEntryCount !== undefined ? { sourceEntryCount } : {}),
    ...(historySummaryText !== undefined ? { historySummaryText } : {}),
    ...(historySummaryEntryCount !== undefined ? { historySummaryEntryCount } : {}),
    compactionSummaryTexts: parseStringArray(
      source.compactionSummaryTexts,
      `${path}.compactionSummaryTexts`,
    ),
    focusKnowledgeTexts: parseStringArray(source.focusKnowledgeTexts, `${path}.focusKnowledgeTexts`),
    continuityEntries: parseArray(
      source.continuityEntries,
      `${path}.continuityEntries`,
      parseSessionEntry,
    ),
    ...(wakeReturnArtifacts !== undefined ? { wakeReturnArtifacts } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
    ...(intentionAppraisalArtifactCount !== undefined ? { intentionAppraisalArtifactCount } : {}),
    ...(compactionPromptText !== undefined ? { compactionPromptText } : {}),
    versionPointer: requireNonEmptyString(source.versionPointer, `${path}.versionPointer`),
  };
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
  const type = requireString(source.type, `${path}.type`);
  if (!['episodic', 'semantic', 'emotional', 'procedural', 'boundary', 'reflection', 'relational'].includes(type)) {
    reject(`${path}.type`, 'contains an unsupported value');
  }
  const sensitivity = requireString(source.sensitivity, `${path}.sensitivity`);
  if (!['public', 'personal', 'intimate', 'confidential'].includes(sensitivity)) {
    reject(`${path}.sensitivity`, 'contains an unsupported value');
  }
  const sourceType = optionalString(source, 'sourceType', path);
  if (
    sourceType !== undefined
    && ![
      'unknown', 'turn', 'reflection', 'heartbeat', 'compaction_summary', 'shard',
      'tool_write', 'autonomous_action',
    ].includes(sourceType)
  ) {
    reject(`${path}.sourceType`, 'contains an unsupported value');
  }
  const retentionClass = optionalString(source, 'retentionClass', path);
  if (retentionClass !== undefined && retentionClass !== 'standard' && retentionClass !== 'durable') {
    reject(`${path}.retentionClass`, 'contains an unsupported value');
  }
  const formationVAD = source.formationVAD === undefined
    ? undefined
    : parseJsonRecord(source.formationVAD, `${path}.formationVAD`);
  const provenance = source.provenance === undefined
    ? undefined
    : parseJsonRecord(source.provenance, `${path}.provenance`);
  const scopeRef = source.scopeRef === undefined
    ? undefined
    : parseJsonRecord(source.scopeRef, `${path}.scopeRef`);
  const consentFlags = source.consentFlags === undefined
    ? undefined
    : parseJsonRecord(source.consentFlags, `${path}.consentFlags`);
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
    importance: requireFiniteNumber(source.importance, `${path}.importance`),
    confidence: requireFiniteNumber(source.confidence, `${path}.confidence`),
    emotionalValence: requireFiniteNumber(source.emotionalValence, `${path}.emotionalValence`),
    ...(formationVAD !== undefined ? { formationVAD } : {}),
    salience: requireFiniteNumber(source.salience, `${path}.salience`),
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
    similarity: requireFiniteNumber(source.similarity, `${path}.similarity`),
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
    : parseJsonRecord(source.profile, `${path}.profile`);
  const emotionalSnapshot = source.emotionalSnapshot === undefined
    ? undefined
    : parseJsonRecord(source.emotionalSnapshot, `${path}.emotionalSnapshot`);
  const episodicChains = source.episodicChains === undefined
    ? undefined
    : parseArray(
      source.episodicChains,
      `${path}.episodicChains`,
      (item, itemPath) => parseJsonRecord(item, itemPath),
    );
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
