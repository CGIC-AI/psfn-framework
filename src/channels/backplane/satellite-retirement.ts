import type {
  RetiredSatelliteConfig,
  SatelliteRegistryConfig,
  SatelliteTestingHarnessProvenance,
} from '../../shared/contracts/satellite-registry.js';

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export interface SyntheticSatelliteRetirementTarget {
  satelliteId: string;
  endpointIds: readonly string[];
  runId: string;
  manifestId: string;
}

export interface SatelliteRegistryBackupPort {
  create(input: {
    target: SyntheticSatelliteRetirementTarget;
  }): Promise<{
    /** Exact parsed owner snapshot represented by backupDigest. */
    registry: SatelliteRegistryConfig;
    backupRef: string;
    backupDigest: string;
  }>;
}

export interface SatelliteRegistryWritePort {
  save(input: {
    config: SatelliteRegistryConfig;
    expectedBackupDigest: string;
  }): Promise<void>;
}

export interface SyntheticSatelliteRetirementReceipt {
  status: 'would_retire' | 'retired' | 'already_retired';
  satelliteId: string;
  endpointIds: string[];
  runId: string;
  manifestId: string;
  backupRef?: string;
  backupDigest?: string;
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(normalized)) {
    throw new Error(`${field} must be a canonical identifier`);
  }
  return normalized;
}

function canonicalTarget(target: SyntheticSatelliteRetirementTarget): {
  satelliteId: string;
  endpointIds: string[];
  provenance: SatelliteTestingHarnessProvenance;
} {
  const endpointIds = target.endpointIds.map((id, index) => requiredId(id, `endpointIds[${index}]`));
  if (endpointIds.length === 0 || new Set(endpointIds).size !== endpointIds.length) {
    throw new Error('endpointIds must contain unique exact endpoint identities');
  }
  endpointIds.sort();
  return {
    satelliteId: requiredId(target.satelliteId, 'satelliteId'),
    endpointIds,
    provenance: {
      schemaVersion: 1,
      kind: 'testing_harness',
      runId: requiredId(target.runId, 'runId'),
      manifestId: requiredId(target.manifestId, 'manifestId'),
    },
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameProvenance(
  left: SatelliteTestingHarnessProvenance,
  right: SatelliteTestingHarnessProvenance,
): boolean {
  return left.runId === right.runId && left.manifestId === right.manifestId;
}

function resolveExactTarget(
  registry: SatelliteRegistryConfig,
  target: ReturnType<typeof canonicalTarget>,
): { state: 'active' } | { state: 'retired'; record: RetiredSatelliteConfig } {
  const active = registry.satellites.find(candidate => candidate.satelliteId === target.satelliteId);
  if (!active) {
    const retired = registry.retiredSatellites?.find(
      candidate => candidate.satelliteId === target.satelliteId,
    );
    if (!retired) throw new Error('Synthetic satellite retirement target does not exist');
    const retiredEndpointIds = [...retired.endpointIds].sort();
    if (!sameStrings(retiredEndpointIds, target.endpointIds)
      || !sameProvenance(retired.testProvenance, target.provenance)) {
      throw new Error('Retired satellite identity or provenance does not match the exact target');
    }
    return { state: 'retired', record: retired };
  }
  if (!active.testProvenance) {
    throw new Error('Satellite does not carry testing-harness provenance');
  }
  if (!sameProvenance(active.testProvenance, target.provenance)) {
    throw new Error('Satellite testing-harness provenance does not match the exact target');
  }
  const activeEndpointIds = active.endpoints.map(endpoint => endpoint.endpointId).sort();
  if (!sameStrings(activeEndpointIds, target.endpointIds)) {
    throw new Error('Satellite endpoint identity mismatch');
  }
  return { state: 'active' };
}

function receipt(
  status: SyntheticSatelliteRetirementReceipt['status'],
  target: ReturnType<typeof canonicalTarget>,
  backup?: { backupRef: string; backupDigest: string },
): SyntheticSatelliteRetirementReceipt {
  return {
    status,
    satelliteId: target.satelliteId,
    endpointIds: [...target.endpointIds],
    runId: target.provenance.runId,
    manifestId: target.provenance.manifestId,
    ...(backup ? backup : {}),
  };
}

export class SyntheticSatelliteRetirementService {
  constructor(private readonly ports: {
    read: () => SatelliteRegistryConfig;
    backup: SatelliteRegistryBackupPort;
    writer: SatelliteRegistryWritePort;
  }) {}

  async retire(input: {
    target: SyntheticSatelliteRetirementTarget;
    dryRun: boolean;
    retiredAt: string;
    approval?: {
      operatorApproved: boolean;
      approvalId: string;
    };
  }): Promise<SyntheticSatelliteRetirementReceipt> {
    const target = canonicalTarget(input.target);
    const registry = this.ports.read();
    const initialTarget = resolveExactTarget(registry, target);
    if (initialTarget.state === 'retired') {
      return receipt('already_retired', target, {
        backupRef: initialTarget.record.backupRef,
        backupDigest: initialTarget.record.backupDigest,
      });
    }
    if (!Number.isFinite(Date.parse(input.retiredAt))
      || new Date(input.retiredAt).toISOString() !== input.retiredAt) {
      throw new Error('retiredAt must be a canonical ISO timestamp');
    }
    if (input.dryRun) return receipt('would_retire', target);
    if (input.approval?.operatorApproved !== true) {
      throw new Error('Synthetic satellite retirement requires explicit operator approval');
    }
    requiredId(input.approval.approvalId, 'approvalId');

    const backup = await this.ports.backup.create({ target: input.target });
    const backupRef = requiredId(backup.backupRef, 'backupRef');
    if (!SHA256_DIGEST_PATTERN.test(backup.backupDigest)) {
      throw new Error('backupDigest must be a sha256 digest');
    }
    const backedTarget = resolveExactTarget(backup.registry, target);
    if (backedTarget.state === 'retired') {
      return receipt('already_retired', target, {
        backupRef: backedTarget.record.backupRef,
        backupDigest: backedTarget.record.backupDigest,
      });
    }
    const retired: RetiredSatelliteConfig = {
      satelliteId: target.satelliteId,
      endpointIds: [...target.endpointIds],
      testProvenance: target.provenance,
      retiredAt: input.retiredAt,
      backupRef,
      backupDigest: backup.backupDigest,
    };
    const next: SatelliteRegistryConfig = {
      ...backup.registry,
      satellites: backup.registry.satellites.filter(
        candidate => candidate.satelliteId !== target.satelliteId,
      ),
      retiredSatellites: [...(backup.registry.retiredSatellites ?? []), retired],
    };
    await this.ports.writer.save({
      config: next,
      expectedBackupDigest: backup.backupDigest,
    });
    return receipt('retired', target, { backupRef, backupDigest: backup.backupDigest });
  }
}
