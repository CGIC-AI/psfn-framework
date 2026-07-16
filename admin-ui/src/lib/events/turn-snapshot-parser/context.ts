import { isObservabilityCallType } from '../../../../../src/shared/contracts/observability-call-types.js';
import { isCapabilityToken } from '../../../../../src/system/capabilities/tokens.js';
import type {
  AdminAdaptiveToolSnapshotCounts,
  AdminAdaptiveToolSnapshotData,
  AdminAdaptiveToolSnapshotSkip,
  AdminAdaptiveToolSnapshotTool,
  AdminTurnSessionContextSnapshotData,
  AdminTurnToolContextSnapshotData,
} from '../../types';
import { parseToolSchema } from './plan';
import {
  optionalNonNegativeInteger,
  optionalString,
  parseArray,
  parseStringArray,
  reject,
  requireBoolean,
  requireExactRecord,
  requireNonEmptyString,
  requireNonNegativeInteger,
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
    : parseArray(source.missingTokens, `${path}.missingTokens`, (item, itemPath) => {
      if (!isCapabilityToken(item)) reject(itemPath, 'contains an unsupported capability token');
      return item;
    });
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

function parseContinuityArtifact(
  value: unknown,
  path: string,
): NonNullable<AdminTurnSessionContextSnapshotData['wakeReturnArtifacts']>[number] {
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
  const rawKind = requireString(source.kind, `${path}.kind`);
  const kind = rawKind === 'checkpoint' || rawKind === 'wake_return'
    ? rawKind
    : reject(`${path}.kind`, 'is unsupported');
  const facets = parseArray(source.facets, `${path}.facets`, (item, itemPath) => {
    const facet = requireString(item, itemPath);
    return facet === 'task' || facet === 'relational' || facet === 'life'
      ? facet
      : reject(itemPath, 'contains an unsupported value');
  });
  const rawOccasion = optionalString(source, 'occasion', path);
  const occasion = rawOccasion === undefined
    ? undefined
    : rawOccasion === 'wake' || rawOccasion === 'return'
      ? rawOccasion
      : reject(`${path}.occasion`, 'contains an unsupported value');
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

function parseOrientation(
  value: unknown,
  path: string,
): NonNullable<AdminTurnSessionContextSnapshotData['orientation']> {
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
  const rawReason = requireString(source.reason, `${path}.reason`);
  const reason = rawReason === 'idle_gap_exceeded'
    || rawReason === 'below_threshold'
    || rawReason === 'no_previous_activity'
    || rawReason === 'internal_channel'
    ? rawReason
    : reject(`${path}.reason`, 'contains an unsupported value');
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
  const noteText = optionalString(source, 'noteText', path);
  const sessionSummary = optionalString(source, 'sessionSummary', path);
  const continuitySummary = optionalString(source, 'continuitySummary', path);
  const lastUserMessage = optionalString(source, 'lastUserMessage', path);
  const openThreadSummary = optionalString(source, 'openThreadSummary', path);
  const lastActivityAt = optionalNonNegativeInteger(source, 'lastActivityAt', path);
  const idleGapMs = optionalNonNegativeInteger(source, 'idleGapMs', path);
  const parsedTimeTexture: NonNullable<
    AdminTurnSessionContextSnapshotData['orientation']
  >['timeTexture'] = timeTexture
    ? (() => {
      const rawKind = requireString(timeTexture.kind, `${path}.timeTexture.kind`);
      const kind: NonNullable<
        NonNullable<AdminTurnSessionContextSnapshotData['orientation']>['timeTexture']
      >['kind'] = rawKind === 'short_gap'
        || rawKind === 'long_workday'
        || rawKind === 'overnight'
        || rawKind === 'multiple_days'
        ? rawKind
        : reject(`${path}.timeTexture.kind`, 'contains an unsupported value');
      const rawWarmth = requireString(
        timeTexture.reconnectionWarmth,
        `${path}.timeTexture.reconnectionWarmth`,
      );
      const reconnectionWarmth: NonNullable<
        NonNullable<AdminTurnSessionContextSnapshotData['orientation']>['timeTexture']
      >['reconnectionWarmth'] = rawWarmth === 'low'
        || rawWarmth === 'medium'
        || rawWarmth === 'high'
        ? rawWarmth
        : reject(`${path}.timeTexture.reconnectionWarmth`, 'contains an unsupported value');
      return {
        kind,
        label: requireString(timeTexture.label, `${path}.timeTexture.label`),
        elapsedMs: requireNonNegativeInteger(timeTexture.elapsedMs, `${path}.timeTexture.elapsedMs`),
        dayBoundaryCount: requireNonNegativeInteger(
          timeTexture.dayBoundaryCount,
          `${path}.timeTexture.dayBoundaryCount`,
        ),
        reconnectionWarmth,
        guidance: requireString(timeTexture.guidance, `${path}.timeTexture.guidance`),
      };
    })()
    : undefined;
  return {
    fired: requireBoolean(source.fired, `${path}.fired`),
    reason,
    observedAt: requireNonNegativeInteger(source.observedAt, `${path}.observedAt`),
    idleThresholdMs: requireNonNegativeInteger(source.idleThresholdMs, `${path}.idleThresholdMs`),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(idleGapMs !== undefined ? { idleGapMs } : {}),
    ...(noteText !== undefined ? { noteText } : {}),
    ...(sessionSummary !== undefined ? { sessionSummary } : {}),
    ...(continuitySummary !== undefined ? { continuitySummary } : {}),
    ...(lastUserMessage !== undefined ? { lastUserMessage } : {}),
    ...(openThreadSummary !== undefined ? { openThreadSummary } : {}),
    ...(parsedTimeTexture !== undefined ? { timeTexture: parsedTimeTexture } : {}),
    sourceCounts: {
      session: requireNonNegativeInteger(sourceCounts.session, `${path}.sourceCounts.session`),
      continuity: requireNonNegativeInteger(sourceCounts.continuity, `${path}.sourceCounts.continuity`),
      focusKnowledge: requireNonNegativeInteger(
        sourceCounts.focusKnowledge,
        `${path}.sourceCounts.focusKnowledge`,
      ),
    },
  };
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
