import { createHash } from 'node:crypto';
import type { TestingHarnessRunProvenance } from '../../shared/contracts/testing-harness.js';
import { normalizeTestingHarnessRunProvenance } from '../../shared/contracts/testing-harness.js';

const SHAKEDOWN_ARTIFACT_KINDS = [
  'session',
  'channel',
  'task',
  'memory',
  'event',
] as const;

type ShakedownArtifactKind = typeof SHAKEDOWN_ARTIFACT_KINDS[number];

interface ShakedownArtifactTarget {
  kind: ShakedownArtifactKind;
  id: string;
}

export interface ShakedownArtifactManifest {
  schemaVersion: 1;
  companionId: string;
  runId: string;
  manifestId: string;
  artifacts: readonly ShakedownArtifactTarget[];
}

export interface ShakedownArtifactInventoryRecord extends ShakedownArtifactTarget {
  companionId: string;
  state: 'active' | 'quarantined' | 'removed';
  provenance?: TestingHarnessRunProvenance;
}

export interface ShakedownCleanupInventoryPort {
  inspectExact(manifest: ShakedownArtifactManifest): Promise<readonly ShakedownArtifactInventoryRecord[]>;
}

interface ShakedownCleanupBackupReceipt {
  backupRef: string;
  backupDigest: string;
  rollbackRef: string;
  artifactKeys: readonly string[];
}

export interface ShakedownCleanupBackupPort {
  captureExact(input: {
    manifest: ShakedownArtifactManifest;
    targets: readonly ShakedownArtifactInventoryRecord[];
  }): Promise<ShakedownCleanupBackupReceipt>;
}

export interface ShakedownCleanupMutationPort {
  quarantineExact(input: {
    manifest: ShakedownArtifactManifest;
    targets: readonly ShakedownArtifactInventoryRecord[];
    backup: ShakedownCleanupBackupReceipt;
  }): Promise<{ quarantineRef: string }>;
  removeQuarantinedExact(input: {
    manifest: ShakedownArtifactManifest;
    targets: readonly ShakedownArtifactInventoryRecord[];
    quarantineRef: string;
  }): Promise<void>;
}

interface ShakedownCleanupAuditRecord {
  schemaVersion: 1;
  companionId: string;
  runId: string;
  manifestId: string;
  approvalId: string;
  backupRef: string;
  backupDigest: string;
  rollbackRef: string;
  targetDigest: string;
  removedCounts: Partial<Record<ShakedownArtifactKind, number>>;
}

export interface ShakedownCleanupAuditPort {
  append(record: ShakedownCleanupAuditRecord): Promise<void>;
}

export interface ShakedownCleanupPlan {
  status: 'ready' | 'already_removed';
  companionId: string;
  runId: string;
  manifestId: string;
  targets: ReadonlyArray<ShakedownArtifactTarget & { state: ShakedownArtifactInventoryRecord['state'] }>;
}

export interface ShakedownCleanupResult extends Omit<ShakedownCleanupPlan, 'status'> {
  status: 'removed' | 'already_removed';
  backupRef?: string;
  rollbackRef?: string;
}

function requireIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`Shakedown cleanup ${field} must be a non-empty canonical identifier`);
  }
  return normalized;
}

function artifactKey(target: ShakedownArtifactTarget): string {
  return JSON.stringify([target.kind, target.id]);
}

function normalizeManifest(manifest: ShakedownArtifactManifest): ShakedownArtifactManifest {
  const rawSchemaVersion: unknown = manifest.schemaVersion;
  if (rawSchemaVersion !== 1) {
    throw new Error('Shakedown cleanup manifest schemaVersion must be 1');
  }
  const companionId = requireIdentifier(manifest.companionId, 'companionId');
  const runId = requireIdentifier(manifest.runId, 'runId');
  const manifestId = requireIdentifier(manifest.manifestId, 'manifestId');
  if (manifest.artifacts.length === 0) {
    throw new Error('Shakedown cleanup manifest must contain exact artifact targets');
  }
  const seen = new Set<string>();
  const artifacts = manifest.artifacts.map(target => {
    const rawKind: unknown = target.kind;
    if (
      typeof rawKind !== 'string'
      || !(SHAKEDOWN_ARTIFACT_KINDS as readonly string[]).includes(rawKind)
    ) {
      throw new Error('Shakedown cleanup manifest contains an unknown artifact kind');
    }
    const normalized = {
      kind: rawKind as ShakedownArtifactKind,
      id: requireIdentifier(target.id, 'artifact id'),
    };
    const key = artifactKey(normalized);
    if (seen.has(key)) throw new Error(`Shakedown cleanup manifest duplicates ${key}`);
    seen.add(key);
    return normalized;
  });
  return { schemaVersion: 1, companionId, runId, manifestId, artifacts };
}

function assertContentFreeReference(value: string, field: string): string {
  return requireIdentifier(value, field);
}

function targetDigest(targets: readonly ShakedownArtifactTarget[]): string {
  return createHash('sha256')
    .update([...targets].map(artifactKey).sort().join('\n'))
    .digest('hex');
}

function countTargets(targets: readonly ShakedownArtifactTarget[]): Partial<Record<ShakedownArtifactKind, number>> {
  const counts: Partial<Record<ShakedownArtifactKind, number>> = {};
  for (const target of targets) counts[target.kind] = (counts[target.kind] ?? 0) + 1;
  return counts;
}

export class ShakedownArtifactCleanupService {
  private readonly companionId: string;
  private readonly inventory: ShakedownCleanupInventoryPort;
  private readonly backup: ShakedownCleanupBackupPort;
  private readonly mutation: ShakedownCleanupMutationPort;
  private readonly audit: ShakedownCleanupAuditPort;

  constructor(input: {
    companionId: string;
    inventory: ShakedownCleanupInventoryPort;
    backup: ShakedownCleanupBackupPort;
    mutation: ShakedownCleanupMutationPort;
    audit: ShakedownCleanupAuditPort;
  }) {
    this.companionId = requireIdentifier(input.companionId, 'bound companionId');
    this.inventory = input.inventory;
    this.backup = input.backup;
    this.mutation = input.mutation;
    this.audit = input.audit;
  }

  private async resolvePlan(manifestInput: ShakedownArtifactManifest): Promise<{
    manifest: ShakedownArtifactManifest;
    records: readonly ShakedownArtifactInventoryRecord[];
    plan: ShakedownCleanupPlan;
  }> {
    const manifest = normalizeManifest(manifestInput);
    if (manifest.companionId !== this.companionId) {
      throw new Error('Shakedown cleanup manifest companion does not match the bound companion');
    }
    const expected = new Map(manifest.artifacts.map(target => [artifactKey(target), target]));
    const records = await this.inventory.inspectExact(manifest);
    const observed = new Map<string, ShakedownArtifactInventoryRecord>();
    for (const record of records) {
      const key = artifactKey(record);
      if (!expected.has(key)) {
        throw new Error(`Shakedown cleanup inventory returned an out-of-manifest artifact ${key}`);
      }
      if (observed.has(key)) {
        throw new Error(`Shakedown cleanup inventory duplicated artifact ${key}`);
      }
      if (record.companionId !== this.companionId) {
        throw new Error(`Shakedown cleanup artifact ${key} belongs to another companion`);
      }
      let provenance: TestingHarnessRunProvenance;
      try {
        provenance = normalizeTestingHarnessRunProvenance(record.provenance);
      } catch {
        throw new Error(`Shakedown cleanup artifact ${key} lacks exact test-run provenance`);
      }
      if (provenance.runId !== manifest.runId || provenance.manifestId !== manifest.manifestId) {
        throw new Error(`Shakedown cleanup artifact ${key} lacks exact test-run provenance`);
      }
      observed.set(key, record);
    }
    for (const key of expected.keys()) {
      if (!observed.has(key)) {
        throw new Error(`Shakedown cleanup exact target ${key} could not be proven`);
      }
    }
    const planTargets = manifest.artifacts.map(target => ({
      ...target,
      state: observed.get(artifactKey(target))?.state ?? 'active',
    }));
    const allRemoved = planTargets.every(target => target.state === 'removed');
    return {
      manifest,
      records,
      plan: {
        status: allRemoved ? 'already_removed' : 'ready',
        companionId: manifest.companionId,
        runId: manifest.runId,
        manifestId: manifest.manifestId,
        targets: planTargets,
      },
    };
  }

  async dryRun(manifest: ShakedownArtifactManifest): Promise<ShakedownCleanupPlan> {
    return (await this.resolvePlan(manifest)).plan;
  }

  async apply(
    manifestInput: ShakedownArtifactManifest,
    approval: { operatorApproved: boolean; approvalId: string },
  ): Promise<ShakedownCleanupResult> {
    if (!approval.operatorApproved) {
      throw new Error('Shakedown cleanup requires explicit operator approval');
    }
    const approvalId = requireIdentifier(approval.approvalId, 'approvalId');
    const { manifest, records, plan } = await this.resolvePlan(manifestInput);
    if (plan.status === 'already_removed') return { ...plan, status: 'already_removed' };

    const activeTargets = records.filter(record => record.state !== 'removed');
    const backup = await this.backup.captureExact({ manifest, targets: activeTargets });
    const backupRef = assertContentFreeReference(backup.backupRef, 'backupRef');
    const rollbackRef = assertContentFreeReference(backup.rollbackRef, 'rollbackRef');
    if (!/^[a-f0-9]{64}$/u.test(backup.backupDigest)) {
      throw new Error('Shakedown cleanup backup digest must be a SHA-256 hex digest');
    }
    const exactKeys = activeTargets.map(artifactKey).sort();
    if (JSON.stringify([...backup.artifactKeys].sort()) !== JSON.stringify(exactKeys)) {
      throw new Error('Shakedown cleanup backup does not cover the exact mutation targets');
    }
    const quarantine = await this.mutation.quarantineExact({
      manifest,
      targets: activeTargets,
      backup,
    });
    const quarantineRef = assertContentFreeReference(quarantine.quarantineRef, 'quarantineRef');
    await this.mutation.removeQuarantinedExact({
      manifest,
      targets: activeTargets,
      quarantineRef,
    });
    await this.audit.append({
      schemaVersion: 1,
      companionId: manifest.companionId,
      runId: manifest.runId,
      manifestId: manifest.manifestId,
      approvalId,
      backupRef,
      backupDigest: backup.backupDigest,
      rollbackRef,
      targetDigest: targetDigest(activeTargets),
      removedCounts: countTargets(activeTargets),
    });
    return { ...plan, status: 'removed', backupRef, rollbackRef };
  }
}
