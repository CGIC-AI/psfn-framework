import { fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveRuntimeCredentialFromEnvironment,
} from './runtime-credential-source.js';

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('runtime credential sources', () => {
  it('resolves a credential from an absolute secret-file reference', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-runtime-credential-'));
    TEMP_DIRS.push(root);
    const credentialPath = join(root, 'database-url');
    writeFileSync(credentialPath, 'postgresql://psfn:file-secret@postgres/psfn\n', 'utf8');

    expect(resolveRuntimeCredentialFromEnvironment({
      POSTGRES_DATABASE_URL_FILE: credentialPath,
    }, {
      description: 'PostgreSQL database URL',
      inlineEnvName: 'POSTGRES_DATABASE_URL',
      fileEnvName: 'POSTGRES_DATABASE_URL_FILE',
      fdEnvName: 'POSTGRES_DATABASE_URL_FD',
    })).toBe('postgresql://psfn:file-secret@postgres/psfn');
  });

  it('consumes and closes an inherited credential file descriptor', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-runtime-credential-fd-'));
    TEMP_DIRS.push(root);
    const credentialPath = join(root, 'database-url');
    writeFileSync(credentialPath, 'postgresql://psfn:fd-secret@postgres/psfn\n', 'utf8');
    const fd = openSync(credentialPath, 'r');

    expect(resolveRuntimeCredentialFromEnvironment({
      POSTGRES_DATABASE_URL_FD: String(fd),
    }, {
      description: 'PostgreSQL database URL',
      inlineEnvName: 'POSTGRES_DATABASE_URL',
      fileEnvName: 'POSTGRES_DATABASE_URL_FILE',
      fdEnvName: 'POSTGRES_DATABASE_URL_FD',
    })).toBe('postgresql://psfn:fd-secret@postgres/psfn');
    expect(() => fstatSync(fd)).toThrow(/EBADF/);
  });

  it('names a broken descriptor handover instead of surfacing a bare platform read error', () => {
    expect(() => resolveRuntimeCredentialFromEnvironment({
      POSTGRES_DATABASE_URL_FD: '999999',
    }, {
      description: 'PostgreSQL database URL',
      inlineEnvName: 'POSTGRES_DATABASE_URL',
      fileEnvName: 'POSTGRES_DATABASE_URL_FILE',
      fdEnvName: 'POSTGRES_DATABASE_URL_FD',
    })).toThrow(
      /PostgreSQL database URL credential file descriptor 999999 could not be read.*EBADF/u,
    );
  });
});
