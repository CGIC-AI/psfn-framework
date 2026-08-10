import type { AdminTurnSnapshotData } from '../types';
import { parseSessionContext, parseToolContext } from './turn-snapshot-parser/context';
import {
  CORRELATION_METADATA_KEYS,
  parseCorrelationMetadataFields,
} from './turn-snapshot-parser/correlation';
import { parseFatigue } from './turn-snapshot-parser/fatigue';
import { parseMemoryContext } from './turn-snapshot-parser/memory';
import { parsePlan, parsePromptSnapshot } from './turn-snapshot-parser/plan';
import { parsePromptContext } from './turn-snapshot-parser/provider';
import {
  optionalString,
  parseStringArray,
  reject,
  requireExactRecord,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requireString,
  TurnSnapshotParserError,
  type TurnSnapshotFailureClassification,
} from './turn-snapshot-parser/primitives';

export type TurnSnapshotParseResult =
  | { ok: true; value: AdminTurnSnapshotData }
  | {
    ok: false;
    error: string;
    classification: TurnSnapshotFailureClassification;
  };

const SNAPSHOT_KEYS = [
  'turnId',
  'requestId',
  'channelId',
  'capturedAt',
  'trustLevel',
  'canonicalContactKey',
  'prompt',
  'plan',
  'promptContext',
  'toolContext',
  'sessionContext',
  'memory',
  'biographicalProjection',
  'fatigue',
];

const EVENT_DATA_KEYS = ['snapshot', ...CORRELATION_METADATA_KEYS];

function requireTrustLevel(value: unknown, path: string): string {
  const result = requireString(value, path);
  if (result !== 'primary' && result !== 'trusted' && result !== 'regular' && result !== 'public') {
    reject(path, `contains unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function validateEventMetadata(data: Record<string, unknown>): void {
  parseCorrelationMetadataFields(data, 'event.data');
}

function requireMatchingEventIdentity(
  data: Record<string, unknown>,
  snapshot: AdminTurnSnapshotData,
): void {
  if (data.turnId !== undefined && data.turnId !== snapshot.turnId) {
    reject('event.data.turnId', 'must match snapshot.turnId');
  }
  if (data.requestId !== undefined && data.requestId !== snapshot.requestId) {
    reject('event.data.requestId', 'must match snapshot.requestId');
  }
  if (data.channelId !== undefined && data.channelId !== snapshot.channelId) {
    reject('event.data.channelId', 'must match snapshot.channelId');
  }
}

function parseSnapshot(value: unknown): AdminTurnSnapshotData {
  const source = requireExactRecord(value, 'snapshot', SNAPSHOT_KEYS);
  const canonicalContactKey = optionalString(source, 'canonicalContactKey', 'snapshot');
  const prompt = source.prompt === undefined
    ? undefined
    : parsePromptSnapshot(source.prompt, 'snapshot.prompt');
  const plan = source.plan === undefined
    ? undefined
    : parsePlan(source.plan, 'snapshot.plan');
  const promptContext = source.promptContext === undefined
    ? undefined
    : parsePromptContext(source.promptContext, 'snapshot.promptContext');
  const toolContext = source.toolContext === undefined
    ? undefined
    : parseToolContext(source.toolContext, 'snapshot.toolContext');
  const sessionContext = source.sessionContext === undefined
    ? undefined
    : parseSessionContext(source.sessionContext, 'snapshot.sessionContext');
  const memory = source.memory === undefined
    ? undefined
    : parseMemoryContext(source.memory, 'snapshot.memory');
  const biographicalProjection = source.biographicalProjection === undefined
    ? undefined
    : (() => {
      const projection = requireExactRecord(
        source.biographicalProjection,
        'snapshot.biographicalProjection',
        ['admittedClaimIds', 'withheldCount', 'contextChars'],
      );
      return {
        admittedClaimIds: parseStringArray(
          projection.admittedClaimIds,
          'snapshot.biographicalProjection.admittedClaimIds',
        ),
        withheldCount: requireNonNegativeInteger(
          projection.withheldCount,
          'snapshot.biographicalProjection.withheldCount',
        ),
        contextChars: requireNonNegativeInteger(
          projection.contextChars,
          'snapshot.biographicalProjection.contextChars',
        ),
      };
    })();
  const fatigue = source.fatigue === undefined
    ? undefined
    : parseFatigue(source.fatigue, 'snapshot.fatigue');
  return {
    turnId: requireNonEmptyString(source.turnId, 'snapshot.turnId'),
    requestId: requireNonEmptyString(source.requestId, 'snapshot.requestId'),
    channelId: requireNonEmptyString(source.channelId, 'snapshot.channelId'),
    capturedAt: requireNonNegativeInteger(source.capturedAt, 'snapshot.capturedAt'),
    trustLevel: requireTrustLevel(source.trustLevel, 'snapshot.trustLevel'),
    ...(canonicalContactKey !== undefined ? { canonicalContactKey } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(promptContext !== undefined ? { promptContext } : {}),
    ...(toolContext !== undefined ? { toolContext } : {}),
    ...(sessionContext !== undefined ? { sessionContext } : {}),
    ...(memory !== undefined ? { memory } : {}),
    ...(biographicalProjection !== undefined ? { biographicalProjection } : {}),
    ...(fatigue !== undefined ? { fatigue } : {}),
  };
}

function describeFailure(cause: unknown): {
  error: string;
  classification: TurnSnapshotFailureClassification;
} {
  if (cause instanceof TurnSnapshotParserError) {
    return { error: cause.message, classification: cause.classification };
  }
  return {
    error: cause instanceof Error
      ? cause.message
      : 'Malformed turn snapshot caused an unknown parse failure',
    classification: 'malformed',
  };
}

/** Total parser shared by persisted API replay and live WebSocket ingestion. */
export function parsePersistedTurnSnapshot(value: unknown): TurnSnapshotParseResult {
  try {
    return { ok: true, value: parseSnapshot(value) };
  } catch (cause) {
    return { ok: false, ...describeFailure(cause) };
  }
}

/** Strict parser for the `agent.turn.snapshot` event data object. */
export function parsePersistedTurnSnapshotEventData(value: unknown): TurnSnapshotParseResult {
  try {
    const data = requireExactRecord(value, 'event.data', EVENT_DATA_KEYS);
    if (!Object.hasOwn(data, 'snapshot')) reject('event.data.snapshot', 'is required');
    validateEventMetadata(data);
    const snapshot = parseSnapshot(data.snapshot);
    requireMatchingEventIdentity(data, snapshot);
    return { ok: true, value: snapshot };
  } catch (cause) {
    return { ok: false, ...describeFailure(cause) };
  }
}
