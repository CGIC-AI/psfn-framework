import type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from '../../../src/shared/contracts/approval-envelope.js';
import { isObjectRecord as isRecord } from '../../../src/shared/utils/types.js';
import { validWebsocketPath } from './fleet-session.js';
import {
  hasExactKeys,
  isBoundedString,
  isLowercaseRfc4122Uuid,
} from './protocol/validation.js';
import { parseHubToClientMessage } from './protocol/framing.js';

const COMPANIONS_PATH = '/v1/fleet-auth/companions';
const APPROVALS_PATH = '/v1/fleet-auth/approvals';

const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_AVATAR_REF_LENGTH = 512;
const MAX_COMPANIONS = 256;
const MAX_APPROVALS = 1024;
const AVATAR_REF_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * One companion the signed-in human may reach. `websocketPath` is the single
 * canonical stream URL for this companion; the active companion is expressed
 * ONLY by which path the app opens (no client-side identity field). Source of
 * truth is the server roster — the app never invents this list.
 */
export interface FleetRosterCompanion {
  readonly companionId: string;
  readonly displayName: string;
  readonly websocketPath: string;
  readonly avatarRef?: string;
}

export interface FleetRoster {
  readonly schemaVersion: 1;
  readonly companions: readonly FleetRosterCompanion[];
}

/** One redacted fleet-wide pending approval, attributed to its companion. */
export interface FleetApprovalEntry {
  readonly companionId: string;
  readonly companionDisplayName: string;
  readonly id: string;
  readonly title: string;
  readonly redactedContext: string;
  readonly sourceSystem: ApprovalSourceSystem;
  readonly attribution: ApprovalAttribution;
  readonly action: string;
  readonly scope: string;
  readonly reason: string;
  readonly grantMode: ApprovalGrantMode;
  readonly requestedAt: string;
  readonly expiresAt?: string;
  readonly status: 'pending';
}

export interface FleetApprovalsView {
  readonly schemaVersion: 1;
  readonly approvals: readonly FleetApprovalEntry[];
}

export class FleetRosterProtocolError extends Error {
  constructor(message = 'Fleet roster response was malformed') {
    super(message);
    this.name = 'FleetRosterProtocolError';
  }
}

/** Converts an opaque local asset reference into a canonical same-origin URL. */
export function companionAvatarUrl(avatarRef: string): string | null {
  if (!isBoundedString(avatarRef, MAX_AVATAR_REF_LENGTH)) return null;
  const segments = avatarRef.split('/');
  if (segments.some(segment => !AVATAR_REF_SEGMENT.test(segment))) return null;
  return `/companion-ui/${segments.map(segment => encodeURIComponent(segment)).join('/')}`;
}

function parseRosterCompanion(value: unknown): FleetRosterCompanion {
  if (!isRecord(value)) throw new FleetRosterProtocolError();
  const hasAvatar = Object.hasOwn(value, 'avatarRef');
  if (!hasExactKeys(value, hasAvatar
    ? ['companionId', 'displayName', 'websocketPath', 'avatarRef']
    : ['companionId', 'displayName', 'websocketPath'])) {
    throw new FleetRosterProtocolError();
  }
  if (!isLowercaseRfc4122Uuid(value.companionId)
    || !isBoundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH)
    || !validWebsocketPath(value.websocketPath)
    // The stream path must belong to exactly this companion; a mismatch is a
    // server/tamper inconsistency and fails closed.
    || value.websocketPath !== `/companion-ui/companions/${value.companionId}/ws`
    || (hasAvatar && (typeof value.avatarRef !== 'string'
      || companionAvatarUrl(value.avatarRef) === null))) {
    throw new FleetRosterProtocolError();
  }
  return Object.freeze({
    companionId: value.companionId,
    displayName: value.displayName,
    websocketPath: value.websocketPath,
    ...(hasAvatar ? { avatarRef: value.avatarRef as string } : {}),
  });
}

export function parseFleetRoster(value: unknown): FleetRoster {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'companions'])
    || value.schemaVersion !== 1 || !Array.isArray(value.companions)
    || value.companions.length > MAX_COMPANIONS) {
    throw new FleetRosterProtocolError();
  }
  const companions: FleetRosterCompanion[] = [];
  const seen = new Set<string>();
  for (const entry of value.companions) {
    const companion = parseRosterCompanion(entry);
    if (seen.has(companion.companionId)) {
      throw new FleetRosterProtocolError('Fleet roster contains a duplicate companion');
    }
    seen.add(companion.companionId);
    companions.push(companion);
  }
  return Object.freeze({ schemaVersion: 1, companions: Object.freeze(companions) });
}

function parseApprovalEntry(value: unknown): FleetApprovalEntry {
  if (!isRecord(value)) throw new FleetRosterProtocolError();
  const hasExpiry = Object.hasOwn(value, 'expiresAt');
  const wireKeys = [
    'companionId',
    'companionDisplayName',
    'id',
    'title',
    'requestedAt',
    'redactedContext',
    'status',
    'sourceSystem',
    'attribution',
    'action',
    'scope',
    'reason',
    'grantMode',
  ];
  if (!hasExactKeys(value, hasExpiry ? [...wireKeys, 'expiresAt'] : wireKeys)) {
    throw new FleetRosterProtocolError();
  }
  if (!isLowercaseRfc4122Uuid(value.companionId)
    || !isBoundedString(value.companionDisplayName, MAX_DISPLAY_NAME_LENGTH)) {
    throw new FleetRosterProtocolError();
  }
  let message;
  try {
    const {
      companionId: _companionId,
      companionDisplayName: _companionDisplayName,
      ...data
    } = value;
    message = parseHubToClientMessage(JSON.stringify({
      type: 'approval.requested',
      data,
    }));
  } catch {
    throw new FleetRosterProtocolError();
  }
  if (message.type !== 'approval.requested') {
    throw new FleetRosterProtocolError();
  }
  const data = message.data;
  const { sourceSystem, attribution, action, scope, reason, grantMode } = data;
  if (sourceSystem === undefined || attribution === undefined
    || action === undefined || scope === undefined || reason === undefined
    || grantMode === undefined || attribution.parentId !== value.companionId
    || attribution.parentLabel !== value.companionDisplayName) {
    throw new FleetRosterProtocolError();
  }
  return Object.freeze({
    companionId: value.companionId,
    companionDisplayName: value.companionDisplayName,
    id: data.id,
    title: data.title,
    requestedAt: data.requestedAt,
    ...(data.expiresAt ? { expiresAt: data.expiresAt } : {}),
    redactedContext: data.redactedContext,
    status: data.status,
    sourceSystem,
    attribution,
    action,
    scope,
    reason,
    grantMode,
  });
}

export function parseFleetApprovalsView(value: unknown): FleetApprovalsView {
  if (!isRecord(value) || !hasExactKeys(value, ['schemaVersion', 'approvals'])
    || value.schemaVersion !== 1 || !Array.isArray(value.approvals)
    || value.approvals.length > MAX_APPROVALS) {
    throw new FleetRosterProtocolError();
  }
  const approvals = value.approvals.map(parseApprovalEntry);
  return Object.freeze({ schemaVersion: 1, approvals: Object.freeze(approvals) });
}

type FetchLike = typeof fetch;

/**
 * Reads the authenticated roster and fleet-wide approvals view. Cookie-authed,
 * no-store, and strictly parsed — a malformed or non-`no-store` response fails
 * closed rather than degrading to a partial/invented list.
 */
export class FleetRosterClient {
  constructor(private readonly fetchImpl: FetchLike = (...args) => fetch(...args)) {}

  async readRoster(): Promise<FleetRoster> {
    return parseFleetRoster(await this.readNoStoreJson(COMPANIONS_PATH));
  }

  async readApprovals(): Promise<FleetApprovalsView> {
    return parseFleetApprovalsView(await this.readNoStoreJson(APPROVALS_PATH));
  }

  private async readNoStoreJson(path: string): Promise<unknown> {
    const response = await this.fetchImpl(path, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok
      || response.headers.get('cache-control')?.toLowerCase().includes('no-store') !== true) {
      throw new FleetRosterProtocolError('Fleet roster response was unavailable');
    }
    return response.json();
  }
}
