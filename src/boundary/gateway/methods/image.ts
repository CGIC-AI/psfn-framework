import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationRpcResult,
} from '../protocol.js';
import { ImageService } from '../../../primitives/images/service.js';
import type { GatewayMethodRuntime, AuditedMethodDescriptor } from './types.js';
import { registerAuditedDescriptors } from './register.js';

function requireImageService(runtime: GatewayMethodRuntime): ImageService {
  if (!runtime.imageConfig) {
    throw new Error('Image provider config is not wired on the gateway');
  }
  return new ImageService(runtime.imageConfig);
}

const IMAGE_METHODS: ReadonlyArray<AuditedMethodDescriptor<any, ImageGenerationRpcResult>> = [
  {
    name: 'image.create',
    handler: async (params: ImageCreateParams, runtime: GatewayMethodRuntime) =>
      await requireImageService(runtime).create(params),
    summary: (params: ImageCreateParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      numImages: params.numImages ?? 1,
    }),
  },
  {
    name: 'image.edit',
    handler: async (params: ImageEditParams, runtime: GatewayMethodRuntime) =>
      await requireImageService(runtime).edit(params),
    summary: (params: ImageEditParams) => ({
      provider: params.provider ?? 'auto',
      model: params.model ?? 'default',
      promptChars: params.prompt.length,
      imageCount: params.imageUrls.length,
    }),
  },
];

export function registerImageMethods(runtime: GatewayMethodRuntime): void {
  registerAuditedDescriptors(runtime, IMAGE_METHODS);
}
