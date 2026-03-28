import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
  buildCharacterPromptTemplateVariables,
  composeSystemPromptTemplate,
  loadCharacterCard,
  loadOrInitializeCharacterCard,
  composeSystemPrompt,
} from './loader.js';
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
    extensions: {
      visual_description: 'cat ears and tail with human hands',
      hexaco: {
        emotional_expression: {
          intensity: 0.5,
        },
      },
    },
  },
};

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-loader-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

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

  it('resolves canonical aliases through runtime macro expansion', () => {
    const aliasCard: CharacterCardV2 = {
      ...TEST_CARD,
      data: {
        ...TEST_CARD.data,
        description: '{{character.name}} with {{char_name}} helping {{user_name}}.',
      },
    };

    const prompt = composeSystemPrompt(aliasCard, 'Alice');
    expect(prompt).toContain('TestChar with TestChar helping Alice.');
  });

  it('skips placeholder system_prompt and post_history', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).not.toContain('sytem prompt');
    expect(prompt).not.toContain('post history');
  });

  it('omits example dialogue from the persistent system prompt', () => {
    const prompt = composeSystemPrompt(TEST_CARD);
    expect(prompt).not.toContain('Example dialogue style:');
    expect(prompt).not.toContain('Hey there!');
    expect(prompt).toContain('<identity>');
  });
});

describe('composeSystemPromptTemplate', () => {
  it('returns a macro-backed template', () => {
    const template = composeSystemPromptTemplate();
    expect(template).toContain('You are {{char}}.');
    expect(template).toContain('{{description}}');
    expect(template).toContain('{{personality}}');
    expect(template).toContain('{{scenario}}');
    expect(template).toContain('{{system_prompt}}');
    expect(template).toContain('{{mes_example}}');
    expect(template).toContain('{{post_history_instructions}}');
  });
});

describe('buildCharacterPromptTemplateVariables', () => {
  it('maps character fields into runtime macro variables', () => {
    const variables = buildCharacterPromptTemplateVariables(TEST_CARD);
    expect(variables.description).toContain('A test character');
    expect(variables.personality).toContain('Friendly and helpful');
    expect(variables.mes_example).toContain('Example dialogue style');
    expect(variables['character.description']).toContain('A test character');
    expect(variables['character.personality']).toContain('Friendly and helpful');
    expect(variables.extensions_visual_description).toBe('cat ears and tail with human hands');
    expect(variables['character.extensions.hexaco.emotional_expression.intensity']).toBe('0.5');
  });
});

describe('loadCharacterCard', () => {
  it('loads a character card from disk', () => {
    const root = makeTempDir();
    const path = join(root, 'character.json');
    writeFileSync(path, `${JSON.stringify(TEST_CARD, null, 2)}\n`, 'utf-8');

    const card = loadCharacterCard(path);
    expect(card.data.name).toBe('TestChar');
    expect(card.spec).toBe('chara_card_v2');
  });

  it('throws on missing file', () => {
    expect(() => loadCharacterCard('/nonexistent/file.json')).toThrow();
  });
});

describe('loadOrInitializeCharacterCard', () => {
  it('loads a required card from disk without initializing a default', () => {
    const root = makeTempDir();
    const path = join(root, 'character.json');
    writeFileSync(path, `${JSON.stringify(TEST_CARD, null, 2)}\n`, 'utf-8');

    const card = loadOrInitializeCharacterCard(path);
    expect(card.data.name).toBe('TestChar');
    expect(card.spec).toBe('chara_card_v2');
  });

  it('throws a clear error when the character card is missing', () => {
    const root = makeTempDir();
    const path = join(root, 'nested', 'character.json');

    expect(() => loadOrInitializeCharacterCard(path)).toThrow(
      `Missing character card at ${path}: explicit companion identity is required before startup`,
    );
  });

  it('throws a clear error when the character card is invalid JSON', () => {
    const root = makeTempDir();
    const path = join(root, 'character.json');
    writeFileSync(path, '{not json', 'utf-8');

    expect(() => loadOrInitializeCharacterCard(path)).toThrow(`Invalid character card at ${path}:`);
  });
});
