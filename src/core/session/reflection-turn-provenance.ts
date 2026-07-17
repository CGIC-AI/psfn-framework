import type { ReflectionTurnProvenance } from '../../shared/contracts/runtime.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';
import type { SessionEntry } from './types.js';

export const SESSION_METADATA_REFLECTION_TURN_KEY = 'reflectionTurn';

const REFLECTION_TURN_KEYS: readonly string[] = [
  'schemaVersion',
  'stage',
  'templateId',
  'mode',
  'journalEntryId',
];

interface SessionMetadataEnvelope {
  [key: string]: unknown;
}

function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing reflection turn provenance parsing');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for reflection turn provenance parsing');
  }
  return parsed;
}

function isReflectionTurnStage(value: unknown): value is ReflectionTurnProvenance['stage'] {
  return value === 'tool_grounding' || value === 'final_output';
}

function isReflectionTurnMode(value: unknown): value is ReflectionTurnProvenance['mode'] {
  return value === 'agent' || value === 'deliberation';
}

function parseReflectionTurnProvenance(value: unknown): ReflectionTurnProvenance {
  if (!isRecord(value)) {
    throw new Error('Session metadata reflectionTurn field must be an object');
  }
  assertNoUnknownKeys(value, REFLECTION_TURN_KEYS, 'reflectionTurn', {
    errorPrefix: 'Session metadata',
  });
  if (value.schemaVersion !== 1) {
    throw new Error('Session metadata reflectionTurn schemaVersion must be 1');
  }
  if (!isReflectionTurnStage(value.stage)) {
    throw new Error('Session metadata reflectionTurn stage is invalid');
  }
  if (!isReflectionTurnMode(value.mode)) {
    throw new Error('Session metadata reflectionTurn mode is invalid');
  }
  if (typeof value.templateId !== 'string' || !value.templateId.trim()) {
    throw new Error('Session metadata reflectionTurn templateId must be a non-empty string');
  }
  if (
    value.journalEntryId !== undefined
    && (typeof value.journalEntryId !== 'string' || !value.journalEntryId.trim())
  ) {
    throw new Error('Session metadata reflectionTurn journalEntryId must be a non-empty string when present');
  }
  if (value.journalEntryId !== undefined && value.stage !== 'final_output') {
    throw new Error('Session metadata reflectionTurn journalEntryId requires final_output stage');
  }
  return {
    schemaVersion: 1,
    stage: value.stage,
    templateId: value.templateId.trim(),
    mode: value.mode,
    ...(typeof value.journalEntryId === 'string'
      ? { journalEntryId: value.journalEntryId.trim() }
      : {}),
  };
}

export function buildSessionMetadataWithReflectionTurn(
  existingMetadata: string | undefined,
  provenance: ReflectionTurnProvenance,
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  return JSON.stringify({
    ...base,
    [SESSION_METADATA_REFLECTION_TURN_KEY]: parseReflectionTurnProvenance(provenance),
  });
}

export function resolveSessionEntryReflectionTurnProvenance(
  entry: Pick<SessionEntry, 'metadata'>,
): ReflectionTurnProvenance | null {
  const envelope = parseMetadataEnvelope(entry.metadata);
  const rawProvenance = envelope[SESSION_METADATA_REFLECTION_TURN_KEY];
  return rawProvenance === undefined ? null : parseReflectionTurnProvenance(rawProvenance);
}
