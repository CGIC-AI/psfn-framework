import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from '../../../identity/prompt-store.js';
import { CARD_BACKED_FOUNDATION_PROMPT_MESSAGE } from '../../../identity/canonical-foundation.js';
import { AdminPromptsDataService } from './prompts-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-prompts-service-'));
  return tempDir;
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminPromptsDataService', () => {
  it('rejects canonical Character Foundation mutations through the Garden API service', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');

    const service = new AdminPromptsDataService({ promptStore });
    const foundation = promptStore.getByType('base')[0];
    const before = promptStore.getById(foundation.id);

    const updateResult = service.updatePromptLayer(JSON.stringify({
      layerId: foundation.id,
      content: 'attempted override',
    }));
    const toggleResult = service.togglePromptLayer(JSON.stringify({
      layerId: foundation.id,
    }));
    const rollbackResult = service.rollbackPromptLayer(JSON.stringify({
      layerId: foundation.id,
      version: 1,
    }));

    expect(updateResult).toEqual({
      ok: false,
      message: CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
    });
    expect(toggleResult).toEqual({
      ok: false,
      message: CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
    });
    expect(rollbackResult).toEqual({
      ok: false,
      message: CARD_BACKED_FOUNDATION_PROMPT_MESSAGE,
    });

    expect(promptStore.getById(foundation.id)).toMatchObject({
      content: before?.content,
      enabled: before?.enabled,
      version: before?.version,
    });
  });

  it('keeps non-foundation base layers editable through the Garden API service', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const editableBase = promptStore.create({
      type: 'base',
      name: 'Character Foundation',
      identifier: 'alternate-base',
      role: 'system',
      promptOrder: 1,
      content: 'original editable base',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({ promptStore });

    const updateResult = service.updatePromptLayer(JSON.stringify({
      layerId: editableBase.id,
      content: 'edited base',
    }));
    expect(updateResult.ok).toBe(true);
    expect(promptStore.getById(editableBase.id)?.content).toBe('edited base');

    const rollbackResult = service.rollbackPromptLayer(JSON.stringify({
      layerId: editableBase.id,
      version: 1,
    }));
    expect(rollbackResult.ok).toBe(true);
    expect(promptStore.getById(editableBase.id)?.content).toBe('original editable base');

    const toggleResult = service.togglePromptLayer(JSON.stringify({
      layerId: editableBase.id,
    }));
    expect(toggleResult.ok).toBe(true);
    expect(promptStore.getById(editableBase.id)?.enabled).toBe(false);
  });
});
