import {
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  type FalCreateModel,
  type FalEditModel,
  type ImageCreateParams,
  type ImageEditParams,
  type ImageGenerationResult,
  type ImageMode,
  type ImageResultAsset,
} from './types.js';

const FAL_QUEUE_BASE_URL = 'https://queue.fal.run';
const DEFAULT_FAL_POLL_INTERVAL_MS = 1_500;
const DEFAULT_FAL_TIMEOUT_MS = 120_000;

interface QueueStatusResponse {
  status?: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';
  request_id?: string;
  response_url?: string;
  status_url?: string;
  cancel_url?: string;
}

interface FalImageOutput {
  images?: Array<{
    url?: string;
    content_type?: string;
    file_name?: string;
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNanoBananaModel(model: string): boolean {
  return model.startsWith('fal-ai/nano-banana-2');
}

function toAbsoluteFalUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) {
    return pathOrUrl;
  }
  return new URL(pathOrUrl, FAL_QUEUE_BASE_URL).toString();
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function payloadToString(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload === null || payload === undefined) return '';
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function normalizeFalImages(payload: FalImageOutput): ImageResultAsset[] {
  return (payload.images ?? [])
    .filter((image): image is NonNullable<FalImageOutput['images']>[number] => Boolean(image?.url))
    .map((image) => ({
      url: image.url!,
      ...(image.content_type ? { contentType: image.content_type } : {}),
      ...(image.file_name ? { fileName: image.file_name } : {}),
    }));
}

function normalizeCreateModel(model: string | undefined): FalCreateModel {
  return (FAL_CREATE_MODELS as readonly string[]).includes(model ?? '')
    ? model as FalCreateModel
    : FAL_CREATE_MODELS[0];
}

function normalizeEditModel(model: string | undefined): FalEditModel {
  return (FAL_EDIT_MODELS as readonly string[]).includes(model ?? '')
    ? model as FalEditModel
    : FAL_EDIT_MODELS[0];
}

export class FalApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'FalApiError';
    this.status = status;
    this.payload = payload;
  }
}

export function isFalContentPolicyError(error: unknown): error is FalApiError {
  if (!(error instanceof FalApiError)) return false;
  if (error.status !== 422) return false;
  const text = payloadToString(error.payload).toLowerCase();
  return text.includes('content policy')
    || text.includes('safety')
    || text.includes('moderation')
    || text.includes('nsfw');
}

export class FalImageClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    const model = normalizeCreateModel(params.model);
    const input: Record<string, unknown> = {
      prompt: params.prompt,
      sync_mode: false,
      enable_safety_checker: false,
      ...(params.numImages !== undefined ? { num_images: params.numImages } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.outputFormat ? { output_format: params.outputFormat } : {}),
    };

    if (isNanoBananaModel(model)) {
      Object.assign(input, {
        ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        safety_tolerance: '6',
      });
    } else {
      Object.assign(input, {
        ...(params.imageSize ? { image_size: params.imageSize } : {}),
        ...(params.background ? { background: params.background } : {}),
      });
    }

    return await this.submit(model, 'create', input);
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    const model = normalizeEditModel(params.model);
    const input: Record<string, unknown> = {
      prompt: params.prompt,
      image_urls: [...params.imageUrls],
      sync_mode: false,
      enable_safety_checker: false,
      ...(params.numImages !== undefined ? { num_images: params.numImages } : {}),
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      ...(params.outputFormat ? { output_format: params.outputFormat } : {}),
    };

    if (isNanoBananaModel(model)) {
      Object.assign(input, {
        ...(params.aspectRatio ? { aspect_ratio: params.aspectRatio } : {}),
        ...(params.resolution ? { resolution: params.resolution } : {}),
        safety_tolerance: '6',
      });
    } else {
      Object.assign(input, {
        ...(params.imageSize ? { image_size: params.imageSize } : {}),
        ...(params.background ? { background: params.background } : {}),
        ...(params.maskImageUrl ? { mask_image_url: params.maskImageUrl } : {}),
        ...(params.inputFidelity ? { input_fidelity: params.inputFidelity } : {}),
      });
    }

    return await this.submit(model, 'edit', input);
  }

  private async submit(
    model: string,
    mode: ImageMode,
    input: Record<string, unknown>,
  ): Promise<ImageGenerationResult> {
    const response = await this.fetchImpl(
      `${FAL_QUEUE_BASE_URL}/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Key ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(input),
      },
    );

    if (!response.ok) {
      const payload = await readResponsePayload(response);
      throw new FalApiError(
        `FAL ${mode} request failed (${response.status}): ${payloadToString(payload) || response.statusText}`,
        response.status,
        payload,
      );
    }

    const queueStatus = await response.json() as QueueStatusResponse;
    const requestId = queueStatus.request_id?.trim();
    if (!requestId) {
      throw new Error(`FAL ${mode} request did not return a request_id`);
    }

    const responseUrl = await this.waitForResultUrl(model, requestId, queueStatus);
    const resultResponse = await this.fetchImpl(responseUrl, {
      headers: {
        Authorization: `Key ${this.apiKey}`,
        Accept: 'application/json',
      },
    });

    if (!resultResponse.ok) {
      const payload = await readResponsePayload(resultResponse);
      throw new FalApiError(
        `FAL ${mode} result fetch failed (${resultResponse.status}): ${payloadToString(payload) || resultResponse.statusText}`,
        resultResponse.status,
        payload,
      );
    }

    const payload = await resultResponse.json() as FalImageOutput;
    const images = normalizeFalImages(payload);
    if (images.length === 0) {
      throw new Error(`FAL ${mode} response did not include any images`);
    }

    return {
      provider: 'fal',
      mode,
      model,
      fallbackUsed: false,
      requestId,
      images,
    };
  }

  private async waitForResultUrl(
    model: string,
    requestId: string,
    queueStatus: QueueStatusResponse,
  ): Promise<string> {
    if (queueStatus.status === 'COMPLETED' && queueStatus.response_url) {
      return toAbsoluteFalUrl(queueStatus.response_url);
    }

    const statusUrl = queueStatus.status_url
      ? toAbsoluteFalUrl(queueStatus.status_url)
      : `${FAL_QUEUE_BASE_URL}/${model}/requests/${requestId}/status`;
    const startedAt = Date.now();

    while (Date.now() - startedAt < DEFAULT_FAL_TIMEOUT_MS) {
      await sleep(DEFAULT_FAL_POLL_INTERVAL_MS);
      const response = await this.fetchImpl(statusUrl, {
        headers: {
          Authorization: `Key ${this.apiKey}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        const payload = await readResponsePayload(response);
        throw new FalApiError(
          `FAL status poll failed (${response.status}): ${payloadToString(payload) || response.statusText}`,
          response.status,
          payload,
        );
      }

      const status = await response.json() as QueueStatusResponse;
      if (status.status === 'COMPLETED' && status.response_url) {
        return toAbsoluteFalUrl(status.response_url);
      }
    }

    throw new Error(`FAL request ${requestId} timed out after ${DEFAULT_FAL_TIMEOUT_MS}ms`);
  }
}
