import type {
  AdminPromptDetailData,
  PromptUpdateResult,
} from './types.js';
import type { AdminPromptsServiceContext } from './prompts-service-context.js';

export class PromptsHistoryService {
  constructor(private readonly context: AdminPromptsServiceContext) {}

  getPromptDetail(layerId: string): AdminPromptDetailData | null {
    const layer = this.context.deps.promptStore.getById(layerId);
    if (!layer) return null;
    return {
      layer,
      layerHistory: this.context.deps.promptStore.getLayerHistory(layerId),
    };
  }

  getStaticPromptDetail(key: string): AdminPromptDetailData | null {
    const staticPrompt = this.context.getPromptRegistry().getByKey(key);
    if (!staticPrompt) return null;
    return {
      staticPrompt,
      staticPromptHistory: this.context.getPromptRegistry().getPromptHistory(key),
    };
  }

  rollbackPromptLayer(body: string): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);

    const existingLayer = this.context.deps.promptStore.getById(layerId);
    if (!existingLayer) {
      return { ok: false, message: `Prompt layer not found: ${layerId}` };
    }

    if (existingLayer.type === 'runtime') {
      const historyEntry = this.context.deps.promptStore.getLayerHistory(layerId)
        .find(entry => entry.version === version);
      if (!historyEntry) {
        return { ok: false, message: `No history entry for layer ${layerId} version ${version}` };
      }

      const validationMessage = this.context.buildRuntimePromptLayerValidationMessage(this.context.replacePromptLayerPreview({
        id: existingLayer.id,
        type: existingLayer.type,
        identifier: existingLayer.identifier,
        content: historyEntry.previousContent,
        enabled: existingLayer.enabled,
      }));
      if (validationMessage) {
        return { ok: false, message: validationMessage };
      }
    }

    try {
      const rolledBackLayer = this.context.deps.promptStore.rollback(layerId, version);
      this.context.injectPromptEditSystemNote(
        `Admin rolled back ${rolledBackLayer.type} prompt layer "${rolledBackLayer.name}" using v${version} content (now v${rolledBackLayer.version}).`,
      );
      return {
        ok: true,
        message: `Rolled back "${rolledBackLayer.name}" to content from v${version}`,
        layer: rolledBackLayer,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  rollbackPromptRegistry(body: string): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const key = params.get('key') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);

    try {
      const staticPrompt = this.context.getPromptRegistry().rollback(key, version);
      return {
        ok: true,
        message: `Rolled back "${staticPrompt.key}" to content from v${version}`,
        staticPrompt,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  previewPromptLayerDiff(body: string): { oldContent: string; newContent: string } | null {
    const params = this.context.parseBody(body);
    const layerId = params.get('layerId') ?? '';
    const layer = this.context.deps.promptStore.getById(layerId);
    if (!layer) return null;

    const layerHistory = this.context.deps.promptStore.getLayerHistory(layerId);
    if (layerHistory.length === 0) return null;

    const previousVersion = layer.version - 1;
    const previousEntry = layerHistory.find(entry => entry.version === previousVersion)
      ?? layerHistory[layerHistory.length - 1];

    return {
      oldContent: previousEntry.previousContent,
      newContent: layer.content,
    };
  }
}
