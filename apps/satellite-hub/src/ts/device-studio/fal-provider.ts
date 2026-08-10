export type FalGenerationMode = "text-to-image" | "image-to-image" | "edit";

export interface FalImageProviderConfig {
  apiKey?: string;
  endpointBaseUrl?: string;
  fetch?: typeof fetch;
  modelIds?: Partial<Record<FalGenerationMode, string>>;
  now?: () => Date;
}

export interface FalImageSourceProvenance {
  source: string;
  label?: string;
  url?: string;
  notes?: string;
}

export interface FalTextToImageRequest {
  prompt: string;
  modelId?: string;
  seed?: number;
  options?: Record<string, unknown>;
  provenance?: FalImageSourceProvenance;
}

export interface FalImageToImageRequest extends FalTextToImageRequest {
  imageUrl?: string;
  imageUrls?: string[];
}

export interface FalEditImageRequest extends FalImageToImageRequest {}

export interface FalGeneratedImageMetadata {
  url: string;
  width?: number;
  height?: number;
  contentType?: string;
}

export interface FalImageGenerationResult {
  provider: "fal";
  modelId: string;
  generatedAt: string;
  prompt: string;
  seed?: number;
  options?: Record<string, unknown>;
  requestId?: string;
  images: FalGeneratedImageMetadata[];
  provenance?: FalImageSourceProvenance;
  source?: {
    mode: FalGenerationMode;
    imageUrls?: string[];
  };
}

export class FalImageProviderError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "FalImageProviderError";
    this.status = options?.status;
  }

  toJSON(): { name: string; message: string; status?: number } {
    return {
      name: this.name,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

export class FalImageProvider {
  readonly provider = "fal" as const;

  readonly #apiKey?: string;
  readonly #endpointBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #modelIds: Partial<Record<FalGenerationMode, string>>;
  readonly #now: () => Date;

  constructor(config: FalImageProviderConfig = {}) {
    this.#apiKey = normalizeOptionalString(config.apiKey ?? process.env.FAL_KEY);
    this.#endpointBaseUrl = (config.endpointBaseUrl ?? "https://fal.run").replace(/\/+$/, "");
    this.#fetch = config.fetch ?? globalThis.fetch;
    this.#modelIds = { ...(config.modelIds ?? {}) };
    this.#now = config.now ?? (() => new Date());
  }

  async generateTextToImage(request: FalTextToImageRequest): Promise<FalImageGenerationResult> {
    return this.generate("text-to-image", request);
  }

  async generateImageToImage(request: FalImageToImageRequest): Promise<FalImageGenerationResult> {
    return this.generate("image-to-image", request);
  }

  async editImage(request: FalEditImageRequest): Promise<FalImageGenerationResult> {
    return this.generate("edit", request);
  }

  async generate(
    mode: FalGenerationMode,
    request: FalTextToImageRequest | FalImageToImageRequest | FalEditImageRequest,
  ): Promise<FalImageGenerationResult> {
    const apiKey = this.requireApiKey();
    const prompt = requireNonEmptyString(request.prompt, "FAL prompt is required");
    const modelId = this.resolveModelId(mode, request.modelId);
    const imageUrls = mode === "text-to-image" ? [] : collectImageUrls(request as FalImageToImageRequest);
    const response = await this.#fetch(this.buildUrl(modelId), {
      method: "POST",
      headers: {
        Authorization: `Key ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildFalRequestBody({ mode, prompt, seed: request.seed, options: request.options, imageUrls })),
    });

    if (!response.ok) {
      throw new FalImageProviderError(await formatFalHttpError(response, apiKey), { status: response.status });
    }

    const payload = await readJsonResponse(response, apiKey);
    const images = parseImages(payload);
    if (!images.length) {
      throw new FalImageProviderError("FAL image generation response did not include image URLs");
    }

    return {
      provider: this.provider,
      modelId,
      generatedAt: this.#now().toISOString(),
      prompt,
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.options === undefined ? {} : { options: { ...request.options } }),
      ...extractRequestId(payload, response.headers),
      images,
      ...(request.provenance === undefined ? {} : { provenance: { ...request.provenance } }),
      source: {
        mode,
        ...(imageUrls.length ? { imageUrls } : {}),
      },
    };
  }

  private requireApiKey(): string {
    if (!this.#apiKey) {
      throw new FalImageProviderError("FAL_KEY is required for FAL image generation");
    }
    return this.#apiKey;
  }

  private resolveModelId(mode: FalGenerationMode, requestedModelId?: string): string {
    return requireNonEmptyString(requestedModelId ?? this.#modelIds[mode], `FAL modelId is required for ${mode}`);
  }

  private buildUrl(modelId: string): string {
    return `${this.#endpointBaseUrl}/${modelId.replace(/^\/+/, "")}`;
  }
}

function buildFalRequestBody(input: {
  mode: FalGenerationMode;
  prompt: string;
  seed?: number;
  options?: Record<string, unknown>;
  imageUrls: string[];
}): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...(input.options ?? {}),
    prompt: input.prompt,
  };
  if (input.seed !== undefined) {
    body.seed = input.seed;
  }
  if (input.mode === "edit" && input.imageUrls.length > 0) {
    body.image_urls = input.imageUrls;
  } else if (input.imageUrls.length === 1) {
    const firstImageUrl = input.imageUrls[0];
    if (firstImageUrl) body.image_url = firstImageUrl;
  } else if (input.imageUrls.length > 1) {
    body.image_urls = input.imageUrls;
  }
  return body;
}

function collectImageUrls(request: FalImageToImageRequest): string[] {
  const urls = [
    ...(request.imageUrl ? [request.imageUrl] : []),
    ...(request.imageUrls ?? []),
  ]
    .map((url) => url.trim())
    .filter(Boolean);

  if (!urls.length) {
    throw new FalImageProviderError("FAL image-to-image/edit generation requires at least one image URL");
  }
  return urls;
}

function parseImages(payload: unknown): FalGeneratedImageMetadata[] {
  const record = asRecord(payload);
  const images = Array.isArray(record?.images)
    ? record.images
    : record?.image === undefined
      ? []
      : [record.image];

  return images.flatMap((image) => {
    const parsed = parseImage(image);
    return parsed ? [parsed] : [];
  });
}

function parseImage(image: unknown): FalGeneratedImageMetadata | undefined {
  if (typeof image === "string") {
    const url = image.trim();
    return url ? { url } : undefined;
  }
  const record = asRecord(image);
  if (!record) return undefined;

  const url = readString(record.url) ?? readString(record.href);
  if (!url) return undefined;

  return {
    url,
    ...readPositiveNumberProperty(record, "width"),
    ...readPositiveNumberProperty(record, "height"),
    ...readContentType(record),
  };
}

function extractRequestId(payload: unknown, headers: Headers): { requestId?: string } {
  const record = asRecord(payload);
  const requestId = readString(record?.request_id)
    ?? readString(record?.requestId)
    ?? readString(headers.get("x-fal-request-id"))
    ?? readString(headers.get("x-request-id"));
  return requestId ? { requestId } : {};
}

function readPositiveNumberProperty(record: Record<string, unknown>, key: "width" | "height"): Partial<Record<"width" | "height", number>> {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? { [key]: value } : {};
}

function readContentType(record: Record<string, unknown>): { contentType?: string } {
  const contentType = readString(record.content_type) ?? readString(record.contentType);
  return contentType ? { contentType } : {};
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new FalImageProviderError(message);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function readJsonResponse(response: Response, apiKey: string): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch (error) {
    throw new FalImageProviderError("FAL image generation response was not valid JSON", {
      cause: sanitizeUnknown(error, apiKey),
    });
  }
}

async function formatFalHttpError(response: Response, apiKey: string): Promise<string> {
  const body = sanitizeForMessage((await response.text()).trim(), apiKey);
  const statusText = sanitizeForMessage(response.statusText.trim(), apiKey);
  const statusLabel = statusText ? `${response.status} ${statusText}` : String(response.status);
  if (!body) {
    return `FAL image generation failed (${statusLabel})`;
  }
  return `FAL image generation failed (${statusLabel}): ${body}`;
}

function sanitizeUnknown(error: unknown, apiKey: string): unknown {
  if (error instanceof Error) {
    return new Error(sanitizeForMessage(error.message, apiKey));
  }
  if (typeof error === "string") {
    return sanitizeForMessage(error, apiKey);
  }
  return error;
}

function sanitizeForMessage(value: string, apiKey: string): string {
  const redactedKey = apiKey ? value.split(apiKey).join("[redacted]") : value;
  return redactedKey
    .replace(/Authorization:\s*Key\s+[^\s"'<>]+/gi, "Authorization: Key [redacted]")
    .replace(/"authorization"\s*:\s*"Key\s+[^"]+"/gi, '"authorization":"Key [redacted]"')
    .slice(0, 2000);
}
