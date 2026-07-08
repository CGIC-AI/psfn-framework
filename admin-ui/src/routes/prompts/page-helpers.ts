import type {
  NorthStarItem,
  PromptLayer,
  PromptRuntimeBlock,
  PromptRuntimeLayerCoverageEntry,
  PromptRuntimeMacroHint,
} from '$lib/types';

export type PromptRuntimeMacroGroup = PromptRuntimeMacroHint['group'];
export type NorthStarDraftItem = Omit<NorthStarItem, 'id'> & { id?: string; clientKey: string };
export type DiffLine = { kind: 'same' | 'remove' | 'add'; line: string };

export interface PromptRuntimeMacroGroupMeta {
  label: string;
  rationale: string;
}

export interface GroupedRuntimeMacroHintSection extends PromptRuntimeMacroGroupMeta {
  group: PromptRuntimeMacroGroup;
  hints: PromptRuntimeMacroHint[];
}

export interface LayerBadgeMeta {
  bg: string;
  text: string;
  label: string;
}

export interface RoleBadgeMeta {
  label: string;
  cls: string;
}

export interface FixedStackEntry {
  id: 'constitution' | 'north-star';
  label: string;
  description: string;
  tokenCount: number;
  preview: string;
  status: string;
}

export type StackEntry =
  | { kind: 'fixed'; fixed: FixedStackEntry }
  | { kind: 'layer'; layer: PromptLayer; idx: number }
  | { kind: 'runtime'; block: PromptRuntimeBlock; idx: number };

export const MACRO_GROUP_META: Record<PromptRuntimeMacroGroup, PromptRuntimeMacroGroupMeta> = {
  global_aliases: {
    label: 'Core Aliases',
    rationale: 'Stable card-backed fields plus the shared clock and channel aliases.',
  },
  runtime_state: {
    label: 'Runtime State',
    rationale: 'Per-turn situational facts: time, speaker, channel, and capability tier.',
  },
  trust: {
    label: 'Trust Gates',
    rationale: 'Use these booleans to branch prose cleanly instead of hardcoding relationship text.',
  },
  response_style: {
    label: 'Response Style',
    rationale: 'Delivery and expansion signals for concise vs expressive turns.',
  },
  affect: {
    label: 'Affect',
    rationale: 'Atomic emotional signals. Write your own prose around them instead of pasting monolithic paragraphs.',
  },
  metacognition: {
    label: 'Metacognition',
    rationale: 'Flags, confidence, and evidence helpers for uncertainty, avoidance, repetition, and confabulation risk.',
  },
  internal_state: {
    label: 'Internal State',
    rationale: 'Cognitive, attentional, relational, and mood labels plus small prose helpers.',
  },
  attention: {
    label: 'Attention & Memory',
    rationale: 'Open threads, appraisal history, behavioral notes, and skills context.',
  },
  tooling: {
    label: 'Tooling & Self-Image',
    rationale: 'Tool counts, appearance context, self-image activation, and extended-tool directory macros.',
  },
};

export const LAYER_BADGE: Record<string, LayerBadgeMeta> = {
  base: { bg: 'bg-[#8B6914]', text: 'text-white', label: 'BASE' },
  operator: { bg: 'bg-[#4A7C59]', text: 'text-white', label: 'OPERATOR' },
  system_language: { bg: 'bg-[#6B6F33]', text: 'text-white', label: 'LANGUAGE' },
  runtime: { bg: 'bg-[#4A5C8B]', text: 'text-white', label: 'RUNTIME' },
  channel: { bg: 'bg-[#6C5B7B]', text: 'text-white', label: 'CHANNEL' },
  task: { bg: 'bg-[#C44569]', text: 'text-white', label: 'TASK' },
};

export const LAYER_TYPE_ORDER: Record<string, number> = {
  base: 0,
  operator: 1,
  system_language: 2,
  runtime: 3,
  channel: 4,
  task: 5,
};

export function comparePromptLayers(a: PromptLayer, b: PromptLayer): number {
  const typeOrder = (LAYER_TYPE_ORDER[a.type] ?? Number.MAX_SAFE_INTEGER)
    - (LAYER_TYPE_ORDER[b.type] ?? Number.MAX_SAFE_INTEGER);
  if (typeOrder !== 0) return typeOrder;
  return a.priority - b.priority;
}

export function groupRuntimeMacroHints(
  runtimeMacroHints: PromptRuntimeMacroHint[],
): GroupedRuntimeMacroHintSection[] {
  const groups = new Map<PromptRuntimeMacroGroup, PromptRuntimeMacroHint[]>();
  for (const hint of runtimeMacroHints) {
    const existing = groups.get(hint.group) ?? [];
    existing.push(hint);
    groups.set(hint.group, existing);
  }
  return (Object.entries(MACRO_GROUP_META) as Array<[PromptRuntimeMacroGroup, PromptRuntimeMacroGroupMeta]>)
    .map(([group, meta]) => ({
      group,
      label: meta.label,
      rationale: meta.rationale,
      hints: groups.get(group) ?? [],
    }))
    .filter(section => section.hints.length > 0);
}

export function compareRuntimeBlocks(a: PromptRuntimeBlock, b: PromptRuntimeBlock): number {
  if (a.effectiveOrder !== b.effectiveOrder) {
    return a.effectiveOrder - b.effectiveOrder;
  }
  return a.label.localeCompare(b.label);
}

export function buildNorthStarPreview(
  items: Array<Pick<NorthStarDraftItem, 'title' | 'content' | 'scope' | 'enabled'>>,
): string {
  const enabledItems = items.filter(item => item.enabled);
  if (enabledItems.length === 0) return '';
  return [
    '[North Star]',
    'Keep these long-term goals in view across planning, maintenance, and independent action.',
    '',
    ...enabledItems.flatMap((item, index) => {
      const block = `${index + 1}. [${item.scope}] ${item.title}\n${item.content.trim()}`;
      return index === enabledItems.length - 1 ? [block] : [block, ''];
    }),
  ].join('\n');
}

export function buildStackEntries({
  constitutionPreviewText,
  constitutionImmutableBlockCount,
  northStarPreviewText,
  northStarActiveCount,
  northStarLimit,
  sortedLayers,
  orderedRuntimeBlocks,
}: {
  constitutionPreviewText: string;
  constitutionImmutableBlockCount: number;
  northStarPreviewText: string;
  northStarActiveCount: number;
  northStarLimit: number;
  sortedLayers: PromptLayer[];
  orderedRuntimeBlocks: PromptRuntimeBlock[];
}): StackEntry[] {
  const entries: StackEntry[] = [];

  entries.push({
    kind: 'fixed',
    fixed: {
      id: 'constitution',
      label: 'CONSTITUTION',
      description: 'Immutable human-care law. Mutable operator policy now lives in the composition stack.',
      tokenCount: estimateTokens(constitutionPreviewText),
      preview: constitutionPreviewText,
      status: `${constitutionImmutableBlockCount} immutable`,
    },
  });

  entries.push({
    kind: 'fixed',
    fixed: {
      id: 'north-star',
      label: 'NORTH STAR',
      description: 'Long-term goals layer. Fixed immediately after Constitution.',
      tokenCount: estimateTokens(northStarPreviewText),
      preview: northStarPreviewText || 'No enabled North Star goals.',
      status: `${northStarActiveCount}/${northStarLimit} active`,
    },
  });

  for (let i = 0; i < sortedLayers.length; i++) {
    const layer = sortedLayers[i];
    entries.push({ kind: 'layer', layer, idx: i });
  }

  for (let i = 0; i < orderedRuntimeBlocks.length; i++) {
    entries.push({ kind: 'runtime', block: orderedRuntimeBlocks[i], idx: i });
  }

  return entries;
}

export function runtimePlacementLabel(block: PromptRuntimeBlock): string {
  if (block.placement === 'system_prompt') return 'System Prompt';
  if (block.placement === 'context_messages') return 'Context Messages';
  return 'Tool Schemas';
}

export function runtimeVisibilityLabel(block: PromptRuntimeBlock): string {
  if (block.visibility === 'runtime_generated') return 'Runtime-generated';
  if (block.visibility === 'provider_managed') return 'Provider-managed';
  return 'Hidden';
}

export function runtimeBlockStatusLabel(block: PromptRuntimeBlock): string {
  if (!block.companionEditable) return block.contentVisible ? 'Built in' : 'Hidden';
  return block.customContent?.trim() ? 'Companion override active' : 'Using built-in guidance';
}

export function runtimeSchemaLabel(block: PromptRuntimeBlock): string {
  if (block.immutable) return 'Immutable';
  return block.required ? 'Required' : 'Optional';
}

export function runtimeSchemaBadge(block: PromptRuntimeBlock): string {
  if (block.immutable) return 'bg-bark-300 text-shadow-700';
  return block.required ? 'bg-wilt-100 text-wilt-700' : 'bg-moss-100 text-moss-700';
}

export function runtimeLayerStatusBadge(entry: PromptRuntimeLayerCoverageEntry): string {
  if (entry.status === 'valid') return 'bg-moss-100 text-moss-700';
  if (entry.status === 'missing') return 'bg-wilt-100 text-wilt-700';
  return 'bg-gold-100 text-gold-800';
}

export function runtimePlacementBadge(block: PromptRuntimeBlock): string {
  if (block.placement === 'system_prompt') return 'bg-[#4A5C8B] text-white';
  if (block.placement === 'context_messages') return 'bg-[#4A7C59] text-white';
  return 'bg-[#8B7355] text-white';
}

export function buildReorderedRuntimeBlockIds(
  orderedRuntimeBlocks: PromptRuntimeBlock[],
  sourceIdx: number,
  targetIdx: number,
): string[] | null {
  if (sourceIdx === targetIdx) return null;
  if (sourceIdx < 0 || sourceIdx >= orderedRuntimeBlocks.length) return null;
  if (targetIdx < 0 || targetIdx >= orderedRuntimeBlocks.length) return null;

  const movableBlocks = orderedRuntimeBlocks.filter(block => block.reorderable);
  const source = orderedRuntimeBlocks[sourceIdx];
  const target = orderedRuntimeBlocks[targetIdx];
  if (!source?.reorderable || !target?.reorderable) return null;

  const movableSourceIdx = movableBlocks.findIndex(block => block.id === source.id);
  const movableTargetIdx = movableBlocks.findIndex(block => block.id === target.id);
  if (movableSourceIdx < 0 || movableTargetIdx < 0) return null;

  const nextOrder = movableBlocks.map(block => block.id);
  const [movedId] = nextOrder.splice(movableSourceIdx, 1);
  if (!movedId) return null;
  nextOrder.splice(movableTargetIdx, 0, movedId);
  return nextOrder;
}

export function buildReorderedLayerIds(
  sortedLayers: PromptLayer[],
  sourceIdx: number,
  targetIdx: number,
): string[] | null {
  if (sourceIdx === targetIdx) return null;
  if (sourceIdx < 0 || sourceIdx >= sortedLayers.length) return null;
  if (targetIdx < 0 || targetIdx >= sortedLayers.length) return null;

  const nextOrder = sortedLayers.map(layer => layer.id);
  const [movedLayerId] = nextOrder.splice(sourceIdx, 1);
  if (!movedLayerId) return null;
  nextOrder.splice(targetIdx, 0, movedLayerId);
  return nextOrder;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function layerBadge(type: string): LayerBadgeMeta {
  return LAYER_BADGE[type] ?? { bg: 'bg-bark-400', text: 'text-white', label: type.toUpperCase() };
}

const ROLE_BADGE_CLASS_BY_ROLE: Record<string, string> = {
  system: 'bg-[#4A5C8B] text-white',
  user: 'bg-[#4A7C59] text-white',
  assistant: 'bg-[#6C5B7B] text-white',
};

export function roleBadge(role: string | undefined): RoleBadgeMeta | null {
  if (!role) return null;
  return { label: role, cls: ROLE_BADGE_CLASS_BY_ROLE[role] ?? 'bg-bark-400 text-white' };
}

export function isProtected(_layer: PromptLayer): boolean {
  return false;
}

export function isConstitutionOwnedLayer(_layer: PromptLayer): boolean {
  return false;
}

export function reorderNorthStarItems(
  items: NorthStarDraftItem[],
  index: number,
  direction: 'up' | 'down',
): NorthStarDraftItem[] {
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(index, 1);
  if (!item) return items;
  next.splice(target, 0, item);
  return next.map((entry, idx) => ({ ...entry, priority: idx }));
}

export function computeDiffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const max = Math.max(oldLines.length, newLines.length);
  const rows: DiffLine[] = [];
  for (let i = 0; i < max; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) {
      rows.push({ kind: 'same', line: oldLine ?? '' });
    } else {
      if (oldLine !== undefined) rows.push({ kind: 'remove', line: oldLine });
      if (newLine !== undefined) rows.push({ kind: 'add', line: newLine });
    }
  }
  return rows;
}
