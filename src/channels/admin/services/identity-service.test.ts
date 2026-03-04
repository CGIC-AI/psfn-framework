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
  it('syncs Character Foundation prompt after identity field updates', () => {
    const root = makeTempDir();
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
      },
    }), 'utf-8');

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
    expect(foundation.content).toContain('You are Companion Prime.');
    expect(foundation.updatedBy).toBe('admin:api');
  });
});
