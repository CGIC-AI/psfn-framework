import { spawn, type ChildProcessByStdio } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

export const ENCRYPTED_BACKUP_PAYLOAD_NAME = 'snapshot.tar.gz.enc';
export const ENCRYPTED_BACKUP_MANIFEST_NAME = 'encrypted-backup.json';

export interface BackupEncryptionKeyRef {
  kind: 'env';
  envName: string;
}

export interface BackupEncryptionRuntimeConfig {
  mode: 'required';
  keyRef: BackupEncryptionKeyRef;
  passphrase: string;
  tarBinary?: string;
}

export interface EncryptedBackupManifest {
  schemaVersion: 1;
  encryptedAt: string;
  sourceDirName: string;
  payloadFile: string;
  archiveFormat: 'tar.gz';
  cipher: 'aes-256-gcm';
  kdf: 'scrypt';
  kdfParams: {
    saltBase64: string;
    keyLengthBytes: 32;
    cost: number;
    blockSize: number;
    parallelization: number;
  };
  ivBase64: string;
  authTagBase64: string;
  encryptedSha256: string;
  encryptedSizeBytes: number;
  keyRef: BackupEncryptionKeyRef;
}

export interface EncryptedBackupPackageResult {
  encryptedBackupDir: string;
  manifestPath: string;
  payloadPath: string;
  encryptedSizeBytes: number;
  encryptedSha256: string;
}

const SCRYPT_PARAMS = {
  cost: 16_384,
  blockSize: 8,
  parallelization: 1,
} as const;

type TarProcess =
  | ChildProcessByStdio<null, Readable, Readable>
  | ChildProcessByStdio<Writable, null, Readable>;

function assertUsablePassphrase(encryption: BackupEncryptionRuntimeConfig): string {
  const passphrase = encryption.passphrase.trim();
  if (!passphrase) {
    throw new Error(`Backup encryption key env ${encryption.keyRef.envName} is empty`);
  }
  return passphrase;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function readManifestString(
  root: Record<string, unknown>,
  key: string,
  manifestPath: string,
): string {
  const value = root[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid encrypted backup manifest at ${manifestPath}`);
  }
  return value;
}

function readManifestNumber(
  root: Record<string, unknown>,
  key: string,
  manifestPath: string,
): number {
  const value = root[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid encrypted backup manifest at ${manifestPath}`);
  }
  return value;
}

function describeProcessError(binary: string, code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const status = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
  const detail = stderr.trim();
  return detail ? `${binary} failed with ${status}: ${detail}` : `${binary} failed with ${status}`;
}

function waitForProcess(child: TarProcess, binary: string): Promise<void> {
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(describeProcessError(binary, code, signal, stderr)));
    });
  });
}

export function readEncryptedBackupManifest(encryptedBackupDir: string): EncryptedBackupManifest {
  const manifestPath = join(encryptedBackupDir, ENCRYPTED_BACKUP_MANIFEST_NAME);
  if (!existsSync(manifestPath)) {
    throw new Error(`Encrypted backup manifest missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as unknown;
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) {
    throw new Error(`Invalid encrypted backup manifest at ${manifestPath}`);
  }
  if (parsed.cipher !== 'aes-256-gcm' || parsed.kdf !== 'scrypt' || parsed.archiveFormat !== 'tar.gz') {
    throw new Error(`Unsupported encrypted backup manifest at ${manifestPath}`);
  }
  const kdfParams = parsed.kdfParams;
  if (!isRecord(kdfParams)) {
    throw new Error(`Invalid encrypted backup manifest at ${manifestPath}`);
  }
  const keyRef = parsed.keyRef;
  if (
    !isRecord(keyRef)
    || keyRef.kind !== 'env'
    || typeof keyRef.envName !== 'string'
    || keyRef.envName.trim() === ''
  ) {
    throw new Error(`Invalid encrypted backup manifest at ${manifestPath}`);
  }
  const keyLengthBytes = readManifestNumber(kdfParams, 'keyLengthBytes', manifestPath);
  if (keyLengthBytes !== 32) {
    throw new Error(`Unsupported encrypted backup manifest at ${manifestPath}`);
  }
  return {
    schemaVersion: 1,
    encryptedAt: readManifestString(parsed, 'encryptedAt', manifestPath),
    sourceDirName: readManifestString(parsed, 'sourceDirName', manifestPath),
    payloadFile: readManifestString(parsed, 'payloadFile', manifestPath),
    archiveFormat: 'tar.gz',
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: {
      saltBase64: readManifestString(kdfParams, 'saltBase64', manifestPath),
      keyLengthBytes: 32,
      cost: readManifestNumber(kdfParams, 'cost', manifestPath),
      blockSize: readManifestNumber(kdfParams, 'blockSize', manifestPath),
      parallelization: readManifestNumber(kdfParams, 'parallelization', manifestPath),
    },
    ivBase64: readManifestString(parsed, 'ivBase64', manifestPath),
    authTagBase64: readManifestString(parsed, 'authTagBase64', manifestPath),
    encryptedSha256: readManifestString(parsed, 'encryptedSha256', manifestPath),
    encryptedSizeBytes: readManifestNumber(parsed, 'encryptedSizeBytes', manifestPath),
    keyRef: {
      kind: 'env',
      envName: keyRef.envName,
    },
  };
}

export function resolveBackupEncryptionFromManifest(
  manifest: EncryptedBackupManifest,
  env: NodeJS.ProcessEnv = process.env,
): BackupEncryptionRuntimeConfig {
  const envName = manifest.keyRef.envName.trim();
  const passphrase = env[envName]?.trim();
  if (!passphrase) {
    throw new Error(`Backup decryption key env ${envName} is required`);
  }
  return {
    mode: 'required',
    keyRef: manifest.keyRef,
    passphrase,
  };
}

export async function encryptBackupDirectory(options: {
  sourceDir: string;
  outputDir: string;
  encryption: BackupEncryptionRuntimeConfig;
  now?: () => number;
}): Promise<EncryptedBackupPackageResult> {
  if (!existsSync(options.sourceDir)) {
    throw new Error(`Backup plaintext staging directory missing: ${options.sourceDir}`);
  }
  const passphrase = assertUsablePassphrase(options.encryption);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const tarBinary = options.encryption.tarBinary?.trim() || 'tar';
  const payloadPath = join(options.outputDir, ENCRYPTED_BACKUP_PAYLOAD_NAME);
  const manifestPath = join(options.outputDir, ENCRYPTED_BACKUP_MANIFEST_NAME);

  mkdirSync(options.outputDir, { recursive: true });
  const tar = spawn(tarBinary, ['-C', options.sourceDir, '-czf', '-', '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    await Promise.all([
      pipeline(tar.stdout, cipher, createWriteStream(payloadPath, { mode: 0o600 })),
      waitForProcess(tar, tarBinary),
    ]);
  } catch (error) {
    rmSync(payloadPath, { force: true });
    throw error;
  }

  const authTag = cipher.getAuthTag();
  const { sha256, sizeBytes } = hashFile(payloadPath);
  const manifest: EncryptedBackupManifest = {
    schemaVersion: 1,
    encryptedAt: new Date((options.now ?? (() => Date.now()))()).toISOString(),
    sourceDirName: basename(options.sourceDir),
    payloadFile: ENCRYPTED_BACKUP_PAYLOAD_NAME,
    archiveFormat: 'tar.gz',
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: {
      saltBase64: salt.toString('base64'),
      keyLengthBytes: 32,
      cost: SCRYPT_PARAMS.cost,
      blockSize: SCRYPT_PARAMS.blockSize,
      parallelization: SCRYPT_PARAMS.parallelization,
    },
    ivBase64: iv.toString('base64'),
    authTagBase64: authTag.toString('base64'),
    encryptedSha256: sha256,
    encryptedSizeBytes: sizeBytes,
    keyRef: options.encryption.keyRef,
  };
  writeJsonAtomic(manifestPath, manifest);

  return {
    encryptedBackupDir: options.outputDir,
    manifestPath,
    payloadPath,
    encryptedSizeBytes: sizeBytes,
    encryptedSha256: sha256,
  };
}

export async function decryptEncryptedBackupPackage(options: {
  encryptedBackupDir: string;
  outputDir: string;
  encryption: BackupEncryptionRuntimeConfig;
}): Promise<string> {
  const manifest = readEncryptedBackupManifest(options.encryptedBackupDir);
  const payloadPath = join(options.encryptedBackupDir, manifest.payloadFile);
  if (!existsSync(payloadPath)) {
    throw new Error(`Encrypted backup payload missing: ${payloadPath}`);
  }
  const current = hashFile(payloadPath);
  if (current.sha256 !== manifest.encryptedSha256 || current.sizeBytes !== manifest.encryptedSizeBytes) {
    throw new Error(`Encrypted backup payload hash mismatch: ${payloadPath}`);
  }

  const passphrase = assertUsablePassphrase(options.encryption);
  const salt = Buffer.from(manifest.kdfParams.saltBase64, 'base64');
  const iv = Buffer.from(manifest.ivBase64, 'base64');
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(Buffer.from(manifest.authTagBase64, 'base64'));
  const tarBinary = options.encryption.tarBinary?.trim() || 'tar';

  mkdirSync(options.outputDir, { recursive: true });
  const tar = spawn(tarBinary, ['-xzf', '-', '-C', options.outputDir], {
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  try {
    await Promise.all([
      pipeline(createReadStream(payloadPath), decipher, tar.stdin),
      waitForProcess(tar, tarBinary),
    ]);
  } catch (error) {
    rmSync(options.outputDir, { recursive: true, force: true });
    throw error;
  }
  return options.outputDir;
}

export async function decryptEncryptedBackupToTemp(
  encryptedBackupDir: string,
  encryption: BackupEncryptionRuntimeConfig,
): Promise<{ decryptedBackupDir: string; cleanup: () => void }> {
  const root = await mkdtemp(join(tmpdir(), 'psfn-backup-decrypted-'));
  const decryptedBackupDir = join(root, 'snapshot');
  try {
    await decryptEncryptedBackupPackage({
      encryptedBackupDir,
      outputDir: decryptedBackupDir,
      encryption,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    decryptedBackupDir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function assertEncryptedBackupPackage(encryptedBackupDir: string): EncryptedBackupManifest {
  const manifest = readEncryptedBackupManifest(encryptedBackupDir);
  const payloadPath = join(encryptedBackupDir, manifest.payloadFile);
  if (!existsSync(payloadPath)) {
    throw new Error(`Encrypted backup payload missing: ${payloadPath}`);
  }
  const stats = statSync(payloadPath);
  if (!stats.isFile()) {
    throw new Error(`Encrypted backup payload is not a file: ${payloadPath}`);
  }
  const current = hashFile(payloadPath);
  if (current.sha256 !== manifest.encryptedSha256 || current.sizeBytes !== manifest.encryptedSizeBytes) {
    throw new Error(`Encrypted backup payload hash mismatch: ${payloadPath}`);
  }
  return manifest;
}
