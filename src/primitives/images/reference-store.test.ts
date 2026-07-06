import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ImageReferenceStore } from './reference-store.js';

let tempRoot: string | null = null;

interface ReferencePathResolver {
  resolveReferencePath(fileName: string): string;
}

function makeCompanionDataDir(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'psfn-reference-store-'));
  return tempRoot;
}

function writeReferenceIndex(companionDataDir: string, fileName: string, id: string): void {
  const assetsDir = join(companionDataDir, 'state', 'identity-assets');
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(
    join(assetsDir, 'image-references.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      defaultReferenceId: id,
      references: [{
        id,
        fileName,
        contentType: 'image/png',
        description: '',
        tags: [],
        sizeBytes: 1,
        createdAt: '2026-07-06T00:00:00.000Z',
        updatedAt: '2026-07-06T00:00:00.000Z',
      }],
    }, null, 2)}\n`,
    'utf-8',
  );
}

function resolveReferencePathForTest(store: ImageReferenceStore, fileName: string): string {
  return (store as unknown as ReferencePathResolver).resolveReferencePath(fileName);
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

describe('ImageReferenceStore path containment', () => {
  it('keeps stored reference file names flattened to a bare basename', async () => {
    const companionDataDir = makeCompanionDataDir();
    writeReferenceIndex(companionDataDir, 'sub/dir/name.png', 'ref-nested');
    const store = new ImageReferenceStore(companionDataDir);

    await expect(store.list()).resolves.toMatchObject({
      references: [expect.objectContaining({ fileName: 'name.png' })],
    });
  });

  it('rejects traversal reference paths outside the image reference root', () => {
    const companionDataDir = makeCompanionDataDir();
    const store = new ImageReferenceStore(companionDataDir);

    expect(() => resolveReferencePathForTest(store, '../evil.png')).toThrow('Invalid reference photo path');
  });

  it('rejects sibling-prefix reference directories outside the image reference root', () => {
    const companionDataDir = makeCompanionDataDir();
    const store = new ImageReferenceStore(companionDataDir);

    expect(() => resolveReferencePathForTest(store, '../image-referencesExtra/evil.png')).toThrow(
      'Invalid reference photo path',
    );
  });
});
