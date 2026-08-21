import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  loadSatelliteRegistryConfig,
  saveSatelliteRegistryConfig,
} from './satellite-registry.js';
import {
  SyntheticSatelliteRetirementService,
} from './satellite-retirement.js';
import { SATELLITE_REGISTRY_FILE_NAME } from '../../shared/contracts/satellite-registry.js';

const BACKUP_FILE_MODE = 0o600;
const BACKUP_DIRECTORY_MODE = 0o700;

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomicBackup(path: string, bytes: Buffer): void {
  const temporaryPath = `${path}.tmp`;
  try {
    writeFileSync(temporaryPath, bytes, { mode: BACKUP_FILE_MODE, flag: 'wx' });
    fsyncFile(temporaryPath);
    renameSync(temporaryPath, path);
    fsyncFile(dirname(path));
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}

export function createFileSyntheticSatelliteRetirementService(input: {
  systemDataDir: string;
  backupDir: string;
}): SyntheticSatelliteRetirementService {
  const systemDataDir = resolve(input.systemDataDir);
  const backupDir = resolve(input.backupDir);
  mkdirSync(backupDir, { recursive: true, mode: BACKUP_DIRECTORY_MODE });

  return new SyntheticSatelliteRetirementService({
    read: () => loadSatelliteRegistryConfig(systemDataDir),
    backup: {
      create: async ({ target }) => {
        const sourcePath = join(systemDataDir, SATELLITE_REGISTRY_FILE_NAME);
        if (!existsSync(sourcePath)) {
          throw new Error('Synthetic satellite retirement requires an existing satellites.json owner');
        }
        const bytes = readFileSync(sourcePath);
        const digest = sha256(bytes);
        const backupName = `${SATELLITE_REGISTRY_FILE_NAME}.${digest}.backup`;
        const backupPath = join(backupDir, backupName);
        if (!existsSync(backupPath)) writeAtomicBackup(backupPath, bytes);
        if (sha256(readFileSync(backupPath)) !== digest) {
          throw new Error('Synthetic satellite retirement backup verification failed');
        }
        if ((statSync(backupPath).mode & 0o777) !== BACKUP_FILE_MODE) {
          throw new Error('Synthetic satellite retirement backup mode must be 0600');
        }
        const targetDigest = sha256(Buffer.from(JSON.stringify({
          satelliteId: target.satelliteId,
          endpointIds: [...target.endpointIds].sort(),
          runId: target.runId,
          manifestId: target.manifestId,
        })));
        return {
          backupRef: `satellite-registry:${basename(backupPath)}:${targetDigest.slice(0, 16)}`,
          backupDigest: `sha256:${digest}`,
        };
      },
    },
    writer: {
      save: async ({ config, expectedBackupDigest }) => {
        const sourcePath = join(systemDataDir, SATELLITE_REGISTRY_FILE_NAME);
        const currentDigest = `sha256:${sha256(readFileSync(sourcePath))}`;
        if (currentDigest !== expectedBackupDigest) {
          throw new Error('Synthetic satellite registry changed after backup; refusing stale retirement');
        }
        saveSatelliteRegistryConfig(systemDataDir, config);
      },
    },
  });
}
