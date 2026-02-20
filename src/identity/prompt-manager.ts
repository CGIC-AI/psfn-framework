import type { PromptLayer } from './prompt-types.js';

export interface ManagedPromptEntry {
  identifier: string;
  content: string;
  sourceLayerId?: string;
  autoHealed?: boolean;
}

export interface PromptManagerComposeResult {
  text: string;
  prompts: ManagedPromptEntry[];
  autoHealedIdentifiers: string[];
}

export interface PromptManagerOptions {
  requiredOrder?: string[];
  fallbackByIdentifier?: Record<string, string>;
}

const DEFAULT_REQUIRED_ORDER = [
  'main',
  'charDescription',
  'charPersonality',
  'scenario',
  'dialogueExamples',
  'postHistoryInstructions',
] as const;

const DEFAULT_FALLBACK_BY_IDENTIFIER: Record<string, string> = {
  main: 'You are {{char}}.',
  charDescription: '',
  charPersonality: '',
  scenario: '',
  dialogueExamples: '',
  postHistoryInstructions: '',
};

const IDENTIFIER_ALIASES: Record<string, string> = {
  main_prompt: 'main',
  character_description: 'charDescription',
  description: 'charDescription',
  character_personality: 'charPersonality',
  personality: 'charPersonality',
  mes_example: 'dialogueExamples',
  chat_examples: 'dialogueExamples',
  post_history_instructions: 'postHistoryInstructions',
  post_history: 'postHistoryInstructions',
};

function normalizeIdentifier(raw?: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  const snake = lower
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_');
  return IDENTIFIER_ALIASES[snake] ?? trimmed;
}

interface WorkingEntry {
  identifier: string;
  content: string;
  sourceLayerId?: string;
  order: number;
  autoHealed?: boolean;
}

export class PromptManager {
  private readonly requiredOrder: string[];
  private readonly requiredSet: Set<string>;
  private readonly fallbackByIdentifier: Record<string, string>;

  constructor(options: PromptManagerOptions = {}) {
    this.requiredOrder = options.requiredOrder
      ? [...options.requiredOrder]
      : [...DEFAULT_REQUIRED_ORDER];
    this.requiredSet = new Set(this.requiredOrder);
    this.fallbackByIdentifier = {
      ...DEFAULT_FALLBACK_BY_IDENTIFIER,
      ...(options.fallbackByIdentifier ?? {}),
    };
  }

  compose(layers: PromptLayer[]): PromptManagerComposeResult {
    if (layers.length === 0) {
      return { text: '', prompts: [], autoHealedIdentifiers: [] };
    }

    const working: WorkingEntry[] = [];
    let hasExplicitIdentifier = false;
    let hasBaseLayer = false;
    let usedLegacyMain = false;

    for (let index = 0; index < layers.length; index++) {
      const layer = layers[index];
      const content = layer.content.trim();
      if (!content) continue;

      const identifier = normalizeIdentifier(layer.identifier);
      const explicitOrder = typeof layer.promptOrder === 'number'
        ? layer.promptOrder
        : undefined;
      const fallbackOrder = 1_000 + index;

      if (identifier) {
        hasExplicitIdentifier = true;
        working.push({
          identifier,
          content,
          sourceLayerId: layer.id,
          order: explicitOrder ?? this.resolveOrder(identifier, fallbackOrder),
        });
        continue;
      }

      if (layer.type === 'base' && !usedLegacyMain) {
        hasBaseLayer = true;
        usedLegacyMain = true;
        working.push({
          identifier: 'main',
          content,
          sourceLayerId: layer.id,
          order: explicitOrder ?? this.resolveOrder('main', fallbackOrder),
        });
        continue;
      }

      working.push({
        identifier: `layer:${layer.id}`,
        content,
        sourceLayerId: layer.id,
        order: explicitOrder ?? fallbackOrder,
      });
    }

    if (working.length === 0) {
      return { text: '', prompts: [], autoHealedIdentifiers: [] };
    }

    const shouldAutoHeal = hasExplicitIdentifier || hasBaseLayer;
    const byIdentifier = new Map<string, WorkingEntry>();
    const passthrough: WorkingEntry[] = [];

    for (const entry of working) {
      if (entry.identifier.startsWith('layer:')) {
        passthrough.push(entry);
        continue;
      }
      if (!byIdentifier.has(entry.identifier)) {
        byIdentifier.set(entry.identifier, entry);
      }
    }

    const autoHealedIdentifiers: string[] = [];
    if (shouldAutoHeal) {
      for (const identifier of this.requiredOrder) {
        if (byIdentifier.has(identifier)) continue;
        autoHealedIdentifiers.push(identifier);
        byIdentifier.set(identifier, {
          identifier,
          content: this.fallbackByIdentifier[identifier] ?? '',
          autoHealed: true,
          order: this.resolveOrder(identifier, Number.MAX_SAFE_INTEGER),
        });
      }
    }

    const orderedCore = [...byIdentifier.values()].sort((left, right) => left.order - right.order);
    const ordered = [...orderedCore, ...passthrough].sort((left, right) => left.order - right.order);
    const prompts = ordered
      .filter(entry => entry.content.trim().length > 0)
      .map(entry => ({
        identifier: entry.identifier,
        content: entry.content,
        sourceLayerId: entry.sourceLayerId,
        autoHealed: entry.autoHealed,
      }));

    return {
      text: prompts.map(prompt => prompt.content).join('\n\n'),
      prompts,
      autoHealedIdentifiers,
    };
  }

  private resolveOrder(identifier: string, fallbackOrder: number): number {
    const requiredIndex = this.requiredOrder.indexOf(identifier);
    if (requiredIndex !== -1) return requiredIndex;
    return fallbackOrder;
  }
}
