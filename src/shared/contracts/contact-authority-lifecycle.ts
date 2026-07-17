import { createHash } from 'node:crypto';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../utils/types.js';

export const CONTACT_AUTHORITY_LIFECYCLE_SCHEMA_VERSION = 1 as const;

export type ContactAuthorityLifecycleAction =
  | 'contact.merge'
  | 'contact.delete'
  | 'contact.discord_unlink'
  | 'contact.identity_conflict'
  | 'contact.verify'
  | 'contact.reapprove';

export type ContactAuthorityPostState =
  | 'merged'
  | 'deleted'
  | 'unlinked'
  | 'conflict_suspended'
  | 'verified'
  | 'reapproved';

interface ContactAuthorityLifecycleBase {
  schemaVersion: 1;
  intentId: string;
  action: ContactAuthorityLifecycleAction;
  contactId: string;
  canonicalContactId?: string;
  providerSubjectId?: string;
}

export type ContactAuthorityLifecycleRequest = ContactAuthorityLifecycleBase & (
  | { phase: 'prepare' }
  | {
      phase: 'finalize';
      postState: {
        schemaVersion: 1;
        state: ContactAuthorityPostState;
        contactVersion: number;
      };
    }
);

export interface ContactAuthorityLifecycleResult {
  schemaVersion: 1;
  intentId: string;
  phase: 'prepare' | 'finalize';
  action: ContactAuthorityLifecycleAction;
  status: 'prepared' | 'reserved' | 'no_binding' | 'finalized';
  authorityGeneration: number;
  globalAuthEpoch: number;
  auditEventId: string;
}

const DISCORD_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;
const ACTIONS = new Set<ContactAuthorityLifecycleAction>([
  'contact.merge',
  'contact.delete',
  'contact.discord_unlink',
  'contact.identity_conflict',
  'contact.verify',
  'contact.reapprove',
]);
const EXPECTED_POST_STATE: Record<ContactAuthorityLifecycleAction, ContactAuthorityPostState> = {
  'contact.merge': 'merged',
  'contact.delete': 'deleted',
  'contact.discord_unlink': 'unlinked',
  'contact.identity_conflict': 'conflict_suspended',
  'contact.verify': 'verified',
  'contact.reapprove': 'reapproved',
};

function contractError(message: string): Error {
  return new Error(`Invalid contact authority lifecycle v1 request: ${message}`);
}

function assertContactId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string'
    || value.length < 1
    || value.length > 256
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw contractError(`${field} is invalid`);
  }
}

function assertCommon(value: Record<string, unknown>): void {
  if (value.schemaVersion !== 1) throw contractError('schemaVersion must be 1');
  if (typeof value.intentId !== 'string' || !isRfc4122Uuid(value.intentId)) {
    throw contractError('intentId must be an RFC-4122 UUID');
  }
  if (typeof value.action !== 'string'
    || !ACTIONS.has(value.action as ContactAuthorityLifecycleAction)) {
    throw contractError('action is unknown');
  }
  assertContactId(value.contactId, 'contactId');
}

function actionKeys(action: ContactAuthorityLifecycleAction): readonly string[] {
  if (action === 'contact.merge') return ['canonicalContactId'];
  if (action === 'contact.delete') return [];
  return ['providerSubjectId'];
}

function validateActionFields(value: Record<string, unknown>): void {
  const action = value.action as ContactAuthorityLifecycleAction;
  if (action === 'contact.merge') {
    assertContactId(value.canonicalContactId, 'canonicalContactId');
    if (value.canonicalContactId === value.contactId) {
      throw contractError('canonicalContactId must differ from contactId');
    }
    return;
  }
  if (action !== 'contact.delete'
    && (typeof value.providerSubjectId !== 'string'
      || !DISCORD_SUBJECT_PATTERN.test(value.providerSubjectId))) {
    throw contractError('providerSubjectId is invalid');
  }
}

function parsePostState(
  value: unknown,
  action: ContactAuthorityLifecycleAction,
): Extract<ContactAuthorityLifecycleRequest, { phase: 'finalize' }>['postState'] {
  if (!isRecord(value)) throw contractError('postState must be an object');
  assertNoUnknownKeys(
    value,
    ['schemaVersion', 'state', 'contactVersion'],
    'postState',
    { errorPrefix: 'Invalid contact authority lifecycle v1 request' },
  );
  if (value.schemaVersion !== 1
    || value.state !== EXPECTED_POST_STATE[action]
    || !Number.isSafeInteger(value.contactVersion)
    || Number(value.contactVersion) < 1) {
    throw contractError('postState is not the exact action result');
  }
  return {
    schemaVersion: 1,
    state: value.state as ContactAuthorityPostState,
    contactVersion: Number(value.contactVersion),
  };
}

export function parseContactAuthorityLifecycleRequest(
  input: unknown,
): ContactAuthorityLifecycleRequest {
  if (!isRecord(input)) throw contractError('request must be an object');
  assertCommon(input);
  if (input.phase !== 'prepare' && input.phase !== 'finalize') {
    throw contractError('phase is unknown');
  }
  const action = input.action as ContactAuthorityLifecycleAction;
  const expectedKeys = [
    'schemaVersion',
    'intentId',
    'phase',
    'action',
    'contactId',
    ...actionKeys(action),
    ...(input.phase === 'finalize' ? ['postState'] : []),
  ];
  assertNoUnknownKeys(input, expectedKeys, 'request', {
    errorPrefix: 'Invalid contact authority lifecycle v1 request',
  });
  if (Object.keys(input).length !== expectedKeys.length
    || expectedKeys.some(key => !Object.hasOwn(input, key))) {
    throw contractError('request is missing a required field');
  }
  validateActionFields(input);
  const common = {
    schemaVersion: 1 as const,
    intentId: input.intentId as string,
    action,
    contactId: input.contactId as string,
    ...(action === 'contact.merge'
      ? { canonicalContactId: input.canonicalContactId as string }
      : {}),
    ...(action !== 'contact.merge' && action !== 'contact.delete'
      ? { providerSubjectId: input.providerSubjectId as string }
      : {}),
  };
  if (input.phase === 'prepare') return { ...common, phase: 'prepare' };
  return { ...common, phase: 'finalize', postState: parsePostState(input.postState, action) };
}

export function contactAuthorityLifecycleIntentDigest(
  request: ContactAuthorityLifecycleRequest,
): string {
  const base = {
    schemaVersion: request.schemaVersion,
    intentId: request.intentId,
    action: request.action,
    contactId: request.contactId,
    ...(request.canonicalContactId ? { canonicalContactId: request.canonicalContactId } : {}),
    ...(request.providerSubjectId ? { providerSubjectId: request.providerSubjectId } : {}),
  };
  return createHash('sha256').update(JSON.stringify(base)).digest('hex');
}

export function contactAuthorityLifecycleRequestDigest(
  request: ContactAuthorityLifecycleRequest,
): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}

export function parseContactAuthorityLifecycleResult(
  value: unknown,
): ContactAuthorityLifecycleResult {
  if (!isRecord(value)) throw new Error('Invalid contact authority lifecycle v1 result');
  const keys = [
    'schemaVersion', 'intentId', 'phase', 'action', 'status',
    'authorityGeneration', 'globalAuthEpoch', 'auditEventId',
  ];
  assertNoUnknownKeys(value, keys, 'result', {
    errorPrefix: 'Invalid contact authority lifecycle v1 result',
  });
  if (Object.keys(value).length !== keys.length
    || value.schemaVersion !== 1
    || typeof value.intentId !== 'string'
    || !isRfc4122Uuid(value.intentId)
    || (value.phase !== 'prepare' && value.phase !== 'finalize')
    || typeof value.action !== 'string'
    || !ACTIONS.has(value.action as ContactAuthorityLifecycleAction)
    || (value.status !== 'prepared' && value.status !== 'reserved'
      && value.status !== 'no_binding' && value.status !== 'finalized')
    || (value.phase === 'prepare' && value.status === 'finalized')
    || (value.phase === 'finalize' && value.status !== 'finalized')
    || !Number.isSafeInteger(value.authorityGeneration)
    || Number(value.authorityGeneration) < 1
    || !Number.isSafeInteger(value.globalAuthEpoch)
    || Number(value.globalAuthEpoch) < 1
    || typeof value.auditEventId !== 'string'
    || !isRfc4122Uuid(value.auditEventId)) {
    throw new Error('Invalid contact authority lifecycle v1 result');
  }
  return value as unknown as ContactAuthorityLifecycleResult;
}

export function contactAuthorityPostStateForAction(
  action: ContactAuthorityLifecycleAction,
): ContactAuthorityPostState {
  return EXPECTED_POST_STATE[action];
}
