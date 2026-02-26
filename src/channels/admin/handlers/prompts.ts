import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminPromptsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  promptsPage(): string {
    return this.legacy.promptsPage();
  }

  promptDetail(layerId: string): string | null {
    return this.legacy.promptDetail(layerId);
  }

  promptRegistryDetail(key: string): string | null {
    return this.legacy.promptRegistryDetail(key);
  }

  updatePromptLayer(body: string): string {
    return this.legacy.updatePromptLayer(body);
  }

  updatePromptRegistry(body: string): string {
    return this.legacy.updatePromptRegistry(body);
  }

  togglePromptLayer(body: string): string {
    return this.legacy.togglePromptLayer(body);
  }

  rollbackPromptLayer(body: string): string {
    return this.legacy.rollbackPromptLayer(body);
  }

  rollbackPromptRegistry(body: string): string {
    return this.legacy.rollbackPromptRegistry(body);
  }

  previewPromptLayerDiff(body: string): string {
    return this.legacy.previewPromptLayerDiff(body);
  }
}
