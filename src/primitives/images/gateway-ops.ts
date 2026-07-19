import type { GatewayClient } from '../../boundary/gateway/client.js';
import type { ImageOperations } from './ops.js';
import type {
  ImageCreateParams,
  ImageEditParams,
  ImageGenerationResult,
  ImageOperationSettingsDefaults,
} from './types.js';

type ImageGatewayClient = Pick<GatewayClient, 'imageCreate' | 'imageEdit'>;

function buildRequestSettingsDefaults<TModel extends string>(
  provider: ImageOperationSettingsDefaults['provider'],
  model: TModel | undefined,
): { provider?: ImageOperationSettingsDefaults['provider']; model?: TModel } | undefined {
  if (provider === undefined && model === undefined) {
    return undefined;
  }
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

export class GatewayImageOps implements ImageOperations {
  constructor(
    private readonly gateway: ImageGatewayClient,
    private readonly settingsDefaultsResolver: () => ImageOperationSettingsDefaults = () => ({}),
  ) {}

  resolveSettingsDefaults(): ImageOperationSettingsDefaults {
    return this.settingsDefaultsResolver();
  }

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    let settingsDefaults = params.settingsDefaults;
    if (!settingsDefaults) {
      const resolved = this.resolveSettingsDefaults();
      settingsDefaults = buildRequestSettingsDefaults(
        resolved.provider,
        resolved.createModel,
      );
    }
    return await this.gateway.imageCreate({
      ...params,
      ...(settingsDefaults ? { settingsDefaults } : {}),
    });
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    let settingsDefaults = params.settingsDefaults;
    if (!settingsDefaults) {
      const resolved = this.resolveSettingsDefaults();
      settingsDefaults = buildRequestSettingsDefaults(
        resolved.provider,
        resolved.editModel,
      );
    }
    return await this.gateway.imageEdit({
      ...params,
      ...(settingsDefaults ? { settingsDefaults } : {}),
    });
  }
}
