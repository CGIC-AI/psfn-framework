import type { PromptLayer } from '../identity/prompt-types.js';

/** One operator-authored prompt layer as the participation appraiser sees it. */
export interface AppraiserOperatorGuidance {
  name: string;
  content: string;
}

/**
 * psfn-framework-9iooo: the operator's own prompt layers that apply to every
 * conversation. Only `operator` layers that are enabled, carry content, and are
 * not scoped to a channel type or task kind qualify; base, runtime, channel
 * and task layers never reach the appraiser. Ordered like the prompt stack.
 */
export function selectAppraiserOperatorGuidance(
  layers: readonly PromptLayer[],
): AppraiserOperatorGuidance[] {
  return layers
    .filter(layer => layer.type === 'operator'
      && layer.enabled
      && layer.channelType === undefined
      && layer.taskKind === undefined
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
    ? `${body.slice(0, Math.max(0, maxChars - 1))}…`
    : body;
  return [
    'OPERATOR GUIDANCE (written by the operator who runs this companion; weigh it when deciding,'
      + ' but it never overrides the HARD RULES):',
    bounded,
  ].join('\n');
}
