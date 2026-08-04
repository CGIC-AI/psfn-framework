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

interface BeadsReadyRequestProof {
  actor?: string;
  limit: number;
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

const BEADS_READY_REQUEST_KEYS = ['action', 'actor', 'limit'] as const;

const BEADS_READY_ISSUE_KEYS = [
  'acceptance_criteria',
  'assignee',
  'created_at',
  'created_by',
  'dependency_count',
  'dependencies',
  'dependent_count',
  'description',
  'design',
  'id',
  'issue_type',
  'labels',
  'metadata',
  'notes',
  'owner',
  'parent',
  'priority',
  'spec_id',
  'started_at',
  'status',
  'title',
  'updated_at',
  'comment_count',
] as const;

const BEADS_READY_ISSUE_STRING_KEYS = [
  'acceptance_criteria',
  'assignee',
  'created_at',
  'created_by',
  'description',
  'design',
  'id',
  'issue_type',
  'notes',
  'owner',
  'parent',
  'spec_id',
  'started_at',
  'status',
  'title',
  'updated_at',
] as const;

const BEADS_READY_ISSUE_INTEGER_KEYS = [
  'comment_count',
  'dependency_count',
  'dependent_count',
  'priority',
] as const;

const BEADS_READY_PROSE_KEYS = [
  'acceptance_criteria',
  'description',
  'design',
  'notes',
  'title',
] as const;

const BEADS_READY_DEPENDENCY_KEYS = [
  'created_at',
  'created_by',
  'depends_on_id',
  'issue_id',
  'metadata',
  'type',
] as const;

function requestedBeadsReady(value: unknown): BeadsReadyRequestProof | undefined {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !(BEADS_READY_REQUEST_KEYS as readonly string[]).includes(key))) {
    return undefined;
  }
  const action = value.action === undefined
    ? ''
    : typeof value.action === 'string' ? value.action.trim() : undefined;
  if (action === undefined || (action !== '' && action !== 'ready' && action !== 'issue_ready')) {
    return undefined;
  }
  const limit = value.limit === undefined ? 20 : value.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return undefined;
  }
  const actor = typeof value.actor === 'string' ? value.actor.trim() : '';
  return { limit, ...(actor ? { actor } : {}) };
}

function isCanonicalBeadsReadyDependency(value: unknown): boolean {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !(BEADS_READY_DEPENDENCY_KEYS as readonly string[]).includes(key))
    || Object.keys(value).length !== BEADS_READY_DEPENDENCY_KEYS.length) {
    return false;
  }
  return BEADS_READY_DEPENDENCY_KEYS.every((key) => (
    typeof value[key] === 'string'
  ));
}

function isCanonicalBeadsReadyIssue(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !(BEADS_READY_ISSUE_KEYS as readonly string[]).includes(key))
    || typeof value.id !== 'string'
    || value.id.trim().length === 0
    || typeof value.title !== 'string'
    || value.title.trim().length === 0) {
    return false;
  }
  for (const key of BEADS_READY_ISSUE_STRING_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false;
  }
  for (const key of BEADS_READY_ISSUE_INTEGER_KEYS) {
    if (typeof value[key] !== 'number' || !Number.isInteger(value[key])) return false;
  }
  if (!['created_at', 'created_by', 'issue_type', 'owner', 'status', 'updated_at'].every((key) => (
    typeof value[key] === 'string' && value[key].trim().length > 0
  ))) {
    return false;
  }
  if (value.labels !== undefined
    && (!Array.isArray(value.labels) || value.labels.some((label) => typeof label !== 'string'))) {
    return false;
  }
  if (value.dependencies !== undefined
    && (!Array.isArray(value.dependencies)
      || value.dependencies.some((dependency) => !isCanonicalBeadsReadyDependency(dependency)))) {
    return false;
  }
  return value.metadata === undefined || isRecord(value.metadata);
}

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

function matchingBeadsReadyResult(
  text: string,
  request: BeadsReadyRequestProof,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)
    || Object.keys(parsed).some((key) => !['actor', 'action', 'target', 'result', 'payload'].includes(key))
    || parsed.action !== 'ready'
    || parsed.target !== 'ready'
    || parsed.result !== 'success'
    || typeof parsed.actor !== 'string'
    || parsed.actor.trim().length === 0
    || (request.actor !== undefined && parsed.actor.trim() !== request.actor)
    || JSON.stringify(parsed, null, 2) !== text
    || !Array.isArray(parsed.payload)
    || parsed.payload.length > request.limit
    || parsed.payload.some((issue) => !isCanonicalBeadsReadyIssue(issue))) {
    return undefined;
  }
  return parsed;
}

function neutralizeBeadsReadyIssue(issue: Record<string, unknown>): Record<string, unknown> {
  const neutralized = { ...issue };
  for (const key of BEADS_READY_PROSE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(issue, key)) {
      neutralized[key] = 'tracked database issue field';
    }
  }
  return neutralized;
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
  if (request) {
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
  const readyRequest = requestedBeadsReady(input.arguments);
  if (!readyRequest) return undefined;
  const readyResult = matchingBeadsReadyResult(input.text, readyRequest);
  if (!readyResult || !Array.isArray(readyResult.payload)) return undefined;
  return {
    benignClass: 'beads_database_ready',
    controlText: JSON.stringify({
      ...readyResult,
      payload: readyResult.payload.map((issue) => neutralizeBeadsReadyIssue(issue)),
    }, null, 2),
  };
}
