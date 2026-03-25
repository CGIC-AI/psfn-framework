import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from '../../../identity/prompt-store.js';
import { IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER } from '../../../identity/prompt-composer.js';
import { CARD_BACKED_FOUNDATION_PROMPT_MESSAGE } from '../../../identity/canonical-foundation.js';
import { NorthStarStore } from '../../../north-star/store.js';
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

  it('returns constitution snapshot with immutable and mutable boundaries plus preview output', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const runtimeLayer = promptStore.create({
      type: 'runtime',
      name: 'Runtime Constitution Layer',
      content: 'runtime constitution content',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({
      promptStore,
      companionValuesLayerProvider: () => ({
        content: 'Companion values snapshot line',
        provenanceRefs: ['values:1'],
        historyVersions: [1],
        entryIds: ['values-1'],
      }),
    });

    const snapshot = service.getConstitutionSnapshot();
    expect(snapshot).not.toBeNull();
    const nonNullSnapshot = snapshot!;
    expect(nonNullSnapshot.immutableBlocks).toHaveLength(3);
    expect(nonNullSnapshot.immutableBlocks.map(block => block.editable)).toEqual([false, false, false]);
    expect(nonNullSnapshot.companionLayer?.editable).toBe(false);
    expect(nonNullSnapshot.mutableLayers.some(layer => layer.id === runtimeLayer.id && layer.editable)).toBe(true);
    expect(nonNullSnapshot.mutableLayers.some(layer => layer.type === 'base' && !layer.editable)).toBe(true);
    expect(nonNullSnapshot.preview.text).toContain(IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER);
    expect(nonNullSnapshot.preview.text).toContain('runtime constitution content');
  });

  it('fails closed when immutable constitution layer edits are attempted', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const runtimeLayer = promptStore.create({
      type: 'runtime',
      name: 'Runtime Constitution Layer',
      content: 'runtime constitution content',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({ promptStore });
    const beforeContent = promptStore.getById(runtimeLayer.id)?.content;

    const result = service.saveConstitutionMutableLayers(JSON.stringify({
      mutableLayers: [
        { id: 'constitution:immutable:1', content: 'forbidden edit' },
        {
          id: runtimeLayer.id,
          content: 'updated runtime content',
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('read-only');
    expect(promptStore.getById(runtimeLayer.id)?.content).toBe(beforeContent);
  });

  it('round-trips mutable constitution layer save with order and content updates', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const runtimeA = promptStore.create({
      type: 'runtime',
      name: 'Runtime A',
      content: 'runtime-a',
      updatedBy: 'admin',
    });
    const runtimeB = promptStore.create({
      type: 'runtime',
      name: 'Runtime B',
      content: 'runtime-b',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({ promptStore });
    const snapshot = service.getConstitutionSnapshot();
    expect(snapshot).not.toBeNull();
    const payload = (snapshot?.mutableLayers ?? []).map(layer => ({
      id: layer.id,
      content: layer.content,
      enabled: layer.enabled,
      identifier: layer.identifier ?? null,
      role: layer.role ?? null,
      promptOrder: layer.promptOrder ?? null,
    }));
    const aIndex = payload.findIndex(layer => layer.id === runtimeA.id);
    const bIndex = payload.findIndex(layer => layer.id === runtimeB.id);
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThanOrEqual(0);
    if (aIndex >= 0 && bIndex >= 0) {
      const [moved] = payload.splice(bIndex, 1);
      payload.splice(aIndex, 0, moved);
      const runtimeBPayload = payload.find(layer => layer.id === runtimeB.id);
      if (runtimeBPayload) runtimeBPayload.content = 'runtime-b-updated';
    }

    const result = service.saveConstitutionMutableLayers(JSON.stringify({
      mutableLayers: payload,
    }));

    expect(result.ok).toBe(true);
    expect(promptStore.getById(runtimeB.id)?.content).toBe('runtime-b-updated');
    expect(result.snapshot?.preview.text).toContain('runtime-b-updated');
    const expectedOrder = payload.map(layer => layer.id);
    for (const [index, layerId] of expectedOrder.entries()) {
      expect(promptStore.getById(layerId)?.priority).toBe(index);
    }
  });

  it('returns a North Star snapshot and saves bounded ordered items', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const northStarStore = new NorthStarStore(join(root, 'north-star.json'));
    northStarStore.create({
      title: 'Shared stewardship',
      content: 'Protect the relationship and the human over the long run.',
      scope: 'shared',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({ promptStore, northStarStore });
    const snapshot = service.getNorthStarSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.preview.text).toContain('[North Star]');
    expect(snapshot?.limit).toBe(3);

    const result = service.saveNorthStarItems(JSON.stringify({
      items: [
        {
          id: snapshot?.items[0]?.id,
          title: 'Shared stewardship',
          content: 'Protect the relationship and the human over the long run.',
          scope: 'shared',
          enabled: true,
        },
        {
          title: 'Companion work',
          content: 'Advance companion-owned projects between conversations.',
          scope: 'companion',
          enabled: true,
        },
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.snapshot?.items).toHaveLength(2);
    expect(result.snapshot?.items[0]?.title).toBe('Shared stewardship');
    expect(result.snapshot?.items[1]?.title).toBe('Companion work');
    expect(result.snapshot?.preview.text).toContain('Companion work');
  });

  it('fails closed when North Star save exceeds the three-item cap', () => {
    const root = makeTempDir();
    const northStarStore = new NorthStarStore(join(root, 'north-star.json'));
    const service = new AdminPromptsDataService({ northStarStore });

    const result = service.saveNorthStarItems(JSON.stringify({
      items: [
        { title: 'Goal 1', content: 'One', scope: 'shared', enabled: true },
        { title: 'Goal 2', content: 'Two', scope: 'shared', enabled: true },
        { title: 'Goal 3', content: 'Three', scope: 'companion', enabled: true },
        { title: 'Goal 4', content: 'Four', scope: 'companion', enabled: true },
      ],
    }));

    expect(result).toEqual({
      ok: false,
      message: 'North Star is limited to 3 items',
    });
  });
});
