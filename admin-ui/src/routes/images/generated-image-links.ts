import {
  GardenPathValidationError,
  scopeGardenDataPath,
} from '$lib/fleet/companion-scope';
import type { GeneratedImageView } from '$lib/api/endpoints/images';

type GeneratedImageLinkInput = Pick<GeneratedImageView, 'artifactRefs' | 'url'>;

export interface GeneratedImageLinks {
  blobHref: string | null;
  sourceHref: string | null;
}

function resolveGardenOwnedHref(
  path: string,
  pathname?: string,
): string | null {
  if (!path.startsWith('/')) return null;
  try {
    return scopeGardenDataPath(path, pathname);
  } catch (error) {
    if (error instanceof GardenPathValidationError) return null;
    throw error;
  }
}

function resolveExternalProvenanceHref(url: string): string | null {
  if (url.trim() !== url || url.includes('\\') || /\p{Cc}/u.test(url)) return null;
  if (!/^https?:\/\//iu.test(url)) return null;
  try {
    const parsed = new URL(url);
    // ubs:ignore — URL protocol is public routing metadata, not a secret or auth token.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve a data-bearing image URL. Generated image bytes are always fetched
 * from a same-origin Garden route, never from provider provenance.
 */
export function resolveGeneratedImageDataHref(
  path: string,
  pathname?: string,
): string | null {
  return resolveGardenOwnedHref(path, pathname);
}

/**
 * Resolve a navigable provenance link without treating it as Garden data.
 * Canonical root-absolute paths retain companion scoping; explicit HTTP(S)
 * URLs stay external. Unsupported or malformed values are isolated as null.
 */
export function resolveGeneratedImageReferenceHref(
  url: string,
  pathname?: string,
): string | null {
  if (url.startsWith('/')) return resolveGardenOwnedHref(url, pathname);
  return resolveExternalProvenanceHref(url);
}

export function resolveGeneratedImageLinks(
  image: GeneratedImageLinkInput,
  pathname?: string,
): GeneratedImageLinks {
  let sourceHref: string | null = null;
  for (const reference of image.artifactRefs) {
    if (reference.kind !== 'shared_image' || !reference.url) continue;
    const candidate = resolveGeneratedImageReferenceHref(reference.url, pathname);
    if (!candidate) continue;
    sourceHref = candidate;
    break;
  }

  return {
    blobHref: resolveGeneratedImageDataHref(image.url, pathname),
    sourceHref,
  };
}
