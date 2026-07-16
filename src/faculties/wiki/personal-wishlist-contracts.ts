import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import type { WikiDocument } from './types.js';

export const COMPANION_WISH_STATES: readonly [
  'open',
  'acknowledged',
  'planned',
  'done',
] = [
  'open',
  'acknowledged',
  'planned',
  'done',
];

export type CompanionWishState = typeof COMPANION_WISH_STATES[number];

export interface CompanionWish {
  schemaVersion: 1;
  kind: 'companion_wish';
  id: string;
  ref: string;
  text: string;
  context?: string;
  state: CompanionWishState;
  visibility: 'primary_contact';
  createdAt: string;
  updatedAt: string;
  acknowledgedAt?: string;
  operatorResponse?: string;
  plannedAt?: string;
  beadId?: string;
  completedAt?: string;
}

const WISH_DOCUMENT_KEYS: readonly string[] = [
  'schemaVersion',
  'kind',
  'id',
  'ref',
  'text',
  'context',
  'state',
  'visibility',
  'createdAt',
  'updatedAt',
  'acknowledgedAt',
  'operatorResponse',
  'plannedAt',
  'beadId',
  'completedAt',
];

const BEAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const MAX_WISH_TEXT_CHARS = 2_000;
export const MAX_WISH_CONTEXT_CHARS = 4_000;
export const MAX_OPERATOR_RESPONSE_CHARS = 4_000;

export function requireWishText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const text = value.trim();
  if (!text) throw new Error(`${field} must be a non-empty string`);
  if (text.length > MAX_WISH_TEXT_CHARS) {
    throw new Error(`${field} must be at most ${MAX_WISH_TEXT_CHARS} characters`);
  }
  return text;
}

export function requireWishContext(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const context = value.trim();
  if (!context) throw new Error(`${field} must be a non-empty string`);
  if (context.length > MAX_WISH_CONTEXT_CHARS) {
    throw new Error(`${field} must be at most ${MAX_WISH_CONTEXT_CHARS} characters`);
  }
  return context;
}

export function requireOperatorWishResponse(value: unknown): string {
  if (typeof value !== 'string') throw new Error('operator response must be a string');
  const response = value.trim();
  if (!response) throw new Error('operator response must be a non-empty string');
  if (response.length > MAX_OPERATOR_RESPONSE_CHARS) {
    throw new Error(`operator response must be at most ${MAX_OPERATOR_RESPONSE_CHARS} characters`);
  }
  return response;
}

export function requireWishId(value: unknown): string {
  if (!isRfc4122Uuid(value)) throw new Error('wish id must be a canonical RFC-4122 UUID');
  return value;
}

export function requireWishBeadId(value: unknown): string {
  if (typeof value !== 'string' || !BEAD_ID_PATTERN.test(value)) {
    throw new Error('wish beadId must be a valid issue reference');
  }
  return value;
}

function isWishState(value: unknown): value is CompanionWishState {
  return COMPANION_WISH_STATES.some(state => state === value);
}

function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!isCanonicalIsoTimestamp(value)) throw new Error(`${field} must be a canonical ISO timestamp`);
  return value;
}

function parseJsonBody(document: WikiDocument): unknown {
  try {
    return JSON.parse(document.body);
  } catch (error) {
    throw new Error(`wiki document ${document.id} has malformed wishlist data`, { cause: error });
  }
}

function assertStateFields(wish: CompanionWish, documentId: string): void {
  for (const [field, timestamp] of [
    ['acknowledgedAt', wish.acknowledgedAt],
    ['plannedAt', wish.plannedAt],
    ['completedAt', wish.completedAt],
  ]) {
    if (timestamp && (
      timestamp.localeCompare(wish.createdAt) < 0
      || timestamp.localeCompare(wish.updatedAt) > 0
    )) {
      throw new Error(`wiki document ${documentId} has ${field} outside its update timeline`);
    }
  }
  if (wish.state === 'open') {
    if (
      wish.acknowledgedAt
      || wish.operatorResponse
      || wish.plannedAt
      || wish.beadId
      || wish.completedAt
    ) {
      throw new Error(`wiki document ${documentId} has operator fields while open`);
    }
    return;
  }
  if (!wish.acknowledgedAt) {
    throw new Error(`wiki document ${documentId} is ${wish.state} without acknowledgedAt`);
  }
  if (wish.state === 'acknowledged' && (wish.plannedAt || wish.beadId || wish.completedAt)) {
    throw new Error(`wiki document ${documentId} has fields inconsistent with acknowledged state`);
  }
  if (wish.state === 'planned' && (!wish.plannedAt || !wish.beadId || wish.completedAt)) {
    throw new Error(`wiki document ${documentId} has fields inconsistent with planned state`);
  }
  if (wish.plannedAt && wish.plannedAt.localeCompare(wish.acknowledgedAt) < 0) {
    throw new Error(`wiki document ${documentId} was planned before it was acknowledged`);
  }
  if (wish.state === 'done') {
    if (!wish.completedAt) {
      throw new Error(`wiki document ${documentId} is done without completedAt`);
    }
    if (Boolean(wish.plannedAt) !== Boolean(wish.beadId)) {
      throw new Error(`wiki document ${documentId} has incomplete planned-bead fields`);
    }
    if (wish.completedAt.localeCompare(wish.acknowledgedAt) < 0
      || (wish.plannedAt && wish.completedAt.localeCompare(wish.plannedAt) < 0)) {
      throw new Error(`wiki document ${documentId} was completed before its prior state`);
    }
  }
}

export function parseCompanionWishDocument(document: WikiDocument): CompanionWish {
  if (document.sourceClass !== 'companion_authored_note' || (document.scope && document.scope !== 'personal')) {
    throw new Error(`wiki document ${document.id} is not companion-owned wishlist data`);
  }
  const value = parseJsonBody(document);
  if (!isRecord(value)) throw new Error(`wiki document ${document.id} is not a wishlist object`);
  assertNoUnknownKeys(value, WISH_DOCUMENT_KEYS, `wiki document ${document.id}`);
  if (value.schemaVersion !== 1 || value.kind !== 'companion_wish') {
    throw new Error(`wiki document ${document.id} is not a companion wish`);
  }
  if (!isWishState(value.state) || value.visibility !== 'primary_contact') {
    throw new Error(`wiki document ${document.id} has invalid wishlist state or visibility`);
  }
  const id = requireWishId(value.id);
  if (document.id !== `wishlist.wish.${id}`) {
    throw new Error(`wiki document ${document.id} has mismatched wish id`);
  }
  const ref = typeof value.ref === 'string' ? value.ref : '';
  if (ref !== `wish:${id}`) throw new Error(`wiki document ${document.id} has mismatched wish ref`);
  if (!isCanonicalIsoTimestamp(value.createdAt) || !isCanonicalIsoTimestamp(value.updatedAt)) {
    throw new Error(`wiki document ${document.id} has invalid wishlist timestamps`);
  }
  if (value.updatedAt.localeCompare(value.createdAt) < 0) {
    throw new Error(`wiki document ${document.id} was updated before it was created`);
  }
  const acknowledgedAt = optionalTimestamp(value.acknowledgedAt, 'acknowledgedAt');
  const plannedAt = optionalTimestamp(value.plannedAt, 'plannedAt');
  const completedAt = optionalTimestamp(value.completedAt, 'completedAt');
  const wish: CompanionWish = {
    schemaVersion: 1,
    kind: 'companion_wish',
    id,
    ref,
    text: requireWishText(value.text, 'wish text'),
    ...(value.context !== undefined
      ? { context: requireWishContext(value.context, 'wish context') }
      : {}),
    state: value.state,
    visibility: 'primary_contact',
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(acknowledgedAt ? { acknowledgedAt } : {}),
    ...(value.operatorResponse !== undefined
      ? { operatorResponse: requireOperatorWishResponse(value.operatorResponse) }
      : {}),
    ...(plannedAt ? { plannedAt } : {}),
    ...(value.beadId !== undefined ? { beadId: requireWishBeadId(value.beadId) } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
  assertStateFields(wish, document.id);
  return wish;
}
