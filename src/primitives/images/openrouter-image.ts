import { randomUUID } from 'node:crypto';

import { resolveInlineOrEnvCredential } from '../../boundary/custody/credential-vault.js';
import { isRecord } from '../../shared/utils/types.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageMode,
  ImageRuntimeConfig,
} from './types.js';

/**
 * OpenRouter image generation (s5b89). The model comes only from models.json
 * `imageModels` and the endpoint/credential only from the referenced
 * providers.json entry. Every miss is a typed error; nothing falls back to
 * another provider or model.
 */
export type OpenRouterImageErrorCode =
  | 'IMAGE_MODEL_NOT_CONFIGURED'
  | 'IMAGE_PROVIDER_NOT_CONFIGURED'
  | 'IMAGE_PROVIDER_CREDENTIAL_MISSING'
  | 'IMAGE_MODEL_NOT_SUPPORTED'
  | 'IMAGE_PROVIDER_RESPONSE_INVALID';

export class OpenRouterImageError extends Error {
  constructor(readonly code: OpenRouterImageErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'OpenRouterImageError';
  }
}

const OUTPUT_FORMATS = new Set(['png', 'jpeg', 'webp']);
const MEDIA_TYPE_PATTERN = /^image\/[a-z0-9.+-]+$/u;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;

export interface OpenRouterImageTarget {
  readonly modelId: string;
  readonly model: string;
  readonly endpoint: string;
  readonly apiKey: string;
}

export function resolveOpenRouterImageTarget(
  config: ImageRuntimeConfig,
  mode: ImageMode,
  env: NodeJS.ProcessEnv = process.env,
): OpenRouterImageTarget {
  const entry = config.modelRegistry?.imageModels?.find(model => model.primary && model.modes.includes(mode));
  if (!entry) {
    throw new OpenRouterImageError(
      'IMAGE_MODEL_NOT_CONFIGURED',
      `models.json imageModels has no primary ${mode} model for the openrouter image provider`,
    );
  }
  const provider = config.providerRegistry?.providers.find(candidate => candidate.id === entry.provider);
  if (!provider || !provider.enabled || provider.type !== 'openrouter' || !provider.apiBaseUrl || !provider.apiKeyRef) {
    throw new OpenRouterImageError(
      'IMAGE_PROVIDER_NOT_CONFIGURED',
      `Image model "${entry.id}" names provider "${entry.provider}", which is not an enabled providers.json OpenRouter entry with a credential reference`,
    );
  }
  const apiKey = resolveInlineOrEnvCredential(undefined, config.credentialVault, provider.apiKeyRef.envName, env);
  if (!apiKey) {
    throw new OpenRouterImageError(
      'IMAGE_PROVIDER_CREDENTIAL_MISSING',
      `${provider.apiKeyRef.envName} is not configured for the openrouter image provider`,
    );
  }
  return {
    modelId: entry.id,
    model: entry.model,
    endpoint: `${provider.apiBaseUrl.replace(/\/+$/u, '')}/images`,
    apiKey,
  };
}

function requestBody(
  mode: ImageMode,
  model: string,
  params: ImageCreateParams | ImageEditParams,
): Record<string, unknown> {
  const outputFormat = params.outputFormat?.trim().toLowerCase();
  return {
    model,
    prompt: params.prompt,
    ...(params.aspectRatio && params.aspectRatio !== 'auto' ? { aspect_ratio: params.aspectRatio } : {}),
    ...(outputFormat && OUTPUT_FORMATS.has(outputFormat) ? { output_format: outputFormat } : {}),
    ...(mode === 'edit'
      ? {
          input_references: (params as ImageEditParams).imageUrls.map(url => ({
            type: 'image_url',
            image_url: { url },
          })),
        }
      : {}),
  };
}

function parseImages(body: unknown): ImageGenerationResult['images'] {
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length === 0) {
    throw new OpenRouterImageError('IMAGE_PROVIDER_RESPONSE_INVALID', 'OpenRouter returned no images');
  }
  return body.data.map((item) => {
    const mediaType = isRecord(item) && typeof item.media_type === 'string' ? item.media_type : 'image/png';
    if (!isRecord(item) || typeof item.b64_json !== 'string' || !BASE64_PATTERN.test(item.b64_json)
      || !MEDIA_TYPE_PATTERN.test(mediaType)) {
      throw new OpenRouterImageError('IMAGE_PROVIDER_RESPONSE_INVALID', 'OpenRouter returned a malformed image');
    }
    return { url: `data:${mediaType};base64,${item.b64_json}`, contentType: mediaType };
  });
}

export async function runOpenRouterImage(input: {
  readonly mode: ImageMode;
  readonly target: OpenRouterImageTarget;
  readonly params: ImageCreateParams | ImageEditParams;
  readonly fetchImpl: typeof fetch;
}): Promise<ImageGenerationResult> {
  if (input.params.model) {
    throw new OpenRouterImageError(
      'IMAGE_MODEL_NOT_SUPPORTED',
      `Fal catalog model "${input.params.model}" cannot run on the openrouter image provider; omit model`,
    );
  }
  const response = await input.fetchImpl(input.target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.target.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody(input.mode, input.target.model, input.params)),
  });
  if (!response.ok) {
    throw new OpenRouterImageError(
      'IMAGE_PROVIDER_RESPONSE_INVALID',
      `OpenRouter image request failed with HTTP ${response.status}`,
      response.status,
    );
  }
  const requestId = randomUUID();
  const body = await response.json() as unknown;
  const providerCostUsd = parseProviderCost(body);
  const images = parseImages(body).map((image, index) => ({
    ...image,
    fileName: `openrouter-${requestId.slice(0, 8)}-${index + 1}.${image.contentType?.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`,
  }));
  return {
    provider: 'openrouter',
    mode: input.mode,
    model: input.target.model,
    fallbackUsed: false,
    requestId: `openrouter:${requestId}`,
    images,
    ...(providerCostUsd !== undefined ? { providerCostUsd } : {}),
  };
}

/** OpenRouter reports the billed amount as `usage.cost` (USD). */
function parseProviderCost(body: unknown): number | undefined {
  if (!isRecord(body) || !isRecord(body.usage)) return undefined;
  const cost = body.usage.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}
