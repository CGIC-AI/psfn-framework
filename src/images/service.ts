import { ComfyUiImageClient } from './comfyui.js';
import { FalImageClient, isFalContentPolicyError } from './fal.js';
import { resolveInlineOrEnvCredential } from '../boundary/custody/credential-vault.js';
import type { ImageOperations } from './ops.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageMode,
  ImageRuntimeConfig,
} from './types.js';

function hasWorkflowForMode(
  config: ImageRuntimeConfig,
  mode: ImageMode,
): boolean {
  return Boolean(config.imageWorkflows?.comfyUi?.[mode]?.workflow);
}

export class ImageService implements ImageOperations {
  constructor(
    private readonly config: ImageRuntimeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
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
      return await this.runComfy(mode, params);
    }

    if (!falApiKey) {
      if (provider === 'fal') {
        throw new Error('FAL_API_KEY is not configured');
      }
      return await this.runComfy(mode, params);
    }

    try {
      return mode === 'create'
        ? await new FalImageClient(falApiKey, this.fetchImpl).create(params)
        : await new FalImageClient(falApiKey, this.fetchImpl).edit(params);
    } catch (error) {
      if (
        provider === 'auto'
        && isFalContentPolicyError(error)
        && this.config.comfyUiBaseUrl
        && hasWorkflowForMode(this.config, mode)
      ) {
        const fallbackResult = await this.runComfy(mode, params);
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
}
