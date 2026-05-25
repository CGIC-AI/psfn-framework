import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { resolveIdentityAssetsDir } from '../../persistence/layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

const REFERENCE_IMAGE_DIR_NAME = 'image-references';
const REFERENCE_IMAGE_INDEX_FILE = 'image-references.json';
const REFERENCE_SCHEMA_VERSION = 1;
const MAX_DESCRIPTION_CHARS = 240;

export interface ImageReferencePhoto {
  id: string;
  fileName: string;
  contentType: string;
  description: string;
  tags: string[];
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}

interface StoredImageReferencePhoto extends Omit<ImageReferencePhoto, 'isDefault'> {}

interface ImageReferenceIndex {
  schemaVersion: 1;
  defaultReferenceId?: string;
  references: StoredImageReferencePhoto[];
}

export interface ImageReferenceListData {
  defaultReferenceId?: string;
  references: ImageReferencePhoto[];
}

export interface ImageReferenceUploadInput {
  filename: string;
  contentType: string;
  data: Buffer;
  description?: string;
  tags?: string[];
  setDefault?: boolean;
}

export interface ImageReferenceUpdateInput {
  description?: string;
  tags?: string[];
  setDefault?: boolean;
}

export interface ImageReferenceBlob {
  id: string;
  fileName: string;
  contentType: string;
  data: Buffer;
}

export interface ImageReferenceSelector {
  referenceImageId?: string;
  referenceImageTags?: string[];
  useDefaultReference?: boolean;
}

export interface ResolvedImageReference {
  id: string;
  dataUrl: string;
  description: string;
  tags: string[];
}

function normalizeDescription(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > MAX_DESCRIPTION_CHARS
    ? trimmed.slice(0, MAX_DESCRIPTION_CHARS)
    : trimmed;
}

export function normalizeImageReferenceTags(tags: readonly string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawTag of tags ?? []) {
    const tag = rawTag.trim().toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
  }
  return normalized;
}

function tagsFromUnknown(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeImageReferenceTags(value.filter((entry): entry is string => typeof entry === 'string'));
  }
  if (typeof value === 'string') {
    return normalizeImageReferenceTags(value.split(','));
  }
  return [];
}

function contentTypeForExtension(extension: string): string | null {
  switch (extension.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return null;
  }
}

function inferSafeImageExtension(filename: string, contentType: string): string {
  const normalizedType = contentType.trim().toLowerCase().split(';')[0] ?? '';
  if (normalizedType === 'image/png') return '.png';
  if (normalizedType === 'image/jpeg' || normalizedType === 'image/jpg') return '.jpg';
  if (normalizedType === 'image/webp') return '.webp';
  if (normalizedType === 'image/gif') return '.gif';

  const extension = extname(filename).toLowerCase();
  const typeFromExtension = contentTypeForExtension(extension);
  if (typeFromExtension) return extension === '.jpeg' ? '.jpg' : extension;
  throw new Error('Reference photo must be PNG, JPEG, WebP, or GIF');
}

function normalizeContentType(filename: string, contentType: string): string {
  const normalizedType = contentType.trim().toLowerCase().split(';')[0] ?? '';
  if (normalizedType.startsWith('image/')) {
    const extension = inferSafeImageExtension(filename, normalizedType);
    return contentTypeForExtension(extension) ?? normalizedType;
  }

  const typeFromExtension = contentTypeForExtension(extname(filename));
  if (!typeFromExtension) {
    throw new Error('Reference photo must be PNG, JPEG, WebP, or GIF');
  }
  return typeFromExtension;
}

function parseStoredReference(value: unknown): StoredImageReferencePhoto | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  const fileName = typeof value.fileName === 'string' ? basename(value.fileName.trim()) : '';
  const contentType = typeof value.contentType === 'string' ? value.contentType.trim().toLowerCase() : '';
  const description = normalizeDescription(typeof value.description === 'string' ? value.description : '');
  const sizeBytes = typeof value.sizeBytes === 'number' && Number.isFinite(value.sizeBytes) && value.sizeBytes >= 0
    ? value.sizeBytes
    : 0;
  const createdAt = typeof value.createdAt === 'string' && value.createdAt.trim()
    ? value.createdAt
    : new Date(0).toISOString();
  const updatedAt = typeof value.updatedAt === 'string' && value.updatedAt.trim()
    ? value.updatedAt
    : createdAt;
  if (!id || !fileName || !contentType.startsWith('image/')) return null;
  return {
    id,
    fileName,
    contentType,
    description,
    tags: tagsFromUnknown(value.tags),
    sizeBytes,
    createdAt,
    updatedAt,
  };
}

function toPublicReference(
  reference: StoredImageReferencePhoto,
  defaultReferenceId: string | undefined,
): ImageReferencePhoto {
  return {
    ...reference,
    isDefault: reference.id === defaultReferenceId,
  };
}

function toDataUrl(contentType: string, data: Buffer): string {
  return `data:${contentType};base64,${data.toString('base64')}`;
}

export class ImageReferenceStore {
  private readonly rootDir: string;
  private readonly referencesDir: string;
  private readonly indexPath: string;

  constructor(companionDataDir: string) {
    this.rootDir = resolveIdentityAssetsDir(companionDataDir);
    this.referencesDir = join(this.rootDir, REFERENCE_IMAGE_DIR_NAME);
    this.indexPath = join(this.rootDir, REFERENCE_IMAGE_INDEX_FILE);
  }

  async list(): Promise<ImageReferenceListData> {
    const index = await this.readIndex();
    const references = index.references
      .map((reference) => toPublicReference(reference, index.defaultReferenceId))
      .sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return b.createdAt.localeCompare(a.createdAt);
      });
    return {
      ...(index.defaultReferenceId ? { defaultReferenceId: index.defaultReferenceId } : {}),
      references,
    };
  }

  async add(input: ImageReferenceUploadInput): Promise<ImageReferencePhoto> {
    if (input.data.length === 0) {
      throw new Error('Reference photo upload was empty');
    }
    const contentType = normalizeContentType(input.filename, input.contentType);
    const extension = inferSafeImageExtension(input.filename, contentType);
    const id = randomUUID();
    const fileName = `${id}${extension}`;
    const now = new Date().toISOString();

    await mkdir(this.referencesDir, { recursive: true });
    await writeFile(join(this.referencesDir, fileName), input.data);

    const index = await this.readIndex();
    const stored: StoredImageReferencePhoto = {
      id,
      fileName,
      contentType,
      description: normalizeDescription(input.description),
      tags: normalizeImageReferenceTags(input.tags),
      sizeBytes: input.data.length,
      createdAt: now,
      updatedAt: now,
    };
    const shouldSetDefault = input.setDefault === true || !index.defaultReferenceId;
    const nextDefaultReferenceId = shouldSetDefault ? id : index.defaultReferenceId;
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...(nextDefaultReferenceId ? { defaultReferenceId: nextDefaultReferenceId } : {}),
      references: [...index.references, stored],
    };
    this.writeIndex(nextIndex);
    return toPublicReference(stored, nextIndex.defaultReferenceId);
  }

  async update(id: string, input: ImageReferenceUpdateInput): Promise<ImageReferencePhoto> {
    const cleanId = id.trim();
    if (!cleanId) throw new Error('Reference id is required');
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) {
      throw new Error('Reference photo not found');
    }

    const updated: StoredImageReferencePhoto = {
      ...reference,
      ...(input.description !== undefined ? { description: normalizeDescription(input.description) } : {}),
      ...(input.tags !== undefined ? { tags: normalizeImageReferenceTags(input.tags) } : {}),
      updatedAt: new Date().toISOString(),
    };
    const nextDefaultReferenceId = input.setDefault === true
      ? cleanId
      : index.defaultReferenceId;
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...(nextDefaultReferenceId ? { defaultReferenceId: nextDefaultReferenceId } : {}),
      references: index.references.map((candidate) => (
        candidate.id === cleanId ? updated : candidate
      )),
    };
    this.writeIndex(nextIndex);
    return toPublicReference(updated, nextIndex.defaultReferenceId);
  }

  async setDefault(id: string): Promise<ImageReferencePhoto> {
    return await this.update(id, { setDefault: true });
  }

  async delete(id: string): Promise<void> {
    const cleanId = id.trim();
    if (!cleanId) throw new Error('Reference id is required');
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) {
      throw new Error('Reference photo not found');
    }

    const remaining = index.references.filter((candidate) => candidate.id !== cleanId);
    const nextDefaultReferenceId = index.defaultReferenceId === cleanId
      ? remaining[0]?.id
      : index.defaultReferenceId;
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...(nextDefaultReferenceId ? { defaultReferenceId: nextDefaultReferenceId } : {}),
      references: remaining,
    };
    this.writeIndex(nextIndex);
    await rm(this.resolveReferencePath(reference.fileName), { force: true });
  }

  async getBlob(id: string): Promise<ImageReferenceBlob | null> {
    const cleanId = id.trim();
    if (!cleanId) return null;
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) return null;
    const data = await readFile(this.resolveReferencePath(reference.fileName));
    return {
      id: reference.id,
      fileName: reference.fileName,
      contentType: reference.contentType,
      data,
    };
  }

  async resolveForTool(selector: ImageReferenceSelector = {}): Promise<ResolvedImageReference | null> {
    const index = await this.readIndex();
    let reference: StoredImageReferencePhoto | undefined;

    const explicitId = selector.referenceImageId?.trim();
    if (explicitId === 'none') return null;
    if (explicitId) {
      reference = index.references.find((candidate) => candidate.id === explicitId);
      if (!reference) {
        throw new Error(`Reference photo not found: ${explicitId}`);
      }
    }

    if (!reference && selector.referenceImageTags?.length) {
      const tags = normalizeImageReferenceTags(selector.referenceImageTags);
      reference = index.references.find((candidate) => (
        tags.every((tag) => candidate.tags.includes(tag))
      ));
      if (!reference) {
        throw new Error(`No reference photo matches tags: ${tags.join(', ')}`);
      }
    }

    if (!reference && selector.useDefaultReference !== false && index.defaultReferenceId) {
      reference = index.references.find((candidate) => candidate.id === index.defaultReferenceId);
    }

    if (!reference) return null;
    const blob = await this.getBlob(reference.id);
    if (!blob) return null;
    return {
      id: reference.id,
      dataUrl: toDataUrl(reference.contentType, blob.data),
      description: reference.description,
      tags: [...reference.tags],
    };
  }

  private async readIndex(): Promise<ImageReferenceIndex> {
    try {
      const raw = JSON.parse(await readFile(this.indexPath, 'utf-8')) as unknown;
      if (!isRecord(raw)) return { schemaVersion: REFERENCE_SCHEMA_VERSION, references: [] };
      const references = Array.isArray(raw.references)
        ? raw.references.map(parseStoredReference).filter((entry): entry is StoredImageReferencePhoto => entry !== null)
        : [];
      const defaultReferenceId = typeof raw.defaultReferenceId === 'string'
        && references.some((reference) => reference.id === raw.defaultReferenceId)
        ? raw.defaultReferenceId
        : references[0]?.id;
      return {
        schemaVersion: REFERENCE_SCHEMA_VERSION,
        ...(defaultReferenceId ? { defaultReferenceId } : {}),
        references,
      };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { schemaVersion: REFERENCE_SCHEMA_VERSION, references: [] };
      }
      throw error;
    }
  }

  private writeIndex(index: ImageReferenceIndex): void {
    writeJsonAtomic(this.indexPath, index);
  }

  private resolveReferencePath(fileName: string): string {
    const safeName = basename(fileName);
    const candidate = resolve(this.referencesDir, safeName);
    const root = resolve(this.referencesDir);
    if (candidate !== root && candidate.startsWith(`${root}/`)) {
      return candidate;
    }
    throw new Error('Invalid reference photo path');
  }
}
