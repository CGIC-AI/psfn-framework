import type { PromptLayerStatePort } from './prompt-state-port.js';

export const TEMPORAL_RULES_LAYER_IDENTIFIER = 'operator.temporal_rules';
export const TEMPORAL_RULES_LAYER_NAME = 'Temporal Grounding Rules';
export const TEMPORAL_RULES_LAYER_PRIORITY = 990;

export const TEMPORAL_RULES_LAYER_CONTENT = [
  '<temporal_rules>',
  '<rule>Treat runtime.current_datetime as the canonical source for the current date and time.</rule>',
  '<rule>Use continuity_anchor or wake_orientation as idle-gap context; it can help with continuity, but it should not change the current date or time.</rule>',
  '<rule>Use cross_channel_continuity as retrieved context from other channels; it can add background, but it should not change the current date or time.</rule>',
  '<rule>When words like now, today, tomorrow, yesterday, earlier, later, still, already, just, since, or ago matter, resolve them from runtime.current_datetime or explicit pinned temporal resolutions rather than memory alone.</rule>',
  '<rule>When making a temporal claim, ground it in runtime.current_datetime, continuity_anchor, wake_orientation, cross_channel_continuity, or an explicit pinned temporal resolution.</rule>',
  '</temporal_rules>',
].join('\n');

export function ensureTemporalRulesPromptLayer(promptStore: PromptLayerStatePort): void {
  const existing = promptStore.getAll().find(layer => (
    layer.type === 'operator'
    && (layer.identifier === TEMPORAL_RULES_LAYER_IDENTIFIER || layer.name === TEMPORAL_RULES_LAYER_NAME)
  ));

  if (!existing) {
    promptStore.create({
      type: 'operator',
      name: TEMPORAL_RULES_LAYER_NAME,
      identifier: TEMPORAL_RULES_LAYER_IDENTIFIER,
      role: 'system',
      promptOrder: TEMPORAL_RULES_LAYER_PRIORITY,
      priority: TEMPORAL_RULES_LAYER_PRIORITY,
      content: TEMPORAL_RULES_LAYER_CONTENT,
      updatedBy: 'system',
    });
    return;
  }

  const metadataPatch = {
    ...(existing.identifier !== TEMPORAL_RULES_LAYER_IDENTIFIER ? { identifier: TEMPORAL_RULES_LAYER_IDENTIFIER } : {}),
    ...(existing.role !== 'system' ? { role: 'system' as const } : {}),
    ...(existing.promptOrder !== TEMPORAL_RULES_LAYER_PRIORITY ? { promptOrder: TEMPORAL_RULES_LAYER_PRIORITY } : {}),
  };
  const needsPriority = existing.priority !== TEMPORAL_RULES_LAYER_PRIORITY;
  const needsName = existing.name !== TEMPORAL_RULES_LAYER_NAME;
  if (!needsPriority && !needsName && Object.keys(metadataPatch).length === 0) {
    return;
  }

  promptStore.update(existing.id, {
    ...(needsName ? { name: TEMPORAL_RULES_LAYER_NAME } : {}),
    ...(needsPriority ? { priority: TEMPORAL_RULES_LAYER_PRIORITY } : {}),
    ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
  }, 'system:temporal-rules-seed', 'Normalize temporal grounding rules prompt layer metadata');
}
