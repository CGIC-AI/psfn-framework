import type { PromptLayer } from '../identity/prompt-types.js';
import { TEMPORAL_RULES_LAYER_IDENTIFIER } from '../identity/temporal-rules-layer.js';

/** One operator-authored prompt layer as the participation appraiser sees it. */
export interface AppraiserOperatorGuidance {
  name: string;
  content: string;
}

/**
 * System-seeded operator layers that ground the chat reply itself and say
 * nothing about whether to reply (psfn-framework-8huns): the temporal rules
 * layer came first in stack order and spent most of the guidance budget, so
 * the operator's own briefing was cut in every appraisal.
 */
const REPLY_GROUNDING_OPERATOR_LAYER_IDENTIFIERS: ReadonlySet<string> = new Set([
  TEMPORAL_RULES_LAYER_IDENTIFIER,
]);

function isSystemSeededLayer(layer: PromptLayer): boolean {
  return layer.updatedBy === 'system' || layer.updatedBy.startsWith('system:');
}

/**
 * psfn-framework-9iooo: the operator's own prompt layers that apply to every
 * conversation. Only `operator` layers that are enabled, carry content, and are
 * not scoped to a channel type or task kind qualify; base, runtime, channel
 * and task layers never reach the appraiser. Layers the runtime seeds and
 * maintains itself (never edited by the operator) and reply-grounding layers
 * are excluded (8huns): appraisal guidance is what the operator wrote.
 * Ordered like the prompt stack.
 */
export function selectAppraiserOperatorGuidance(
  layers: readonly PromptLayer[],
): AppraiserOperatorGuidance[] {
  return layers
    .filter(layer => layer.type === 'operator'
      && layer.enabled
      && layer.channelType === undefined
      && layer.taskKind === undefined
      && !isSystemSeededLayer(layer)
      && !(layer.identifier !== undefined && REPLY_GROUNDING_OPERATOR_LAYER_IDENTIFIERS.has(layer.identifier))
      && layer.content.trim().length > 0)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
    .map(layer => ({ name: layer.name, content: layer.content.trim() }));
}

/**
 * Render operator guidance as one bounded system-prompt section. Guidance
 * beyond `maxChars` is cut with an explicit marker, never silently.
 */
export function renderAppraiserOperatorGuidance(
  guidance: readonly AppraiserOperatorGuidance[],
  maxChars: number,
): string {
  if (guidance.length === 0) return '';
  const body = guidance.map(item => `[${item.name}]\n${item.content}`).join('\n\n');
  const bounded = body.length > maxChars
    ? `${body.slice(0, Math.max(0, maxChars))}\n[operator guidance truncated: ${body.length - maxChars} of ${body.length} characters not shown]`
    : body;
  return [
    'OPERATOR GUIDANCE (written by the operator who runs this companion; weigh it when deciding,'
      + ' but it never overrides the HARD RULES):',
    bounded,
  ].join('\n');
}
