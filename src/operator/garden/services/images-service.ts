import type { Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import {
  resolveGeneratedImagesDir,
  resolvePersonalImagesDir,
} from '../../../persistence/layout.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  ImageReferenceStore,
  type ImageReferenceListData,
  type ImageReferencePhoto,
  type ImageReferenceUpdateInput,
  type ImageReferenceUploadInput,
} from '../../../primitives/images/reference-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type {
  AdminGeneratedImageArtifactRef,
  AdminGeneratedImageCompanionNoteRef,
  AdminGeneratedImageConversationLink,
  AdminGeneratedImageListData,
  AdminGeneratedImageListQuery,
  AdminGeneratedImageMeaningfulMoment,
  AdminGeneratedImageRootView,
  AdminGeneratedImageUpdateInput,
  AdminGeneratedImageView,
  AdminImageBlob,
  AdminImagesService,
} from './types.js';

const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);
const MAX_GALLERY_TAGS = 32;
const MAX_GALLERY_TAG_CHARS = 64;
const MAX_GALLERY_NOTE_CHARS = 2_000;
const MAX_GALLERY_REF_CHARS = 512;

interface GeneratedImageRoot {
  kind: 'personal' | 'companion';
  path: string;
}

interface GeneratedImageId {
  rootKind: 'personal' | 'companion';
  relativePath: string;
}

interface ResolvedGeneratedImagePath {
  root: GeneratedImageRoot;
  imagePath: string;
  relativePath: string;
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.tif':
    case '.tiff':
      return 'image/tiff';
    default:
      return 'image/png';
  }
}

function encodeGeneratedImageId(value: GeneratedImageId): string {
  return Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
}

function decodeGeneratedImageId(id: string): GeneratedImageId | null {
  try {
    const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rootKind = record.rootKind;
    const relativePath = typeof record.relativePath === 'string' ? record.relativePath.trim() : '';
    if ((rootKind !== 'personal' && rootKind !== 'companion') || !relativePath) return null;
    return { rootKind, relativePath };
  } catch {
    return null;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}/`);
}

async function readMetadata(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(`${path}${GENERATED_IMAGE_META_SUFFIX}`, 'utf-8')) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Existing images may not have sidecars.
  }
  return {};
}

function writeMetadata(path: string, metadata: Record<string, unknown>): void {
  writeJsonAtomic(`${path}${GENERATED_IMAGE_META_SUFFIX}`, metadata);
}

function stringFromMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayFromMetadata(metadata: Record<string, unknown>, key: string): string[] | undefined {
  const value = metadata[key];
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return items.length > 0 ? items : undefined;
}

function normalizedOptionalString(value: unknown, maxChars: number = MAX_GALLERY_REF_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function normalizedOptionalInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}

function normalizeGalleryTags(tags: readonly unknown[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags ?? []) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag.length > MAX_GALLERY_TAG_CHARS ? tag.slice(0, MAX_GALLERY_TAG_CHARS) : tag);
    if (normalized.length >= MAX_GALLERY_TAGS) break;
  }
  return normalized;
}

function galleryTagsFromMetadata(metadata: Record<string, unknown>): string[] {
  const tags = metadata.tags;
  if (Array.isArray(tags)) return normalizeGalleryTags(tags);
  if (typeof tags === 'string') return normalizeGalleryTags(tags.split(','));
  return [];
}

function normalizeConversationLink(value: unknown): AdminGeneratedImageConversationLink | undefined {
  if (!isRecord(value)) return undefined;
  const link: AdminGeneratedImageConversationLink = {
    ...(normalizedOptionalString(value.channelId) ? { channelId: normalizedOptionalString(value.channelId) } : {}),
    ...(normalizedOptionalString(value.channelType) ? { channelType: normalizedOptionalString(value.channelType) } : {}),
    ...(normalizedOptionalString(value.turnId) ? { turnId: normalizedOptionalString(value.turnId) } : {}),
    ...(normalizedOptionalString(value.requestId) ? { requestId: normalizedOptionalString(value.requestId) } : {}),
    ...(normalizedOptionalString(value.sourceMessageId) ? { sourceMessageId: normalizedOptionalString(value.sourceMessageId) } : {}),
    ...(normalizedOptionalInteger(value.userSessionEntryId) !== undefined
      ? { userSessionEntryId: normalizedOptionalInteger(value.userSessionEntryId) }
      : {}),
    ...(normalizedOptionalInteger(value.assistantSessionEntryId) !== undefined
      ? { assistantSessionEntryId: normalizedOptionalInteger(value.assistantSessionEntryId) }
      : {}),
  };
  return Object.keys(link).length > 0 ? link : undefined;
}

function normalizeCompanionNoteRefs(value: unknown): AdminGeneratedImageCompanionNoteRef[] {
  if (!Array.isArray(value)) return [];
  const refs: AdminGeneratedImageCompanionNoteRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = normalizedOptionalString(entry.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    refs.push({
      id,
      ...(normalizedOptionalString(entry.label) ? { label: normalizedOptionalString(entry.label) } : {}),
      ...(normalizedOptionalString(entry.url) ? { url: normalizedOptionalString(entry.url) } : {}),
    });
  }
  return refs;
}

function normalizeArtifactRefs(value: unknown): AdminGeneratedImageArtifactRef[] {
  if (!Array.isArray(value)) return [];
  const refs: AdminGeneratedImageArtifactRef[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = entry.kind;
    if (
      kind !== 'generated_image'
      && kind !== 'shared_image'
      && kind !== 'conversation_turn'
      && kind !== 'companion_note'
      && kind !== 'l0_artifact'
    ) {
      continue;
    }
    const refId = normalizedOptionalString(entry.refId);
    const url = normalizedOptionalString(entry.url);
    const localPath = normalizedOptionalString(entry.localPath, 2_000);
    const label = normalizedOptionalString(entry.label);
    const dedupeKey = `${kind}:${refId ?? ''}:${url ?? ''}:${localPath ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    refs.push({
      kind,
      ...(refId ? { refId } : {}),
      ...(label ? { label } : {}),
      ...(url ? { url } : {}),
      ...(localPath ? { localPath } : {}),
    });
  }
  return refs;
}

function normalizeMeaningfulMoment(value: unknown): AdminGeneratedImageMeaningfulMoment | undefined {
  if (!isRecord(value) || value.marked !== true) return undefined;
  const markedAt = normalizedOptionalString(value.markedAt) ?? new Date().toISOString();
  const note = normalizedOptionalString(value.note, MAX_GALLERY_NOTE_CHARS);
  const conversation = normalizeConversationLink(value.conversation);
  return {
    marked: true,
    markedAt,
    ...(note ? { note } : {}),
    ...(conversation ? { conversation } : {}),
  };
}

function mergeGeneratedImageUpdate(
  metadata: Record<string, unknown>,
  input: AdminGeneratedImageUpdateInput,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...metadata,
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
  };

  if (input.favorite !== undefined) {
    if (input.favorite) next.favorite = true;
    else delete next.favorite;
  }
  if (input.tags !== undefined) {
    const tags = normalizeGalleryTags(input.tags);
    if (tags.length > 0) next.tags = tags;
    else delete next.tags;
  }
  if (input.meaningfulMoment !== undefined) {
    if (input.meaningfulMoment.marked) {
      const existing = normalizeMeaningfulMoment(metadata.meaningfulMoment);
      const conversation = normalizeConversationLink(input.conversation)
        ?? existing?.conversation
        ?? normalizeConversationLink(metadata.conversation);
      next.meaningfulMoment = {
        marked: true,
        markedAt: existing?.markedAt ?? new Date().toISOString(),
        ...(normalizedOptionalString(input.meaningfulMoment.note, MAX_GALLERY_NOTE_CHARS)
          ? { note: normalizedOptionalString(input.meaningfulMoment.note, MAX_GALLERY_NOTE_CHARS) }
          : {}),
        ...(conversation ? { conversation } : {}),
      } satisfies AdminGeneratedImageMeaningfulMoment;
    } else {
      delete next.meaningfulMoment;
    }
  }
  if (input.conversation !== undefined) {
    const conversation = normalizeConversationLink(input.conversation);
    if (conversation) next.conversation = conversation;
    else delete next.conversation;
  }
  if (input.companionNoteRefs !== undefined) {
    const refs = normalizeCompanionNoteRefs(input.companionNoteRefs);
    if (refs.length > 0) next.companionNoteRefs = refs;
    else delete next.companionNoteRefs;
  }
  if (input.artifactRefs !== undefined) {
    const refs = normalizeArtifactRefs(input.artifactRefs);
    if (refs.length > 0) next.artifactRefs = refs;
    else delete next.artifactRefs;
  }

  return next;
}

function baseArtifactRefs(input: {
  metadata: Record<string, unknown>;
  filePath: string;
  imageUrl: string;
  relativePath: string;
}): AdminGeneratedImageArtifactRef[] {
  const refs = normalizeArtifactRefs(input.metadata.artifactRefs);
  const originalUrl = stringFromMetadata(input.metadata, 'originalUrl');
  const localPath = input.filePath;
  const generatedRef: AdminGeneratedImageArtifactRef = {
    kind: 'generated_image',
    refId: input.relativePath,
    url: input.imageUrl,
    localPath,
  };
  const sharedRef: AdminGeneratedImageArtifactRef | null = originalUrl
    ? {
        kind: 'shared_image',
        refId: stringFromMetadata(input.metadata, 'requestId') ?? input.relativePath,
        url: originalUrl,
        localPath,
      }
    : null;
  const existingKeys = new Set(refs.map((ref) => `${ref.kind}:${ref.refId ?? ''}:${ref.url ?? ''}:${ref.localPath ?? ''}`));
  const additions = [generatedRef, sharedRef].filter((ref): ref is AdminGeneratedImageArtifactRef => ref !== null)
    .filter((ref) => {
      const key = `${ref.kind}:${ref.refId ?? ''}:${ref.url ?? ''}:${ref.localPath ?? ''}`;
      if (existingKeys.has(key)) return false;
      existingKeys.add(key);
      return true;
    });
  return [...refs, ...additions];
}

function matchesGeneratedImageQuery(
  image: AdminGeneratedImageView,
  query: AdminGeneratedImageListQuery | undefined,
): boolean {
  const requiredTags = normalizeGalleryTags(query?.tags);
  if (requiredTags.length > 0 && !requiredTags.every((tag) => image.tags.includes(tag))) return false;
  if (query?.favorite !== undefined && image.favorite !== query.favorite) return false;
  if (query?.meaningful !== undefined && Boolean(image.meaningfulMoment) !== query.meaningful) return false;
  const search = query?.search?.trim().toLowerCase();
  if (!search) return true;
  const haystack = [
    image.fileName,
    image.relativePath,
    image.prompt,
    image.provider,
    image.mode,
    image.model,
    image.sourceToolName,
    image.requestId,
    image.meaningfulMoment?.note,
    image.conversation?.turnId,
    image.conversation?.channelId,
    ...image.tags,
    ...image.companionNoteRefs.flatMap(ref => [ref.id, ref.label, ref.url]),
  ].filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .join('\n')
    .toLowerCase();
  return haystack.includes(search);
}

async function walkImageFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkImageFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(GENERATED_IMAGE_META_SUFFIX)) continue;
    if (!IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    files.push(path);
  }
  return files;
}

export class AdminImagesDataService implements AdminImagesService {
  private readonly referenceStore: ImageReferenceStore;

  constructor(private readonly deps: {
    config: SubstrateConfig;
    companionDataDir: string;
  }) {
    this.referenceStore = new ImageReferenceStore(deps.companionDataDir);
  }

  async listGeneratedImages(query?: AdminGeneratedImageListQuery): Promise<AdminGeneratedImageListData> {
    const roots = this.resolveGeneratedImageRoots();
    const images = (await Promise.all(
      roots.map((root) => this.listGeneratedImagesForRoot(root)),
    ))
      .flat()
      .filter((image) => matchesGeneratedImageQuery(image, query))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      roots: roots.map((root): AdminGeneratedImageRootView => ({
        kind: root.kind,
        path: root.path,
      })),
      images,
    };
  }

  async getGeneratedImageBlob(id: string): Promise<AdminImageBlob | null> {
    const resolvedImage = this.resolveGeneratedImagePath(id);
    if (!resolvedImage) return null;
    const { imagePath } = resolvedImage;
    try {
      const fileStat = await stat(imagePath);
      if (!fileStat.isFile() || !IMAGE_EXTENSIONS.has(extname(imagePath).toLowerCase())) return null;
      return {
        fileName: basename(imagePath),
        contentType: contentTypeForPath(imagePath),
        data: await readFile(imagePath),
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async updateGeneratedImage(id: string, input: AdminGeneratedImageUpdateInput): Promise<AdminGeneratedImageView> {
    const resolvedImage = this.resolveGeneratedImagePath(id);
    if (!resolvedImage) {
      throw new Error('Generated image not found');
    }
    const fileStat = await stat(resolvedImage.imagePath);
    if (!fileStat.isFile() || !IMAGE_EXTENSIONS.has(extname(resolvedImage.imagePath).toLowerCase())) {
      throw new Error('Generated image not found');
    }
    const existingMetadata = await readMetadata(resolvedImage.imagePath);
    const nextMetadata = mergeGeneratedImageUpdate(existingMetadata, input);
    writeMetadata(resolvedImage.imagePath, nextMetadata);
    return this.buildGeneratedImageView(resolvedImage.root, resolvedImage.imagePath, fileStat, nextMetadata);
  }

  async listReferencePhotos(): Promise<ImageReferenceListData> {
    return await this.referenceStore.list();
  }

  async addReferencePhoto(input: ImageReferenceUploadInput): Promise<ImageReferencePhoto> {
    return await this.referenceStore.add(input);
  }

  async updateReferencePhoto(id: string, input: ImageReferenceUpdateInput): Promise<ImageReferencePhoto> {
    return await this.referenceStore.update(id, input);
  }

  async deleteReferencePhoto(id: string): Promise<void> {
    await this.referenceStore.delete(id);
  }

  async setDefaultReferencePhoto(id: string): Promise<ImageReferencePhoto> {
    return await this.referenceStore.setDefault(id);
  }

  async getReferencePhotoBlob(id: string) {
    return await this.referenceStore.getBlob(id);
  }

  private resolveGeneratedImageRoots(): GeneratedImageRoot[] {
    const roots: GeneratedImageRoot[] = [];
    const seen = new Set<string>();
    const addRoot = (kind: GeneratedImageRoot['kind'], path: string | undefined): void => {
      const trimmed = path?.trim();
      if (!trimmed) return;
      const resolvedPath = resolve(trimmed);
      if (seen.has(resolvedPath)) return;
      seen.add(resolvedPath);
      roots.push({ kind, path: resolvedPath });
    };

    const workspacePath = typeof this.deps.config.workspacePath === 'string'
      ? this.deps.config.workspacePath
      : undefined;
    addRoot('personal', workspacePath ? resolvePersonalImagesDir(workspacePath) : undefined);
    addRoot('companion', resolveGeneratedImagesDir(this.deps.companionDataDir));
    return roots;
  }

  private resolveGeneratedImagePath(id: string): ResolvedGeneratedImagePath | null {
    const decoded = decodeGeneratedImageId(id);
    if (!decoded) return null;
    const root = this.resolveGeneratedImageRoots()
      .find((candidate) => candidate.kind === decoded.rootKind);
    if (!root) return null;
    const imagePath = resolve(root.path, decoded.relativePath);
    if (!isInsideRoot(root.path, imagePath)) return null;
    return {
      root,
      imagePath,
      relativePath: decoded.relativePath,
    };
  }

  private async listGeneratedImagesForRoot(root: GeneratedImageRoot): Promise<AdminGeneratedImageView[]> {
    const files = await walkImageFiles(root.path);
    return await Promise.all(files.map(async (filePath): Promise<AdminGeneratedImageView> => {
      const fileStat = await stat(filePath);
      const metadata = await readMetadata(filePath);
      return this.buildGeneratedImageView(root, filePath, fileStat, metadata);
    }));
  }

  private buildGeneratedImageView(
    root: GeneratedImageRoot,
    filePath: string,
    fileStat: Stats,
    metadata: Record<string, unknown>,
  ): AdminGeneratedImageView {
    const relativePath = relative(root.path, filePath);
    const id = encodeGeneratedImageId({ rootKind: root.kind, relativePath });
    const url = `/api/admin/images/generated/${encodeURIComponent(id)}/blob`;
    const createdAt = stringFromMetadata(metadata, 'createdAt') ?? fileStat.mtime.toISOString();
    const updatedAt = stringFromMetadata(metadata, 'updatedAt') ?? fileStat.mtime.toISOString();
    const conversation = normalizeConversationLink(metadata.conversation)
      ?? normalizeConversationLink({
        channelId: metadata.channelId,
        channelType: metadata.channelType,
        turnId: metadata.turnId,
        requestId: metadata.requestId,
        sourceMessageId: metadata.sourceMessageId,
        userSessionEntryId: metadata.userSessionEntryId,
        assistantSessionEntryId: metadata.assistantSessionEntryId,
      });
    const meaningfulMoment = normalizeMeaningfulMoment(metadata.meaningfulMoment);
    return {
      id,
      url,
      rootKind: root.kind,
      relativePath,
      fileName: basename(filePath),
      contentType: stringFromMetadata(metadata, 'contentType') ?? contentTypeForPath(filePath),
      sizeBytes: fileStat.size,
      createdAt,
      updatedAt,
      favorite: metadata.favorite === true,
      tags: galleryTagsFromMetadata(metadata),
      companionNoteRefs: normalizeCompanionNoteRefs(metadata.companionNoteRefs),
      artifactRefs: baseArtifactRefs({ metadata, filePath, imageUrl: url, relativePath }),
      ...(stringFromMetadata(metadata, 'prompt') ? { prompt: stringFromMetadata(metadata, 'prompt') } : {}),
      ...(stringFromMetadata(metadata, 'provider') ? { provider: stringFromMetadata(metadata, 'provider') } : {}),
      ...(stringFromMetadata(metadata, 'mode') ? { mode: stringFromMetadata(metadata, 'mode') } : {}),
      ...(stringFromMetadata(metadata, 'model') ? { model: stringFromMetadata(metadata, 'model') } : {}),
      ...(stringFromMetadata(metadata, 'sourceToolName') ? { sourceToolName: stringFromMetadata(metadata, 'sourceToolName') } : {}),
      ...(stringFromMetadata(metadata, 'requestId') ? { requestId: stringFromMetadata(metadata, 'requestId') } : {}),
      ...(stringArrayFromMetadata(metadata, 'referenceImageIds') ? { referenceImageIds: stringArrayFromMetadata(metadata, 'referenceImageIds') } : {}),
      ...(meaningfulMoment ? { meaningfulMoment } : {}),
      ...(conversation ? { conversation } : {}),
    };
  }
}
