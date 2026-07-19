import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageOperationSettingsDefaults,
} from './types.js';

export interface ImageOperations {
  /** Resolve mutable per-companion selections immediately before each tool call. */
  resolveSettingsDefaults?(): ImageOperationSettingsDefaults;
  create(params: ImageCreateParams): Promise<ImageGenerationResult>;
  edit(params: ImageEditParams): Promise<ImageGenerationResult>;
}
