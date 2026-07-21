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

describe('ImageReferenceStore lineage, promotion, and rollback', () => {
  function last<T>(items: readonly T[]): T | undefined {
    return items[items.length - 1];
  }

  it('promotes a generated image, records lineage, and rolls back with a full audit trail', async () => {
    const dir = makeCompanionDataDir();
    const store = new ImageReferenceStore(dir);
    const uploaded = await store.add({
      filename: 'base.png',
      contentType: 'image/png',
      data: Buffer.from([1, 2, 3]),
      description: 'base look',
      setDefault: true,
    });
    expect(uploaded.isDefault).toBe(true);
    expect(uploaded.lineage.source.kind).toBe('upload');

    const promoted = await store.promoteGeneration({
      filename: 'promoted.png',
      contentType: 'image/png',
      data: Buffer.from([4, 5, 6]),
      promotionReason: 'she looks the most like me here',
      source: { kind: 'promoted_generation', generatedImageId: 'gen-1', requestId: 'req-9' },
    });
    expect(promoted.isDefault).toBe(true);
    expect(promoted.lineage.source.generatedImageId).toBe('gen-1');
    expect(promoted.lineage.previousReferenceId).toBe(uploaded.id);
    expect(promoted.lineage.promotionReason).toBe('she looks the most like me here');

    const afterPromote = await store.list();
    expect(afterPromote.defaultReferenceId).toBe(promoted.id);
    expect(last(afterPromote.defaultHistory)).toMatchObject({
      referenceId: promoted.id,
      previousReferenceId: uploaded.id,
      actor: 'operator',
      reason: 'she looks the most like me here',
    });

    const rolledBack = await store.rollbackDefault({ reason: 'the promoted look drifted' });
    expect(rolledBack.id).toBe(uploaded.id);
    const afterRollback = await store.list();
    expect(afterRollback.defaultReferenceId).toBe(uploaded.id);
    expect(last(afterRollback.defaultHistory)).toMatchObject({
      referenceId: uploaded.id,
      previousReferenceId: promoted.id,
      reason: 'the promoted look drifted',
    });
  });

  it('exposes a lineage chain from a promoted reference back to its seed upload', async () => {
    const dir = makeCompanionDataDir();
    const store = new ImageReferenceStore(dir);
    const uploaded = await store.add({
      filename: 'seed.png',
      contentType: 'image/png',
      data: Buffer.from([1]),
      setDefault: true,
    });
    const promoted = await store.promoteGeneration({
      filename: 'p.png',
      contentType: 'image/png',
      data: Buffer.from([2]),
      promotionReason: 'anchor',
      source: { kind: 'promoted_generation', generatedImageId: 'gen-1' },
    });
    await store.recordDerivedGeneration(promoted.id, 'gen-42');

    const lineage = await store.getLineage(promoted.id);
    expect(lineage.reference.id).toBe(promoted.id);
    expect(lineage.reference.lineage.derivedGenerationIds).toContain('gen-42');
    expect(lineage.chain.map((entry) => entry.id)).toEqual([uploaded.id]);
  });

  it('fails closed when rolling back with no recorded previous default', async () => {
    const dir = makeCompanionDataDir();
    const store = new ImageReferenceStore(dir);
    await store.add({
      filename: 'only.png',
      contentType: 'image/png',
      data: Buffer.from([1]),
      setDefault: true,
    });
    await expect(store.rollbackDefault()).rejects.toThrow('No previous reference recorded');
  });

  it('loads a legacy flat index without lineage fields unchanged', async () => {
    const dir = makeCompanionDataDir();
    writeReferenceIndex(dir, 'legacy.png', 'legacy-id');
    const store = new ImageReferenceStore(dir);

    const list = await store.list();
    expect(list.references[0]?.lineage).toEqual({ source: { kind: 'upload' }, derivedGenerationIds: [] });
    expect(list.defaultHistory).toEqual([]);
    expect(list.defaultReferenceId).toBe('legacy-id');
  });
});
