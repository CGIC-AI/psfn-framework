import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileDurableAtomicSync } from '../../../shared/utils/fs.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../../shared/utils/types.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import { withCrossProcessWriteLock } from '../../sessions/cross-process-write-lock.js';

export const FLEET_AUTH_AUTHORITY_FLOOR_FILE_NAME = 'fleet-auth-authority-floor.json';
const LOCK_DIR_NAME = '.fleet-auth-authority-floor.lock';
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type AccountAuthorityTombstoneKind =
  | 'provider_subject'
  | 'contact_binding'
  | 'role_grant'
  | 'principal'
  | 'companion'
  | 'contact_authority_fence'
  | 'companion_lineage_floor'
  | 'recovery_credential';

export interface CompanionReaddFloorClaim {
  principalId: string;
  authnVersion: number;
  authzVersion: number;
  bindingVersion: number;
  grantVersion: number;
  policyVersion: number;
}

export interface AccountAuthorityTombstone {
  kind: AccountAuthorityTombstoneKind;
  resourceHash: string;
  generation: number;
  revokedAt: string;
  reasonHash: string;
  companionReadd?: {
    decisionId: string;
    ceremonyId: string;
    decisionFingerprint: string;
    actorPrincipalId: string;
    target: CompanionReaddFloorClaim;
    priorCompanionVersion: number;
    priorAuthorityGeneration: number;
    priorGlobalAuthEpoch: number;
    reasonDigest: string;
  };
}

export interface CompanionAuthorityLineageFloor {
  lineageId: string;
  lineageGeneration: number;
  authorityGeneration: number;
  entry: AccountAuthorityTombstone & {
    kind: 'companion_lineage_floor';
    companionReadd: NonNullable<AccountAuthorityTombstone['companionReadd']>;
  };
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

export interface FleetAuthAuthorityFloor {
  schemaVersion: 2;
  trustedHost: TrustedHostAuthorityFloor;
  updatedAt: string;
}

const LOCK_OPTIONS = {
  pollMs: 10,
  staleMs: 30_000,
  timeoutMs: 10_000,
} as const;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function companionResourceHash(companionId: string): string {
  return digest(companionId);
}

export function companionAuthorityLineageId(
  trustedHost: Pick<TrustedHostAuthorityFloor, 'provisioningSecret'>,
  resourceHash: string,
  lineageGeneration: number,
): string {
  return createHmac('sha256', trustedHost.provisioningSecret)
    .update(`fleet-auth-companion-authority-lineage:v1:${resourceHash}:${lineageGeneration}`)
    .digest('hex');
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

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !isRfc4122Uuid(value)) {
    throw new Error(`Invalid fleet auth authority floor: ${field} must be an RFC-4122 UUID`);
  }
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
  if (value !== 'provider_subject'
    && value !== 'contact_binding'
    && value !== 'role_grant'
    && value !== 'principal'
    && value !== 'companion'
    && value !== 'contact_authority_fence'
    && value !== 'companion_lineage_floor'
    && value !== 'recovery_credential') {
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
  const commonKeys = ['kind', 'resourceHash', 'generation', 'revokedAt', 'reasonHash'] as const;
  assertNoUnknownKeys(raw, [...commonKeys, 'companionReadd'], field, {
    errorPrefix: 'Invalid fleet auth authority floor',
  });
  for (const key of commonKeys) {
    if (!Object.hasOwn(raw, key)) {
      throw new Error(`Invalid fleet auth authority floor: ${field}.${key} is required`);
    }
  }
  assertAccountAuthorityTombstoneKind(raw.kind, `${field}.kind`);
  const resourceHash = assertString(raw.resourceHash, `${field}.resourceHash`);
  const reasonHash = assertString(raw.reasonHash, `${field}.reasonHash`);
  if (!HASH_PATTERN.test(resourceHash) || !HASH_PATTERN.test(reasonHash)) {
    throw new Error(`Invalid fleet auth authority floor: ${field} hashes must be SHA-256 hex`);
  }
  const common = {
    kind: raw.kind,
    resourceHash,
    generation: assertInteger(raw.generation, `${field}.generation`, 1),
    revokedAt: assertTimestamp(raw.revokedAt, `${field}.revokedAt`),
    reasonHash,
  };
  if (raw.kind !== 'companion_lineage_floor') {
    if (raw.companionReadd !== undefined) {
      throw new Error(`Invalid fleet auth authority floor: ${field}.companionReadd is misplaced`);
    }
    return common;
  }
  const readd = assertRecord(raw.companionReadd, `${field}.companionReadd`);
  strictKeys(readd, [
    'decisionId',
    'ceremonyId',
    'decisionFingerprint',
    'actorPrincipalId',
    'target',
    'priorCompanionVersion',
    'priorAuthorityGeneration',
    'priorGlobalAuthEpoch',
    'reasonDigest',
  ], `${field}.companionReadd`);
  assertUuid(readd.decisionId, `${field}.companionReadd.decisionId`);
  assertUuid(readd.ceremonyId, `${field}.companionReadd.ceremonyId`);
  assertUuid(readd.actorPrincipalId, `${field}.companionReadd.actorPrincipalId`);
  const target = assertRecord(readd.target, `${field}.companionReadd.target`);
  strictKeys(target, [
    'principalId',
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ], `${field}.companionReadd.target`);
  assertUuid(target.principalId, `${field}.companionReadd.target.principalId`);
  for (const version of [
    'authnVersion',
    'authzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ] as const) {
    assertInteger(target[version], `${field}.companionReadd.target.${version}`, 1);
  }
  const decisionFingerprint = assertString(
    readd.decisionFingerprint,
    `${field}.companionReadd.decisionFingerprint`,
  );
  const reasonDigest = assertString(readd.reasonDigest, `${field}.companionReadd.reasonDigest`);
  if (!HASH_PATTERN.test(decisionFingerprint) || !HASH_PATTERN.test(reasonDigest)) {
    throw new Error(`Invalid fleet auth authority floor: ${field}.companionReadd digests are invalid`);
  }
  return {
    ...common,
    kind: 'companion_lineage_floor',
    companionReadd: {
      decisionId: readd.decisionId,
      ceremonyId: readd.ceremonyId,
      decisionFingerprint,
      actorPrincipalId: readd.actorPrincipalId,
      target: target as unknown as CompanionReaddFloorClaim,
      priorCompanionVersion: assertInteger(
        readd.priorCompanionVersion,
        `${field}.companionReadd.priorCompanionVersion`,
        1,
      ),
      priorAuthorityGeneration: assertInteger(
        readd.priorAuthorityGeneration,
        `${field}.companionReadd.priorAuthorityGeneration`,
        1,
      ),
      priorGlobalAuthEpoch: assertInteger(
        readd.priorGlobalAuthEpoch,
        `${field}.companionReadd.priorGlobalAuthEpoch`,
        1,
      ),
      reasonDigest,
    },
  };
}

export function validateFleetAuthAuthorityFloor(value: unknown): FleetAuthAuthorityFloor {
  const root = assertRecord(value, 'root');
  strictKeys(root, ['schemaVersion', 'trustedHost', 'updatedAt'], 'root');
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
  for (const entry of accountTombstones) {
    if (entry.kind !== 'companion_lineage_floor' || !entry.companionReadd) continue;
    const removal = accountTombstones.find(candidate => (
      candidate.kind === 'companion' && candidate.resourceHash === entry.resourceHash
    ));
    if (!removal || entry.companionReadd.priorAuthorityGeneration + 1 !== entry.generation) {
      throw new Error('Invalid fleet auth authority floor: companion lineage floor is not monotonic');
    }
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
    updatedAt: new Date().toISOString(),
  };
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

  readTrustedHost(): TrustedHostAuthorityFloor {
    return this.read().trustedHost;
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
      if (resource.kind === 'companion_lineage_floor' || resource.kind === 'recovery_credential') {
        throw new Error('Dedicated authority floors require their exact mutation operation');
      }
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

  /**
   * Fence the configured trusted-host recovery credential without advancing
   * ordinary human authority. The revocation checkpoint is non-restored and
   * is signed into every recovery capability, so issued/unconsumed tokens are
   * defeated while routine sessions and roles retain their existing floor.
   */
  revokeRecoveryCredential(input: {
    credentialId: string;
    reason: string;
    at: string;
  }): FleetAuthAuthorityFloor {
    assertTimestamp(input.at, 'revokeRecoveryCredential.at');
    const credentialId = assertString(input.credentialId, 'revokeRecoveryCredential.credentialId');
    if (!HASH_PATTERN.test(credentialId)) {
      throw new Error('Invalid fleet auth authority floor: recovery credential id must be SHA-256 hex');
    }
    assertString(input.reason, 'revokeRecoveryCredential.reason');
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const resourceHash = digest(credentialId);
      const nextCheckpoint = current.trustedHost.revocationCheckpoint + 1;
      const next: FleetAuthAuthorityFloor = {
        ...current,
        trustedHost: {
          ...current.trustedHost,
          revocationCheckpoint: nextCheckpoint,
          tombstones: [
            ...current.trustedHost.tombstones.filter(entry => (
              entry.kind !== 'recovery_credential' || entry.resourceHash !== resourceHash
            )),
            {
              kind: 'recovery_credential',
              resourceHash,
              generation: current.trustedHost.authorityGeneration,
              revokedAt: input.at,
              reasonHash: digest(input.reason),
            },
          ],
        },
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }

  beginCompanionAuthorityReadd(input: {
    companionId: string;
    decisionId: string;
    ceremonyId: string;
    decisionFingerprint: string;
    actorPrincipalId: string;
    target: CompanionReaddFloorClaim;
    priorCompanionVersion: number;
    priorAuthorityGeneration: number;
    priorGlobalAuthEpoch: number;
    reasonDigest: string;
    at: string;
  }): CompanionAuthorityLineageFloor {
    assertUuid(input.companionId, 'beginCompanionAuthorityReadd.companionId');
    assertUuid(input.decisionId, 'beginCompanionAuthorityReadd.decisionId');
    assertUuid(input.ceremonyId, 'beginCompanionAuthorityReadd.ceremonyId');
    assertUuid(input.actorPrincipalId, 'beginCompanionAuthorityReadd.actorPrincipalId');
    assertTimestamp(input.at, 'beginCompanionAuthorityReadd.at');
    if (!HASH_PATTERN.test(input.decisionFingerprint) || !HASH_PATTERN.test(input.reasonDigest)) {
      throw new Error('Companion authority re-add digests must be SHA-256 hex');
    }
    assertUuid(input.target.principalId, 'beginCompanionAuthorityReadd.target.principalId');
    for (const [field, value] of Object.entries(input.target)) {
      if (field !== 'principalId') {
        assertInteger(value, `beginCompanionAuthorityReadd.target.${field}`, 1);
      }
    }
    assertInteger(input.priorCompanionVersion, 'beginCompanionAuthorityReadd.priorCompanionVersion', 1);
    assertInteger(input.priorAuthorityGeneration, 'beginCompanionAuthorityReadd.priorAuthorityGeneration', 1);
    assertInteger(input.priorGlobalAuthEpoch, 'beginCompanionAuthorityReadd.priorGlobalAuthEpoch', 1);
    return withCrossProcessWriteLock(this.lockPath, LOCK_OPTIONS, () => {
      const current = this.read();
      const resourceHash = companionResourceHash(input.companionId);
      const prior = current.trustedHost.tombstones.find(entry => (
        entry.kind === 'companion_lineage_floor' && entry.resourceHash === resourceHash
      ));
      const removal = current.trustedHost.tombstones.find(entry => (
        entry.kind === 'companion' && entry.resourceHash === resourceHash
      ));
      if (prior?.companionReadd?.decisionId === input.decisionId
        && timingSafeStringEqual(
          prior.companionReadd.decisionFingerprint,
          input.decisionFingerprint,
        )) {
        if (current.trustedHost.authorityGeneration !== prior.generation
          || !removal
          || removal.generation >= prior.generation) {
          throw new Error('Companion re-add lineage is no longer current');
        }
        const entry = prior as CompanionAuthorityLineageFloor['entry'];
        return {
          lineageId: companionAuthorityLineageId(current.trustedHost, resourceHash, entry.generation),
          lineageGeneration: entry.generation,
          authorityGeneration: current.trustedHost.authorityGeneration,
          entry,
        };
      }
      if (current.trustedHost.authorityGeneration !== input.priorAuthorityGeneration) {
        throw new Error('Fleet auth authority changed before companion re-add floor publication');
      }
      if (!removal || removal.generation > input.priorAuthorityGeneration) {
        throw new Error('Companion re-add requires a current permanent removal floor');
      }
      const nextGeneration = current.trustedHost.authorityGeneration + 1;
      const entry: CompanionAuthorityLineageFloor['entry'] = {
        kind: 'companion_lineage_floor',
        resourceHash,
        generation: nextGeneration,
        revokedAt: input.at,
        reasonHash: digest(input.reasonDigest),
        companionReadd: {
          decisionId: input.decisionId,
          ceremonyId: input.ceremonyId,
          decisionFingerprint: input.decisionFingerprint,
          actorPrincipalId: input.actorPrincipalId,
          target: input.target,
          priorCompanionVersion: input.priorCompanionVersion,
          priorAuthorityGeneration: input.priorAuthorityGeneration,
          priorGlobalAuthEpoch: input.priorGlobalAuthEpoch,
          reasonDigest: input.reasonDigest,
        },
      };
      const next: FleetAuthAuthorityFloor = {
        ...current,
        trustedHost: {
          ...current.trustedHost,
          authorityGeneration: nextGeneration,
          revocationCheckpoint: current.trustedHost.revocationCheckpoint + 1,
          tombstones: [
            ...current.trustedHost.tombstones.filter(candidate => (
              candidate.kind !== 'companion_lineage_floor'
                || candidate.resourceHash !== resourceHash
            )),
            entry,
          ],
        },
        updatedAt: input.at,
      };
      this.write(next);
      return {
        lineageId: companionAuthorityLineageId(next.trustedHost, resourceHash, nextGeneration),
        lineageGeneration: nextGeneration,
        authorityGeneration: nextGeneration,
        entry,
      };
    });
  }

  findCompanionAuthorityReadd(
    companionId: string,
    floor: FleetAuthAuthorityFloor = this.read(),
  ): CompanionAuthorityLineageFloor | undefined {
    const resourceHash = companionResourceHash(companionId);
    const entry = floor.trustedHost.tombstones.find(candidate => (
      candidate.kind === 'companion_lineage_floor'
        && candidate.resourceHash === resourceHash
        && candidate.companionReadd !== undefined
    )) as CompanionAuthorityLineageFloor['entry'] | undefined;
    if (!entry) return undefined;
    return {
      lineageId: companionAuthorityLineageId(floor.trustedHost, resourceHash, entry.generation),
      lineageGeneration: entry.generation,
      authorityGeneration: floor.trustedHost.authorityGeneration,
      entry,
    };
  }

  companionAuthorityLineageIsCurrent(input: {
    companionId: string;
    lineageId: string;
    lineageGeneration: number;
  }, floor: FleetAuthAuthorityFloor = this.read()): boolean {
    const lineage = this.findCompanionAuthorityReadd(input.companionId, floor);
    if (!lineage
      || !timingSafeStringEqual(lineage.lineageId, input.lineageId)
      || lineage.lineageGeneration !== input.lineageGeneration) {
      return false;
    }
    const resourceHash = companionResourceHash(input.companionId);
    const removal = floor.trustedHost.tombstones.find(entry => (
      entry.kind === 'companion' && entry.resourceHash === resourceHash
    ));
    return removal !== undefined && removal.generation < input.lineageGeneration;
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
      if (restored.kind === 'companion_lineage_floor'
        || restored.kind === 'recovery_credential') {
        throw new Error('Non-restored dedicated floors cannot be synthesized from restored authority');
      }
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
        updatedAt: input.at,
      };
      this.write(next);
      return next;
    });
  }
}
