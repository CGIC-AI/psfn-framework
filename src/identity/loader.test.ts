import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import {
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
  it('creates a default card when the file is missing', () => {
    const root = makeTempDir();
    const path = join(root, 'nested', 'character.json');
    expect(existsSync(path)).toBe(false);

    const first = loadOrInitializeCharacterCard(path);
    expect(first.initialized).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(first.card.data.name).toBe('Purrsephone');
    expect(first.card.data.personality.length).toBeGreaterThan(0);

    const second = loadOrInitializeCharacterCard(path);
    expect(second.initialized).toBe(false);
    expect(second.card.data.name).toBe('Purrsephone');
  });
});
