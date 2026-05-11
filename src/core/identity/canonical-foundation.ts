import type { PromptLayer } from './prompt-types.js';
import { FOUNDATION_SECTION_DEFINITIONS } from './foundation-sections.js';

export const CANONICAL_CHARACTER_FOUNDATION_NAME = 'Character Foundation';
export const CANONICAL_CHARACTER_FOUNDATION_IDENTIFIER = 'main';
export const CARD_BACKED_FOUNDATION_PROMPT_MESSAGE =
  'Character Foundation is human-owned prompt soil. Agent-side edits are blocked.';

const CANONICAL_FOUNDATION_IDENTIFIERS = new Set<string>(
  FOUNDATION_SECTION_DEFINITIONS.map(section => section.identifier),
);
const CANONICAL_FOUNDATION_LAYER_NAMES = new Set<string>(
  FOUNDATION_SECTION_DEFINITIONS.map(section => section.layerName),
);

export function isCanonicalCharacterFoundationLayer(
  layer: Pick<PromptLayer, 'type' | 'name' | 'identifier'> | null | undefined,
): boolean {
  return !!layer
    && layer.type === 'base'
    && (
      (
        layer.name === CANONICAL_CHARACTER_FOUNDATION_NAME
        && layer.identifier === CANONICAL_CHARACTER_FOUNDATION_IDENTIFIER
      )
      || (layer.identifier != null && CANONICAL_FOUNDATION_IDENTIFIERS.has(layer.identifier))
      || CANONICAL_FOUNDATION_LAYER_NAMES.has(layer.name)
    );
}
