import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileDurableAtomicSync } from '../../../shared/utils/fs.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import { withCrossProcessWriteLock } from '../../sessions/cross-process-write-lock.js';

export const FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME = 'fleet-auth-authority-floor.json';
const LOCK_DIR_NAME = '.fleet-auth-authority-floor.lock';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PROVIDER_SUBJECT_PATTERN = /^[1-9][0-9]{16,19}$/u;

export type AccountAuthorityTombstoneKind =
  | 'provider_subject'
  | 'contact_binding'
  | 'role_grant';

export interface AccountAuthorityTombstone {
  kind: AccountAuthorityTombstoneKind;
  resourceHash: string;
  generation: number;
  revokedAt: string;
  reasonHash: string;
}

export interface TrustedHostAuthorityFloor {
  lineageId: string;
  provisioningSecret: string;
  authorityGeneration: number;
  activationGeneration: number;
  restoreCheckpoint: number;
  revocationCheckpoint: number;
  lastLifecycleTransitionId: string | null;
  tombstones: AccountAuthorityTombstone[];
}

export interface PasskeyAuthorityCandidate {
  credentialIdHash: string;
  publicKeyVerifier: string;
  rpId: string;
  principalId: string;
  expectedProvider: 'discord';
  expectedProviderSubjectId: string;
  signCount: number;
  backupEligible: boolean;
  backupState: boolean;
}

export type PasskeyAuthorityStatus = 'current' | 'revoked' | 'replaced' | 'compromised';

export interface PasskeyAuthorityEntry extends PasskeyAuthorityCandidate {
  generation: number;
  status: PasskeyAuthorityStatus;
  createdAt: string;
  revokedAt?: string;
  replacedByCredentialIdHash?: string;
}

export interface PasskeyAuthorityTombstone {
  credentialIdHash: string;
  generation: number;
  status: Exclude<PasskeyAuthorityStatus, 'current'>;
  at: string;
  replacedByCredentialIdHash?: string;
}

export interface PasskeyAuthorityFloor {
  generation: number;
  credentials: PasskeyAuthorityEntry[];
  tombstones: PasskeyAuthorityTombstone[];
}

export interface FleetAuthAuthorityFloor {
  schemaVersion: 2;
  trustedHost: TrustedHostAuthorityFloor;
  passkeys: PasskeyAuthorityFloor;
  updatedAt: string;
}

export type PasskeyVerificationResult =
  | { allowed: true; generation: number }
  | { allowed: false; reason: 'not_found' | 'not_current' | 'metadata_mismatch' };

const LOCK_OPTIONS = {
  pollMs: 10,
  staleMs: 30_000,
  timeoutMs: 10_000,
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function lineageIdForSecret(secret: string): string {
  return digest(`fleet-auth-authority-lineage:v1:${secret}`);
}

function assertTimestamp(value: unknown, field: string): string {
  if (!isCanonicalIsoTimestamp(value)) {
    throw new Error(`Invalid fleet auth authority floor: ${field} must be an ISO timestamp`);
  }
  return value;
}

function assertInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`Invalid fleet auth authority floor: ${field} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid fleet auth authority floor: ${field} must be a non-empty string`);
  }
  return value;
}

function assertRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Invalid fleet auth authority floor: ${field} must be an object`);
  }
  return value;
}

function assertAccountAuthorityTombstoneKind(
  value: unknown,
  field: string,
): asserts value is AccountAuthorityTombstoneKind {
  if (value !== 'provider_subject' && value !== 'contact_binding' && value !== 'role_grant') {
    throw new Error(`Invalid fleet auth authority floor: ${field} is unknown`);
  }
}

function strictKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  assertNoUnknownKeys(value, keys, field, { errorPrefix: 'Invalid fleet auth authority floor' });
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Invalid fleet auth authority floor: ${field}.${key} is required`);
    }
  }
}

function parseAccountTombstone(value: unknown, index: number): AccountAuthorityTombstone {
  const field = `trustedHost.tombstones[${index}]`;
  const raw = assertRecord(value, field);
  strictKeys(raw, ['kind', 'resourceHash', 'generation', 'revokedAt', 'reasonHash'], field);
  assertAccountAuthorityTombstoneKind(raw.kind, `${field}.kind`);
  const resourceHash = assertString(raw.resourceHash, `${field}.resourceHash`);
  const reasonHash = assertString(raw.reasonHash, `${field}.reasonHash`);
  if (!HASH_PATTERN.test(resourceHash) || !HASH_PATTERN.test(reasonHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field} hashes must be SHA-256 hex`);
  }
  return {
    kind: raw.kind,
    resourceHash,
    generation: assertInteger(raw.generation, `${field}.generation`, 1),
    revokedAt: assertTimestamp(raw.revokedAt, `${field}.revokedAt`),
    reasonHash,
  };
}

function parsePasskeyCandidate(
  raw: Record<string, unknown>,
  field: string,
): PasskeyAuthorityCandidate {
  const credentialIdHash = assertString(raw.credentialIdHash, `${field}.credentialIdHash`);
  if (!HASH_PATTERN.test(credentialIdHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.credentialIdHash must be SHA-256 hex`);
  }
  const principalId = assertString(raw.principalId, `${field}.principalId`);
  if (!isRfc4122Uuid(principalId)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.principalId must be an RFC-4122 UUID`);
  }
  if (raw.expectedProvider !== 'discord') {
    throw new Error(`Invalid fleet auth authority floor: ${field}.expectedProvider must be discord`);
  }
  const expectedProviderSubjectId = assertString(
    raw.expectedProviderSubjectId,
    `${field}.expectedProviderSubjectId`,
  );
  if (!PROVIDER_SUBJECT_PATTERN.test(expectedProviderSubjectId)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.expectedProviderSubjectId is invalid`);
  }
  if (typeof raw.backupEligible !== 'boolean' || typeof raw.backupState !== 'boolean') {
    throw new Error(`Invalid fleet auth authority floor: ${field} backup signals must be booleans`);
  }
  if (raw.backupState && !raw.backupEligible) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.backupState requires backupEligible`);
  }
  return {
    credentialIdHash,
    publicKeyVerifier: assertString(raw.publicKeyVerifier, `${field}.publicKeyVerifier`),
    rpId: assertString(raw.rpId, `${field}.rpId`),
    principalId,
    expectedProvider: 'discord',
    expectedProviderSubjectId,
    signCount: assertInteger(raw.signCount, `${field}.signCount`),
    backupEligible: raw.backupEligible,
    backupState: raw.backupState,
  };
}

function parsePasskeyEntry(value: unknown, index: number): PasskeyAuthorityEntry {
  const field = `passkeys.credentials[${index}]`;
  const raw = assertRecord(value, field);
  assertNoUnknownKeys(raw, [
    'credentialIdHash',
    'publicKeyVerifier',
    'rpId',
    'principalId',
    'expectedProvider',
    'expectedProviderSubjectId',
    'signCount',
    'backupEligible',
    'backupState',
    'generation',
    'status',
    'createdAt',
    'revokedAt',
    'replacedByCredentialIdHash',
  ], field, { errorPrefix: 'Invalid fleet auth authority floor' });
  for (const required of [
    'credentialIdHash', 'publicKeyVerifier', 'rpId', 'principalId', 'expectedProvider',
    'expectedProviderSubjectId', 'signCount', 'backupEligible', 'backupState', 'generation',
    'status', 'createdAt',
  ]) {
    if (!Object.hasOwn(raw, required)) {
      throw new Error(`Invalid fleet auth authority floor: ${field}.${required} is required`);
    }
  }
  if (raw.status !== 'current' && raw.status !== 'revoked'
    && raw.status !== 'replaced' && raw.status !== 'compromised') {
    throw new Error(`Invalid fleet auth authority floor: ${field}.status is unknown`);
  }
  const candidate = parsePasskeyCandidate(raw, field);
  const replacedByCredentialIdHash = raw.replacedByCredentialIdHash === undefined
    ? undefined
    : assertString(raw.replacedByCredentialIdHash, `${field}.replacedByCredentialIdHash`);
  if (replacedByCredentialIdHash !== undefined && !HASH_PATTERN.test(replacedByCredentialIdHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.replacedByCredentialIdHash is invalid`);
  }
  return {
    ...candidate,
    generation: assertInteger(raw.generation, `${field}.generation`, 1),
    status: raw.status,
    createdAt: assertTimestamp(raw.createdAt, `${field}.createdAt`),
    ...(raw.revokedAt === undefined
      ? {}
      : { revokedAt: assertTimestamp(raw.revokedAt, `${field}.revokedAt`) }),
    ...(replacedByCredentialIdHash ? { replacedByCredentialIdHash } : {}),
  };
}

function parsePasskeyTombstone(value: unknown, index: number): PasskeyAuthorityTombstone {
  const field = `passkeys.tombstones[${index}]`;
  const raw = assertRecord(value, field);
  assertNoUnknownKeys(raw, [
    'credentialIdHash', 'generation', 'status', 'at', 'replacedByCredentialIdHash',
  ], field, { errorPrefix: 'Invalid fleet auth authority floor' });
  for (const required of ['credentialIdHash', 'generation', 'status', 'at']) {
    if (!Object.hasOwn(raw, required)) {
      throw new Error(`Invalid fleet auth authority floor: ${field}.${required} is required`);
    }
  }
  const credentialIdHash = assertString(raw.credentialIdHash, `${field}.credentialIdHash`);
  if (!HASH_PATTERN.test(credentialIdHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.credentialIdHash is invalid`);
  }
  if (raw.status !== 'revoked' && raw.status !== 'replaced' && raw.status !== 'compromised') {
    throw new Error(`Invalid fleet auth authority floor: ${field}.status is unknown`);
  }
  const replacedByCredentialIdHash = raw.replacedByCredentialIdHash === undefined
    ? undefined
    : assertString(raw.replacedByCredentialIdHash, `${field}.replacedByCredentialIdHash`);
  if (replacedByCredentialIdHash !== undefined && !HASH_PATTERN.test(replacedByCredentialIdHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.replacedByCredentialIdHash is invalid`);
  }
  return {
    credentialIdHash,
    generation: assertInteger(raw.generation, `${field}.generation`, 1),
    status: raw.status,
    at: assertTimestamp(raw.at, `${field}.at`),
    ...(replacedByCredentialIdHash ? { replacedByCredentialIdHash } : {}),
  };
}

export function validateFleetAuthAuthorityFloor(value: unknown): FleetAuthAuthorityFloor {
  const root = assertRecord(value, 'root');
  strictKeys(root, ['schemaVersion', 'trustedHost', 'passkeys', 'updatedAt'], 'root');
  if (root.schemaVersion !== 2) {
    throw new Error('Invalid fleet auth authority floor: schemaVersion must be 2');
  }
  const trustedHost = assertRecord(root.trustedHost, 'trustedHost');
  strictKeys(trustedHost, [
    'lineageId',
    'provisioningSecret',
    'authorityGeneration',
    'activationGeneration',
    'restoreCheckpoint',
    'revocationCheckpoint',
    'lastLifecycleTransitionId',
    'tombstones',
  ], 'trustedHost');
  if (!Array.isArray(trustedHost.tombstones)) {
    throw new Error('Invalid fleet auth authority floor: trustedHost.tombstones must be an array');
  }
  const accountTombstones = trustedHost.tombstones.map(parseAccountTombstone);
  const accountIdentities = accountTombstones.map(entry => `${entry.kind}:${entry.resourceHash}`);
  if (new Set(accountIdentities).size !== accountIdentities.length) {
    throw new Error('Invalid fleet auth authority floor: duplicate trusted-host tombstone');
  }
  const authorityGeneration = assertInteger(
    trustedHost.authorityGeneration,
    'trustedHost.authorityGeneration',
    1,
  );
  if (accountTombstones.some(entry => entry.generation > authorityGeneration)) {
    throw new Error('Invalid fleet auth authority floor: trusted-host tombstone is ahead of its floor');
  }
  const lineageId = assertString(trustedHost.lineageId, 'trustedHost.lineageId');
  const provisioningSecret = assertString(
    trustedHost.provisioningSecret,
    'trustedHost.provisioningSecret',
  );
  if (!HASH_PATTERN.test(lineageId) || !HASH_PATTERN.test(provisioningSecret)
    || lineageIdForSecret(provisioningSecret) !== lineageId) {
    throw new Error('Invalid fleet auth authority floor: trusted-host lineage proof is invalid');
  }
  const lastLifecycleTransitionId = trustedHost.lastLifecycleTransitionId;
  if (lastLifecycleTransitionId !== null
    && (typeof lastLifecycleTransitionId !== 'string'
      || !HASH_PATTERN.test(lastLifecycleTransitionId))) {
    throw new Error(
      'Invalid fleet auth authority floor: trustedHost.lastLifecycleTransitionId is invalid',
    );
  }

  const passkeys = assertRecord(root.passkeys, 'passkeys');
  strictKeys(passkeys, ['generation', 'credentials', 'tombstones'], 'passkeys');
  if (!Array.isArray(passkeys.credentials) || !Array.isArray(passkeys.tombstones)) {
    throw new Error('Invalid fleet auth authority floor: passkey credentials/tombstones must be arrays');
  }
  const credentials = passkeys.credentials.map(parsePasskeyEntry);
  const credentialIds = credentials.map(entry => entry.credentialIdHash);
  if (new Set(credentialIds).size !== credentialIds.length) {
    throw new Error('Invalid fleet auth authority floor: duplicate passkey credential');
  }
  const currentPrincipals = credentials.filter(entry => entry.status === 'current')
    .map(entry => entry.principalId);
  if (new Set(currentPrincipals).size !== currentPrincipals.length) {
    throw new Error('Invalid fleet auth authority floor: multiple current credentials for one principal');
  }
  const passkeyTombstones = passkeys.tombstones.map(parsePasskeyTombstone);
  const tombstoneIds = passkeyTombstones.map(entry => entry.credentialIdHash);
  if (new Set(tombstoneIds).size !== tombstoneIds.length) {
    throw new Error('Invalid fleet auth authority floor: duplicate passkey tombstone');
  }
  const passkeyGeneration = assertInteger(passkeys.generation, 'passkeys.generation');
  const maximumCredentialGeneration = Math.max(
    0,
    ...credentials.map(entry => entry.generation),
    ...passkeyTombstones.map(entry => entry.generation),
  );
  if (maximumCredentialGeneration !== passkeyGeneration) {
    throw new Error('Invalid fleet auth authority floor: passkey generation does not match its ledger');
  }
  const tombstonesByCredential = new Map(
    passkeyTombstones.map(entry => [entry.credentialIdHash, entry]),
  );
  for (const credential of credentials) {
    const tombstone = tombstonesByCredential.get(credential.credentialIdHash);
    if (credential.status === 'current') {
      if (credential.revokedAt || credential.replacedByCredentialIdHash || tombstone) {
        throw new Error('Invalid fleet auth authority floor: current passkey carries revocation state');
      }
      continue;
    }
    if (!credential.revokedAt || !tombstone
      || tombstone.status !== credential.status
      || tombstone.generation !== credential.generation
      || tombstone.at !== credential.revokedAt
      || tombstone.replacedByCredentialIdHash !== credential.replacedByCredentialIdHash) {
      throw new Error('Invalid fleet auth authority floor: passkey revocation ledger is inconsistent');
    }
    if (credential.status === 'replaced' && !credential.replacedByCredentialIdHash) {
      throw new Error('Invalid fleet auth authority floor: replaced passkey lacks its replacement identity');
    }
    if (credential.status !== 'replaced' && credential.replacedByCredentialIdHash) {
      throw new Error('Invalid fleet auth authority floor: non-replaced passkey names a replacement');
    }
  }
  if (passkeyTombstones.some(entry => !credentialIds.includes(entry.credentialIdHash))) {
    throw new Error('Invalid fleet auth authority floor: passkey tombstone has no credential ledger entry');
  }

  return {
    schemaVersion: 2,
    trustedHost: {
      lineageId,
      provisioningSecret,
      authorityGeneration,
      activationGeneration: assertInteger(trustedHost.activationGeneration, 'trustedHost.activationGeneration', 1),
      restoreCheckpoint: assertInteger(trustedHost.restoreCheckpoint, 'trustedHost.restoreCheckpoint'),
      revocationCheckpoint: assertInteger(trustedHost.revocationCheckpoint, 'trustedHost.revocationCheckpoint'),
      lastLifecycleTransitionId,
      tombstones: accountTombstones,
    },
    passkeys: {
      generation: passkeyGeneration,
      credentials,
      tombstones: passkeyTombstones,
    },
    updatedAt: assertTimestamp(root.updatedAt, 'updatedAt'),
  };
}

function initialFloor(activationGeneration: number): FleetAuthAuthorityFloor {
  const provisioningSecret = randomBytes(32).toString('hex');
  return {
    schemaVersion: 2,
    trustedHost: {
      lineageId: lineageIdForSecret(provisioningSecret),
      provisioningSecret,
      authorityGeneration: 1,
      activationGeneration,
      restoreCheckpoint: 0,
      revocationCheckpoint: 0,
      lastLifecycleTransitionId: null,
      tombstones: [],
    },
    passkeys: {
      generation: 0,
      credentials: [],
      tombstones: [],
    },
    updatedAt: new Date().toISOString(),
  };
}

function samePasskeyMetadata(
  stored: PasskeyAuthorityEntry,
  candidate: PasskeyAuthorityCandidate,
): boolean {
  return stored.credentialIdHash === candidate.credentialIdHash
    && stored.publicKeyVerifier === candidate.publicKeyVerifier
    && stored.rpId === candidate.rpId
    && stored.principalId === candidate.principalId
    && stored.expectedProviderSubjectId === candidate.expectedProviderSubjectId
    && stored.signCount === candidate.signCount
    && stored.backupEligible === candidate.backupEligible
    && stored.backupState === candidate.backupState;
}

export class FleetAuthAuthorityFloorStore {
  readonly root: string;
  private readonly path: string;
  private readonly lockPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.path = join(this.root, FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME);
    this.lockPath = join(this.root, LOCK_DIR_NAME);
  }

  private write(value: FleetAuthAuthorityFloor): void {
    const validated = validateFleetAuthAuthorityFloor(value);
    writeFileDurableAtomicSync(this.path, `${JSON.stringify(validated, null, 2)}\n`);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): FleetAuthAuthorityFloor {
    if (!existsSync(this.path)) {
      throw new Error(`Fleet auth authority floor is unavailable at ${this.path}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (error) {
      throw new Error(`Fleet auth authority floor is unreadable: ${String(error)}`);
    }
    return validateFleetAuthAuthorityFloor(value);
  }

  open(input: {
    activationGeneration: number;
    databaseHasDurableAuthority: boolean;
    lifecycleTransitionId?: string;
  }): FleetAuthAuthorityFloor {
    if (!Number.isSafeInteger(input.activationGeneration) || input.activationGeneration < 1) {
      throw new Error('Fleet auth activation generation must be an integer >= 1');
    }
    if (input.lifecycleTransitionId !== undefined
      && !HASH_PATTERN.test(input.lifecycleTransitionId)) {
      throw new Error('Fleet auth lifecycle transition id must be SHA-256 hex');
    }
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      if (!existsSync(this.path)) {
        if (input.databaseHasDurableAuthority) {
          throw new Error(
            'Fleet auth authority floor is missing while durable fleet auth authority exists',
          );
        }
        const created = initialFloor(input.activationGeneration);
        if (input.lifecycleTransitionId) {
          created.trustedHost.lastLifecycleTransitionId = input.lifecycleTransitionId;
        }
        this.write(created);
        return created;
      }
      const current = this.read();
      if (input.activationGeneration < current.trustedHost.activationGeneration) {
        throw new Error('Fleet auth activation generation cannot move backward');
      }
      const activationAdvanced = input.activationGeneration
        > current.trustedHost.activationGeneration;
      const lifecycleAdvanced = input.lifecycleTransitionId !== undefined
        && input.lifecycleTransitionId !== current.trustedHost.lastLifecycleTransitionId;
      if (!activationAdvanced && !lifecycleAdvanced) return current;
      const next: FleetAuthAuthorityFloor = {
        ...current,
        trustedHost: {
          ...current.trustedHost,
          activationGeneration: input.activationGeneration,
          authorityGeneration: current.trustedHost.authorityGeneration + 1,
          restoreCheckpoint: current.trustedHost.restoreCheckpoint + 1,
          ...(input.lifecycleTransitionId
            ? { lastLifecycleTransitionId: input.lifecycleTransitionId }
            : {}),
        },
        updatedAt: new Date().toISOString(),
      };
      this.write(next);
      return next;
    });
  }

  revokeAccountAuthority(input: {
    kind: AccountAuthorityTombstoneKind;
    resourceId: string;
    reason: string;
    at: string;
  }): FleetAuthAuthorityFloor {
    return this.revokeAccountAuthorities({ resources: [input], at: input.at });
  }

  revokeAccountAuthorities(input: {
    resources: ReadonlyArray<{
      kind: AccountAuthorityTombstoneKind;
      resourceId: string;
      reason: string;
    }>;
    at: string;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'revokeAccountAuthorities.at');
    if (input.resources.length === 0) {
      throw new Error('Fleet auth account authority revocation requires at least one resource');
    }
    for (const [index, resource] of input.resources.entries()) {
      assertString(resource.resourceId, `revokeAccountAuthorities.resources[${index}].resourceId`);
      assertString(resource.reason, `revokeAccountAuthorities.resources[${index}].reason`);
      assertAccountAuthorityTombstoneKind(
        resource.kind,
        `revokeAccountAuthorities.resources[${index}].kind`,
      );
    }
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const nextGeneration = current.trustedHost.authorityGeneration + 1;
      const replacementKeys = new Set(input.resources.map(resource => (
        `${resource.kind}:${digest(resource.resourceId)}`
      )));
      const withoutPrior = current.trustedHost.tombstones.filter(entry => (
        !replacementKeys.has(`${entry.kind}:${entry.resourceHash}`)
      ));
      const next: FleetAuthAuthorityFloor = {
        ...current,
        trustedHost: {
          ...current.trustedHost,
          authorityGeneration: nextGeneration,
          revocationCheckpoint: current.trustedHost.revocationCheckpoint + 1,
          tombstones: [...withoutPrior, ...input.resources.map(resource => ({
            kind: resource.kind,
            resourceHash: digest(resource.resourceId),
            generation: nextGeneration,
            revokedAt: input.at,
            reasonHash: digest(resource.reason),
          }))],
        },
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }

  isAccountAuthorityTombstoned(
    kind: AccountAuthorityTombstoneKind,
    resourceId: string,
    floor: FleetAuthAuthorityFloor = this.read(),
  ): boolean {
    const resourceHash = digest(resourceId);
    return floor.trustedHost.tombstones.some(entry => (
      entry.kind === kind && entry.resourceHash === resourceHash
    ));
  }

  prepareRestore(input: {
    activationGeneration: number;
    restoredTombstones: ReadonlyArray<{
      kind: AccountAuthorityTombstoneKind;
      resourceId: string;
    }>;
    at: string;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'prepareRestore.at');
    assertInteger(input.activationGeneration, 'prepareRestore.activationGeneration', 1);
    for (const [index, restored] of input.restoredTombstones.entries()) {
      assertString(restored.resourceId, `prepareRestore.restoredTombstones[${index}].resourceId`);
      assertAccountAuthorityTombstoneKind(
        restored.kind,
        `prepareRestore.restoredTombstones[${index}].kind`,
      );
    }
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      if (input.activationGeneration < current.trustedHost.activationGeneration) {
        throw new Error('Fleet auth activation generation cannot move backward during restore');
      }
      const nextGeneration = current.trustedHost.authorityGeneration + 1;
      const tombstones = new Map(
        current.trustedHost.tombstones.map(entry => [`${entry.kind}:${entry.resourceHash}`, entry]),
      );
      for (const restored of input.restoredTombstones) {
        const resourceHash = digest(restored.resourceId);
        const identity = `${restored.kind}:${resourceHash}`;
        if (!tombstones.has(identity)) {
          tombstones.set(identity, {
            kind: restored.kind,
            resourceHash,
            generation: nextGeneration,
            revokedAt: input.at,
            reasonHash: digest('restored-tombstone'),
          });
        }
      }
      const next: FleetAuthAuthorityFloor = {
        ...current,
        trustedHost: {
          ...current.trustedHost,
          activationGeneration: input.activationGeneration,
          authorityGeneration: nextGeneration,
          restoreCheckpoint: current.trustedHost.restoreCheckpoint + 1,
          tombstones: [...tombstones.values()],
        },
        // PasskeyAuthorityFloor is deliberately copied byte-for-byte. Restored
        // passkey projections can never replace or promote this verifier state.
        passkeys: current.passkeys,
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }

  enrollPasskey(candidate: PasskeyAuthorityCandidate, at: string): FleetAuthAuthorityFloor {
    assertTimestamp(at, 'enrollPasskey.at');
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      // Reuse the strict parser for caller-provided credential metadata.
      const validated = parsePasskeyCandidate(candidate as unknown as Record<string, unknown>, 'candidate');
      if (current.passkeys.credentials.some(entry => entry.credentialIdHash === validated.credentialIdHash)
        || current.passkeys.tombstones.some(entry => entry.credentialIdHash === validated.credentialIdHash)) {
        throw new Error('Passkey credential identity is already present or tombstoned');
      }
      if (current.passkeys.credentials.some(entry => (
        entry.principalId === validated.principalId && entry.status === 'current'
      ))) {
        throw new Error('Passkey enrollment requires explicit replacement of the current credential');
      }
      const generation = current.passkeys.generation + 1;
      const next: FleetAuthAuthorityFloor = {
        ...current,
        passkeys: {
          ...current.passkeys,
          generation,
          credentials: [...current.passkeys.credentials, {
            ...validated,
            generation,
            status: 'current',
            createdAt: at,
          }],
        },
        updatedAt: at,
      };
      this.write(next);
      return next;
    });
  }

  replacePasskey(input: {
    priorCredentialIdHash: string;
    replacement: PasskeyAuthorityCandidate;
    at: string;
    faultInjection?: (stage: 'after_prior_fenced') => void;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'replacePasskey.at');
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const priorIndex = current.passkeys.credentials.findIndex(entry => (
        entry.credentialIdHash === input.priorCredentialIdHash && entry.status === 'current'
      ));
      if (priorIndex < 0) throw new Error('Passkey replacement requires an exact current prior credential');
      const replacement = parsePasskeyCandidate(
        input.replacement as unknown as Record<string, unknown>,
        'replacement',
      );
      if (current.passkeys.credentials.some(entry => entry.credentialIdHash === replacement.credentialIdHash)
        || current.passkeys.tombstones.some(entry => entry.credentialIdHash === replacement.credentialIdHash)) {
        throw new Error('Replacement passkey identity is already present or tombstoned');
      }
      const prior = current.passkeys.credentials[priorIndex]!;
      if (prior.principalId !== replacement.principalId
        || prior.expectedProviderSubjectId !== replacement.expectedProviderSubjectId
        || prior.rpId !== replacement.rpId) {
        throw new Error('Replacement passkey must preserve principal/provider/RP binding');
      }

      // Publish the prior tombstone first. If replacement publication fails,
      // the old credential remains denied (over-fenced) rather than usable.
      const fencedGeneration = current.passkeys.generation + 1;
      const fencedCredentials = [...current.passkeys.credentials];
      fencedCredentials[priorIndex] = {
        ...prior,
        generation: fencedGeneration,
        status: 'replaced',
        revokedAt: input.at,
        replacedByCredentialIdHash: replacement.credentialIdHash,
      };
      const fenced: FleetAuthAuthorityFloor = {
        ...current,
        passkeys: {
          generation: fencedGeneration,
          credentials: fencedCredentials,
          tombstones: [...current.passkeys.tombstones, {
            credentialIdHash: prior.credentialIdHash,
            generation: fencedGeneration,
            status: 'replaced',
            at: input.at,
            replacedByCredentialIdHash: replacement.credentialIdHash,
          }],
        },
        updatedAt: input.at,
      };
      this.write(fenced);
      input.faultInjection?.('after_prior_fenced');

      const replacementGeneration = fencedGeneration + 1;
      const completed: FleetAuthAuthorityFloor = {
        ...fenced,
        passkeys: {
          ...fenced.passkeys,
          generation: replacementGeneration,
          credentials: [...fenced.passkeys.credentials, {
            ...replacement,
            generation: replacementGeneration,
            status: 'current',
            createdAt: input.at,
          }],
        },
        updatedAt: input.at,
      };
      this.write(completed);
      return completed;
    });
  }

  revokePasskey(input: {
    credentialIdHash: string;
    status: 'revoked' | 'compromised';
    at: string;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'revokePasskey.at');
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const credentialIndex = current.passkeys.credentials.findIndex(entry => (
        entry.credentialIdHash === input.credentialIdHash && entry.status === 'current'
      ));
      if (credentialIndex < 0) {
        throw new Error('Passkey revocation requires an exact current credential');
      }
      const generation = current.passkeys.generation + 1;
      const credentials = [...current.passkeys.credentials];
      credentials[credentialIndex] = {
        ...credentials[credentialIndex]!,
        generation,
        status: input.status,
        revokedAt: input.at,
      };
      const next: FleetAuthAuthorityFloor = {
        ...current,
        passkeys: {
          generation,
          credentials,
          tombstones: [...current.passkeys.tombstones, {
            credentialIdHash: input.credentialIdHash,
            generation,
            status: input.status,
            at: input.at,
          }],
        },
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }

  updateCurrentPasskeySignals(input: {
    credentialIdHash: string;
    expectedGeneration: number;
    signCount: number;
    backupEligible: boolean;
    backupState: boolean;
    at: string;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'updateCurrentPasskeySignals.at');
    assertInteger(input.expectedGeneration, 'updateCurrentPasskeySignals.expectedGeneration', 1);
    assertInteger(input.signCount, 'updateCurrentPasskeySignals.signCount');
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const credentialIndex = current.passkeys.credentials.findIndex(entry => (
        entry.credentialIdHash === input.credentialIdHash && entry.status === 'current'
      ));
      if (credentialIndex < 0) {
        throw new Error('Passkey signal update requires an exact current credential');
      }
      const credential = current.passkeys.credentials[credentialIndex]!;
      if (credential.generation !== input.expectedGeneration) {
        throw new Error('Passkey signal update generation is stale');
      }
      if (input.signCount < credential.signCount) {
        throw new Error('Passkey sign counter cannot move backward');
      }
      if (input.backupEligible !== credential.backupEligible) {
        throw new Error('Passkey backup eligibility cannot change');
      }
      if (input.signCount === credential.signCount
        && input.backupState === credential.backupState) {
        return current;
      }
      const generation = current.passkeys.generation + 1;
      const credentials = [...current.passkeys.credentials];
      credentials[credentialIndex] = {
        ...credential,
        generation,
        signCount: input.signCount,
        backupState: input.backupState,
      };
      const next: FleetAuthAuthorityFloor = {
        ...current,
        passkeys: {
          ...current.passkeys,
          generation,
          credentials,
        },
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }

  verifyCurrentPasskey(candidate: PasskeyAuthorityCandidate): PasskeyVerificationResult {
    const current = this.read();
    const stored = current.passkeys.credentials.find(entry => (
      entry.credentialIdHash === candidate.credentialIdHash
    ));
    if (!stored) return { allowed: false, reason: 'not_found' };
    if (stored.status !== 'current') return { allowed: false, reason: 'not_current' };
    if (!samePasskeyMetadata(stored, candidate)) {
      return { allowed: false, reason: 'metadata_mismatch' };
    }
    return { allowed: true, generation: stored.generation };
  }
}
