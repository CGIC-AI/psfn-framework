import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ComfyUiImageClient } from './comfyui.js';
import { FalApiError, FalImageClient, isFalContentPolicyError } from './fal.js';
import { resolveInlineOrEnvCredential } from '../../boundary/custody/credential-vault.js';
import { resolveConfiguredCompanionDataDir, resolveGeneratedImagesDir } from '../../persistence/layout.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ImageOperations } from './ops.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageMode,
  ImageResultAsset,
  ImageRuntimeConfig,
} from './types.js';

const log = createComponentLogger('ImageService');
const FAL_TRANSIENT_ATTEMPTS = 2;

function hasWorkflowForMode(
  config: ImageRuntimeConfig,
  mode: ImageMode,
): boolean {
  return Boolean(config.imageWorkflows?.comfyUi?.[mode]?.workflow);
}

function isTransientFalError(error: unknown): boolean {
  if (error instanceof FalApiError) {
    return error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b(fetch failed|network|timeout|timed out|econnreset|econnrefused|etimedout|socket hang up)\b/i.test(message);
}

function inferExtension(url: string, contentType: string | undefined): string {
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

function sanitizeFileStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'image';
}

function deriveFileStem(asset: ImageResultAsset, requestId: string | undefined, index: number): string {
  const fromAsset = asset.fileName?.trim();
  if (fromAsset) {
    const name = basename(fromAsset, extname(fromAsset));
    return sanitizeFileStem(name);
  }
  if (requestId) {
    return sanitizeFileStem(`${requestId}-${index + 1}`);
  }
  return `image-${index + 1}`;
}

function resolveConfiguredCompanionDataDirOrNull(config: ImageRuntimeConfig): string | null {
  const rawConfig = config as Record<string, unknown>;
  const hasExplicitCompanionDir = typeof rawConfig.companionDataDir === 'string' && rawConfig.companionDataDir.trim().length > 0;
  const hasExplicitDataDir = typeof rawConfig.dataDir === 'string' && rawConfig.dataDir.trim().length > 0;
  if (!hasExplicitCompanionDir && !hasExplicitDataDir) {
    return null;
  }
  try {
    return resolveConfiguredCompanionDataDir(config as Parameters<typeof resolveConfiguredCompanionDataDir>[0]);
  } catch {
    return null;
  }
}

export class ImageService implements ImageOperations {
  constructor(
    private readonly config: ImageRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: {
      companionDataDir?: string;
    } = {},
  ) {}

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    return await this.run('create', params);
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    return await this.run('edit', params);
  }

  private async run(
    mode: 'create',
    params: ImageCreateParams,
  ): Promise<ImageGenerationResult>;
  private async run(
    mode: 'edit',
    params: ImageEditParams,
  ): Promise<ImageGenerationResult>;
  private async run(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
  ): Promise<ImageGenerationResult> {
    const falApiKey = resolveInlineOrEnvCredential(
      this.config.falApiKey,
      this.config.credentialVault,
      'FAL_API_KEY',
    );
    const provider = params.provider ?? 'auto';
    if (provider === 'comfyui') {
      return await this.persistGeneratedImages(await this.runComfy(mode, params));
    }

    if (!falApiKey) {
      if (provider === 'fal') {
        throw new Error('FAL_API_KEY is not configured');
      }
      return await this.persistGeneratedImages(await this.runComfy(mode, params));
    }

    try {
      const falClient = new FalImageClient(falApiKey, this.fetchImpl);
      let result: ImageGenerationResult | null = null;
      for (let attempt = 1; attempt <= FAL_TRANSIENT_ATTEMPTS; attempt += 1) {
        try {
          result = mode === 'create'
            ? await falClient.create(params)
            : await falClient.edit(params);
          break;
        } catch (error) {
          if (attempt >= FAL_TRANSIENT_ATTEMPTS || !isTransientFalError(error)) {
            throw error;
          }
          log.warn('Retrying transient FAL image request failure', {
            mode,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (!result) {
        throw new Error('FAL image request did not return a result');
      }
      return await this.persistGeneratedImages(result);
    } catch (error) {
      if (
        provider === 'auto'
        && isFalContentPolicyError(error)
        && this.config.comfyUiBaseUrl
        && hasWorkflowForMode(this.config, mode)
      ) {
        const fallbackResult = await this.persistGeneratedImages(await this.runComfy(mode, params));
        return {
          ...fallbackResult,
          fallbackUsed: true,
          fallbackReason: 'fal_content_policy_422',
        };
      }
      throw error;
    }
  }

  private async runComfy(
    mode: 'create',
    params: ImageCreateParams,
  ): Promise<ImageGenerationResult>;
  private async runComfy(
    mode: 'edit',
    params: ImageEditParams,
  ): Promise<ImageGenerationResult>;
  private async runComfy(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
  ): Promise<ImageGenerationResult> {
    const baseUrl = this.config.comfyUiBaseUrl?.trim();
    if (!baseUrl) {
      throw new Error('comfyUiBaseUrl is not configured');
    }

    const client = new ComfyUiImageClient(
      baseUrl,
      this.config.imageWorkflows ?? {},
      this.config,
      this.fetchImpl,
    );
    return mode === 'create'
      ? await client.create(params)
      : await client.edit(params);
  }

  private async persistGeneratedImages(result: ImageGenerationResult): Promise<ImageGenerationResult> {
    const companionDataDir = this.options.companionDataDir?.trim()
      || resolveConfiguredCompanionDataDirOrNull(this.config);
    if (result.images.length === 0) {
      return result;
    }
    if (!companionDataDir) {
      log.warn('Generated image persistence skipped: companionDataDir unavailable', {
        requestId: result.requestId,
        imageCount: result.images.length,
      });
      return result;
    }

    const now = new Date();
    const dateDir = [
      now.getUTCFullYear().toString().padStart(4, '0'),
      (now.getUTCMonth() + 1).toString().padStart(2, '0'),
      now.getUTCDate().toString().padStart(2, '0'),
    ].join('-');
    const storageDir = join(resolveGeneratedImagesDir(companionDataDir), dateDir);
    await mkdir(storageDir, { recursive: true });

    const images = await Promise.all(result.images.map(async (asset, index) => {
      if (asset.localPath?.trim()) {
        return asset;
      }

      const extension = inferExtension(asset.url, asset.contentType);
      const fileStem = deriveFileStem(asset, result.requestId, index);
      const fileName = `${fileStem}-${randomUUID().slice(0, 8)}${extension}`;
      const localPath = join(storageDir, fileName);

      try {
        const response = await this.fetchImpl(asset.url);
        if (!response.ok) {
          throw new Error(`download failed with ${response.status}`);
        }

        const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
          || asset.contentType
          || 'image/png';
        if (!contentType.startsWith('image/')) {
          throw new Error(`provider returned non-image content type ${contentType}`);
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) {
          throw new Error('provider returned an empty image body');
        }

        await writeFile(localPath, bytes);
        return {
          ...asset,
          contentType,
          localPath,
        };
      } catch (error) {
        log.warn('Failed to persist generated image locally', {
          url: asset.url,
          requestId: result.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
        return asset;
      }
    }));

    return {
      ...result,
      images,
    };
  }
}
