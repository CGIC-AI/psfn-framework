import { describe, expect, it } from 'vitest';
import { buildCharacterMacroMap } from './character-macro-map.js';
import type { CharacterCardV2 } from './types.js';

const TEST_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Companion',
    description: 'A grounded helper.',
    personality: 'Warm and practical.',
    scenario: '{{user}} and {{char}} are pairing on code.',
    first_mes: 'Hello {{user}}',
    mes_example: '{{user}}: hi\n{{char}}: hello',
    system_prompt: 'Use concise direct language.',
    post_history_instructions: 'Avoid restating context.',
    tags: ['assistant', 'engineering'],
    creator: 'system',
    creator_notes: 'starter card',
    alternate_greetings: ['hi', 'hello'],
    extensions: {
      visual_description: 'cat ears and tail',
      hexaco: {
        emotional_expression: {
          intensity: 0.3,
        },
      },
      moderation_enabled: true,
    },
  },
};

describe('buildCharacterMacroMap', () => {
  it('builds canonical card macros with aliases', () => {
    const variables = buildCharacterMacroMap(TEST_CARD);

    expect(variables.name).toBe('Companion');
    expect(variables.char).toBe('Companion');
    expect(variables.character).toBe('Companion');
    expect(variables['character.name']).toBe('Companion');
    expect(variables.description).toBe('A grounded helper.');
    expect(variables['character.description']).toBe('A grounded helper.');
    expect(variables.mes_example).toContain('Example dialogue style:');
    expect(variables['character.mes_example']).toContain('{{char}}: hello');
  });

  it('flattens extension macros into canonical extension keys', () => {
    const variables = buildCharacterMacroMap(TEST_CARD);

    expect(variables.extensions_visual_description).toBe('cat ears and tail');
    expect(variables['character.extensions.visual_description']).toBe('cat ears and tail');
    expect(variables.extensions_hexaco_emotional_expression_intensity).toBe('0.3');
    expect(variables['character.extensions.hexaco.emotional_expression.intensity']).toBe('0.3');
    expect(variables.extensions_moderation_enabled).toBe('true');
  });

  it('normalizes missing and placeholder fields into canonical empty macro values', () => {
    const minimalCard: CharacterCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Companion',
        description: '',
        personality: 'Helpful and calm.',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: 'sytem prompt',
        post_history_instructions: 'post history instructions',
        tags: [],
        creator: 'system',
      },
    };

    const variables = buildCharacterMacroMap(minimalCard);

    expect(variables.char).toBe('Companion');
    expect(variables.system_prompt).toBe('');
    expect(variables.post_history_instructions).toBe('');
    expect(variables.mes_example).toBe('');
    expect(variables.creator_notes).toBe('');
    expect(variables.alternate_greetings).toBe('');
    expect(variables.visual_description).toBe('');
    expect(variables['character.creator_notes']).toBe('');
    expect(variables['character.alternate_greetings']).toBe('');
    expect(variables['character.visual_description']).toBe('');
  });
});
