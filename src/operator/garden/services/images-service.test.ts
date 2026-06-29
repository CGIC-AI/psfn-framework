import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolvePersonalImagesDir } from '../../../persistence/layout.js';
import { AdminImagesDataService } from './images-service.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('AdminImagesDataService', () => {
  it('lists generated images from the personal images root with metadata sidecars', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-images-companion-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'psfn-images-workspace-'));
    tempDirs.push(companionDataDir, workspacePath);
    const personalImagesDir = join(resolvePersonalImagesDir(workspacePath), '2026-05-24');
    await mkdir(personalImagesDir, { recursive: true });
    const imagePath = join(personalImagesDir, 'portrait.png');
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 1]));
    writeFileSync(`${imagePath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-05-24T10:00:00.000Z',
      provider: 'fal',
      mode: 'edit',
      model: 'openai/gpt-image-2/edit',
      requestId: 'req-gallery-1',
      prompt: 'a portrait grounded by a reference image',
      sourceToolName: 'selfie_create',
      referenceImageIds: ['ref-1'],
      contentType: 'image/png',
    }));

    const service = new AdminImagesDataService({
      companionDataDir,
      config: { workspacePath } as any,
    });

    const list = await service.listGeneratedImages();
    expect(list.images).toHaveLength(1);
    expect(list.images[0]).toMatchObject({
      rootKind: 'personal',
      fileName: 'portrait.png',
      prompt: 'a portrait grounded by a reference image',
      model: 'openai/gpt-image-2/edit',
      sourceToolName: 'selfie_create',
      referenceImageIds: ['ref-1'],
    });

    const blob = await service.getGeneratedImageBlob(list.images[0]!.id);
    expect(blob?.contentType).toBe('image/png');
    expect(blob?.data).toEqual(readFileSync(imagePath));
  });

  it('persists gallery favorites, tags, meaningful markers, and filters across service instances', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-images-companion-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'psfn-images-workspace-'));
    tempDirs.push(companionDataDir, workspacePath);
    const personalImagesDir = join(resolvePersonalImagesDir(workspacePath), '2026-05-25');
    await mkdir(personalImagesDir, { recursive: true });
    const firstPath = join(personalImagesDir, 'first.png');
    const secondPath = join(personalImagesDir, 'second.png');
    writeFileSync(firstPath, Buffer.from([1, 2, 3]));
    writeFileSync(secondPath, Buffer.from([4, 5, 6]));
    writeFileSync(`${firstPath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-05-25T10:00:00.000Z',
      prompt: 'first portrait',
      requestId: 'req-first',
      originalUrl: 'https://images.example.test/first.png',
    }));
    writeFileSync(`${secondPath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-05-25T11:00:00.000Z',
      prompt: 'second landscape',
      requestId: 'req-second',
    }));

    const service = new AdminImagesDataService({
      companionDataDir,
      config: { workspacePath } as any,
    });
    const first = (await service.listGeneratedImages()).images.find((image) => image.fileName === 'first.png');
    expect(first).toBeDefined();

    const updated = await service.updateGeneratedImage(first!.id, {
      favorite: true,
      tags: ['Portrait', 'meaningful', 'Portrait'],
      meaningfulMoment: { marked: true, note: 'A warm conversation moment.' },
      conversation: {
        channelId: 'discord:gallery',
        channelType: 'discord',
        turnId: 'turn-gallery-1',
        requestId: 'req-turn-gallery',
        sourceMessageId: 'message-gallery-1',
        userSessionEntryId: 100,
      },
      companionNoteRefs: [{ id: 'wiki:gallery-note', label: 'Gallery note', url: '/wiki/gallery-note' }],
      artifactRefs: [{ kind: 'l0_artifact', refId: 'artifact-gallery-note', label: 'Episode artifact' }],
    });

    expect(updated.favorite).toBe(true);
    expect(updated.tags).toEqual(['portrait', 'meaningful']);
    expect(updated.meaningfulMoment).toMatchObject({
      marked: true,
      note: 'A warm conversation moment.',
      conversation: {
        channelId: 'discord:gallery',
        turnId: 'turn-gallery-1',
      },
    });
    expect(updated.companionNoteRefs).toEqual([
      { id: 'wiki:gallery-note', label: 'Gallery note', url: '/wiki/gallery-note' },
    ]);
    expect(updated.artifactRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'generated_image', localPath: firstPath }),
      expect.objectContaining({ kind: 'shared_image', url: 'https://images.example.test/first.png' }),
      expect.objectContaining({ kind: 'l0_artifact', refId: 'artifact-gallery-note' }),
    ]));

    const persistedMetadata = JSON.parse(readFileSync(`${firstPath}.image-meta.json`, 'utf-8')) as {
      favorite: boolean;
      tags: string[];
      meaningfulMoment: { marked: boolean; note: string };
      companionNoteRefs: Array<{ id: string }>;
    };
    expect(persistedMetadata.favorite).toBe(true);
    expect(persistedMetadata.tags).toEqual(['portrait', 'meaningful']);
    expect(persistedMetadata.meaningfulMoment).toMatchObject({
      marked: true,
      note: 'A warm conversation moment.',
    });
    expect(persistedMetadata.companionNoteRefs).toEqual([expect.objectContaining({ id: 'wiki:gallery-note' })]);

    const reloaded = new AdminImagesDataService({
      companionDataDir,
      config: { workspacePath } as any,
    });
    expect((await reloaded.listGeneratedImages({ favorite: true })).images.map((image) => image.fileName)).toEqual(['first.png']);
    expect((await reloaded.listGeneratedImages({ tags: ['portrait'] })).images.map((image) => image.fileName)).toEqual(['first.png']);
    expect((await reloaded.listGeneratedImages({ meaningful: true, search: 'warm conversation' })).images.map((image) => image.fileName)).toEqual(['first.png']);
    expect((await reloaded.listGeneratedImages({ tags: ['missing'] })).images).toEqual([]);
    expect((await reloaded.listGeneratedImages({ favorite: false })).images.map((image) => image.fileName)).toEqual(['second.png']);
  });

  it('stores, updates, defaults, and deletes identity reference photos', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-ref-companion-'));
    tempDirs.push(companionDataDir);
    const service = new AdminImagesDataService({
      companionDataDir,
      config: {} as any,
    });

    const first = await service.addReferencePhoto({
      filename: 'default.png',
      contentType: 'image/png',
      data: Buffer.from([1, 2, 3]),
      description: 'Default selfie reference',
      tags: ['Default', 'Long Hair'],
      setDefault: true,
    });
    const second = await service.addReferencePhoto({
      filename: 'short-hair.jpg',
      contentType: 'image/jpeg',
      data: Buffer.from([4, 5, 6]),
      description: 'Short hair variant',
      tags: ['short-hair'],
    });

    await service.updateReferencePhoto(second.id, {
      description: 'Short bob variant',
      tags: ['short-hair', 'bob'],
    });
    await service.setDefaultReferencePhoto(second.id);

    const list = await service.listReferencePhotos();
    expect(list.defaultReferenceId).toBe(second.id);
    expect(list.references[0]).toMatchObject({
      id: second.id,
      description: 'Short bob variant',
      tags: ['short-hair', 'bob'],
      isDefault: true,
    });

    const blob = await service.getReferencePhotoBlob(second.id);
    expect(blob?.contentType).toBe('image/jpeg');
    expect(blob?.data).toEqual(Buffer.from([4, 5, 6]));

    await service.deleteReferencePhoto(second.id);
    const afterDelete = await service.listReferencePhotos();
    expect(afterDelete.defaultReferenceId).toBe(first.id);
    expect(afterDelete.references).toHaveLength(1);
    expect(existsSync(join(companionDataDir, 'state', 'identity-assets', 'image-references', `${second.id}.jpg`))).toBe(false);
  });
});
