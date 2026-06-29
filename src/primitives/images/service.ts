import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { ComfyUiImageClient } from './comfyui.js';
import { FalImageClient, isFalContentPolicyError, isTransientFalError } from './fal.js';
import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  type FalCreateModel,
  type FalEditModel,
} from './types.js';
import { resolveInlineOrEnvCredential } from '../../boundary/custody/credential-vault.js';
import {
  resolveConfiguredCompanionDataDir,
  resolveGeneratedImagesDir,
  resolvePersonalImagesDir,
} from '../../persistence/layout.js';
import { createComponentLogger } from '../../shared/logger.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
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
const FAL_TRANSIENT_MODEL_ATTEMPTS = 2;
const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';

const DEFAULT_FAL_CREATE_MODEL_CHAIN: readonly FalCreateModel[] = FAL_CREATE_MODELS.slice(
  0,
  FAL_TRANSIENT_MODEL_ATTEMPTS,
);
const DEFAULT_FAL_EDIT_MODEL_CHAIN: readonly FalEditModel[] = FAL_EDIT_MODELS.slice(
  0,
  FAL_TRANSIENT_MODEL_ATTEMPTS,
);

function hasWorkflowForMode(
  config: ImageRuntimeConfig,
  mode: ImageMode,
): boolean {
  return Boolean(config.imageWorkflows?.comfyUi?.[mode]?.workflow);
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

function resolveFalFallbackModelChain(
  mode: 'create',
  params: ImageCreateParams,
  provider: ImageCreateParams['provider'],
): readonly (FalCreateModel | undefined)[];
function resolveFalFallbackModelChain(
  mode: 'edit',
  params: ImageEditParams,
  provider: ImageEditParams['provider'],
): readonly (FalEditModel | undefined)[];
function resolveFalFallbackModelChain(
  mode: ImageMode,
  params: ImageCreateParams | ImageEditParams,
  provider: ImageCreateParams['provider'] | ImageEditParams['provider'],
): readonly (FalCreateModel | FalEditModel | undefined)[] {
  if (params.model || provider !== 'auto') {
    return [params.model];
  }
  return mode === 'create'
    ? DEFAULT_FAL_CREATE_MODEL_CHAIN
    : DEFAULT_FAL_EDIT_MODEL_CHAIN;
}

function applyFalModel(
  mode: 'create',
  params: ImageCreateParams,
  model: FalCreateModel | undefined,
): ImageCreateParams;
function applyFalModel(
  mode: 'edit',
  params: ImageEditParams,
  model: FalEditModel | undefined,
): ImageEditParams;
function applyFalModel(
  mode: ImageMode,
  params: ImageCreateParams | ImageEditParams,
  model: FalCreateModel | FalEditModel | undefined,
): ImageCreateParams | ImageEditParams {
  if (!model) return params;
  if (mode === 'create') {
    return { ...(params as ImageCreateParams), model: model as FalCreateModel };
  }
  return { ...(params as ImageEditParams), model: model as FalEditModel };
}

function buildGeneratedImageMetadata(
  result: ImageGenerationResult,
  params: ImageCreateParams | ImageEditParams | undefined,
  asset: ImageResultAsset,
  index: number,
  contentType: string,
): Record<string, unknown> {
  const sourceImageCount = params && 'imageUrls' in params ? params.imageUrls.length : 0;
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    provider: result.provider,
    mode: result.mode,
    ...(result.model ? { model: result.model } : {}),
    fallbackUsed: result.fallbackUsed,
    ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.requestId ? { requestId: result.requestId } : {}),
    imageIndex: index,
    originalUrl: asset.url,
    contentType,
    ...(asset.fileName ? { providerFileName: asset.fileName } : {}),
    ...(params?.prompt ? { prompt: params.prompt } : {}),
    ...(params?.sourceToolName ? { sourceToolName: params.sourceToolName } : {}),
    ...(params?.referenceImageIds?.length ? { referenceImageIds: params.referenceImageIds } : {}),
    sourceImageCount,
  };
}

export class ImageService implements ImageOperations {
  constructor(
    private readonly config: ImageRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: {
      companionDataDir?: string;
      generatedImagesDir?: string;
      personalFilesDir?: string;
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
      const result = mode === 'create'
        ? await this.runComfy('create', params as ImageCreateParams)
        : await this.runComfy('edit', params as ImageEditParams);
      return await this.persistGeneratedImages(result, params);
    }

    if (!falApiKey) {
      if (provider === 'fal') {
        throw new Error('FAL_API_KEY is not configured');
      }
      const result = mode === 'create'
        ? await this.runComfy('create', params as ImageCreateParams)
        : await this.runComfy('edit', params as ImageEditParams);
      return await this.persistGeneratedImages(result, params);
    }

    try {
      const falClient = new FalImageClient(falApiKey, this.fetchImpl);
      const result = mode === 'create'
        ? await this.runFal('create', params as ImageCreateParams, provider, falClient)
        : await this.runFal('edit', params as ImageEditParams, provider, falClient);
      return await this.persistGeneratedImages(result, params);
    } catch (error) {
      if (
        provider === 'auto'
        && isFalContentPolicyError(error)
        && this.config.comfyUiBaseUrl
        && hasWorkflowForMode(this.config, mode)
      ) {
        const result = mode === 'create'
          ? await this.runComfy('create', params as ImageCreateParams)
          : await this.runComfy('edit', params as ImageEditParams);
        const fallbackResult = await this.persistGeneratedImages(result, params);
        return {
          ...fallbackResult,
          fallbackUsed: true,
          fallbackReason: 'fal_content_policy_422',
        };
      }
      throw error;
    }
  }

  private async runFal(
    mode: 'create',
    params: ImageCreateParams,
    provider: ImageCreateParams['provider'],
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult>;
  private async runFal(
    mode: 'edit',
    params: ImageEditParams,
    provider: ImageEditParams['provider'],
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult>;
  private async runFal(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    provider: ImageCreateParams['provider'] | ImageEditParams['provider'],
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult> {
    const modelChain = mode === 'create'
      ? resolveFalFallbackModelChain('create', params as ImageCreateParams, provider)
      : resolveFalFallbackModelChain('edit', params as ImageEditParams, provider);
    let lastError: unknown;
    for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex += 1) {
      const model = modelChain[modelIndex];
      const candidateParams = mode === 'create'
        ? applyFalModel('create', params as ImageCreateParams, model as FalCreateModel | undefined)
        : applyFalModel('edit', params as ImageEditParams, model as FalEditModel | undefined);
      try {
        const result = mode === 'create'
          ? await this.runFalCandidate('create', candidateParams as ImageCreateParams, falClient)
          : await this.runFalCandidate('edit', candidateParams as ImageEditParams, falClient);
        if (modelIndex === 0) {
          return result;
        }
        return {
          ...result,
          fallbackUsed: true,
          fallbackReason: 'fal_transient_model_fallback',
        };
      } catch (error) {
        lastError = error;
        const nextModel = modelChain[modelIndex + 1];
        if (nextModel && isTransientFalError(error)) {
          log.warn('Falling back to alternate FAL image model after transient failures', {
            mode,
            failedModel: model,
            nextModel,
            attempts: FAL_TRANSIENT_ATTEMPTS,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'FAL image request failed'));
  }

  private async runFalCandidate(
    mode: 'create',
    params: ImageCreateParams,
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult>;
  private async runFalCandidate(
    mode: 'edit',
    params: ImageEditParams,
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult>;
  private async runFalCandidate(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    falClient: FalImageClient,
  ): Promise<ImageGenerationResult> {
    let result: ImageGenerationResult | null = null;
    for (let attempt = 1; attempt <= FAL_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        result = mode === 'create'
          ? await falClient.create(params as ImageCreateParams)
          : await falClient.edit(params as ImageEditParams);
        break;
      } catch (error) {
        if (attempt >= FAL_TRANSIENT_ATTEMPTS || !isTransientFalError(error)) {
          throw error;
        }
        log.warn('Retrying transient FAL image request failure', {
          mode,
          attempt,
          model: params.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!result) {
      throw new Error('FAL image request did not return a result');
    }
    return result;
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
    if (mode === 'create') {
      return await client.create(params as ImageCreateParams);
    }
    return await client.edit(params as ImageEditParams);
  }

  private async persistGeneratedImages(
    result: ImageGenerationResult,
    params?: ImageCreateParams | ImageEditParams,
  ): Promise<ImageGenerationResult> {
    const storageRoot = this.options.generatedImagesDir?.trim()
      || (this.options.personalFilesDir?.trim()
        ? resolvePersonalImagesDir(this.options.personalFilesDir.trim())
        : null)
      || (() => {
        const companionDataDir = this.options.companionDataDir?.trim()
          || resolveConfiguredCompanionDataDirOrNull(this.config);
        return companionDataDir ? resolveGeneratedImagesDir(companionDataDir) : null;
      })();
    if (result.images.length === 0) {
      return result;
    }
    if (!storageRoot) {
      log.warn('Generated image persistence skipped: storage root unavailable', {
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
    const storageDir = join(storageRoot, dateDir);
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
        try {
          writeJsonAtomic(
            `${localPath}${GENERATED_IMAGE_META_SUFFIX}`,
            buildGeneratedImageMetadata(result, params, asset, index, contentType),
          );
        } catch (error) {
          log.warn('Failed to write generated image metadata sidecar', {
            localPath,
            requestId: result.requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
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
