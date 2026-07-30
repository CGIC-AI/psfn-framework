import { closeSync, readFileSync, readSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_RUNTIME_CREDENTIAL_BYTES = 16 * 1024;

export interface RuntimeCredentialEnvironmentContract {
  description: string;
  inlineEnvName: string;
  fileEnvName: string;
  fdEnvName: string;
}

function normalizeCredentialValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function readFileCredential(path: string, description: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`${description} credential file path must be absolute`);
  }
  const stats = statSync(path);
  if (!stats.isFile()) {
    throw new Error(`${description} credential source must be a regular file`);
  }
  if (stats.size > MAX_RUNTIME_CREDENTIAL_BYTES) {
    throw new Error(`${description} credential exceeds ${MAX_RUNTIME_CREDENTIAL_BYTES} bytes`);
  }
  const value = normalizeCredentialValue(readFileSync(path, 'utf8'));
  if (!value) {
    throw new Error(`${description} credential file is empty`);
  }
  return value;
}

function parseCredentialDescriptor(value: string, description: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new Error(`${description} credential file descriptor must be an integer`);
  }
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 3) {
    throw new Error(`${description} credential file descriptor must be at least 3`);
  }
  return fd;
}

function readDescriptorCredential(fd: number, description: string): string {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  let bytesRead: number;
  let readFailure: Error | undefined;
  try {
    do {
      const buffer = Buffer.allocUnsafe(Math.min(4096, MAX_RUNTIME_CREDENTIAL_BYTES + 1 - byteCount));
      try {
        bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        readFailure = new Error(
          `${description} credential file descriptor ${fd} could not be read: ${reason}`,
          { cause: error },
        );
        throw readFailure;
      }
      if (bytesRead > 0) {
        byteCount += bytesRead;
        if (byteCount > MAX_RUNTIME_CREDENTIAL_BYTES) {
          throw new Error(`${description} credential exceeds ${MAX_RUNTIME_CREDENTIAL_BYTES} bytes`);
        }
        chunks.push(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    try {
      closeSync(fd);
    } catch (error) {
      // A failed read of an invalid/platform-incompatible descriptor commonly
      // also makes close fail. Preserve the actionable read error instead of
      // replacing it with a bare EBADF/EINVAL from close.
      if (!readFailure) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${description} credential file descriptor ${fd} could not be closed: ${reason}`,
          { cause: error },
        );
      }
    }
  }
  const value = normalizeCredentialValue(Buffer.concat(chunks).toString('utf8'));
  if (!value) {
    throw new Error(`${description} credential file descriptor is empty`);
  }
  return value;
}

export function resolveRuntimeCredentialFromEnvironment(
  env: NodeJS.ProcessEnv,
  contract: RuntimeCredentialEnvironmentContract,
): string {
  const inlineCredential = normalizeCredentialValue(env[contract.inlineEnvName]);
  if (inlineCredential) {
    throw new Error(
      `${contract.inlineEnvName} must not be present in the agent process environment; `
      + `use ${contract.fileEnvName} or ${contract.fdEnvName}`,
    );
  }

  const filePath = normalizeCredentialValue(env[contract.fileEnvName]);
  const descriptor = normalizeCredentialValue(env[contract.fdEnvName]);
  if (Boolean(filePath) === Boolean(descriptor)) {
    throw new Error(
      `${contract.description} requires exactly one of ${contract.fileEnvName} or ${contract.fdEnvName}`,
    );
  }
  if (filePath) {
    return readFileCredential(filePath, contract.description);
  }
  return readDescriptorCredential(
    parseCredentialDescriptor(descriptor!, contract.description),
    contract.description,
  );
}
