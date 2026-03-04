// ── Prompt Composer ──
// Composes a system prompt by layering enabled prompt layers
// in precedence order: base -> operator -> runtime -> channel -> task.
// Includes context-aware filtering (channelType, taskKind).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { createComponentLogger } from '../logger.js';
import { writeJsonAtomic } from '../utils/fs.js';

const STATIC_PREFIX_LAYER_TYPES = new Set<LayerType>(['base', 'operator', 'channel']);
const LAST_KNOWN_GOOD_FILENAME = 'last-known-good.json';
const LAST_KNOWN_GOOD_VERSION = 1;
const log = createComponentLogger('PromptComposer');

interface PersistedLastKnownGood {
  version: number;
  savedAt: string;
  compose: ComposeSplitResult;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function isComposeSplitResult(value: unknown): value is ComposeSplitResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  if (typeof result.staticPrefix !== 'string') return false;
  if (typeof result.dynamicSuffix !== 'string') return false;
  if (typeof result.staticHash !== 'string') return false;
  if (typeof result.dynamicHash !== 'string') return false;
  if (typeof result.text !== 'string') return false;
  if (typeof result.hash !== 'string') return false;
  if (typeof result.layerCount !== 'number') return false;
  if (!isStringArray(result.layerIds)) return false;
  if (!isStringArray(result.staticLayerIds)) return false;
  if (!isStringArray(result.dynamicLayerIds)) return false;
  if (result.promptIdentifiers !== undefined && !isStringArray(result.promptIdentifiers)) return false;
  if (result.autoHealedPromptIdentifiers !== undefined && !isStringArray(result.autoHealedPromptIdentifiers)) return false;
  return true;
}

function isPersistedLastKnownGood(value: unknown): value is PersistedLastKnownGood {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.version !== LAST_KNOWN_GOOD_VERSION) return false;
  if (typeof record.savedAt !== 'string') return false;
  if (!isComposeSplitResult(record.compose)) return false;
  return true;
}

function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function composeSplitResultsEqual(left: ComposeSplitResult, right: ComposeSplitResult): boolean {
  if (left.text !== right.text) return false;
  if (left.hash !== right.hash) return false;
  if (left.staticPrefix !== right.staticPrefix) return false;
  if (left.dynamicSuffix !== right.dynamicSuffix) return false;
  if (left.staticHash !== right.staticHash) return false;
  if (left.dynamicHash !== right.dynamicHash) return false;
  if (left.layerCount !== right.layerCount) return false;
  if (!areStringArraysEqual(left.layerIds, right.layerIds)) return false;
  if (!areStringArraysEqual(left.staticLayerIds, right.staticLayerIds)) return false;
  if (!areStringArraysEqual(left.dynamicLayerIds, right.dynamicLayerIds)) return false;
  if (!areStringArraysEqual(left.promptIdentifiers, right.promptIdentifiers)) return false;
  if (!areStringArraysEqual(left.autoHealedPromptIdentifiers, right.autoHealedPromptIdentifiers)) return false;
  return true;
}

export class PromptComposer {
  private store: PromptLayerStore;
  private manager: PromptManager;
  private lastKnownGood: ComposeSplitResult | null = null;
  private lastKnownGoodPath: string;

  constructor(
    store: PromptLayerStore,
    manager: PromptManager = new PromptManager(),
    lastKnownGoodPath?: string,
  ) {
    this.store = store;
    this.manager = manager;
    this.lastKnownGoodPath = lastKnownGoodPath ?? join(dirname(this.store.layerFilePath), LAST_KNOWN_GOOD_FILENAME);
    this.lastKnownGood = this.loadPersistedLastKnownGood();
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
      const shouldPersist = !this.lastKnownGood || !composeSplitResultsEqual(this.lastKnownGood, result);
      this.lastKnownGood = result;
      if (shouldPersist) {
        this.persistLastKnownGood(result);
      }
    }

    return result;
  }

  private loadPersistedLastKnownGood(): ComposeSplitResult | null {
    if (!existsSync(this.lastKnownGoodPath)) return null;
    try {
      const raw = readFileSync(this.lastKnownGoodPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isPersistedLastKnownGood(parsed)) {
        throw new Error('Invalid persisted last-known-good format');
      }
      return parsed.compose;
    } catch (error) {
      log.warn('Failed to load persisted last-known-good prompt', {
        path: this.lastKnownGoodPath,
        error: String(error),
      });
      return null;
    }
  }

  private persistLastKnownGood(result: ComposeSplitResult): void {
    const payload: PersistedLastKnownGood = {
      version: LAST_KNOWN_GOOD_VERSION,
      savedAt: new Date().toISOString(),
      compose: result,
    };
    try {
      writeJsonAtomic(this.lastKnownGoodPath, payload, { trailingNewline: true });
    } catch (error) {
      log.warn('Failed to persist last-known-good prompt', {
        path: this.lastKnownGoodPath,
        error: String(error),
      });
    }
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
