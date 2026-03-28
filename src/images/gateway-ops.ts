import type { GatewayClient } from '../boundary/gateway/client.js';
import type { ImageOperations } from './ops.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
} from './types.js';

export class GatewayImageOps implements ImageOperations {
  constructor(private readonly gateway: GatewayClient) {}

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    return await this.gateway.imageCreate(params);
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    return await this.gateway.imageEdit(params);
  }
}
