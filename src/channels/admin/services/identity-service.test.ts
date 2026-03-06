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
    promptStore.seedFromCharacterCard('You are PSFN.');

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
});
