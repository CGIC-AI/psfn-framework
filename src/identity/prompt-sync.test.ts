import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSystemPromptTemplate } from './loader.js';
import { PromptLayerStore } from './prompt-store.js';
import { syncCharacterFoundationPromptFromCard } from './prompt-sync.js';
import type { CharacterCardV2 } from './types.js';

const TEST_CARD: CharacterCardV2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Synced Companion',
    description: 'A synced card description.',
    personality: 'Steady and concise.',
    scenario: '',
    first_mes: '',
    mes_example: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: ['test'],
    creator: 'test',
  },
};

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-prompt-sync-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('syncCharacterFoundationPromptFromCard', () => {
  it('rewrites foundation to macro template content instead of rendered identity text', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const previousContent = [
      'You are Synced Companion.',
      '',
      'A synced card description.',
      '',
      'Steady and concise.',
    ].join('\n');
    promptStore.seedFromCharacterCard(previousContent);

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      TEST_CARD,
      'admin:sync-test',
      'sync foundation for runtime macro resolution',
    );

    expect(result).toEqual({ ok: true, updated: true });
    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toBe(composeSystemPromptTemplate());
    expect(foundation.content).toContain('{{description}}');
    expect(foundation.content).not.toContain('Synced Companion');

    const history = promptStore.getLayerHistory(foundation.id);
    expect(history).toHaveLength(1);
    expect(history[0].reason).toBe('sync foundation for runtime macro resolution');
  });

  it('skips update when foundation is already macro template content', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard(composeSystemPromptTemplate());

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      TEST_CARD,
      'admin:sync-test',
    );

    expect(result).toEqual({ ok: true, updated: false });
    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toBe(composeSystemPromptTemplate());
    expect(promptStore.getLayerHistory(foundation.id)).toHaveLength(0);
  });

  it('fails closed when card-sourced macros introduce unsupported unresolved tokens', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('Legacy rendered foundation content');

    const badCard: CharacterCardV2 = {
      ...TEST_CARD,
      data: {
        ...TEST_CARD.data,
        description: 'Contains unsupported token {{mystery_macro}}',
      },
    };

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      badCard,
      'admin:sync-test',
    );

    expect(result.ok).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.error).toContain('mystery_macro');

    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toBe('Legacy rendered foundation content');
  });
});
