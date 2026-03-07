import type { LLMProvider } from './contracts.js';
import type { RuntimeMode } from './tool-wiring-validator.js';

const VISION_ATTACHMENT_EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

const VISION_ATTACHMENT_FORMAT_QUERY_KEYS = ['format', 'fm'] as const;

interface GatewayRuntimeInferenceCandidate {
  discordSend?: (channelId: string, content: string) => Promise<void>;
  fsRead?: (path: string) => Promise<string>;
  webFetch?: (
    url: string,
    prompt?: string,
    lane?: 'default' | 'local_crawler',
  ) => Promise<string>;
}

export function formatSignedDecimal(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(3)}`;
}

export function inferRuntimeModeFromProvider(provider: LLMProvider): RuntimeMode {
  const candidate = provider as unknown as GatewayRuntimeInferenceCandidate;
  if (
    typeof candidate.discordSend === 'function'
    || typeof candidate.fsRead === 'function'
    || typeof candidate.webFetch === 'function'
  ) {
    return 'gateway';
  }
  return 'single';
}

export function inferImageMimeTypeFromAttachmentCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let pathCandidate = trimmed;
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const parsed = new URL(trimmed);
      const fromQuery = inferImageMimeTypeFromQueryParams(parsed.searchParams);
      if (fromQuery) return fromQuery;
      pathCandidate = parsed.pathname;
    }
  } catch {
    pathCandidate = trimmed;
  }

  const lowerPath = pathCandidate.toLowerCase();
  for (const [extension, mimeType] of Object.entries(VISION_ATTACHMENT_EXTENSION_TO_MIME)) {
    if (lowerPath.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}

function inferImageMimeTypeFromQueryParams(searchParams: URLSearchParams): string | null {
  for (const key of VISION_ATTACHMENT_FORMAT_QUERY_KEYS) {
    const raw = searchParams.get(key)?.trim().toLowerCase();
    if (!raw) continue;
    const normalized = raw.startsWith('.') ? raw : `.${raw}`;
    const mimeType = VISION_ATTACHMENT_EXTENSION_TO_MIME[normalized];
    if (mimeType) return mimeType;
  }
  return null;
}
