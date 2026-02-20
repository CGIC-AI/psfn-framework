import { describe, it, expect } from 'vitest';
import { loadCharacterCard, composeSystemPrompt } from './loader.js';
import type { CharacterCardV2 } from './types.js';

const TEST_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'TestChar',
    description: 'A test character with {{char}} references.',
    personality: 'Friendly and helpful. {{char}} likes cats.',
    scenario: '{{user}} and {{char}} are chatting.',
    first_mes: 'Hello {{user}}!',
    mes_example: '{{user}}: Hi\n{{char}}: Hey there!',
    system_prompt: 'sytem prompt',
    post_history_instructions: 'post history',
    tags: ['test'],
    creator: 'test',
  },
};

describe('composeSystemPrompt', () => {
  it('composes prompt with character name', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).toContain('You are TestChar.');
  });

  it('replaces {{char}} tokens', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).toContain('TestChar likes cats');
    expect(prompt).not.toContain('{{char}}');
  });

  it('preserves {{user}} tokens by default for runtime interpolation', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).toContain('{{user}} and TestChar are chatting');
  });

  it('replaces {{user}} tokens', () => {
    const prompt = composeSystemPrompt(TEST_CARD, 'Alice');
    expect(prompt).toContain('Alice and TestChar are chatting');
    expect(prompt).not.toContain('{{user}}');
  });

  it('skips placeholder system_prompt and post_history', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).not.toContain('sytem prompt');
    expect(prompt).not.toContain('post history');
  });

  it('includes example dialogue', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).toContain('Example dialogue style:');
    expect(prompt).toContain('Hey there!');
  });
});

describe('loadCharacterCard', () => {
  it('loads the real character card', () => {
    const card = loadCharacterCard('/path/to/your/character.json');
    expect(card.data.name).toBe('Purrsephone');
    expect(card.spec).toBe('chara_card_v2');
  });

  it('throws on missing file', () => {
    expect(() => loadCharacterCard('/nonexistent/file.json')).toThrow();
  });
});
