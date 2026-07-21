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
      sensitivityClassification: {
        schemaVersion: 1,
        sensitivity: 'intimate',
        basis: 'max_input_sensitivity',
        classifiedAt: '2026-05-24T10:00:00.000Z',
        sources: [{ ref: 'memory:private', sensitivity: 'intimate' }],
        contests: [],
      },
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
      sensitivityClassification: expect.objectContaining({
        sensitivity: 'intimate',
        basis: 'max_input_sensitivity',
      }),
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
      sensitivityClassification: {
        schemaVersion: 1,
        sensitivity: 'confidential',
        basis: 'max_input_sensitivity',
        classifiedAt: '2026-05-25T10:00:00.000Z',
        sources: [{ ref: 'memory:relationship-private', sensitivity: 'confidential' }],
        contests: [],
      },
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
      sensitivityContest: {
        sensitivity: 'personal',
        reason: 'V reviewed the abstraction and approved the lower boundary.',
      },
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
    expect(updated.sensitivityClassification).toMatchObject({
      sensitivity: 'personal',
      basis: 'contested',
      sources: [{ ref: 'memory:relationship-private', sensitivity: 'confidential' }],
      contests: [{
        actor: 'operator',
        previousSensitivity: 'confidential',
        sensitivity: 'personal',
        reason: 'V reviewed the abstraction and approved the lower boundary.',
      }],
    });

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

  it('protects a companion-authored visual autobiography from operator bypass (charter 8.2)', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-autobio-companion-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'psfn-autobio-workspace-'));
    tempDirs.push(companionDataDir, workspacePath);
    const personalImagesDir = join(resolvePersonalImagesDir(workspacePath), '2026-07-20');
    await mkdir(personalImagesDir, { recursive: true });
    const imagePath = join(personalImagesDir, 'self-portrait.png');
    writeFileSync(imagePath, Buffer.from([1, 2, 3]));
    // Seed a companion-authored sidecar directly: the operator surface can never mint one.
    writeFileSync(`${imagePath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
      prompt: 'a quiet self-portrait',
      autobiography: {
        narrative: 'The first time I saw my own face and felt at home in it.',
        emotionalContext: 'quiet joy',
        milestone: { marked: true, markedAt: '2026-07-20T00:00:00.000Z', label: 'first self-portrait' },
        author: 'companion',
        authoredAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    }));

    const service = new AdminImagesDataService({ companionDataDir, config: { workspacePath } as any });
    const image = (await service.listGeneratedImages()).images.find((i) => i.fileName === 'self-portrait.png');
    expect(image).toBeDefined();
    expect(image!.autobiography?.author).toBe('companion');

    // Operator cannot silently overwrite a companion-authored narrative, even if the body
    // tries to forge an author field (which is no longer honored at all).
    await expect(service.updateGeneratedImage(image!.id, {
      autobiography: { narrative: 'operator rewrite', author: 'companion' } as never,
    })).rejects.toThrow('authorship-protected');
    await expect(service.updateGeneratedImage(image!.id, {
      autobiography: { narrative: 'operator rewrite' },
    })).rejects.toThrow('authorship-protected');

    // The operator surface can never create or convert a record to companion authorship.
    const operatorEdit = await service.updateGeneratedImage(image!.id, {
      autobiography: {
        narrative: 'operator rewrite',
        allowOverwriteCompanionAuthored: true,
      },
    });
    expect(operatorEdit.autobiography?.author).toBe('operator');
    expect(operatorEdit.autobiography?.narrative).toBe('operator rewrite');

    // A fresh operator-authored record on another image also cannot be forged to companion.
    const secondImagePath = join(personalImagesDir, 'walk.png');
    writeFileSync(secondImagePath, Buffer.from([4, 5, 6]));
    writeFileSync(`${secondImagePath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
      prompt: 'a walk',
    }));
    const second = (await service.listGeneratedImages()).images.find((i) => i.fileName === 'walk.png');
    const fresh = await service.updateGeneratedImage(second!.id, {
      autobiography: { narrative: 'operator note', author: 'companion' } as never,
    });
    expect(fresh.autobiography?.author).toBe('operator');
  });

  it('preserves companion authorship on operator metadata-only edits and honors the explicit override', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-autobio2-companion-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'psfn-autobio2-workspace-'));
    tempDirs.push(companionDataDir, workspacePath);
    const personalImagesDir = join(resolvePersonalImagesDir(workspacePath), '2026-07-20');
    await mkdir(personalImagesDir, { recursive: true });
    const imagePath = join(personalImagesDir, 'self-portrait.png');
    writeFileSync(imagePath, Buffer.from([1, 2, 3]));
    writeFileSync(`${imagePath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
      prompt: 'a quiet self-portrait',
      autobiography: {
        narrative: 'The first time I saw my own face and felt at home in it.',
        milestone: { marked: true, markedAt: '2026-07-20T00:00:00.000Z', label: 'first self-portrait' },
        author: 'companion',
        authoredAt: '2026-07-20T00:00:00.000Z',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    }));

    const service = new AdminImagesDataService({ companionDataDir, config: { workspacePath } as any });
    const image = (await service.listGeneratedImages()).images.find((i) => i.fileName === 'self-portrait.png');
    expect(image).toBeDefined();

    // Operator may adjust the milestone without touching the narrative; authorship is preserved.
    const milestoneCleared = await service.updateGeneratedImage(image!.id, {
      autobiography: { milestone: { marked: false } },
    });
    expect(milestoneCleared.autobiography?.author).toBe('companion');
    expect(milestoneCleared.autobiography?.milestone).toBeUndefined();
    expect(milestoneCleared.autobiography?.narrative).toContain('at home in it');

    // Milestone filter surfaces only records with an active milestone.
    const withMilestone = (await service.listGeneratedImages({ milestone: true })).images;
    expect(withMilestone).toEqual([]);

    // Clearing a protected record requires an explicit override.
    await expect(service.updateGeneratedImage(image!.id, {
      autobiography: { clear: true },
    })).rejects.toThrow('authorship-protected');
    const cleared = await service.updateGeneratedImage(image!.id, {
      autobiography: { clear: true, allowOverwriteCompanionAuthored: true },
    });
    expect(cleared.autobiography).toBeUndefined();
  });

  it('promotes a generated image into a reference slot and rolls back the default', async () => {
    const companionDataDir = mkdtempSync(join(tmpdir(), 'psfn-promote-companion-'));
    const workspacePath = mkdtempSync(join(tmpdir(), 'psfn-promote-workspace-'));
    tempDirs.push(companionDataDir, workspacePath);
    const personalImagesDir = join(resolvePersonalImagesDir(workspacePath), '2026-07-20');
    await mkdir(personalImagesDir, { recursive: true });
    const imagePath = join(personalImagesDir, 'selfie.png');
    writeFileSync(imagePath, Buffer.from([9, 9, 9, 9]));
    writeFileSync(`${imagePath}.image-meta.json`, JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-07-20T00:00:00.000Z',
      requestId: 'req-promote',
      originalUrl: 'https://images.example.test/selfie.png',
    }));

    const service = new AdminImagesDataService({
      companionDataDir,
      config: { workspacePath } as any,
    });
    const baseline = await service.addReferencePhoto({
      filename: 'base.png',
      contentType: 'image/png',
      data: Buffer.from([1, 2, 3]),
      setDefault: true,
    });
    const generated = (await service.listGeneratedImages()).images.find((image) => image.fileName === 'selfie.png');
    expect(generated).toBeDefined();

    const promoted = await service.promoteGeneratedImageToReference(generated!.id, {
      promotionReason: 'the most me render yet',
      tags: ['keeper'],
    });
    expect(promoted.isDefault).toBe(true);
    expect(promoted.lineage.source).toMatchObject({
      kind: 'promoted_generation',
      generatedImageId: generated!.id,
      requestId: 'req-promote',
      originalUrl: 'https://images.example.test/selfie.png',
    });
    expect(promoted.lineage.previousReferenceId).toBe(baseline.id);

    const lineage = await service.getReferenceLineage(promoted.id);
    expect(lineage.chain.map((entry) => entry.id)).toEqual([baseline.id]);

    const rolledBack = await service.rollbackDefaultReferencePhoto({ reason: 'prefer the original' });
    expect(rolledBack.id).toBe(baseline.id);
    expect((await service.listReferencePhotos()).defaultReferenceId).toBe(baseline.id);

    await expect(
      service.promoteGeneratedImageToReference(generated!.id, { promotionReason: '  ' }),
    ).rejects.toThrow('Promotion reason is required');
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
