import type { PromptLayerStatePort } from './prompt-state-port.js';

export const TEMPORAL_RULES_LAYER_IDENTIFIER = 'operator.temporal_rules';
export const TEMPORAL_RULES_LAYER_NAME = 'Temporal Grounding Rules';
export const TEMPORAL_RULES_LAYER_PRIORITY = 990;
export const TEMPORAL_RULES_LAYER_VERSION = 2;

export const TEMPORAL_RULES_LAYER_CONTENT = [
  `<temporal_rules version="${TEMPORAL_RULES_LAYER_VERSION}">`,
  '<rule>Treat runtime.current_datetime as the canonical source for the current date and time.</rule>',
  '<rule>Use attributed chat-format temporal system notes, including Temporal wake and Time-of-day refresher notes, as idle-gap context; they can help with continuity, but they should not change the current date or time.</rule>',
  '<rule>Use cross_channel_continuity as retrieved context from other channels; it can add background, but it should not change the current date or time.</rule>',
  '<rule>When words like now, today, tomorrow, yesterday, earlier, later, still, already, just, since, or ago matter, resolve them from runtime.current_datetime or explicit pinned temporal resolutions rather than memory alone.</rule>',
  '<rule>When making a temporal claim, ground it in runtime.current_datetime, attributed chat-format temporal system notes, cross_channel_continuity, or an explicit pinned temporal resolution.</rule>',
  '</temporal_rules>',
].join('\n');

function isSystemOwnedPromptLayer(updatedBy: string): boolean {
  return updatedBy === 'system' || updatedBy.startsWith('system:');
}

function referencesRetiredTemporalBlocks(content: string): boolean {
  return /\b(?:continuity_anchor|wake_orientation)\b/.test(content);
}

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
  };
  const needsName = existing.name !== TEMPORAL_RULES_LAYER_NAME;
  const needsContentRefresh = existing.content !== TEMPORAL_RULES_LAYER_CONTENT
    && (
      isSystemOwnedPromptLayer(existing.updatedBy)
      || referencesRetiredTemporalBlocks(existing.content)
    );
  if (!needsName && !needsContentRefresh && Object.keys(metadataPatch).length === 0) {
    return;
  }

  promptStore.update(existing.id, {
    ...(needsName ? { name: TEMPORAL_RULES_LAYER_NAME } : {}),
    ...(needsContentRefresh ? { content: TEMPORAL_RULES_LAYER_CONTENT } : {}),
    ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
  }, 'system:temporal-rules-seed', `Normalize temporal grounding rules prompt layer v${TEMPORAL_RULES_LAYER_VERSION}`);
}
