import { createHash } from 'node:crypto';
import { normalizeTestingHarnessRunProvenance } from '../../shared/contracts/testing-harness.js';
import { isRecord } from '../../shared/utils/types.js';

const SHAKEDOWN_ARTIFACT_KINDS = [
  'session',
  'channel',
  'task',
  'memory',
  'event',
] as const;

type ShakedownArtifactKind = typeof SHAKEDOWN_ARTIFACT_KINDS[number];

export interface ShakedownArtifactTarget {
  kind: ShakedownArtifactKind;
  id: string;
}

export interface ShakedownCleanupTarget {
  schemaVersion: 1;
  companionId: string;
  sessionId: string;
  runId: string;
  manifestId: string;
  artifacts: readonly ShakedownArtifactTarget[];
}

export interface ShakedownCleanupInventory {
  status: 'present' | 'absent';
  targetRevision: string;
  artifactCounts: Readonly<Record<string, number>>;
  artifacts: readonly ShakedownArtifactTarget[];
}

export interface ShakedownCleanupBackupReceipt {
  backupRef: string;
  backupDigest: string;
  rollbackRef: string;
  targetRevision: string;
}

interface ShakedownCleanupProof {
  allRunArtifactsRemoved: boolean;
  remainingArtifactCounts: Readonly<Record<string, number>>;
}

export interface ShakedownCleanupPorts {
  inspectExact(target: ShakedownCleanupTarget): Promise<ShakedownCleanupInventory>;
  captureBackup(input: {
    target: ShakedownCleanupTarget;
    inventory: ShakedownCleanupInventory;
  }): Promise<ShakedownCleanupBackupReceipt>;
  removeExact(input: {
    target: ShakedownCleanupTarget;
    expectedRevision: string;
    backup: ShakedownCleanupBackupReceipt;
  }): Promise<void>;
  verifyAbsent(target: ShakedownCleanupTarget): Promise<ShakedownCleanupProof>;
  appendAudit(record: ShakedownCleanupAuditRecord): Promise<void>;
  finalize(target: ShakedownCleanupTarget): Promise<void>;
}

export interface ShakedownCleanupAuditRecord {
  schemaVersion: 1;
  companionId: string;
  sessionId: string;
  runId: string;
  manifestId: string;
  approvalId: string;
  backupRef: string;
  backupDigest: string;
  rollbackRef: string;
  targetRevision: string;
  artifactCounts: Readonly<Record<string, number>>;
  artifacts: readonly ShakedownArtifactTarget[];
}

export interface ShakedownCleanupPlan extends ShakedownCleanupTarget {
  status: 'ready' | 'already_removed';
  targetRevision: string;
  artifactCounts: Readonly<Record<string, number>>;
}

export interface ShakedownCleanupResult extends ShakedownCleanupTarget {
  status: 'removed' | 'already_removed';
  targetRevision: string;
  artifactCounts: Readonly<Record<string, number>>;
  backupRef?: string;
  backupDigest?: string;
  rollbackRef?: string;
  proof: ShakedownCleanupProof;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function requiredIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Shakedown cleanup ${field} must be a non-empty canonical identifier`);
  }
  return normalized;
}

function normalizeTarget(target: ShakedownCleanupTarget): ShakedownCleanupTarget {
  const provenance = normalizeTestingHarnessRunProvenance({
    schemaVersion: 1,
    kind: 'testing_harness',
    runId: target.runId,
    manifestId: target.manifestId,
  });
  if (target.artifacts.length === 0) {
    throw new Error('Shakedown cleanup requires a non-empty schemaVersion 1 artifact manifest');
  }
  const seen = new Set<string>();
  const artifacts = target.artifacts.map(artifact => {
    if (!(SHAKEDOWN_ARTIFACT_KINDS as readonly string[]).includes(artifact.kind)) {
      throw new Error('Shakedown cleanup manifest contains an unknown artifact kind');
    }
    const normalized = {
      kind: artifact.kind,
      id: requiredIdentifier(artifact.id, 'artifact id'),
    };
    const key = JSON.stringify([normalized.kind, normalized.id]);
    if (seen.has(key)) throw new Error(`Shakedown cleanup manifest duplicates ${key}`);
    seen.add(key);
    return normalized;
  });
  return {
    schemaVersion: 1,
    companionId: requiredIdentifier(target.companionId, 'companionId'),
    sessionId: requiredIdentifier(target.sessionId, 'sessionId'),
    runId: provenance.runId,
    manifestId: provenance.manifestId,
    artifacts,
  };
}

export function parseShakedownCleanupManifest(value: unknown): ShakedownCleanupTarget {
  if (!isRecord(value)) throw new Error('Shakedown cleanup manifest must be an object');
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    'artifacts',
    'companionId',
    'manifestId',
    'runId',
    'schemaVersion',
    'sessionId',
  ];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || !Array.isArray(value.artifacts)) {
    throw new Error('Shakedown cleanup manifest has an invalid shape');
  }
  if (value.schemaVersion !== 1) {
    throw new Error('Shakedown cleanup manifest schemaVersion must be 1');
  }
  const artifacts = value.artifacts.map(artifact => {
    if (!isRecord(artifact) || Object.keys(artifact).sort().join(',') !== 'id,kind') {
      throw new Error('Shakedown cleanup manifest artifact has an invalid shape');
    }
    return {
      kind: artifact.kind as ShakedownArtifactKind,
      id: artifact.id as string,
    };
  });
  return normalizeTarget({
    schemaVersion: value.schemaVersion as 1,
    companionId: value.companionId as string,
    sessionId: value.sessionId as string,
    runId: value.runId as string,
    manifestId: value.manifestId as string,
    artifacts,
  });
}

function artifactKeys(artifacts: readonly ShakedownArtifactTarget[]): string[] {
  return artifacts.map(artifact => JSON.stringify([artifact.kind, artifact.id])).sort();
}

function validateInventory(
  inventory: ShakedownCleanupInventory,
  target: ShakedownCleanupTarget,
): ShakedownCleanupInventory {
  if (!SHA256_PATTERN.test(inventory.targetRevision)) {
    throw new Error('Shakedown cleanup inventory targetRevision must be a SHA-256 digest');
  }
  for (const [kind, count] of Object.entries(inventory.artifactCounts)) {
    if (!kind.trim() || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Shakedown cleanup inventory returned invalid artifact counts');
    }
  }
  const observed = Object.values(inventory.artifactCounts).reduce((sum, count) => sum + count, 0);
  if ((inventory.status === 'absent') !== (observed === 0)) {
    throw new Error('Shakedown cleanup inventory status does not match its artifact counts');
  }
  const observedKeys = artifactKeys(inventory.artifacts);
  if (inventory.status === 'absent' && observedKeys.length > 0) {
    throw new Error('Shakedown cleanup absent inventory returned artifact identities');
  }
  if (
    inventory.status === 'present'
    && JSON.stringify(observedKeys) !== JSON.stringify(artifactKeys(target.artifacts))
  ) {
    throw new Error('Shakedown cleanup inventory does not match the exact artifact manifest');
  }
  return inventory;
}

function validateProof(proof: ShakedownCleanupProof): ShakedownCleanupProof {
  const remaining = Object.values(proof.remainingArtifactCounts)
    .reduce((sum, count) => sum + count, 0);
  if (Object.values(proof.remainingArtifactCounts).some(
    count => !Number.isSafeInteger(count) || count < 0,
  )) {
    throw new Error('Shakedown cleanup verification returned invalid artifact counts');
  }
  if (!proof.allRunArtifactsRemoved || remaining !== 0) {
    throw new Error('Shakedown cleanup could not prove that every run-owned artifact was removed');
  }
  return proof;
}

function absentProof(): ShakedownCleanupProof {
  return { allRunArtifactsRemoved: true, remainingArtifactCounts: {} };
}

export class ShakedownArtifactCleanupService {
  constructor(private readonly ports: ShakedownCleanupPorts) {}

  async dryRun(targetInput: ShakedownCleanupTarget): Promise<ShakedownCleanupPlan> {
    const target = normalizeTarget(targetInput);
    const inventory = validateInventory(await this.ports.inspectExact(target), target);
    return {
      ...target,
      status: inventory.status === 'absent' ? 'already_removed' : 'ready',
      targetRevision: inventory.targetRevision,
      artifactCounts: inventory.artifactCounts,
      artifacts: target.artifacts,
    };
  }

  async apply(
    targetInput: ShakedownCleanupTarget,
    approval: { operatorApproved: boolean; approvalId: string },
  ): Promise<ShakedownCleanupResult> {
    if (!approval.operatorApproved) {
      throw new Error('Shakedown cleanup requires explicit operator approval');
    }
    const approvalId = requiredIdentifier(approval.approvalId, 'approvalId');
    const target = normalizeTarget(targetInput);
    const inventory = validateInventory(await this.ports.inspectExact(target), target);
    if (inventory.status === 'absent') {
      await this.ports.finalize(target);
      return {
        ...target,
        status: 'already_removed',
        targetRevision: inventory.targetRevision,
        artifactCounts: inventory.artifactCounts,
        proof: absentProof(),
      };
    }

    const backup = await this.ports.captureBackup({ target, inventory });
    if (!SHA256_PATTERN.test(backup.backupDigest)) {
      throw new Error('Shakedown cleanup backupDigest must be a SHA-256 digest');
    }
    requiredIdentifier(backup.backupRef, 'backupRef');
    requiredIdentifier(backup.rollbackRef, 'rollbackRef');
    if (backup.targetRevision !== inventory.targetRevision) {
      throw new Error('Shakedown cleanup backup does not cover the inspected target revision');
    }

    const afterBackup = validateInventory(await this.ports.inspectExact(target), target);
    if (afterBackup.status !== 'present' || afterBackup.targetRevision !== inventory.targetRevision) {
      throw new Error('Shakedown cleanup target changed while the backup was being captured');
    }

    await this.ports.removeExact({
      target,
      expectedRevision: inventory.targetRevision,
      backup,
    });
    const proof = validateProof(await this.ports.verifyAbsent(target));
    await this.ports.appendAudit({
      ...target,
      approvalId,
      backupRef: backup.backupRef,
      backupDigest: backup.backupDigest,
      rollbackRef: backup.rollbackRef,
      targetRevision: inventory.targetRevision,
      artifactCounts: inventory.artifactCounts,
    });
    await this.ports.finalize(target);
    return {
      ...target,
      status: 'removed',
      targetRevision: inventory.targetRevision,
      artifactCounts: inventory.artifactCounts,
      backupRef: backup.backupRef,
      backupDigest: backup.backupDigest,
      rollbackRef: backup.rollbackRef,
      proof,
    };
  }
}

export function shakedownCleanupRevision(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}
