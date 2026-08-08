import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { isStrictSubpath, resolveIdentityAssetsDir } from '../../persistence/layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';

function isFileNotFoundError(error: unknown): boolean {
  return (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
  );
}

const REFERENCE_IMAGE_DIR_NAME = 'image-references';
const REFERENCE_IMAGE_INDEX_FILE = 'image-references.json';
const REFERENCE_SCHEMA_VERSION = 1;
const MAX_DESCRIPTION_CHARS = 240;

export type ImageReferenceSourceKind = 'upload' | 'promoted_generation';

/**
 * Where a reference slot's pixels came from. Uploads carry no linkage; a
 * promoted generation records the gallery artifact it was lifted from so a
 * derived render can be traced back to the identity image that anchored it.
 */
export interface ImageReferenceSource {
  kind: ImageReferenceSourceKind;
  /** Opaque gallery id (base64url) of the promoted generated image. */
  generatedImageId?: string;
  requestId?: string;
  originalUrl?: string;
  localPath?: string;
}

/**
 * Additive lineage record for a reference slot. Legacy stores without this
 * field load as a plain `upload` source with no derived generations.
 */
export interface ImageReferenceLineage {
  source: ImageReferenceSource;
  promotionReason?: string;
  /** Reference that was the active default when this slot was promoted in. */
  previousReferenceId?: string;
  /** Generations that were rendered against this reference slot. */
  derivedGenerationIds: string[];
}

export type ImageReferenceActor = 'operator' | 'companion' | 'system';

/** One audited change of the active default reference; feeds rollback. */
export interface ImageReferenceDefaultChange {
  referenceId: string;
  previousReferenceId?: string;
  reason?: string;
  actor: ImageReferenceActor;
  changedAt: string;
}

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
  lineage: ImageReferenceLineage;
}

interface StoredImageReferencePhoto extends Omit<ImageReferencePhoto, 'isDefault'> {}

interface ImageReferenceIndex {
  schemaVersion: 1;
  defaultReferenceId?: string;
  defaultHistory: ImageReferenceDefaultChange[];
  references: StoredImageReferencePhoto[];
}

export interface ImageReferenceListData {
  defaultReferenceId?: string;
  defaultHistory: ImageReferenceDefaultChange[];
  references: ImageReferencePhoto[];
}

export interface ImageReferencePromotionInput {
  filename: string;
  contentType: string;
  data: Buffer;
  description?: string;
  tags?: string[];
  source: ImageReferenceSource;
  promotionReason: string;
  setDefault?: boolean;
  actor?: ImageReferenceActor;
}

export interface ImageReferenceSetDefaultOptions {
  reason?: string;
  actor?: ImageReferenceActor;
}

export interface ImageReferenceLineageChainEntry {
  id: string;
  description: string;
  tags: string[];
  createdAt: string;
  lineage: ImageReferenceLineage;
}

export interface ImageReferenceLineageView {
  reference: ImageReferencePhoto;
  /** Ancestor references, nearest first, walked via previousReferenceId. */
  chain: ImageReferenceLineageChainEntry[];
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

function trimmedStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseReferenceSource(value: unknown): ImageReferenceSource {
  if (!isRecord(value)) return { kind: 'upload' };
  const kind: ImageReferenceSourceKind = value.kind === 'promoted_generation'
    ? 'promoted_generation'
    : 'upload';
  return {
    kind,
    ...(trimmedStringOrUndefined(value.generatedImageId) ? { generatedImageId: trimmedStringOrUndefined(value.generatedImageId) } : {}),
    ...(trimmedStringOrUndefined(value.requestId) ? { requestId: trimmedStringOrUndefined(value.requestId) } : {}),
    ...(trimmedStringOrUndefined(value.originalUrl) ? { originalUrl: trimmedStringOrUndefined(value.originalUrl) } : {}),
    ...(trimmedStringOrUndefined(value.localPath) ? { localPath: trimmedStringOrUndefined(value.localPath) } : {}),
  };
}

function parseDerivedGenerationIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const id = trimmedStringOrUndefined(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function parseLineage(value: unknown): ImageReferenceLineage {
  if (!isRecord(value)) {
    return { source: { kind: 'upload' }, derivedGenerationIds: [] };
  }
  const promotionReason = trimmedStringOrUndefined(value.promotionReason);
  const previousReferenceId = trimmedStringOrUndefined(value.previousReferenceId);
  return {
    source: parseReferenceSource(value.source),
    ...(promotionReason ? { promotionReason: normalizeDescription(promotionReason) } : {}),
    ...(previousReferenceId ? { previousReferenceId } : {}),
    derivedGenerationIds: parseDerivedGenerationIds(value.derivedGenerationIds),
  };
}

function parseDefaultHistory(value: unknown): ImageReferenceDefaultChange[] {
  if (!Array.isArray(value)) return [];
  const result: ImageReferenceDefaultChange[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const referenceId = trimmedStringOrUndefined(entry.referenceId);
    if (!referenceId) continue;
    const reason = trimmedStringOrUndefined(entry.reason);
    const previousReferenceId = trimmedStringOrUndefined(entry.previousReferenceId);
    const actor: ImageReferenceActor = entry.actor === 'companion' || entry.actor === 'system'
      ? entry.actor
      : 'operator';
    result.push({
      referenceId,
      ...(previousReferenceId ? { previousReferenceId } : {}),
      ...(reason ? { reason: normalizeDescription(reason) } : {}),
      actor,
      changedAt: trimmedStringOrUndefined(entry.changedAt) ?? new Date(0).toISOString(),
    });
  }
  return result;
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
    lineage: parseLineage(value.lineage),
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
      defaultHistory: index.defaultHistory,
      references,
    };
  }

  async add(input: ImageReferenceUploadInput): Promise<ImageReferencePhoto> {
    const { id, fileName, contentType } = await this.persistReferenceBlob(
      input.filename,
      input.contentType,
      input.data,
    );
    const now = new Date().toISOString();

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
      lineage: { source: { kind: 'upload' }, derivedGenerationIds: [] },
    };
    const shouldSetDefault = input.setDefault === true || !index.defaultReferenceId;
    const transition = this.buildDefaultTransition(
      index,
      shouldSetDefault ? id : index.defaultReferenceId,
      { actor: 'operator' },
    );
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
      references: [...index.references, stored],
    };
    this.writeIndex(nextIndex);
    return toPublicReference(stored, nextIndex.defaultReferenceId);
  }

  /**
   * Promote an especially identity-aligned generated image into a reference
   * slot, recording where it came from and which reference it supersedes.
   * Promotion becomes the active default unless `setDefault` is explicitly
   * false, and the switch is written to the audited default history.
   */
  async promoteGeneration(input: ImageReferencePromotionInput): Promise<ImageReferencePhoto> {
    if (input.source.kind !== 'promoted_generation') {
      throw new Error('promoteGeneration requires a promoted_generation source');
    }
    const promotionReason = normalizeDescription(input.promotionReason);
    if (!promotionReason) {
      throw new Error('Promotion reason is required');
    }
    const { id, fileName, contentType } = await this.persistReferenceBlob(
      input.filename,
      input.contentType,
      input.data,
    );
    const now = new Date().toISOString();
    const index = await this.readIndex();
    const previousReferenceId = index.defaultReferenceId;
    const lineage: ImageReferenceLineage = {
      source: input.source,
      promotionReason,
      ...(previousReferenceId ? { previousReferenceId } : {}),
      derivedGenerationIds: [],
    };
    const stored: StoredImageReferencePhoto = {
      id,
      fileName,
      contentType,
      description: normalizeDescription(input.description),
      tags: normalizeImageReferenceTags(input.tags),
      sizeBytes: input.data.length,
      createdAt: now,
      updatedAt: now,
      lineage,
    };
    const shouldSetDefault = input.setDefault !== false;
    const transition = this.buildDefaultTransition(
      index,
      shouldSetDefault ? id : index.defaultReferenceId,
      { reason: promotionReason, actor: input.actor ?? 'operator' },
    );
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
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
    const transition = input.setDefault === true
      ? this.buildDefaultTransition(index, cleanId, { actor: 'operator' })
      : {
          ...(index.defaultReferenceId ? { defaultReferenceId: index.defaultReferenceId } : {}),
          defaultHistory: index.defaultHistory,
        };
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
      references: index.references.map((candidate) => (
        candidate.id === cleanId ? updated : candidate
      )),
    };
    this.writeIndex(nextIndex);
    return toPublicReference(updated, nextIndex.defaultReferenceId);
  }

  async setDefault(id: string, options?: ImageReferenceSetDefaultOptions): Promise<ImageReferencePhoto> {
    const cleanId = id.trim();
    if (!cleanId) throw new Error('Reference id is required');
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) {
      throw new Error('Reference photo not found');
    }
    const transition = this.buildDefaultTransition(index, cleanId, options);
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
      references: index.references,
    };
    this.writeIndex(nextIndex);
    return toPublicReference(reference, nextIndex.defaultReferenceId);
  }

  /**
   * Restore the reference that was active before the current default was set,
   * using the audited default history. Fails closed when nothing is recorded
   * to roll back to or the previous slot no longer exists.
   */
  async rollbackDefault(options?: ImageReferenceSetDefaultOptions): Promise<ImageReferencePhoto> {
    const index = await this.readIndex();
    const currentDefaultId = index.defaultReferenceId;
    if (!currentDefaultId) {
      throw new Error('No active default reference to roll back');
    }
    let target: string | undefined;
    for (let i = index.defaultHistory.length - 1; i >= 0; i -= 1) {
      const entry = index.defaultHistory[i]!;
      if (entry.referenceId === currentDefaultId && entry.previousReferenceId) {
        target = entry.previousReferenceId;
        break;
      }
    }
    if (!target) {
      throw new Error('No previous reference recorded to roll back to');
    }
    const reference = index.references.find((candidate) => candidate.id === target);
    if (!reference) {
      throw new Error('Previous reference is no longer available to roll back to');
    }
    const transition = this.buildDefaultTransition(index, target, {
      reason: options?.reason ?? 'rollback to previous reference',
      actor: options?.actor ?? 'operator',
    });
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
      references: index.references,
    };
    this.writeIndex(nextIndex);
    return toPublicReference(reference, nextIndex.defaultReferenceId);
  }

  /**
   * Resolve the ancestor chain of a reference slot so a promoted lineage can be
   * walked back to the upload (or promoted generation) that seeded it.
   */
  async getLineage(id: string): Promise<ImageReferenceLineageView> {
    const cleanId = id.trim();
    if (!cleanId) throw new Error('Reference id is required');
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) {
      throw new Error('Reference photo not found');
    }
    const chain: ImageReferenceLineageChainEntry[] = [];
    const seen = new Set<string>([cleanId]);
    let cursor = reference.lineage.previousReferenceId;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const ancestor = index.references.find((candidate) => candidate.id === cursor);
      if (!ancestor) break;
      chain.push({
        id: ancestor.id,
        description: ancestor.description,
        tags: [...ancestor.tags],
        createdAt: ancestor.createdAt,
        lineage: ancestor.lineage,
      });
      cursor = ancestor.lineage.previousReferenceId;
    }
    return {
      reference: toPublicReference(reference, index.defaultReferenceId),
      chain,
    };
  }

  /** Link a generation to the reference slot it was rendered against. */
  async recordDerivedGeneration(referenceId: string, generationId: string): Promise<void> {
    const cleanRefId = referenceId.trim();
    const cleanGenId = generationId.trim();
    if (!cleanRefId || !cleanGenId) {
      throw new Error('Reference id and generation id are required');
    }
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanRefId);
    if (!reference) {
      throw new Error('Reference photo not found');
    }
    if (reference.lineage.derivedGenerationIds.includes(cleanGenId)) {
      return;
    }
    const updated: StoredImageReferencePhoto = {
      ...reference,
      lineage: {
        ...reference.lineage,
        derivedGenerationIds: [...reference.lineage.derivedGenerationIds, cleanGenId],
      },
      updatedAt: new Date().toISOString(),
    };
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...(index.defaultReferenceId ? { defaultReferenceId: index.defaultReferenceId } : {}),
      defaultHistory: index.defaultHistory,
      references: index.references.map((candidate) => (
        candidate.id === cleanRefId ? updated : candidate
      )),
    };
    this.writeIndex(nextIndex);
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
    const removingDefault = index.defaultReferenceId === cleanId;
    const nextDefaultReferenceId = removingDefault ? remaining[0]?.id : index.defaultReferenceId;
    const transition = removingDefault && nextDefaultReferenceId
      ? this.buildDefaultTransition(index, nextDefaultReferenceId, {
          reason: 'previous default reference deleted',
          actor: 'system',
        })
      : {
          ...(nextDefaultReferenceId ? { defaultReferenceId: nextDefaultReferenceId } : {}),
          defaultHistory: index.defaultHistory,
        };
    const nextIndex: ImageReferenceIndex = {
      schemaVersion: REFERENCE_SCHEMA_VERSION,
      ...transition,
      references: remaining,
    };
    // Remove the blob before committing the index. The index is the only lookup
    // and deletion surface, so if we dropped the reference first and then failed
    // to unlink the blob, the blob would become an unreachable, unretryable
    // orphan. Unlinking first means an rm failure rejects with the reference
    // still recorded — discoverable and safe to retry — while a successful rm is
    // followed by the authoritative index commit. rm uses force so a retry after
    // a partial success (blob gone, index not yet committed) is a no-op unlink.
    await rm(this.resolveReferencePath(reference.fileName), { force: true });
    this.writeIndex(nextIndex);
  }

  private buildDefaultTransition(
    index: ImageReferenceIndex,
    nextDefaultId: string | undefined,
    options?: ImageReferenceSetDefaultOptions,
  ): { defaultReferenceId?: string; defaultHistory: ImageReferenceDefaultChange[] } {
    const previous = index.defaultReferenceId;
    const defaultHistory = [...index.defaultHistory];
    if (nextDefaultId && nextDefaultId !== previous) {
      const reason = options?.reason ? normalizeDescription(options.reason) : '';
      defaultHistory.push({
        referenceId: nextDefaultId,
        ...(previous ? { previousReferenceId: previous } : {}),
        ...(reason ? { reason } : {}),
        actor: options?.actor ?? 'operator',
        changedAt: new Date().toISOString(),
      });
    }
    return {
      ...(nextDefaultId ? { defaultReferenceId: nextDefaultId } : {}),
      defaultHistory,
    };
  }

  private async persistReferenceBlob(
    filename: string,
    contentType: string,
    data: Buffer,
  ): Promise<{ id: string; fileName: string; contentType: string }> {
    if (data.length === 0) {
      throw new Error('Reference photo upload was empty');
    }
    const normalizedContentType = normalizeContentType(filename, contentType);
    const extension = inferSafeImageExtension(filename, normalizedContentType);
    const id = randomUUID();
    const fileName = `${id}${extension}`;
    await mkdir(this.referencesDir, { recursive: true });
    await writeFile(join(this.referencesDir, fileName), data);
    return { id, fileName, contentType: normalizedContentType };
  }

  async getBlob(id: string): Promise<ImageReferenceBlob | null> {
    const cleanId = id.trim();
    if (!cleanId) return null;
    const index = await this.readIndex();
    const reference = index.references.find((candidate) => candidate.id === cleanId);
    if (!reference) return null;
    let data: Buffer;
    try {
      data = await readFile(this.resolveReferencePath(reference.fileName));
    } catch (error) {
      // The index entry exists but the blob file is gone. This is reachable
      // through the deliberate rm-before-writeIndex ordering in delete()
      // (psfn-framework-xyd7): a crash between the unlink and the index commit
      // leaves the index advertising a reference whose blob no longer exists.
      // Return null so getBlob's not-found contract stays uniform with the
      // empty-id and missing-entry cases above, instead of leaking a raw ENOENT
      // (which also embeds the on-disk companion-data path) to callers. Every
      // other error class still propagates.
      if (isFileNotFoundError(error)) return null;
      throw error;
    }
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
      if (!isRecord(raw)) return { schemaVersion: REFERENCE_SCHEMA_VERSION, defaultHistory: [], references: [] };
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
        defaultHistory: parseDefaultHistory(raw.defaultHistory),
        references,
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return { schemaVersion: REFERENCE_SCHEMA_VERSION, defaultHistory: [], references: [] };
      }
      throw error;
    }
  }

  private writeIndex(index: ImageReferenceIndex): void {
    writeJsonAtomic(this.indexPath, index);
  }

  private resolveReferencePath(fileName: string): string {
    const candidate = resolve(this.referencesDir, fileName);
    if (isStrictSubpath(candidate, this.referencesDir)) {
      return candidate;
    }
    throw new Error('Invalid reference photo path');
  }
}
