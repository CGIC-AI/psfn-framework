import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SubstrateConfig } from '../../../types.js';
import { CharacterCardVersionStore } from '../../../identity/card-versioning.js';
import { PromptLayerStore } from '../../../identity/prompt-store.js';
import { loadCharacterCard } from '../../../identity/loader.js';
import { AdminIdentityDataService } from './identity-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-identity-service-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminIdentityDataService', () => {
  function writeCard(root: string, overrides: Partial<Record<string, unknown>> = {}): string {
    const characterCardPath = join(root, 'character.json');
    writeFileSync(characterCardPath, JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Companion',
        description: '',
        personality: 'Steady and warm.',
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: '',
        post_history_instructions: '',
        tags: ['bootstrap'],
        creator: 'system',
        ...overrides,
      },
    }), 'utf-8');
    return characterCardPath;
  }

  it('syncs Character Foundation prompt after identity field updates', () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are Companion.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = service.updateIdentityField(JSON.stringify({
      field: 'name',
      value: 'Companion Prime',
    }));

    expect(result.ok).toBe(true);
    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toContain('You are {{char}}.');
    expect(foundation.content).toContain('{{description}}');
    expect(foundation.content).toContain('{{personality}}');
    expect(foundation.content).not.toContain('Companion Prime');
    expect(foundation.updatedBy).toBe('admin:api');
  });

  it('fails closed when editing required identity fields to empty/placeholder values', () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const emptyName = service.updateIdentityField(JSON.stringify({
      field: 'name',
      value: '',
    }));
    expect(emptyName.ok).toBe(false);
    expect(emptyName.message).toContain('required identity field');

    const placeholderName = service.updateIdentityField(JSON.stringify({
      field: 'name',
      value: 'system prompt',
    }));
    expect(placeholderName.ok).toBe(false);
    expect(placeholderName.message).toContain('required identity field');
  });

  it('syncs Character Foundation prompt after card data import', async () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('Legacy rendered foundation text.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = await service.importIdentityCard(JSON.stringify({
      cardData: {
        data: {
          name: 'Imported Companion',
          description: 'Imported description',
          personality: 'Imported personality',
          scenario: '',
          first_mes: '',
          mes_example: '',
          system_prompt: '',
          post_history_instructions: '',
          tags: ['imported'],
          creator: 'import',
        },
      },
    }));

    expect(result.ok).toBe(true);
    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toContain('You are {{char}}.');
    expect(foundation.content).toContain('{{description}}');
    expect(foundation.content).toContain('{{personality}}');
    expect(foundation.content).not.toContain('Imported Companion');
    expect(foundation.updatedBy).toBe('admin:upload');
  });

  it('clears bootstrap onboarding marker when importing card payload data', async () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = await service.importIdentityCard(JSON.stringify({
      cardData: {
        data: {
          name: 'Imported Starter',
          description: 'Imported starter profile',
          personality: 'Ready for setup',
          scenario: '',
          first_mes: '',
          mes_example: '',
          system_prompt: '',
          post_history_instructions: '',
          tags: ['bootstrap'],
          creator: 'system',
        },
      },
    }));

    expect(result.ok).toBe(true);
    expect(service.getIdentityData().card.data.tags).not.toContain('bootstrap');
  });

  it('surfaces Character Foundation sync warnings on rollback', () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('Legacy rendered foundation text.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const badUpdate = service.updateIdentityField(JSON.stringify({
      field: 'description',
      value: 'Contains unsupported token {{mystery_macro}}',
    }));
    expect(badUpdate.ok).toBe(true);
    expect(badUpdate.message).toContain('Character Foundation sync warning');

    const safeUpdate = service.updateIdentityField(JSON.stringify({
      field: 'description',
      value: 'Safe description',
    }));
    expect(safeUpdate.ok).toBe(true);

    const rollback = service.rollbackIdentityCard(JSON.stringify({ version: 2 }));
    expect(rollback.ok).toBe(true);
    expect(rollback.message).toContain('Rolled back to version 2');
    expect(rollback.message).toContain('Character Foundation sync warning');
  });

  it('fails closed on rollback when target version has missing required identity fields', () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    cardVersionStore.updateData({ personality: 'Still valid.' }, 'test', 'safe');
    const invalidSnapshot = cardVersionStore.updateData({ name: 'system prompt' }, 'test', 'invalid');

    const rollback = service.rollbackIdentityCard(JSON.stringify({ version: invalidSnapshot.version - 1 }));
    expect(rollback.ok).toBe(false);
    expect(rollback.message).toContain('Rollback blocked');
  });

  it('completes onboarding when keeping starter identity', async () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = await service.applyOnboardingAction(JSON.stringify({
      action: 'keep_starter',
    }));

    expect(result.ok).toBe(true);
    expect(result.action).toBe('keep_starter');
    expect(result.onboardingRequired).toBe(false);
    expect(service.getIdentityData().card.data.tags).not.toContain('bootstrap');
  });

  it('completes onboarding when editing identity fields from chat setup', async () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = await service.applyOnboardingAction(JSON.stringify({
      action: 'edit_identity',
      fields: {
        name: 'Canopy Guide',
        personality: 'Grounded, curious, and kind.',
      },
    }));

    expect(result.ok).toBe(true);
    expect(result.action).toBe('edit_identity');
    expect(result.updatedFields).toEqual(expect.arrayContaining(['name', 'personality']));
    expect(result.onboardingRequired).toBe(false);

    const identity = service.getIdentityData().card.data;
    expect(identity.name).toBe('Canopy Guide');
    expect(identity.personality).toBe('Grounded, curious, and kind.');
    expect(identity.tags).not.toContain('bootstrap');
  });

  it('fails closed for onboarding edits that include unsupported fields', async () => {
    const root = makeTempDir();
    const characterCardPath = writeCard(root);

    const cardVersionStore = new CharacterCardVersionStore(
      characterCardPath,
      join(root, 'character-card-history.jsonl'),
    );
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('You are {{char}}.');

    const service = new AdminIdentityDataService({
      characterCard: loadCharacterCard(characterCardPath),
      config: {} as SubstrateConfig,
      cardVersionStore,
      promptStore,
    });

    const result = await service.applyOnboardingAction(JSON.stringify({
      action: 'edit_identity',
      fields: {
        tags: 'bootstrap',
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unsupported onboarding identity field');
    expect(result.onboardingRequired).toBe(true);
    expect(service.getIdentityData().card.data.tags).toContain('bootstrap');
  });
});
