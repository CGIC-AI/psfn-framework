import type { AdminTurnSnapshotData } from '../types';
import { isObservabilityCallType } from '../../../../src/shared/contracts/observability-call-types.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
} from '../../../../src/shared/contracts/charge-policy.js';
import {
  CHANNEL_TYPES,
  REQUESTER_PROVENANCE_VALUES,
} from '../../../../src/shared/contracts/runtime.js';
import { isChannelPrivacy } from '../../../../src/system/trust/context-envelope.js';
import { parseSessionContext, parseToolContext } from './turn-snapshot-parser/context';
import { parseFatigue } from './turn-snapshot-parser/fatigue';
import { parseMemoryContext } from './turn-snapshot-parser/memory';
import { parsePlan, parsePromptSnapshot } from './turn-snapshot-parser/plan';
import { parsePromptContext } from './turn-snapshot-parser/provider';
import {
  optionalString,
  parseJsonValue,
  reject,
  requireBoolean,
  requireExactRecord,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requireString,
} from './turn-snapshot-parser/primitives';

export type TurnSnapshotParseResult =
  | { ok: true; value: AdminTurnSnapshotData }
  | { ok: false; error: string };

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
  'fatigue',
];

const EVENT_DATA_KEYS = [
  'snapshot',
  'companionId',
  'sessionId',
  'turnId',
  'requestId',
  'channelId',
  'channelType',
  'toolName',
  'toolCallId',
  'originType',
  'originStage',
  'telemetryVisibility',
  'service',
  'process',
  'chargeLane',
  'chargeSurface',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
  'shardId',
  'subagentId',
  'conversationId',
  'rootInitiationId',
  'workloadType',
  'workloadId',
  'callType',
  'purpose',
  'viewerTrustLevel',
  'requesterProvenance',
  'viewerChannelPrivacy',
  'viewerIsDirectMessage',
  'viewerMemorySubjectContactId',
  'embodimentContext',
  'icpCorrelation',
];

const EVENT_STRING_KEYS = [
  'companionId',
  'sessionId',
  'turnId',
  'requestId',
  'channelId',
  'toolName',
  'toolCallId',
  'originStage',
  'service',
  'process',
  'chargeEventId',
  'chargeRunId',
  'chargeRootRunId',
  'chargeParentRunId',
  'shardId',
  'subagentId',
  'conversationId',
  'rootInitiationId',
  'workloadType',
  'workloadId',
  'purpose',
  'viewerMemorySubjectContactId',
];

function requireTrustLevel(value: unknown, path: string): string {
  const result = requireString(value, path);
  if (result !== 'primary' && result !== 'trusted' && result !== 'regular' && result !== 'public') {
    reject(path, `contains unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function requireOneOf(value: unknown, path: string, allowed: readonly string[]): string {
  const result = requireString(value, path);
  if (!allowed.includes(result)) {
    reject(path, `contains unsupported value ${JSON.stringify(result)}`);
  }
  return result;
}

function validateEventMetadata(data: Record<string, unknown>): void {
  for (const key of EVENT_STRING_KEYS) {
    if (data[key] !== undefined) requireNonEmptyString(data[key], `event.data.${key}`);
  }
  for (const key of ['callType', 'originType']) {
    const value = data[key];
    if (value !== undefined && !isObservabilityCallType(value)) {
      reject(`event.data.${key}`, `contains unsupported value ${JSON.stringify(value)}`);
    }
  }
  if (data.channelType !== undefined) {
    requireOneOf(data.channelType, 'event.data.channelType', CHANNEL_TYPES);
  }
  if (data.telemetryVisibility !== undefined) {
    requireOneOf(data.telemetryVisibility, 'event.data.telemetryVisibility', [
      'operator_visible',
      'companion_private',
    ]);
  }
  if (data.chargeLane !== undefined) {
    requireOneOf(
      data.chargeLane,
      'event.data.chargeLane',
      CHARGE_POLICY_RUNTIME_LANE_VALUES,
    );
  }
  if (data.chargeSurface !== undefined) {
    requireOneOf(
      data.chargeSurface,
      'event.data.chargeSurface',
      CHARGE_POLICY_SURFACE_VALUES,
    );
  }
  if (data.viewerTrustLevel !== undefined) {
    requireTrustLevel(data.viewerTrustLevel, 'event.data.viewerTrustLevel');
  }
  if (data.requesterProvenance !== undefined) {
    requireOneOf(
      data.requesterProvenance,
      'event.data.requesterProvenance',
      REQUESTER_PROVENANCE_VALUES,
    );
  }
  if (data.viewerChannelPrivacy !== undefined && !isChannelPrivacy(data.viewerChannelPrivacy)) {
    reject(
      'event.data.viewerChannelPrivacy',
      `contains unsupported value ${JSON.stringify(data.viewerChannelPrivacy)}`,
    );
  }
  if (data.viewerIsDirectMessage !== undefined) {
    requireBoolean(data.viewerIsDirectMessage, 'event.data.viewerIsDirectMessage');
  }
  for (const key of ['embodimentContext', 'icpCorrelation']) {
    if (data[key] !== undefined) {
      parseJsonValue(data[key], `event.data.${key}`, new WeakSet<object>());
    }
  }
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
    ...(fatigue !== undefined ? { fatigue } : {}),
  };
}

function describeFailure(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Malformed turn snapshot caused an unknown parse failure';
}

/** Total parser shared by persisted API replay and live WebSocket ingestion. */
export function parsePersistedTurnSnapshot(value: unknown): TurnSnapshotParseResult {
  try {
    return { ok: true, value: parseSnapshot(value) };
  } catch (cause) {
    return { ok: false, error: describeFailure(cause) };
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
    return { ok: false, error: describeFailure(cause) };
  }
}
