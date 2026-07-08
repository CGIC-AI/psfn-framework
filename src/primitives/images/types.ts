import { isRecord } from '../../shared/utils/types.js';
import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { DnsResolver } from '../../boundary/gateway/url-policy.js';
import { IMAGE_MODEL_CATALOG } from './model-catalog.js';

export const FAL_CREATE_MODELS = IMAGE_MODEL_CATALOG.createModels;
export const FAL_EDIT_MODELS = IMAGE_MODEL_CATALOG.editModels;
export const DEFAULT_FAL_CREATE_MODEL_CHAIN = IMAGE_MODEL_CATALOG.defaultCreateModelChain;
export const DEFAULT_FAL_EDIT_MODEL_CHAIN = IMAGE_MODEL_CATALOG.defaultEditModelChain;
export const DEFAULT_SELFIE_EDIT_MODEL_CHAIN = IMAGE_MODEL_CATALOG.selfieEditModelChain;

export const IMAGE_ASPECT_RATIO_VALUES = [
  'auto',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  '4:1',
  '1:4',
  '8:1',
  '1:8',
] as const;

export const IMAGE_PROVIDER_VALUES = ['fal', 'comfyui'] as const;
export const IMAGE_PROVIDER_PREFERENCE_VALUES = ['auto', ...IMAGE_PROVIDER_VALUES] as const;

export type FalCreateModel = typeof FAL_CREATE_MODELS[number];
export type FalEditModel = typeof FAL_EDIT_MODELS[number];
export type FalImageModel = FalCreateModel | FalEditModel;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIO_VALUES[number];
export type ImageProvider = typeof IMAGE_PROVIDER_VALUES[number];
export type ImageProviderPreference = typeof IMAGE_PROVIDER_PREFERENCE_VALUES[number];
export type ImageMode = 'create' | 'edit';

export interface ComfyWorkflowTemplate {
  description?: string;
  workflow: Record<string, unknown>;
}

export interface ImageWorkflowSettings {
  comfyUi?: {
    create?: ComfyWorkflowTemplate;
    edit?: ComfyWorkflowTemplate;
  };
}

export interface ImageRuntimeConfig {
  credentialVault?: CredentialVaultPort;
  falApiKey?: string;
  comfyUiBaseUrl?: string;
  imageWorkflows?: ImageWorkflowSettings;
  webFetchAllowHttp?: boolean;
  webFetchDomainAllowlist?: string[];
  webFetchAllowInternalNetwork?: boolean;
  webFetchDnsResolver?: DnsResolver;
}

export interface ImageResultAsset {
  url: string;
  contentType?: string;
  fileName?: string;
  localPath?: string;
}

export interface ImageGenerationResult {
  provider: ImageProvider;
  mode: ImageMode;
  model?: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
  requestId?: string;
  images: ImageResultAsset[];
}

export interface MediaToolResultDetails {
  isError?: boolean;
  mediaResult?: ImageGenerationResult;
  visionReview?: ImageVisionReview;
  visionReviewError?: string;
}

export interface ImageToolResultDetails {
  isError?: boolean;
  imageResult?: ImageGenerationResult;
  visionReview?: ImageVisionReview;
  visionReviewError?: string;
}

export interface ImageCreateParams {
  prompt: string;
  provider?: ImageProviderPreference;
  model?: FalCreateModel;
  numImages?: number;
  width?: number;
  height?: number;
  aspectRatio?: ImageAspectRatio;
  resolution?: string;
  imageSize?: string;
  background?: string;
  outputFormat?: string;
  seed?: number;
  guidanceScale?: number;
  numInferenceSteps?: number;
  acceleration?: string;
  enablePromptExpansion?: boolean;
  enableSafetyChecker?: boolean;
  negativePrompt?: string;
  useTurbo?: boolean;
  sourceToolName?: string;
  referenceImageIds?: string[];
}

export interface ImageEditParams {
  prompt: string;
  imageUrls: string[];
  provider?: ImageProviderPreference;
  model?: FalEditModel;
  numImages?: number;
  width?: number;
  height?: number;
  aspectRatio?: ImageAspectRatio;
  resolution?: string;
  maskImageUrl?: string;
  inputFidelity?: string;
  imageSize?: string;
  background?: string;
  outputFormat?: string;
  seed?: number;
  sourceToolName?: string;
  referenceImageIds?: string[];
}

export interface ImageVisionReview {
  question: string;
  summary: string;
  model: string;
  imageCount: number;
}

export interface ImageVisionReviewRequest {
  imageUrls: string[];
  imageLocalPaths?: string[];
  question?: string;
  prompt?: string;
  mode?: ImageMode;
}

export interface ImageVisionReviewer {
  analyze(input: ImageVisionReviewRequest): Promise<ImageVisionReview>;
}

const WORKFLOW_TEMPLATE_KEYS = ['create', 'edit'] as const;

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function normalizeWorkflowTemplate(
  value: unknown,
  fieldPath: string,
): ComfyWorkflowTemplate {
  if (!isRecord(value)) {
    throw new Error(`${fieldPath} must be an object`);
  }

  const workflow = value.workflow;
  if (!isRecord(workflow)) {
    throw new Error(`${fieldPath}.workflow must be an object`);
  }

  const description = typeof value.description === 'string'
    ? value.description.trim()
    : undefined;

  return {
    ...(description ? { description } : {}),
    workflow: cloneJsonRecord(workflow),
  };
}

export function cloneImageWorkflowSettings(
  value: ImageWorkflowSettings | undefined,
): ImageWorkflowSettings {
  return normalizeImageWorkflowSettings(value ?? {});
}

export function normalizeImageWorkflowSettings(value: unknown): ImageWorkflowSettings {
  if (value === undefined || value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error('imageWorkflows must be an object');
  }

  const normalized: ImageWorkflowSettings = {};
  const comfyUi = value.comfyUi;
  if (comfyUi !== undefined) {
    if (!isRecord(comfyUi)) {
      throw new Error('imageWorkflows.comfyUi must be an object');
    }

    const normalizedComfy: NonNullable<ImageWorkflowSettings['comfyUi']> = {};
    for (const key of WORKFLOW_TEMPLATE_KEYS) {
      const template = comfyUi[key];
      if (template === undefined || template === null) continue;
      normalizedComfy[key] = normalizeWorkflowTemplate(
        template,
        `imageWorkflows.comfyUi.${key}`,
      );
    }

    normalized.comfyUi = normalizedComfy;
  }

  return normalized;
}
