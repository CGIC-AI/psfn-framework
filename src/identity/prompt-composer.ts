// ── Prompt Composer ──
// Composes a system prompt by layering enabled prompt layers
// in precedence order: base -> operator -> runtime -> channel -> task.
// Includes context-aware filtering (channelType, taskKind).

import { createHash } from 'node:crypto';
import type { ComposeContext, ComposeResult } from './prompt-types.js';
import { LAYER_TYPE_ORDER } from './prompt-types.js';
import type { PromptLayerStore } from './prompt-store.js';
import { PromptManager } from './prompt-manager.js';

export class PromptComposer {
  private store: PromptLayerStore;
  private manager: PromptManager;
  private lastKnownGood: ComposeResult | null = null;

  constructor(store: PromptLayerStore, manager: PromptManager = new PromptManager()) {
    this.store = store;
    this.manager = manager;
  }

  compose(ctx?: ComposeContext): ComposeResult {
    const layers = this.store.getAll();

    // 1. Filter enabled layers
    const enabled = layers.filter(l => l.enabled);

    // 2. Filter by context
    const matching = enabled.filter(layer => {
      // Base, operator, runtime layers always included
      if (layer.type === 'base' || layer.type === 'operator' || layer.type === 'runtime') {
        return true;
      }
      // Channel layers: match channelType if specified
      if (layer.type === 'channel') {
        if (!layer.channelType || !ctx?.channelType) return false;
        return layer.channelType === ctx.channelType;
      }
      // Task layers: match taskKind if specified
      if (layer.type === 'task') {
        if (!layer.taskKind || !ctx?.taskKind) return false;
        return layer.taskKind === ctx.taskKind;
      }
      return false;
    });

    // 3. Sort: type precedence -> priority (ascending)
    const sorted = [...matching].sort((a, b) => {
      const typeOrder = LAYER_TYPE_ORDER[a.type] - LAYER_TYPE_ORDER[b.type];
      if (typeOrder !== 0) return typeOrder;
      return a.priority - b.priority;
    });

    // 4. Prompt-manager composition (required prompts, deterministic prompt ordering, auto-heal)
    const managed = this.manager.compose(sorted);
    const text = managed.text;

    // 5. Hash
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);

    const result: ComposeResult = {
      text,
      hash,
      layerCount: sorted.length,
      layerIds: sorted.map(l => l.id),
      promptIdentifiers: managed.prompts.map(prompt => prompt.identifier),
      autoHealedPromptIdentifiers: managed.autoHealedIdentifiers,
    };

    // 6. Fallback guard
    if (!text && this.lastKnownGood) {
      return this.lastKnownGood;
    }

    if (text) {
      this.lastKnownGood = result;
    }

    return result;
  }
}
