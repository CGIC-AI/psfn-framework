import { isRecord } from '../../shared/utils/types.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageMode,
  ImageResultAsset,
} from './types.js';
import type { SensitivityLevel } from '../../system/trust/types.js';

export const COMFYUI_MCP_SERVER_ID = 'comfyui';
export const COMFYUI_MCP_CREATE_TOOL = 'generate_image';
export const COMFYUI_MCP_EDIT_TOOL = 'edit_image';

export type ComfyUiMcpAdapterErrorCode =
  | 'IMAGE_MCP_NOT_CONFIGURED'
  | 'IMAGE_MCP_OUTPUT_WITHHELD'
  | 'IMAGE_MCP_PROVIDER_ERROR'
  | 'IMAGE_MCP_INVALID_RESULT';

export class ComfyUiMcpAdapterError extends Error {
  override readonly name = 'ComfyUiMcpAdapterError';

  constructor(
    readonly code: ComfyUiMcpAdapterErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ComfyUiMcpScreenedResult {
  serverId: string;
  toolName: string;
  isError: boolean;
  effectiveText: string;
  withheld: boolean;
}

export type ComfyUiMcpInvoker = (input: {
  mode: ImageMode;
  arguments: Record<string, unknown>;
  outboundSensitivity: SensitivityLevel;
}) => Promise<ComfyUiMcpScreenedResult>;

export function resolveComfyUiMcpSensitivity(
  params: ImageCreateParams | ImageEditParams,
): SensitivityLevel {
  if ('imageUrls' in params && params.imageUrls.some(url => url.startsWith('data:'))) {
    return 'confidential';
  }
  return 'personal';
}

function compactRecord(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));
}

export function buildComfyUiMcpArguments(
  mode: 'create',
  params: ImageCreateParams,
): Record<string, unknown>;
export function buildComfyUiMcpArguments(
  mode: 'edit',
  params: ImageEditParams,
): Record<string, unknown>;
export function buildComfyUiMcpArguments(
  mode: ImageMode,
  params: ImageCreateParams | ImageEditParams,
): Record<string, unknown> {
  const common = compactRecord([
    ['prompt', params.prompt],
    ['num_images', params.numImages],
    ['width', params.width],
    ['height', params.height],
    ['aspect_ratio', params.aspectRatio],
    ['resolution', params.resolution],
    ['image_size', params.imageSize],
    ['background', params.background],
    ['output_format', params.outputFormat],
    ['seed', params.seed],
  ]);
  if (mode === 'create') {
    const create = params as ImageCreateParams;
    return {
      ...common,
      ...compactRecord([
        ['guidance_scale', create.guidanceScale],
        ['num_inference_steps', create.numInferenceSteps],
        ['acceleration', create.acceleration],
        ['enable_prompt_expansion', create.enablePromptExpansion],
        ['enable_safety_checker', create.enableSafetyChecker],
        ['negative_prompt', create.negativePrompt],
        ['use_turbo', create.useTurbo],
      ]),
    };
  }
  const edit = params as ImageEditParams;
  return {
    ...common,
    input_urls: edit.imageUrls,
    ...compactRecord([
      ['mask_image_url', edit.maskImageUrl],
      ['input_fidelity', edit.inputFidelity],
    ]),
  };
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractStructuredPayload(protocolResult: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(protocolResult.structuredContent)) {
    return protocolResult.structuredContent;
  }
  if (!Array.isArray(protocolResult.content)) return null;
  for (const block of protocolResult.content) {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    const parsed = parseJsonRecord(block.text);
    if (parsed) return parsed;
  }
  return null;
}

function extractProtocolImageAssets(protocolResult: Record<string, unknown>): ImageResultAsset[] {
  if (!Array.isArray(protocolResult.content)) return [];
  const images: ImageResultAsset[] = [];
  for (const block of protocolResult.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'image') {
      const data = optionalTrimmedString(block.data);
      const mimeType = optionalTrimmedString(block.mimeType);
      if (!data || !mimeType?.startsWith('image/')) continue;
      const fileName = optionalTrimmedString(block.name);
      images.push({
        url: `data:${mimeType};base64,${data}`,
        contentType: mimeType,
        ...(fileName ? { fileName } : {}),
      });
      continue;
    }
    if (block.type === 'resource_link') {
      const url = optionalTrimmedString(block.uri);
      const contentType = optionalTrimmedString(block.mimeType);
      if (!url || !contentType?.startsWith('image/')) continue;
      const fileName = optionalTrimmedString(block.name);
      images.push({
        url,
        contentType,
        ...(fileName ? { fileName } : {}),
      });
    }
  }
  return images;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseImageAsset(value: unknown): ImageResultAsset | null {
  if (!isRecord(value)) return null;
  const url = optionalTrimmedString(value.url);
  if (!url) return null;
  const contentType = optionalTrimmedString(value.content_type);
  const fileName = optionalTrimmedString(value.file_name);
  return {
    url,
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
  };
}

export function parseComfyUiMcpResult(
  mode: ImageMode,
  result: ComfyUiMcpScreenedResult,
): ImageGenerationResult {
  if (result.withheld) {
    throw new ComfyUiMcpAdapterError(
      'IMAGE_MCP_OUTPUT_WITHHELD',
      'ComfyUI MCP output was withheld by the gateway intake policy',
    );
  }
  if (result.isError) {
    throw new ComfyUiMcpAdapterError(
      'IMAGE_MCP_PROVIDER_ERROR',
      `ComfyUI MCP ${mode} tool reported an error`,
    );
  }
  const protocolResult = parseJsonRecord(result.effectiveText);
  const payload = protocolResult ? extractStructuredPayload(protocolResult) : null;
  const structuredImages = Array.isArray(payload?.images)
    ? payload.images.map(parseImageAsset)
    : [];
  const protocolImages = protocolResult ? extractProtocolImageAssets(protocolResult) : [];
  const images = structuredImages.length > 0 ? structuredImages : protocolImages;
  if (images.length === 0 || images.some(image => image === null)) {
    throw new ComfyUiMcpAdapterError(
      'IMAGE_MCP_INVALID_RESULT',
      'ComfyUI MCP returned no valid structured image assets',
    );
  }
  const requestId = optionalTrimmedString(payload?.request_id);
  const model = optionalTrimmedString(payload?.model);
  return {
    provider: 'comfyui_mcp',
    mode,
    ...(model ? { model } : {}),
    fallbackUsed: false,
    ...(requestId ? { requestId } : {}),
    images: images as ImageResultAsset[],
  };
}
