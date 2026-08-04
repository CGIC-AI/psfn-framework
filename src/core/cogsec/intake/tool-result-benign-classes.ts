import { isRecord } from '../../../shared/utils/types.js';
import type { IntakeBenignClass } from '../../../system/config/intake-policy-config.js';

export interface ToolResultBenignClassInput {
  toolName: string;
  arguments: unknown;
  text: string;
}

export interface ToolResultBenignClassification {
  benignClass: IntakeBenignClass;
  /** The same result with the request-bound benign field neutralized for a control scan. */
  controlText: string;
}

interface BeadsCreateRequestProof {
  title: string;
  actor?: string;
}

const BEADS_CREATE_PAYLOAD_KEYS = [
  'assignee',
  'created_at',
  'created_by',
  'id',
  'issue_type',
  'labels',
  'owner',
  'priority',
  'schema_version',
  'status',
  'title',
  'updated_at',
] as const;

const BEADS_CREATE_PAYLOAD_STRING_KEYS = [
  'assignee',
  'created_at',
  'created_by',
  'issue_type',
  'owner',
  'status',
  'updated_at',
] as const;

function requestedBeadsCreate(value: unknown): BeadsCreateRequestProof | undefined {
  if (!isRecord(value)) return undefined;
  const action = typeof value.action === 'string' ? value.action.trim() : '';
  if (action !== 'create' && action !== 'issue_create') return undefined;
  if (typeof value.title !== 'string') return undefined;
  const title = value.title.trim();
  if (!title) return undefined;
  const actor = typeof value.actor === 'string' ? value.actor.trim() : '';
  return { title, ...(actor ? { actor } : {}) };
}

function isCanonicalBeadsCreatePayload(value: unknown, requestedTitle: string): boolean {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !(BEADS_CREATE_PAYLOAD_KEYS as readonly string[]).includes(key))
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || typeof value.title !== 'string'
    || value.title.trim() !== requestedTitle) {
    return false;
  }
  for (const key of BEADS_CREATE_PAYLOAD_STRING_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  if (value.priority !== undefined
    && (typeof value.priority !== 'number' || !Number.isInteger(value.priority))) {
    return false;
  }
  if (value.schema_version !== undefined
    && (typeof value.schema_version !== 'number' || !Number.isInteger(value.schema_version))) {
    return false;
  }
  return value.labels === undefined
    || (Array.isArray(value.labels) && value.labels.every((label) => typeof label === 'string'));
}

function matchingBeadsCreateResult(
  text: string,
  request: BeadsCreateRequestProof,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).some((key) => !['actor', 'action', 'target', 'result', 'payload'].includes(key))
    || parsed.action !== 'create'
    || parsed.target !== 'new'
    || parsed.result !== 'success'
    || typeof parsed.actor !== 'string'
    || parsed.actor.trim().length === 0
    || (request.actor !== undefined && parsed.actor.trim() !== request.actor)
    || JSON.stringify(parsed, null, 2) !== text
    || !isCanonicalBeadsCreatePayload(parsed.payload, request.title)) {
    return undefined;
  }
  return parsed;
}

/**
 * Returns a benign class only when trusted runtime provenance and the exact
 * result shape prove that mutation language is database record content.
 */
export function classifyToolResultBenignClass(
  input: ToolResultBenignClassInput,
): ToolResultBenignClassification | undefined {
  if (input.toolName !== 'beads') return undefined;
  const request = requestedBeadsCreate(input.arguments);
  if (!request) return undefined;
  const parsed = matchingBeadsCreateResult(input.text, request);
  if (!parsed || !isRecord(parsed.payload)) return undefined;
  return {
    benignClass: 'beads_database_create',
    controlText: JSON.stringify({
      ...parsed,
      payload: { ...parsed.payload, title: 'tracked database issue' },
    }, null, 2),
  };
}
