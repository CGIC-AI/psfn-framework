import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
} from './types.js';

export interface ImageOperations {
  create(params: ImageCreateParams): Promise<ImageGenerationResult>;
  edit(params: ImageEditParams): Promise<ImageGenerationResult>;
}
