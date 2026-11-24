import type { CharacterCardV2 } from './types.js';

export interface ImportedCharacterCardInput {
  data: {
    name?: unknown;
    description?: unknown;
    personality?: unknown;
    scenario?: unknown;
    first_mes?: unknown;
    mes_example?: unknown;
    system_prompt?: unknown;
    post_history_instructions?: unknown;
    tags?: unknown;
    creator?: unknown;
    creator_notes?: unknown;
    character_book?: unknown;
  };
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function requireRuntimeFields(data: CharacterCardV2['data']): void {
  if (!data.name.trim()) {
    throw new Error('Imported card is missing required name');
  }
  if (!data.personality.trim()) {
    throw new Error('Imported card is missing required personality');
  }
}

export function normalizeImportedCard(card: ImportedCharacterCardInput): CharacterCardV2 {
  const runtimeCard: CharacterCardV2 = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: toText(card.data.name),
      description: toText(card.data.description),
      personality: toText(card.data.personality) || toText(card.data.description),
      scenario: toText(card.data.scenario),
      first_mes: toText(card.data.first_mes),
      mes_example: toText(card.data.mes_example),
      system_prompt: toText(card.data.system_prompt),
      post_history_instructions: toText(card.data.post_history_instructions),
      tags: toTextArray(card.data.tags),
      creator: toText(card.data.creator),
      ...(toText(card.data.creator_notes)
        ? { creator_notes: toText(card.data.creator_notes) }
        : {}),
    },
  };

  requireRuntimeFields(runtimeCard.data);
  return runtimeCard;
}
