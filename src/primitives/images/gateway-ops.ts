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
    private readonly settingsDefaults: ImageOperationSettingsDefaults = {},
  ) {}

  async create(params: ImageCreateParams): Promise<ImageGenerationResult> {
    const settingsDefaults = buildRequestSettingsDefaults(
      this.settingsDefaults.provider,
      this.settingsDefaults.createModel,
    );
    return await this.gateway.imageCreate({
      ...params,
      ...(settingsDefaults ? { settingsDefaults } : {}),
    });
  }

  async edit(params: ImageEditParams): Promise<ImageGenerationResult> {
    const settingsDefaults = buildRequestSettingsDefaults(
      this.settingsDefaults.provider,
      this.settingsDefaults.editModel,
    );
    return await this.gateway.imageEdit({
      ...params,
      ...(settingsDefaults ? { settingsDefaults } : {}),
    });
  }
}
