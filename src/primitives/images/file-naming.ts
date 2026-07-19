import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import type { ImageResultAsset } from './types.js';

export function inferImageExtension(
  url: string,
  contentType: string | undefined,
): string {
  const normalizedType = (contentType ?? '').trim().toLowerCase();
  if (normalizedType.startsWith('image/png')) return '.png';
  if (normalizedType.startsWith('image/jpeg')) return '.jpg';
  if (normalizedType.startsWith('image/webp')) return '.webp';
  if (normalizedType.startsWith('image/gif')) return '.gif';
  if (normalizedType.startsWith('image/bmp')) return '.bmp';
  if (normalizedType.startsWith('image/tiff')) return '.tiff';

  try {
    const candidate = extname(new URL(url).pathname).trim().toLowerCase();
    if (candidate) {
      return candidate;
    }
  } catch {
    // Fall through to default extension.
  }

  return '.png';
}

export function sanitizeImageFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'image';
}

export function deriveImageFileStem(
  asset: ImageResultAsset,
  requestId: string | undefined,
  index: number,
): string {
  const fromAsset = asset.fileName?.trim();
  if (fromAsset) {
    const name = basename(fromAsset, extname(fromAsset));
    return sanitizeImageFileStem(name);
  }
  if (requestId) {
    return sanitizeImageFileStem(`${requestId}-${index + 1}`);
  }
  return `image-${index + 1}`;
}

export function buildImageFileName(
  asset: ImageResultAsset,
  requestId: string | undefined,
  index: number,
  uniqueId = randomUUID(),
): string {
  const extension = inferImageExtension(asset.url, asset.contentType);
  const fileStem = deriveImageFileStem(asset, requestId, index);
  return `${fileStem}-${uniqueId.slice(0, 8)}${extension}`;
}
