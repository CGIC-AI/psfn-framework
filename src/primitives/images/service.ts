import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ComfyUiImageClient } from './comfyui.js';
import { FalImageClient, isFalContentPolicyError, isTransientFalError } from './fal.js';
import {
  DEFAULT_FAL_CREATE_MODEL_CHAIN,
  DEFAULT_FAL_EDIT_MODEL_CHAIN,
  normalizeFalCreateModelSetting,
  normalizeFalEditModelSetting,
  normalizeImageProviderSetting,
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
import { buildImageFileName } from './file-naming.js';
import {
  buildComfyUiMcpArguments,
  ComfyUiMcpAdapterError,
  parseComfyUiMcpResult,
  resolveComfyUiMcpSensitivity,
  type ComfyUiMcpInvoker,
} from './comfyui-mcp.js';

const log = createComponentLogger('ImageService');
const FAL_TRANSIENT_ATTEMPTS = 2;
const GENERATED_IMAGE_META_SUFFIX = '.image-meta.json';
type ImageFallbackReason = 'fal_transient_model_fallback' | 'fal_content_policy_422';

export interface ImageProviderAttempt {
  attempt: number;
  provider: 'fal' | 'comfyui' | 'comfyui_mcp';
  model: string;
  startedAtMs: number;
  completedAtMs: number;
  status: 'success' | 'failure';
  result?: ImageGenerationResult;
  error?: Error;
}

export interface ImageProviderAttemptStart {
  attempt: number;
  provider: 'fal' | 'comfyui' | 'comfyui_mcp';
  model: string;
  startedAtMs: number;
}

export class ImageProviderAttemptPreflightError extends Error {
  constructor(
    readonly attempt: ImageProviderAttemptStart,
    cause: unknown,
  ) {
    super(
      `Failed to preflight ${attempt.provider} image provider attempt ${attempt.attempt}`,
      { cause },
    );
    this.name = 'ImageProviderAttemptPreflightError';
  }
}

export class ImageProviderAttemptSettlementError extends Error {
  constructor(
    readonly attempt: ImageProviderAttempt,
    cause: unknown,
  ) {
    super(
      `Failed to settle ${attempt.provider} image provider attempt ${attempt.attempt}`,
      { cause },
    );
    this.name = 'ImageProviderAttemptSettlementError';
  }
}

function isRetryableFalProviderError(error: unknown): boolean {
  return !(error instanceof ImageProviderAttemptPreflightError)
    && !(error instanceof ImageProviderAttemptSettlementError)
    && isTransientFalError(error);
}

interface ImageServiceOptions {
  companionDataDir?: string;
  generatedImagesDir?: string;
  personalFilesDir?: string;
  beforeProviderAttempt?: (attempt: ImageProviderAttemptStart) => Promise<void> | void;
  onProviderAttempt?: (attempt: ImageProviderAttempt) => Promise<void> | void;
  mcpInvoker?: ComfyUiMcpInvoker;
}

interface ImageRunContext {
  providerAttempt: number;
}

function hasWorkflowForMode(
  config: ImageRuntimeConfig,
  mode: ImageMode,
): boolean {
  return Boolean(config.imageWorkflows?.comfyUi?.[mode]?.workflow);
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
  requestedProvider: ImageCreateParams['provider'],
  configuredModel: FalCreateModel | undefined,
): readonly (FalCreateModel | undefined)[];
function resolveFalFallbackModelChain(
  mode: 'edit',
  params: ImageEditParams,
  requestedProvider: ImageEditParams['provider'],
  configuredModel: FalEditModel | undefined,
): readonly (FalEditModel | undefined)[];
function resolveFalFallbackModelChain(
  mode: ImageMode,
  params: ImageCreateParams | ImageEditParams,
  requestedProvider: ImageCreateParams['provider'] | ImageEditParams['provider'],
  configuredModel: FalCreateModel | FalEditModel | undefined,
): readonly (FalCreateModel | FalEditModel | undefined)[] {
  if (params.model) {
    return [params.model];
  }
  const defaultChain = mode === 'create'
    ? DEFAULT_FAL_CREATE_MODEL_CHAIN
    : DEFAULT_FAL_EDIT_MODEL_CHAIN;
  if (configuredModel) {
    return [configuredModel];
  }
  if (requestedProvider !== undefined && requestedProvider !== 'auto') {
    return [undefined];
  }
  return defaultChain;
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

function resolveSettingsProvider(
  params: ImageCreateParams | ImageEditParams,
  config: ImageRuntimeConfig,
): ImageRuntimeConfig['imageProvider'] {
  const value = params.settingsDefaults?.provider ?? config.imageProvider;
  return value === undefined
    ? undefined
    : normalizeImageProviderSetting(value, 'settingsDefaults.provider');
}

function resolveSettingsModel(
  mode: 'create',
  params: ImageCreateParams,
  config: ImageRuntimeConfig,
): FalCreateModel | undefined;
function resolveSettingsModel(
  mode: 'edit',
  params: ImageEditParams,
  config: ImageRuntimeConfig,
): FalEditModel | undefined;
function resolveSettingsModel(
  mode: ImageMode,
  params: ImageCreateParams | ImageEditParams,
  config: ImageRuntimeConfig,
): FalCreateModel | FalEditModel | undefined {
  const value = params.settingsDefaults?.model
    ?? (mode === 'create' ? config.imageFalCreateModel : config.imageFalEditModel);
  if (value === undefined) {
    return undefined;
  }
  return mode === 'create'
    ? normalizeFalCreateModelSetting(value, 'settingsDefaults.model')
    : normalizeFalEditModelSetting(value, 'settingsDefaults.model');
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
    artifactRefs: [{
      kind: 'shared_image',
      refId: result.requestId ?? asset.fileName ?? asset.url,
      url: asset.url,
    }],
  };
}

export class ImageService implements ImageOperations {
  constructor(
    private readonly config: ImageRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly options: ImageServiceOptions = {},
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
    const context: ImageRunContext = { providerAttempt: 0 };
    const falApiKey = resolveInlineOrEnvCredential(
      this.config.falApiKey,
      this.config.credentialVault,
      'FAL_API_KEY',
    );
    // An explicit Fal catalog model is itself an explicit provider selection
    // when provider is omitted. It must not be discarded by a configured
    // ComfyUI default.
    const requestedProvider = params.provider ?? (params.model ? 'fal' : undefined);
    const provider = requestedProvider ?? resolveSettingsProvider(params, this.config) ?? 'auto';
    const configuredModel = mode === 'create'
      ? resolveSettingsModel('create', params as ImageCreateParams, this.config)
      : resolveSettingsModel('edit', params as ImageEditParams, this.config);
    if (provider === 'comfyui') {
      const result = mode === 'create'
        ? await this.runComfy('create', params as ImageCreateParams, context)
        : await this.runComfy('edit', params as ImageEditParams, context);
      return await this.persistGeneratedImages(result, params);
    }
    if (provider === 'comfyui_mcp') {
      const result = mode === 'create'
        ? await this.runComfyMcp('create', params as ImageCreateParams, context)
        : await this.runComfyMcp('edit', params as ImageEditParams, context);
      return await this.persistGeneratedImages(result, params);
    }

    if (!falApiKey) {
      if (provider === 'fal') {
        throw new Error('FAL_API_KEY is not configured');
      }
      const result = mode === 'create'
        ? await this.runComfy('create', params as ImageCreateParams, context)
        : await this.runComfy('edit', params as ImageEditParams, context);
      return await this.persistGeneratedImages(result, params);
    }

    try {
      // Owner-file backed polling limits ride the runtime config (zet.7).
      const falClient = new FalImageClient(falApiKey, this.fetchImpl, this.config);
      const result = mode === 'create'
        ? await this.runFal('create', params as ImageCreateParams, requestedProvider, configuredModel as FalCreateModel | undefined, falClient, context)
        : await this.runFal('edit', params as ImageEditParams, requestedProvider, configuredModel as FalEditModel | undefined, falClient, context);
      return await this.persistGeneratedImages(result, params);
    } catch (error) {
      if (
        provider === 'auto'
        && isFalContentPolicyError(error)
        && this.config.comfyUiBaseUrl
        && hasWorkflowForMode(this.config, mode)
      ) {
        const result = mode === 'create'
          ? await this.runComfy('create', params as ImageCreateParams, context, 'fal_content_policy_422')
          : await this.runComfy('edit', params as ImageEditParams, context, 'fal_content_policy_422');
        return await this.persistGeneratedImages(result, params);
      }
      throw error;
    }
  }

  private async runFal(
    mode: 'create',
    params: ImageCreateParams,
    requestedProvider: ImageCreateParams['provider'],
    configuredModel: FalCreateModel | undefined,
    falClient: FalImageClient,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult>;
  private async runFal(
    mode: 'edit',
    params: ImageEditParams,
    requestedProvider: ImageEditParams['provider'],
    configuredModel: FalEditModel | undefined,
    falClient: FalImageClient,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult>;
  private async runFal(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    requestedProvider: ImageCreateParams['provider'] | ImageEditParams['provider'],
    configuredModel: FalCreateModel | FalEditModel | undefined,
    falClient: FalImageClient,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult> {
    const modelChain = mode === 'create'
      ? resolveFalFallbackModelChain(
          'create',
          params as ImageCreateParams,
          requestedProvider,
          configuredModel as FalCreateModel | undefined,
        )
      : resolveFalFallbackModelChain(
          'edit',
          params as ImageEditParams,
          requestedProvider,
          configuredModel as FalEditModel | undefined,
        );
    let lastError: unknown;
    for (let modelIndex = 0; modelIndex < modelChain.length; modelIndex += 1) {
      const model = modelChain[modelIndex];
      const fallbackReason = modelIndex === 0
        ? undefined
        : 'fal_transient_model_fallback';
      const candidateParams = mode === 'create'
        ? applyFalModel('create', params as ImageCreateParams, model as FalCreateModel | undefined)
        : applyFalModel('edit', params as ImageEditParams, model as FalEditModel | undefined);
      try {
        const result = mode === 'create'
          ? await this.runFalCandidate('create', candidateParams as ImageCreateParams, falClient, context, fallbackReason)
          : await this.runFalCandidate('edit', candidateParams as ImageEditParams, falClient, context, fallbackReason);
        return result;
      } catch (error) {
        lastError = error;
        const nextModel = modelChain[modelIndex + 1];
        if (nextModel && isRetryableFalProviderError(error)) {
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
    context: ImageRunContext,
    fallbackReason: ImageFallbackReason | undefined,
  ): Promise<ImageGenerationResult>;
  private async runFalCandidate(
    mode: 'edit',
    params: ImageEditParams,
    falClient: FalImageClient,
    context: ImageRunContext,
    fallbackReason: ImageFallbackReason | undefined,
  ): Promise<ImageGenerationResult>;
  private async runFalCandidate(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    falClient: FalImageClient,
    context: ImageRunContext,
    fallbackReason: ImageFallbackReason | undefined,
  ): Promise<ImageGenerationResult> {
    let result: ImageGenerationResult | null = null;
    for (let attempt = 1; attempt <= FAL_TRANSIENT_ATTEMPTS; attempt += 1) {
      try {
        result = await this.runProviderAttempt(
          context,
          'fal',
          params.model ?? (mode === 'create' ? DEFAULT_FAL_CREATE_MODEL_CHAIN[0]! : DEFAULT_FAL_EDIT_MODEL_CHAIN[0]!),
          async () => mode === 'create'
            ? await falClient.create(params as ImageCreateParams)
            : await falClient.edit(params as ImageEditParams),
          fallbackReason,
        );
        break;
      } catch (error) {
        if (attempt >= FAL_TRANSIENT_ATTEMPTS || !isRetryableFalProviderError(error)) {
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
    context: ImageRunContext,
    fallbackReason?: ImageFallbackReason,
  ): Promise<ImageGenerationResult>;
  private async runComfy(
    mode: 'edit',
    params: ImageEditParams,
    context: ImageRunContext,
    fallbackReason?: ImageFallbackReason,
  ): Promise<ImageGenerationResult>;
  private async runComfy(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    context: ImageRunContext,
    fallbackReason?: ImageFallbackReason,
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
    return await this.runProviderAttempt(
      context,
      'comfyui',
      `configured:${mode}`,
      async () => mode === 'create'
        ? await client.create(params as ImageCreateParams)
        : await client.edit(params as ImageEditParams),
      fallbackReason,
    );
  }

  private async runComfyMcp(
    mode: 'create',
    params: ImageCreateParams,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult>;
  private async runComfyMcp(
    mode: 'edit',
    params: ImageEditParams,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult>;
  private async runComfyMcp(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    context: ImageRunContext,
  ): Promise<ImageGenerationResult> {
    return await this.runProviderAttempt(
      context,
      'comfyui_mcp',
      `mcp:${mode}`,
      async () => {
        const invoker = this.options.mcpInvoker;
        if (!invoker) {
          throw new ComfyUiMcpAdapterError(
            'IMAGE_MCP_NOT_CONFIGURED',
            'ComfyUI MCP image provider is not configured on the gateway',
          );
        }
        const outboundSensitivity = resolveComfyUiMcpSensitivity(params);
        const result = mode === 'create'
          ? await invoker({
              mode,
              arguments: buildComfyUiMcpArguments('create', params as ImageCreateParams),
              outboundSensitivity,
            })
          : await invoker({
              mode,
              arguments: buildComfyUiMcpArguments('edit', params as ImageEditParams),
              outboundSensitivity,
            });
        return parseComfyUiMcpResult(mode, result);
      },
    );
  }

  private async runProviderAttempt(
    context: ImageRunContext,
    provider: 'fal' | 'comfyui' | 'comfyui_mcp',
    model: string,
    operation: () => Promise<ImageGenerationResult>,
    fallbackReason?: ImageFallbackReason,
  ): Promise<ImageGenerationResult> {
    context.providerAttempt += 1;
    const attempt = context.providerAttempt;
    const startedAtMs = Date.now();
    const attemptStart: ImageProviderAttemptStart = {
      attempt,
      provider,
      model,
      startedAtMs,
    };
    try {
      await this.options.beforeProviderAttempt?.(attemptStart);
    } catch (error) {
      throw new ImageProviderAttemptPreflightError(attemptStart, error);
    }
    let result: ImageGenerationResult;
    try {
      result = await operation();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.settleProviderAttempt({
        attempt,
        provider,
        model,
        startedAtMs,
        completedAtMs: Date.now(),
        status: 'failure',
        error: err,
      });
      throw err;
    }
    const settledResult = fallbackReason
      ? {
          ...result,
          fallbackUsed: true,
          fallbackReason,
        }
      : result;
    await this.settleProviderAttempt({
      attempt,
      provider,
      model: settledResult.model ?? model,
      startedAtMs,
      completedAtMs: Date.now(),
      status: 'success',
      result: settledResult,
    });
    return settledResult;
  }

  private async settleProviderAttempt(attempt: ImageProviderAttempt): Promise<void> {
    try {
      await this.options.onProviderAttempt?.(attempt);
    } catch (error) {
      throw new ImageProviderAttemptSettlementError(attempt, error);
    }
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

      const fileName = buildImageFileName(asset, result.requestId, index);
      const localPath = join(storageDir, fileName);

      try {
        const response = await this.fetchImpl(asset.url);
        if (!response.ok) {
          throw new Error(`download failed with ${response.status}`);
        }

        const contentType = (response.headers.get('content-type')?.split(';')[0] ?? '').trim().toLowerCase()
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
