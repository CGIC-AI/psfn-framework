import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../../persistence/jsonl.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  INTROSPECTION_CONSENT_SCHEMA_VERSION,
  type CompanionConsentActor,
  type IntrospectionConsentPolicy,
  type IntrospectionConsentRevision,
} from './contracts.js';

const REVISION_KEYS = new Set([
  'schemaVersion',
  'revision',
  'enabled',
  'allowedPublicChannelIds',
  'actor',
  'reason',
  'createdAt',
  'previousHash',
  'hash',
]);
const ACTOR_KEYS = new Set(['kind', 'turnId', 'requestId']);
const MAX_CHANNEL_IDS = 64;
const MAX_CHANNEL_ID_LENGTH = 240;
const MAX_REASON_LENGTH = 500;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface AppendIntrospectionConsentInput {
  enabled: boolean;
  allowedPublicChannelIds: string[];
  actor: CompanionConsentActor;
  reason: string;
  createdAt?: string;
}
function assertExactKeys(record: Record<string, unknown>, keys: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!keys.has(key)) {
      throw new Error(`Invalid introspection consent ${label}: unknown field ${key}`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw new Error(`Invalid introspection consent ${label}: missing field ${key}`);
    }
  }
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid introspection consent: ${field} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || /[\r\n\0]/.test(normalized)) {
    throw new Error(`Invalid introspection consent: ${field} must be 1-${maxLength} safe characters`);
  }
  return normalized;
}

function normalizeActor(value: unknown): CompanionConsentActor {
  if (!isRecord(value)) {
    throw new Error('Invalid introspection consent: actor must be an object');
  }
  assertExactKeys(value, ACTOR_KEYS, 'actor');
  if (value.kind !== 'companion') {
    throw new Error('Invalid introspection consent: actor.kind must be companion');
  }
  return {
    kind: 'companion',
    turnId: requireBoundedString(value.turnId, 'actor.turnId', 240),
    requestId: requireBoundedString(value.requestId, 'actor.requestId', 240),
  };
}

function normalizeChannels(value: unknown, enabled: boolean): string[] {
  if (!Array.isArray(value) || value.length > MAX_CHANNEL_IDS) {
    throw new Error(`Invalid introspection consent: allowedPublicChannelIds must contain at most ${MAX_CHANNEL_IDS} entries`);
  }
  const normalized = value.map((entry, index) => {
    const channelId = requireBoundedString(
      entry,
      `allowedPublicChannelIds[${index}]`,
      MAX_CHANNEL_ID_LENGTH,
    );
    if (channelId === '*' || channelId.includes('*')) {
      throw new Error('Invalid introspection consent: wildcard channels are forbidden');
    }
    return channelId;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Invalid introspection consent: duplicate channel ids are forbidden');
  }
  if (enabled && normalized.length === 0) {
    throw new Error('Invalid introspection consent: enabled policy requires at least one exact public channel id');
  }
  return normalized;
}

function normalizeCreatedAt(value: unknown): string {
  const createdAt = requireBoundedString(value, 'createdAt', 64);
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== createdAt) {
    throw new Error('Invalid introspection consent: createdAt must be a canonical ISO timestamp');
  }
  return createdAt;
}

function calculateHash(revision: Omit<IntrospectionConsentRevision, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify({
    schemaVersion: revision.schemaVersion,
    revision: revision.revision,
    enabled: revision.enabled,
    allowedPublicChannelIds: revision.allowedPublicChannelIds,
    actor: revision.actor,
    reason: revision.reason,
    createdAt: revision.createdAt,
    previousHash: revision.previousHash,
  })).digest('hex');
}

function normalizeRevision(
  value: unknown,
  expectedRevision: number,
  expectedPreviousHash: string | null,
): IntrospectionConsentRevision {
  if (!isRecord(value)) {
    throw new Error('Invalid introspection consent revision: entry must be an object');
  }
  assertExactKeys(value, REVISION_KEYS, 'revision');
  if (value.schemaVersion !== INTROSPECTION_CONSENT_SCHEMA_VERSION) {
    throw new Error('Invalid introspection consent: unsupported schemaVersion');
  }
  if (!Number.isSafeInteger(value.revision) || value.revision !== expectedRevision) {
    throw new Error(`Invalid introspection consent: expected revision ${expectedRevision}`);
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error('Invalid introspection consent: enabled must be boolean');
  }
  const allowedPublicChannelIds = normalizeChannels(value.allowedPublicChannelIds, value.enabled);
  const actor = normalizeActor(value.actor);
  const reason = requireBoundedString(value.reason, 'reason', MAX_REASON_LENGTH);
  const createdAt = normalizeCreatedAt(value.createdAt);
  if (value.previousHash !== expectedPreviousHash) {
    throw new Error(`Invalid introspection consent: revision ${expectedRevision} previousHash mismatch`);
  }
  if (typeof value.hash !== 'string' || !HASH_PATTERN.test(value.hash)) {
    throw new Error('Invalid introspection consent: hash must be a SHA-256 digest');
  }
  const normalized: IntrospectionConsentRevision = {
    schemaVersion: INTROSPECTION_CONSENT_SCHEMA_VERSION,
    revision: expectedRevision,
    enabled: value.enabled,
    allowedPublicChannelIds,
    actor,
    reason,
    createdAt,
    previousHash: expectedPreviousHash,
    hash: value.hash,
  };
  const expectedHash = calculateHash(normalized);
  if (normalized.hash !== expectedHash) {
    throw new Error(`Invalid introspection consent: revision ${expectedRevision} hash mismatch`);
  }
  return normalized;
}

export class IntrospectionConsentStore {
  constructor(private readonly path: string) {}

  load(): IntrospectionConsentPolicy {
    if (!existsSync(this.path)) {
      return { status: 'unconfigured', enabled: false, allowedPublicChannelIds: [] };
    }
    const raw = readFileSync(this.path, 'utf8');
    if (raw.length === 0 || !raw.endsWith('\n')) {
      throw new Error('Invalid introspection consent ledger: ledger must end with a newline');
    }
    const lines = raw.slice(0, -1).split('\n');
    if (lines.length === 0 || lines.some(line => line.trim().length === 0)) {
      throw new Error('Invalid introspection consent ledger: blank lines are forbidden');
    }
    let previousHash: string | null = null;
    let current: IntrospectionConsentRevision | undefined;
    lines.forEach((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid introspection consent ledger line ${index + 1}: ${String(error)}`);
      }
      current = normalizeRevision(parsed, index + 1, previousHash);
      previousHash = current.hash;
    });
    if (!current) {
      throw new Error('Invalid introspection consent ledger: no revisions');
    }
    return current;
  }

  append(input: AppendIntrospectionConsentInput): IntrospectionConsentRevision {
    if (!isRecord(input)) {
      throw new Error('Invalid introspection consent input');
    }
    const current = this.load();
    const revision = current.status === 'unconfigured' ? 1 : current.revision + 1;
    const previousHash = current.status === 'unconfigured' ? null : current.hash;
    if (typeof input.enabled !== 'boolean') {
      throw new Error('Invalid introspection consent: enabled must be boolean');
    }
    const draft: Omit<IntrospectionConsentRevision, 'hash'> = {
      schemaVersion: INTROSPECTION_CONSENT_SCHEMA_VERSION,
      revision,
      enabled: input.enabled,
      allowedPublicChannelIds: normalizeChannels(input.allowedPublicChannelIds, input.enabled),
      actor: normalizeActor(input.actor),
      reason: requireBoundedString(input.reason, 'reason', MAX_REASON_LENGTH),
      createdAt: normalizeCreatedAt(input.createdAt ?? new Date().toISOString()),
      previousHash,
    };
    const record: IntrospectionConsentRevision = { ...draft, hash: calculateHash(draft) };
    appendJsonLine(this.path, record);
    return record;
  }
}
