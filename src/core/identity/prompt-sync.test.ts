import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeSystemPromptTemplate } from './loader.js';
import { PromptLayerStore } from './prompt-store.js';
import { syncCharacterFoundationPromptFromCard } from './prompt-sync.js';
import type { CharacterCardV2 } from './types.js';
import { FOUNDATION_SECTION_DEFINITIONS } from './foundation-sections.js';

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

function canonicalFoundationLayers(promptStore: PromptLayerStore) {
  return promptStore.getByType('base')
    .filter(layer => layer.name.startsWith('Character Foundation'))
    .sort((left, right) => (left.promptOrder ?? 0) - (right.promptOrder ?? 0));
}

function composedFoundationPrompt(promptStore: PromptLayerStore): string {
  return canonicalFoundationLayers(promptStore)
    .filter(layer => layer.enabled)
    .map(layer => layer.content)
    .join('\n\n');
}

describe('syncCharacterFoundationPromptFromCard', () => {
  it('rewrites foundation to macro template content instead of rendered identity text', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.create({
      type: 'base',
      name: 'Character Foundation',
      identifier: 'main',
      role: 'system',
      promptOrder: 0,
      content: 'You are Synced Companion.\n\nA synced card description.\n\nSteady and concise.',
      updatedBy: 'system',
    });

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      TEST_CARD,
      'admin:sync-test',
      'sync foundation for runtime macro resolution',
    );

    expect(result).toEqual({ ok: true, updated: true });
    const foundationLayers = canonicalFoundationLayers(promptStore);
    expect(foundationLayers).toHaveLength(FOUNDATION_SECTION_DEFINITIONS.length);
    const composed = composedFoundationPrompt(promptStore);
    const identityLayer = foundationLayers.find(layer => layer.identifier === 'main');
    const descriptionLayer = foundationLayers.find(layer => layer.identifier === 'charDescription');
    const personalityLayer = foundationLayers.find(layer => layer.identifier === 'charPersonality');
    const systemPromptLayer = foundationLayers.find(layer => layer.identifier === 'systemPrompt');
    expect(identityLayer?.content).toBe('<identity>\nYou are {{char}}.\n</identity>');
    expect(descriptionLayer?.content).toBe('<description>\n{{description}}\n</description>');
    expect(personalityLayer?.content).toBe('<personality>\n{{personality}}\n</personality>');
    expect(systemPromptLayer?.content).toContain('A synced card description.');
    expect(composed).toContain('{{description}}');
    expect(composed).toContain('<system_prompt>');
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
    expect(composedFoundationPrompt(promptStore)).toBe(composeSystemPromptTemplate());
    expect(promptStore.getHistory()).toHaveLength(0);
  });

  it('does not clobber admin-managed macro-backed foundation layouts', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard(composeSystemPromptTemplate());
    const foundation = canonicalFoundationLayers(promptStore)[0];
    promptStore.update(
      foundation.id,
      '<identity>\nYou are {{char}}, custom laid out.\n</identity>',
      'admin',
      undefined,
      'custom layout',
    );

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      TEST_CARD,
      'admin:sync-test',
    );

    expect(result).toEqual({ ok: true, updated: false });
    expect(canonicalFoundationLayers(promptStore)[0]?.content).toContain('custom laid out');
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

    const foundation = canonicalFoundationLayers(promptStore).find(layer => layer.identifier === 'systemPrompt');
    expect(foundation?.content).toBe('<system_prompt>\nLegacy rendered foundation content\n</system_prompt>');
  });

  it('fails closed when required identity fields are effectively empty after normalization', () => {
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
        name: 'system prompt',
      },
    };

    const result = syncCharacterFoundationPromptFromCard(
      promptStore,
      badCard,
      'admin:sync-test',
    );

    expect(result.ok).toBe(false);
    expect(result.updated).toBe(false);
    expect(result.errorCode).toBe('missing_required_fields');
    expect(result.error).toContain('name');

    const foundation = canonicalFoundationLayers(promptStore).find(layer => layer.identifier === 'systemPrompt');
    expect(foundation?.content).toBe('<system_prompt>\nLegacy rendered foundation content\n</system_prompt>');
  });
});
