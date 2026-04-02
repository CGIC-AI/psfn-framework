import { basename } from 'node:path';
import {
  cloneImageWorkflowSettings,
  type ComfyWorkflowTemplate,
  type ImageCreateParams,
  type ImageEditParams,
  type ImageGenerationResult,
  type ImageMode,
  type ImageResultAsset,
  type ImageWorkflowSettings,
} from './types.js';

const DEFAULT_COMFY_POLL_INTERVAL_MS = 1_500;
const DEFAULT_COMFY_TIMEOUT_MS = 180_000;
const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

interface UploadedComfyImage {
  name: string;
  filename?: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryResponse {
  outputs?: Record<string, { images?: UploadedComfyImage[] }>;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inferExtension(contentType: string | null | undefined): string {
  const normalized = (contentType ?? '').toLowerCase();
  if (normalized.includes('png')) return '.png';
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return '.jpg';
  if (normalized.includes('webp')) return '.webp';
  if (normalized.includes('gif')) return '.gif';
  return '.bin';
}

function sanitizeUploadName(value: string, fallbackBase: string): string {
  const trimmed = value.trim();
  if (!trimmed) return fallbackBase;
  return trimmed.replace(/[^A-Za-z0-9._-]+/g, '-');
}

function buildViewUrl(baseUrl: string, image: UploadedComfyImage): string {
  const fileName = image.filename ?? image.name;
  if (!fileName) {
    throw new Error('ComfyUI output image is missing a file name');
  }
  const url = new URL('/view', baseUrl);
  url.searchParams.set('filename', fileName);
  url.searchParams.set('subfolder', image.subfolder ?? '');
  url.searchParams.set('type', image.type ?? 'output');
  return url.toString();
}

function collectOutputImages(
  baseUrl: string,
  history: ComfyHistoryResponse,
): ImageResultAsset[] {
  const assets: ImageResultAsset[] = [];
  for (const output of Object.values(history.outputs ?? {})) {
    for (const image of output.images ?? []) {
      const fileName = image.filename ?? image.name;
      if (!fileName) continue;
      assets.push({
        url: buildViewUrl(baseUrl, image),
        fileName,
      });
    }
  }
  return assets;
}

function stringifyMessages(messages: unknown): string {
  if (!Array.isArray(messages)) return '';
  return messages
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length === 0) return '';
      try {
        return JSON.stringify(entry);
      } catch {
        return String(entry);
      }
    })
    .filter(Boolean)
    .join('; ');
}

function exactPlaceholderMatch(value: string): string | null {
  const match = value.match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/);
  return match?.[1] ?? null;
}

function renderTemplateValue(
  value: unknown,
  context: Record<string, unknown>,
): unknown {
  if (typeof value === 'string') {
    const exactKey = exactPlaceholderMatch(value);
    if (exactKey) {
      if (!(exactKey in context)) {
        throw new Error(`Missing image workflow placeholder "${exactKey}"`);
      }
      return context[exactKey];
    }

    return value.replace(PLACEHOLDER_PATTERN, (_match, key: string) => {
      if (!(key in context)) {
        throw new Error(`Missing image workflow placeholder "${key}"`);
      }
      const replacement = context[key];
      if (
        replacement !== null
        && replacement !== undefined
        && typeof replacement === 'object'
      ) {
        throw new Error(`Placeholder "${key}" cannot be interpolated into a string field`);
      }
      return String(replacement ?? '');
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, context));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, renderTemplateValue(entry, context)]),
    );
  }

  return value;
}

function cloneWorkflowTemplate(template: ComfyWorkflowTemplate): Record<string, unknown> {
  return JSON.parse(JSON.stringify(template.workflow)) as Record<string, unknown>;
}

async function readJsonOrThrow(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(`${label} returned an empty response`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class ComfyUiImageClient {
  constructor(
    private readonly baseUrl: string,
    private readonly workflows: ImageWorkflowSettings,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    return await this.execute('create', params, []);
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    return await this.execute('edit', params, params.imageUrls, params.maskImageUrl);
  }

  private resolveTemplate(mode: ImageMode): ComfyWorkflowTemplate {
    const workflows = cloneImageWorkflowSettings(this.workflows);
    const template = workflows.comfyUi?.[mode];
    if (!template?.workflow) {
      throw new Error(
        `No ComfyUI ${mode} workflow configured. Add imageWorkflows.comfyUi.${mode}.workflow from Garden.`,
      );
    }
    return template;
  }

  private async execute(
    mode: ImageMode,
    params: ImageCreateParams | ImageEditParams,
    imageUrls: string[],
    maskImageUrl?: string,
  ): Promise<ImageGenerationResult> {
    const template = this.resolveTemplate(mode);
    const uploadedImages = await Promise.all(
      imageUrls.map((url, index) => this.uploadImage(url, `input-image-${index + 1}`)),
    );
    const uploadedMask = maskImageUrl
      ? await this.uploadImage(maskImageUrl, 'mask-image')
      : undefined;

    const context: Record<string, unknown> = {
      prompt: params.prompt,
      seed: params.seed ?? Date.now(),
      num_images: params.numImages ?? 1,
      batch_size: params.numImages ?? 1,
      width: params.width ?? 2048,
      height: params.height ?? 2048,
      aspect_ratio: params.aspectRatio ?? '',
      resolution: params.resolution ?? '2K',
      image_size: params.imageSize ?? '',
      background: params.background ?? '',
      output_format: params.outputFormat ?? '',
      mask_image: uploadedMask?.name ?? '',
      mask_image_name: uploadedMask?.name ?? '',
    };

    uploadedImages.forEach((image, index) => {
      const ordinal = index + 1;
      context[`input_image_${ordinal}`] = image.name;
      context[`image_${ordinal}`] = image.name;
    });

    const renderedPrompt = renderTemplateValue(
      cloneWorkflowTemplate(template),
      context,
    ) as Record<string, unknown>;

    const submitResponse = await this.fetchImpl(new URL('/prompt', this.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ prompt: renderedPrompt }),
    });
    if (!submitResponse.ok) {
      const payload = await readJsonOrThrow(submitResponse, 'ComfyUI prompt submit');
      throw new Error(
        `ComfyUI ${mode} submit failed (${submitResponse.status}): ${JSON.stringify(payload)}`,
      );
    }

    const submitPayload = await submitResponse.json() as { prompt_id?: string };
    const promptId = submitPayload.prompt_id?.trim();
    if (!promptId) {
      throw new Error(`ComfyUI ${mode} submit did not return a prompt_id`);
    }

    const history = await this.waitForHistory(promptId, mode);
    const images = collectOutputImages(this.baseUrl, history);
    if (images.length === 0) {
      throw new Error(`ComfyUI ${mode} workflow completed without output images`);
    }

    return {
      provider: 'comfyui',
      mode,
      model: `configured:${mode}`,
      fallbackUsed: false,
      requestId: promptId,
      images,
    };
  }

  private async waitForHistory(
    promptId: string,
    mode: ImageMode,
  ): Promise<ComfyHistoryResponse> {
    const startedAt = Date.now();
    const url = new URL(`/history/${promptId}`, this.baseUrl);
    while (Date.now() - startedAt < DEFAULT_COMFY_TIMEOUT_MS) {
      await sleep(DEFAULT_COMFY_POLL_INTERVAL_MS);
      const response = await this.fetchImpl(url, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) continue;

      const payload = await response.json() as Record<string, ComfyHistoryResponse>;
      if (!Object.hasOwn(payload, promptId)) continue;
      const history = payload[promptId]!;

      const status = history.status?.status_str;
      if (status === 'success') {
        return history;
      }
      if (status === 'error') {
        throw new Error(
          `ComfyUI ${mode} workflow failed: ${stringifyMessages(history.status?.messages) || 'unknown error'}`,
        );
      }
    }

    throw new Error(`ComfyUI ${mode} workflow timed out after ${DEFAULT_COMFY_TIMEOUT_MS}ms`);
  }

  private async uploadImage(
    url: string,
    fallbackBaseName: string,
  ): Promise<UploadedComfyImage> {
    const asset = await this.downloadImage(url, fallbackBaseName);
    const formData = new FormData();
    const uploadBytes = new Uint8Array(asset.bytes);
    formData.append(
      'image',
      new Blob([uploadBytes], { type: asset.contentType }),
      asset.fileName,
    );
    formData.append('type', 'input');
    formData.append('overwrite', 'true');

    const response = await this.fetchImpl(new URL('/upload/image', this.baseUrl), {
      method: 'POST',
      body: formData,
    });
    if (!response.ok) {
      const payload = await readJsonOrThrow(response, 'ComfyUI image upload');
      throw new Error(`ComfyUI image upload failed (${response.status}): ${JSON.stringify(payload)}`);
    }

    const payload = await response.json() as UploadedComfyImage;
    if (!payload.name) {
      throw new Error('ComfyUI image upload did not return a file name');
    }
    return payload;
  }

  private async downloadImage(
    url: string,
    fallbackBaseName: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; fileName: string }> {
    if (url.startsWith('data:')) {
      const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
      if (!match) {
        throw new Error('Unsupported data URL image payload');
      }
      const mimeType = match[1] || 'application/octet-stream';
      const encoded = match[3];
      const bytes = match[2]
        ? Uint8Array.from(Buffer.from(encoded, 'base64'))
        : Uint8Array.from(Buffer.from(decodeURIComponent(encoded), 'utf8'));
      return {
        bytes,
        contentType: mimeType,
        fileName: `${fallbackBaseName}${inferExtension(mimeType)}`,
      };
    }

    const response = await this.fetchImpl(url, {
      headers: { Accept: 'image/*,*/*;q=0.8' },
    });
    if (!response.ok) {
      throw new Error(`Failed to download image input (${response.status} ${response.statusText})`);
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    const pathname = new URL(url).pathname;
    const fromUrl = basename(pathname);
    const fileName = sanitizeUploadName(
      fromUrl || `${fallbackBaseName}${inferExtension(contentType)}`,
      `${fallbackBaseName}${inferExtension(contentType)}`,
    );

    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType,
      fileName,
    };
  }
}
