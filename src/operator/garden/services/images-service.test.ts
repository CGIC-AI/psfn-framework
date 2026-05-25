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
