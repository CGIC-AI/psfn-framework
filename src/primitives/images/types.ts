import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import type { DnsResolver } from '../../boundary/gateway/url-policy.js';
import type {
  CanonicalModelRegistry,
  CanonicalProviderRegistry,
} from '../../shared/contracts/runtime-base.js';
import type {
  FalCreateModel,
  FalEditModel,
  ImageProvider,
  ImageProviderPreference,
  ImageWorkflowSettings,
} from '../../shared/contracts/image-config-contracts.js';
import type {
  EmbodimentConsistencyVerdict,
} from '../../shared/contracts/image-vision-review.js';

export {
  DEFAULT_FAL_CREATE_MODEL_CHAIN,
  DEFAULT_FAL_EDIT_MODEL_CHAIN,
  DEFAULT_SELFIE_EDIT_MODEL_CHAIN,
  FAL_CREATE_MODELS,
  FAL_EDIT_MODELS,
  IMAGE_PROVIDER_PREFERENCE_VALUES,
  IMAGE_PROVIDER_VALUES,
  cloneImageWorkflowSettings,
  normalizeFalCreateModelSetting,
  normalizeFalEditModelSetting,
  normalizeImageProviderSetting,
  normalizeImageWorkflowSettings,
} from '../../shared/contracts/image-config-contracts.js';
export type {
  ComfyWorkflowTemplate,
  FalCreateModel,
  FalEditModel,
  ImageGenerationResult,
  ImageProvider,
  ImageProviderPreference,
  ImageResultAsset,
  ImageToolResultDetails,
  ImageWorkflowSettings,
  MediaToolResultDetails,
} from '../../shared/contracts/image-config-contracts.js';
export type {
  EmbodimentConsistencyVerdict,
  ImageEmbodimentConsistency,
  ImageMode,
  ImageVisionReview,
  ImageVisionReviewRequest,
  ImageVisionReviewer,
} from '../../shared/contracts/image-vision-review.js';

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

export type FalImageModel = FalCreateModel | FalEditModel;
export type ImageAspectRatio = typeof IMAGE_ASPECT_RATIO_VALUES[number];

export function isLocalImageProvider(
  value: ImageProviderPreference | undefined,
): value is Extract<ImageProvider, 'comfyui' | 'comfyui_mcp'> {
  return value === 'comfyui' || value === 'comfyui_mcp';
}

export interface ImageRuntimeConfig {
  credentialVault?: CredentialVaultPort;
  /** models.json: `imageModels` names the OpenRouter image models (s5b89). */
  modelRegistry?: Pick<CanonicalModelRegistry, 'imageModels'>;
  /** providers.json: owns the image provider endpoint and credential reference. */
  providerRegistry?: CanonicalProviderRegistry;
  falApiKey?: string;
  comfyUiBaseUrl?: string;
  imageProvider?: ImageProvider;
  imageFalCreateModel?: FalCreateModel;
  imageFalEditModel?: FalEditModel;
  imageSelfieEditModel?: FalEditModel;
  imageWorkflows?: ImageWorkflowSettings;
  webFetchAllowHttp?: boolean;
  webFetchDomainAllowlist?: string[];
  webFetchAllowInternalNetwork?: boolean;
  webFetchDnsResolver?: DnsResolver;
  /** Overall wait cap (ms) for FAL queue results (owner-file backed, zet.7). */
  imageFalTimeoutMs?: number;
  /** Poll cadence (ms) for FAL queue status (owner-file backed, zet.7). */
  imageFalPollIntervalMs?: number;
  /** Overall wait cap (ms) for ComfyUI workflow completion (owner-file backed, zet.7). */
  imageComfyTimeoutMs?: number;
  /** Poll cadence (ms) for ComfyUI workflow history (owner-file backed, zet.7). */
  imageComfyPollIntervalMs?: number;
}

export interface ImageOperationSettingsDefaults {
  provider?: ImageProvider;
  createModel?: FalCreateModel;
  editModel?: FalEditModel;
  selfieEditModel?: FalEditModel;
}

export interface ImageCreateSettingsDefaults {
  provider?: ImageProvider;
  model?: FalCreateModel;
}

export interface ImageEditSettingsDefaults {
  provider?: ImageProvider;
  model?: FalEditModel;
}

export interface ImageCreateParams {
  prompt: string;
  provider?: ImageProviderPreference;
  model?: FalCreateModel;
  /** Per-companion settings selection carried across the agent→gateway boundary. */
  settingsDefaults?: ImageCreateSettingsDefaults;
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
  /** Per-companion settings selection carried across the agent→gateway boundary. */
  settingsDefaults?: ImageEditSettingsDefaults;
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

const EMBODIMENT_FRAMING: Record<EmbodimentConsistencyVerdict, string> = {
  same_me: 'This still reads as me.',
  drifted: 'Something about this drifted from how I usually look.',
  different_person: 'This does not look like me.',
};

export function describeEmbodimentVerdict(verdict: EmbodimentConsistencyVerdict): string {
  return EMBODIMENT_FRAMING[verdict];
}
