import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import {
  resolveGeneratedImagesDir,
  resolvePersonalImagesDir,
} from '../../../persistence/layout.js';
import {
  ImageReferenceStore,
  type ImageReferenceListData,
  type ImageReferencePhoto,
  type ImageReferenceUpdateInput,
  type ImageReferenceUploadInput,
} from '../../../primitives/images/reference-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type {
  AdminGeneratedImageListData,
  AdminGeneratedImageRootView,
  AdminGeneratedImageView,
  AdminImageBlob,
  AdminImagesService,
} from './types.js';

const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tiff']);

interface GeneratedImageRoot {
  kind: 'personal' | 'companion';
  path: string;
}

interface GeneratedImageId {
  rootKind: 'personal' | 'companion';
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
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Existing images may not have sidecars.
  }
  return {};
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

  async listGeneratedImages(): Promise<AdminGeneratedImageListData> {
    const roots = this.resolveGeneratedImageRoots();
    const images = (await Promise.all(
      roots.map((root) => this.listGeneratedImagesForRoot(root)),
    )).flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      roots: roots.map((root): AdminGeneratedImageRootView => ({
        kind: root.kind,
        path: root.path,
      })),
      images,
    };
  }

  async getGeneratedImageBlob(id: string): Promise<AdminImageBlob | null> {
    const decoded = decodeGeneratedImageId(id);
    if (!decoded) return null;
    const root = this.resolveGeneratedImageRoots()
      .find((candidate) => candidate.kind === decoded.rootKind);
    if (!root) return null;
    const imagePath = resolve(root.path, decoded.relativePath);
    if (!isInsideRoot(root.path, imagePath)) return null;
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

  private async listGeneratedImagesForRoot(root: GeneratedImageRoot): Promise<AdminGeneratedImageView[]> {
    const files = await walkImageFiles(root.path);
    return await Promise.all(files.map(async (filePath): Promise<AdminGeneratedImageView> => {
      const fileStat = await stat(filePath);
      const metadata = await readMetadata(filePath);
      const relativePath = relative(root.path, filePath);
      const createdAt = stringFromMetadata(metadata, 'createdAt') ?? fileStat.mtime.toISOString();
      return {
        id: encodeGeneratedImageId({ rootKind: root.kind, relativePath }),
        url: `/api/admin/images/generated/${encodeURIComponent(encodeGeneratedImageId({ rootKind: root.kind, relativePath }))}/blob`,
        rootKind: root.kind,
        relativePath,
        fileName: basename(filePath),
        contentType: stringFromMetadata(metadata, 'contentType') ?? contentTypeForPath(filePath),
        sizeBytes: fileStat.size,
        createdAt,
        updatedAt: fileStat.mtime.toISOString(),
        ...(stringFromMetadata(metadata, 'prompt') ? { prompt: stringFromMetadata(metadata, 'prompt') } : {}),
        ...(stringFromMetadata(metadata, 'provider') ? { provider: stringFromMetadata(metadata, 'provider') } : {}),
        ...(stringFromMetadata(metadata, 'mode') ? { mode: stringFromMetadata(metadata, 'mode') } : {}),
        ...(stringFromMetadata(metadata, 'model') ? { model: stringFromMetadata(metadata, 'model') } : {}),
        ...(stringFromMetadata(metadata, 'sourceToolName') ? { sourceToolName: stringFromMetadata(metadata, 'sourceToolName') } : {}),
        ...(stringFromMetadata(metadata, 'requestId') ? { requestId: stringFromMetadata(metadata, 'requestId') } : {}),
        ...(stringArrayFromMetadata(metadata, 'referenceImageIds') ? { referenceImageIds: stringArrayFromMetadata(metadata, 'referenceImageIds') } : {}),
      };
    }));
  }
}
