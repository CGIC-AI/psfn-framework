import { isObjectRecord as isRecord } from '../../../src/shared/utils/types.js';
import { validWebsocketPath } from './fleet-session.js';

const COMPANIONS_PATH = '/v1/fleet-auth/companions';
const APPROVALS_PATH = '/v1/fleet-auth/approvals';

const LOWERCASE_RFC4122_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAX_DISPLAY_NAME_LENGTH = 120;
const MAX_AVATAR_REF_LENGTH = 512;
const MAX_ID_LENGTH = 160;
const MAX_TITLE_LENGTH = 160;
const MAX_COMPANIONS = 256;
const MAX_APPROVALS = 1024;

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

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= maxLength;
}

function isoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 40) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function parseRosterCompanion(value: unknown): FleetRosterCompanion {
  if (!isRecord(value)) throw new FleetRosterProtocolError();
  const hasAvatar = Object.hasOwn(value, 'avatarRef');
  if (!exactKeys(value, hasAvatar
    ? ['companionId', 'displayName', 'websocketPath', 'avatarRef']
    : ['companionId', 'displayName', 'websocketPath'])) {
    throw new FleetRosterProtocolError();
  }
  if (typeof value.companionId !== 'string' || !LOWERCASE_RFC4122_UUID.test(value.companionId)
    || !boundedString(value.displayName, MAX_DISPLAY_NAME_LENGTH)
    || !validWebsocketPath(value.websocketPath)
    // The stream path must belong to exactly this companion; a mismatch is a
    // server/tamper inconsistency and fails closed.
    || value.websocketPath !== `/companion-ui/companions/${value.companionId}/ws`
    || (hasAvatar && !boundedString(value.avatarRef, MAX_AVATAR_REF_LENGTH))) {
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
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'companions'])
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
  if (!exactKeys(value, hasExpiry
    ? ['companionId', 'companionDisplayName', 'id', 'title', 'requestedAt', 'expiresAt', 'status']
    : ['companionId', 'companionDisplayName', 'id', 'title', 'requestedAt', 'status'])) {
    throw new FleetRosterProtocolError();
  }
  if (typeof value.companionId !== 'string' || !LOWERCASE_RFC4122_UUID.test(value.companionId)
    || !boundedString(value.companionDisplayName, MAX_DISPLAY_NAME_LENGTH)
    || !boundedString(value.id, MAX_ID_LENGTH)
    || !boundedString(value.title, MAX_TITLE_LENGTH)
    || !isoTimestamp(value.requestedAt)
    || (hasExpiry && !isoTimestamp(value.expiresAt))
    || value.status !== 'pending') {
    throw new FleetRosterProtocolError();
  }
  return Object.freeze({
    companionId: value.companionId,
    companionDisplayName: value.companionDisplayName,
    id: value.id,
    title: value.title,
    requestedAt: value.requestedAt,
    ...(hasExpiry ? { expiresAt: value.expiresAt as string } : {}),
    status: 'pending' as const,
  });
}

export function parseFleetApprovalsView(value: unknown): FleetApprovalsView {
  if (!isRecord(value) || !exactKeys(value, ['schemaVersion', 'approvals'])
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
