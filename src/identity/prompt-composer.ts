// ── Prompt Composer ──
// Composes a system prompt by layering enabled prompt layers
// in precedence order: base -> operator -> runtime -> channel -> task.
// Includes context-aware filtering (channelType, taskKind).

import { createHash } from 'node:crypto';
import type {
  ComposeContext,
  ComposeResult,
  ComposeSplitResult,
  LayerType,
  PromptLayer,
} from './prompt-types.js';
import { LAYER_TYPE_ORDER } from './prompt-types.js';
import type { PromptLayerStore } from './prompt-store.js';
import { PromptManager } from './prompt-manager.js';

const STATIC_PREFIX_LAYER_TYPES = new Set<LayerType>(['base', 'operator', 'channel']);

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class PromptComposer {
  private store: PromptLayerStore;
  private manager: PromptManager;
  private lastKnownGood: ComposeSplitResult | null = null;

  constructor(store: PromptLayerStore, manager: PromptManager = new PromptManager()) {
    this.store = store;
    this.manager = manager;
  }

  compose(ctx?: ComposeContext): ComposeResult {
    const split = this.composeSplit(ctx);
    return {
      text: split.text,
      hash: split.hash,
      layerCount: split.layerCount,
      layerIds: split.layerIds,
      promptIdentifiers: split.promptIdentifiers,
      autoHealedPromptIdentifiers: split.autoHealedPromptIdentifiers,
    };
  }

  composeSplit(ctx?: ComposeContext): ComposeSplitResult {
    const layers = this.store.getAll();
    const sorted = this.resolveSortedLayers(layers, ctx);

    // Prompt-manager composition (required prompts, deterministic prompt ordering, auto-heal)
    const managed = this.manager.compose(sorted);
    const layerById = new Map(sorted.map(layer => [layer.id, layer]));

    const staticChunks: string[] = [];
    const dynamicChunks: string[] = [];
    const staticLayerIds: string[] = [];
    const dynamicLayerIds: string[] = [];
    const seenStaticLayerIds = new Set<string>();
    const seenDynamicLayerIds = new Set<string>();

    for (const prompt of managed.prompts) {
      const sourceLayer = prompt.sourceLayerId ? layerById.get(prompt.sourceLayerId) : undefined;
      const target = this.resolvePromptSection(sourceLayer);
      if (target === 'static') {
        staticChunks.push(prompt.content);
        if (sourceLayer && !seenStaticLayerIds.has(sourceLayer.id)) {
          seenStaticLayerIds.add(sourceLayer.id);
          staticLayerIds.push(sourceLayer.id);
        }
        continue;
      }

      dynamicChunks.push(prompt.content);
      if (sourceLayer && !seenDynamicLayerIds.has(sourceLayer.id)) {
        seenDynamicLayerIds.add(sourceLayer.id);
        dynamicLayerIds.push(sourceLayer.id);
      }
    }

    const staticPrefix = staticChunks.join('\n\n');
    const dynamicSuffix = dynamicChunks.join('\n\n');
    const text = [staticPrefix, dynamicSuffix]
      .map(section => section.trim())
      .filter(section => section.length > 0)
      .join('\n\n');

    const hash = hashText(text);
    const staticHash = hashText(staticPrefix);
    const dynamicHash = hashText(dynamicSuffix);

    const result: ComposeSplitResult = {
      staticPrefix,
      dynamicSuffix,
      staticHash,
      dynamicHash,
      staticLayerIds,
      dynamicLayerIds,
      text,
      hash,
      layerCount: sorted.length,
      layerIds: sorted.map(l => l.id),
      promptIdentifiers: managed.prompts.map(prompt => prompt.identifier),
      autoHealedPromptIdentifiers: managed.autoHealedIdentifiers,
    };

    // Fallback guard
    if (!text && this.lastKnownGood) {
      return this.lastKnownGood;
    }

    if (text) {
      this.lastKnownGood = result;
    }

    return result;
  }

  private resolveSortedLayers(layers: PromptLayer[], ctx?: ComposeContext): PromptLayer[] {
    const enabled = layers.filter(layer => layer.enabled);
    const matching = enabled.filter(layer => this.matchesContext(layer, ctx));
    return [...matching].sort((a, b) => {
      const typeOrder = LAYER_TYPE_ORDER[a.type] - LAYER_TYPE_ORDER[b.type];
      if (typeOrder !== 0) return typeOrder;
      return a.priority - b.priority;
    });
  }

  private matchesContext(layer: PromptLayer, ctx?: ComposeContext): boolean {
    if (layer.type === 'base' || layer.type === 'operator' || layer.type === 'runtime') {
      return true;
    }

    if (layer.type === 'channel') {
      if (!layer.channelType || !ctx?.channelType) return false;
      return layer.channelType === ctx.channelType;
    }

    if (layer.type === 'task') {
      if (!layer.taskKind || !ctx?.taskKind) return false;
      return layer.taskKind === ctx.taskKind;
    }

    return false;
  }

  private resolvePromptSection(layer: PromptLayer | undefined): 'static' | 'dynamic' {
    if (!layer) return 'static';
    return STATIC_PREFIX_LAYER_TYPES.has(layer.type) ? 'static' : 'dynamic';
  }
}
