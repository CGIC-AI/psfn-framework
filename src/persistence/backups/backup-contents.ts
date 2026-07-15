import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  KUBERNETES_HELM_RECOVERY_DIR_NAME,
  KUBERNETES_HELM_RECOVERY_MANIFEST_NAME,
} from './kubernetes-helm.js';

export const BACKUP_CONTENTS_MANIFEST_NAME = 'backup-contents.json';
export const FLEET_ARTIFACT_IDENTITY_NAME = 'fleet-artifact-identity.json';

export interface SessionSnapshotMember {
  name: string;
  sha256: string;
}

export interface BackupContentsManifest {
  schemaVersion: 1 | 2;
  capturedAt: string;
  kubernetesHelmRecovery: 'required' | 'absent';
  fleetArtifactIdentitySha256?: string;
  sessionSnapshots?: SessionSnapshotMember[];
}

export function createBackupContentsManifest(options: {
  backupDir: string;
  kubernetesHelmRecovery: boolean;
  fleetArtifactIdentitySha256?: string;
  sessionSnapshots?: readonly SessionSnapshotMember[];
  now?: () => number;
}): BackupContentsManifest {
  const manifest: BackupContentsManifest = {
    schemaVersion: options.sessionSnapshots ? 2 : 1,
    capturedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    kubernetesHelmRecovery: options.kubernetesHelmRecovery ? 'required' : 'absent',
    ...(options.fleetArtifactIdentitySha256
      ? { fleetArtifactIdentitySha256: options.fleetArtifactIdentitySha256 }
      : {}),
    ...(options.sessionSnapshots
      ? { sessionSnapshots: options.sessionSnapshots.map(member => ({ ...member })) }
      : {}),
  };
  writeJsonAtomic(join(options.backupDir, BACKUP_CONTENTS_MANIFEST_NAME), manifest);
  return manifest;
}

export function verifyBackupContentsManifest(backupDir: string): BackupContentsManifest {
  const manifestPath = join(backupDir, BACKUP_CONTENTS_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup contents manifest missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  if (!isRecord(parsed)) {
    throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
  }
  const actualKeys = Object.keys(parsed).sort((a, b) => a.localeCompare(b));
  const identityPath = join(backupDir, FLEET_ARTIFACT_IDENTITY_NAME);
  const identityExists = existsSync(identityPath);
  const hasAuthenticatedSessions = parsed.schemaVersion === 2;
  const expectedKeys = [
    'capturedAt',
    ...(identityExists ? ['fleetArtifactIdentitySha256'] : []),
    'kubernetesHelmRecovery',
    'schemaVersion',
    ...(hasAuthenticatedSessions ? ['sessionSnapshots'] : []),
  ];
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2)
    || typeof parsed.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.capturedAt))
    || (identityExists && (typeof parsed.fleetArtifactIdentitySha256 !== 'string'
      || !/^[0-9a-f]{64}$/u.test(parsed.fleetArtifactIdentitySha256)))
    || (parsed.kubernetesHelmRecovery !== 'required' && parsed.kubernetesHelmRecovery !== 'absent')
  ) {
    throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
  }

  let sessionSnapshots: SessionSnapshotMember[] | undefined;
  if (hasAuthenticatedSessions) {
    if (!Array.isArray(parsed.sessionSnapshots)) {
      throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
    }
    sessionSnapshots = parsed.sessionSnapshots.map((rawMember) => {
      if (!isRecord(rawMember)
        || Object.keys(rawMember).sort().join(',') !== 'name,sha256'
        || typeof rawMember.name !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/u.test(rawMember.name)
        || typeof rawMember.sha256 !== 'string'
        || !/^[0-9a-f]{64}$/u.test(rawMember.sha256)) {
        throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
      }
      return { name: rawMember.name, sha256: rawMember.sha256 };
    });
    const expectedNames = sessionSnapshots.map(member => member.name);
    const canonicalNames = [...new Set(expectedNames)].sort((a, b) => a.localeCompare(b));
    if (expectedNames.some((name, index) => name !== canonicalNames[index])) {
      throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
    }
    const sessionsDir = join(backupDir, 'sessions');
    if (!existsSync(sessionsDir) || !statSync(sessionsDir).isDirectory()) {
      throw new Error('Backup contents session snapshot membership mismatch');
    }
    const actualEntries = readdirSync(sessionsDir, { withFileTypes: true });
    const actualNames = actualEntries.map(entry => entry.name).sort((a, b) => a.localeCompare(b));
    if (actualEntries.some(entry => !entry.isFile())
      || actualNames.length !== expectedNames.length
      || actualNames.some((name, index) => name !== expectedNames[index])) {
      throw new Error('Backup contents session snapshot membership mismatch');
    }
    for (const member of sessionSnapshots) {
      const snapshotPath = join(sessionsDir, member.name);
      const bytes = readFileSync(snapshotPath);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== member.sha256) {
        throw new Error(`Backup contents session snapshot digest mismatch: ${member.name}`);
      }
      const lines = bytes.toString('utf8').split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        try {
          JSON.parse(line);
        } catch {
          throw new Error(
            `Backup contents session snapshot has invalid JSONL: ${member.name}:${index + 1}`,
          );
        }
      }
    }
  }

  const helmManifestExists = existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME));
  const helmDirectoryExists = existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_DIR_NAME));
  if (parsed.kubernetesHelmRecovery === 'required' && (!helmManifestExists || !helmDirectoryExists)) {
    throw new Error('Backup contents manifest requires a complete Kubernetes Helm recovery bundle');
  }
  if (parsed.kubernetesHelmRecovery === 'absent' && (helmManifestExists || helmDirectoryExists)) {
    throw new Error('Backup contents manifest forbids an unexpected Kubernetes Helm recovery bundle');
  }
  if (identityExists) {
    const actualIdentitySha256 = createHash('sha256').update(readFileSync(identityPath)).digest('hex');
    if (actualIdentitySha256 !== parsed.fleetArtifactIdentitySha256) {
      throw new Error('Backup contents manifest fleet artifact identity digest mismatch');
    }
  }

  return {
    schemaVersion: parsed.schemaVersion,
    capturedAt: parsed.capturedAt,
    kubernetesHelmRecovery: parsed.kubernetesHelmRecovery,
    ...(identityExists
      ? { fleetArtifactIdentitySha256: parsed.fleetArtifactIdentitySha256 as string }
      : {}),
    ...(sessionSnapshots ? { sessionSnapshots } : {}),
  };
}
