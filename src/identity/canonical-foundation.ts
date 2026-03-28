import type { PromptLayer } from './prompt-types.js';

export const CANONICAL_CHARACTER_FOUNDATION_NAME = 'Character Foundation';
export const CANONICAL_CHARACTER_FOUNDATION_IDENTIFIER = 'main';
export const CARD_BACKED_FOUNDATION_PROMPT_MESSAGE =
  'Character Foundation is managed through Prompt Soil → Character Foundation, not generic prompt-layer edits.';

export function isCanonicalCharacterFoundationLayer(
  layer: Pick<PromptLayer, 'type' | 'name' | 'identifier'> | null | undefined,
): boolean {
  return !!layer
    && layer.type === 'base'
    && layer.name === CANONICAL_CHARACTER_FOUNDATION_NAME
    && layer.identifier === CANONICAL_CHARACTER_FOUNDATION_IDENTIFIER;
}
