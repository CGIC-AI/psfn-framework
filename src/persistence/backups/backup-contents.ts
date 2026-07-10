import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  KUBERNETES_HELM_RECOVERY_DIR_NAME,
  KUBERNETES_HELM_RECOVERY_MANIFEST_NAME,
} from './kubernetes-helm.js';

export const BACKUP_CONTENTS_MANIFEST_NAME = 'backup-contents.json';

export interface BackupContentsManifest {
  schemaVersion: 1;
  capturedAt: string;
  kubernetesHelmRecovery: 'required' | 'absent';
}

export function createBackupContentsManifest(options: {
  backupDir: string;
  kubernetesHelmRecovery: boolean;
  now?: () => number;
}): BackupContentsManifest {
  const manifest: BackupContentsManifest = {
    schemaVersion: 1,
    capturedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    kubernetesHelmRecovery: options.kubernetesHelmRecovery ? 'required' : 'absent',
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
  const expectedKeys = ['capturedAt', 'kubernetesHelmRecovery', 'schemaVersion'];
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
    || parsed.schemaVersion !== 1
    || typeof parsed.capturedAt !== 'string'
    || !Number.isFinite(Date.parse(parsed.capturedAt))
    || (parsed.kubernetesHelmRecovery !== 'required' && parsed.kubernetesHelmRecovery !== 'absent')
  ) {
    throw new Error(`Invalid backup contents manifest: ${manifestPath}`);
  }

  const helmManifestExists = existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_MANIFEST_NAME));
  const helmDirectoryExists = existsSync(join(backupDir, KUBERNETES_HELM_RECOVERY_DIR_NAME));
  if (parsed.kubernetesHelmRecovery === 'required' && (!helmManifestExists || !helmDirectoryExists)) {
    throw new Error('Backup contents manifest requires a complete Kubernetes Helm recovery bundle');
  }
  if (parsed.kubernetesHelmRecovery === 'absent' && (helmManifestExists || helmDirectoryExists)) {
    throw new Error('Backup contents manifest forbids an unexpected Kubernetes Helm recovery bundle');
  }

  return {
    schemaVersion: 1,
    capturedAt: parsed.capturedAt,
    kubernetesHelmRecovery: parsed.kubernetesHelmRecovery,
  };
}
