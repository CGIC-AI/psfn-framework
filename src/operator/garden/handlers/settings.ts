import type { ModelDiscoveryBackend } from '../../../primitives/llm/discovery.js';

interface LegacySettingsContext {
  modelDiscovery?: ModelDiscoveryBackend | null;
}

export class AdminSettingsHandlers {
  constructor(private readonly legacy: LegacySettingsContext) {}

  private getModelDiscovery(): ModelDiscoveryBackend {
    if (!this.legacy.modelDiscovery) {
      throw new Error('Model discovery backend unavailable');
    }
    return this.legacy.modelDiscovery;
  }

  async modelListJson(): Promise<string> {
    const modelDiscovery = this.getModelDiscovery();
    const models = await modelDiscovery.getAvailableModels();
    return JSON.stringify(models);
  }

  async refreshModels(): Promise<string> {
    const modelDiscovery = this.getModelDiscovery();
    modelDiscovery.invalidateCache();
    const models = await modelDiscovery.getAvailableModels();
    return JSON.stringify(models);
  }
}
