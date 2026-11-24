// ── Pure image config & workflow contracts (psfn-framework-kbdvl.1) ──
//
// Core-owned image model catalog vocabulary, workflow settings normalization,
// and media result contracts used by settings/config and generated-media
// attachment handling without importing provider/network/gateway modules.

import { isRecord } from '../utils/types.js';
import { normalizeJsonRecordForSerialization } from '../utils/json-serialization.js';
import { IMAGE_MODEL_CATALOG } from '../../primitives/images/model-catalog.js';
import type { ImageMode, ImageVisionReview } from './image-vision-review.js';

export const FAL_CREATE_MODELS = IMAGE_MODEL_CATALOG.createModels;
export const FAL_EDIT_MODELS = IMAGE_MODEL_CATALOG.editModels;
export const DEFAULT_FAL_CREATE_MODEL_CHAIN = IMAGE_MODEL_CATALOG.defaultCreateModelChain;
export const DEFAULT_FAL_EDIT_MODEL_CHAIN = IMAGE_MODEL_CATALOG.defaultEditModelChain;
export const DEFAULT_SELFIE_EDIT_MODEL_CHAIN = IMAGE_MODEL_CATALOG.selfieEditModelChain;

export const IMAGE_PROVIDER_VALUES = ['fal', 'comfyui', 'comfyui_mcp', 'openrouter'] as const;
export const IMAGE_PROVIDER_PREFERENCE_VALUES = ['auto', ...IMAGE_PROVIDER_VALUES] as const;

export type FalCreateModel = typeof FAL_CREATE_MODELS[number];
export type FalEditModel = typeof FAL_EDIT_MODELS[number];
export type ImageProvider = typeof IMAGE_PROVIDER_VALUES[number];
export type ImageProviderPreference = typeof IMAGE_PROVIDER_PREFERENCE_VALUES[number];

function normalizeCatalogModelSetting<TModel extends string>(
  value: unknown,
  fieldName: string,
  supportedModels: readonly TModel[],
): TModel {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty image model catalog ID`);
  }
  const normalized = value.trim();
  if (!(supportedModels as readonly string[]).includes(normalized)) {
    throw new Error(
      `${fieldName} references unsupported image model catalog ID "${normalized}". `
      + `Valid values: ${supportedModels.join(', ')}`,
    );
  }
  return normalized as TModel;
}

export function normalizeImageProviderSetting(
  value: unknown,
  fieldName = 'imageProvider',
): ImageProvider {
  if (typeof value !== 'string' || !(IMAGE_PROVIDER_VALUES as readonly string[]).includes(value)) {
    throw new Error(`${fieldName} must be one of: ${IMAGE_PROVIDER_VALUES.join(', ')}`);
  }
  return value as ImageProvider;
}

export function normalizeFalCreateModelSetting(
  value: unknown,
  fieldName = 'imageFalCreateModel',
): FalCreateModel {
  return normalizeCatalogModelSetting(value, fieldName, FAL_CREATE_MODELS);
}

export function normalizeFalEditModelSetting(
  value: unknown,
  fieldName = 'imageFalEditModel',
): FalEditModel {
  return normalizeCatalogModelSetting(value, fieldName, FAL_EDIT_MODELS);
}

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
  /** Provider-reported cost of this generation, when the provider exposes it (6da92). */
  providerCostUsd?: number;
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

const WORKFLOW_TEMPLATE_KEYS = ['create', 'edit'] as const;

function normalizeWorkflowJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return normalizeJsonRecordForSerialization(value, 'image workflow');
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
    workflow: normalizeWorkflowJsonRecord(workflow),
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
