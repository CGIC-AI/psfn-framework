import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertInsideRoot, CogSecForensicArchive } from './forensic-archive.js';
import { resolveCogSecForensicArchiveDir } from '../../persistence/layout.js';

let tempRoot: string | null = null;

function makeTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'psfn-cogsec-archive-'));
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('CogSecForensicArchive', () => {
  it('seals payload outside normal metadata and returns only opaque ref/hash metadata', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);
    const archive = new CogSecForensicArchive(archiveDir, {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });

    const metadata = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_archive',
      kind: 'l0_rows',
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      payload: [{
        id: 7,
        content: 'dirty payload text that belongs only in the sealed archive',
      }],
    });

    expect(metadata).toMatchObject({
      caseId: 'cogsec_20260701T000000Z_archive',
      kind: 'l0_rows',
      sourceChannelId: 'discord-channel-1',
      logicalSessionId: 'logical-session-1',
      createdAt: '2026-07-01T00:00:00.000Z',
    });
    expect(metadata.ref).toMatch(/^cogsec-forensic:\/\/cogsec_20260701T000000Z_archive\/[0-9a-f-]+\.json$/u);
    expect(metadata.sha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(metadata)).not.toContain('dirty payload');
    expect(Object.hasOwn(metadata, 'payload')).toBe(false);

    const artifact = archive.readArtifact(metadata.ref);
    expect(JSON.stringify(artifact.payload)).toContain('dirty payload text');
  });

  it('can return artifact metadata without exposing payload content', () => {
    const root = makeTempRoot();
    const archive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(root));

    const sealed = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_metadata',
      kind: 'memory',
      payload: {
        text: 'sealed unsafe source',
      },
    });

    const metadata = archive.getArtifactMetadata(sealed.ref);

    expect(metadata).toEqual(sealed);
    expect(JSON.stringify(metadata)).not.toContain('sealed unsafe source');
    expect(Object.hasOwn(metadata, 'payload')).toBe(false);
  });

  it('stores artifacts under the CogSec forensic archive directory', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);
    const archive = new CogSecForensicArchive(archiveDir);

    const sealed = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_path',
      kind: 'other',
      payload: ['sealed'],
    });
    const filePath = join(
      archiveDir,
      'cogsec_20260701T000000Z_path',
      `${sealed.artifactId}.json`,
    );

    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('"payload"');
  });

  it('fails closed when the stored payload no longer matches the sealed sha256 digest', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);
    const archive = new CogSecForensicArchive(archiveDir);

    const sealed = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_tamper',
      kind: 'summary',
      payload: { text: 'original sealed summary' },
    });
    const filePath = join(archiveDir, 'cogsec_20260701T000000Z_tamper', `${sealed.artifactId}.json`);

    const stored = JSON.parse(readFileSync(filePath, 'utf-8')) as { payload: { text: string } };
    stored.payload.text = 'tampered sealed summary!!';
    writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');

    expect(() => archive.readArtifact(sealed.ref)).toThrow(
      'CogSec forensic artifact payload does not match its sealed sha256 digest',
    );
    expect(() => archive.getArtifactMetadata(sealed.ref)).toThrow(
      'CogSec forensic artifact payload does not match its sealed sha256 digest',
    );
  });

  it('fails closed when the sealed byte length no longer matches the stored payload', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);
    const archive = new CogSecForensicArchive(archiveDir);

    const sealed = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_length',
      kind: 'summary',
      payload: { text: 'length-checked payload' },
    });
    const filePath = join(archiveDir, 'cogsec_20260701T000000Z_length', `${sealed.artifactId}.json`);

    const stored = JSON.parse(readFileSync(filePath, 'utf-8')) as { byteLength: number };
    stored.byteLength = sealed.byteLength + 1;
    writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');

    expect(() => archive.readArtifact(sealed.ref)).toThrow(
      'CogSec forensic artifact payload does not match its sealed byte length',
    );
  });

  it('fails closed when the stored payload is removed entirely', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);
    const archive = new CogSecForensicArchive(archiveDir);

    const sealed = archive.sealArtifact({
      caseId: 'cogsec_20260701T000000Z_missing',
      kind: 'summary',
      payload: { text: 'payload to remove' },
    });
    const filePath = join(archiveDir, 'cogsec_20260701T000000Z_missing', `${sealed.artifactId}.json`);

    const stored = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    delete stored.payload;
    writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, 'utf-8');

    expect(() => archive.readArtifact(sealed.ref)).toThrow(
      'artifact.payload must be JSON-serializable',
    );
  });

  it('rejects malformed or traversal refs', () => {
    const root = makeTempRoot();
    const archive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(root));

    expect(() => archive.readArtifact('cogsec-forensic://cogsec_20260701T000000Z_bad/../escape.json')).toThrow(
      /malformed|artifact id/u,
    );
    expect(() => archive.sealArtifact({
      caseId: '../bad',
      kind: 'l0_rows',
      payload: [],
    })).toThrow(/caseId/u);
  });

  it('rejects traversal artifact paths outside the forensic archive root', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);

    expect(() => assertInsideRoot(archiveDir, join(archiveDir, '..', 'evil.json'))).toThrow(
      'CogSec forensic path escaped archive root',
    );
  });

  it('rejects sibling-prefix artifact directories outside the forensic archive root', () => {
    const root = makeTempRoot();
    const archiveDir = resolveCogSecForensicArchiveDir(root);

    expect(() => assertInsideRoot(archiveDir, join(`${archiveDir}Extra`, 'artifact.json'))).toThrow(
      'CogSec forensic path escaped archive root',
    );
  });
});
