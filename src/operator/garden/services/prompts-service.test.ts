import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from '../../../core/identity/prompt-store.js';
import { IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER } from '../../../core/identity/prompt-composer.js';
import { composeDefaultFoundationTemplate } from '../../../core/identity/foundation-sections.js';
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
  it('allows human Character Foundation mutations through the Garden API service', () => {
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

    expect(updateResult.ok).toBe(true);
    expect(toggleResult.ok).toBe(true);
    expect(rollbackResult.ok).toBe(true);

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
    promptStore.create({
      type: 'operator',
      name: 'Operator Constitution Layer',
      content: 'operator constitution content',
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
    expect(nonNullSnapshot.mutableLayers).toHaveLength(0);
    expect(nonNullSnapshot.preview.text).toContain(IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER);
    expect(nonNullSnapshot.preview.text).not.toContain('operator constitution content');
    expect(nonNullSnapshot.preview.text).not.toContain('seeded foundation');
  });

  it('fails closed when immutable constitution layer edits are attempted', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const operatorLayer = promptStore.create({
      type: 'operator',
      name: 'Operator Constitution Layer',
      content: 'operator constitution content',
      updatedBy: 'admin',
    });

    const service = new AdminPromptsDataService({ promptStore });
    const beforeContent = promptStore.getById(operatorLayer.id)?.content;

    const result = service.saveConstitutionMutableLayers(JSON.stringify({
      mutableLayers: [
        { id: 'constitution:immutable:1', content: 'forbidden edit' },
        {
          id: operatorLayer.id,
          content: 'updated operator content',
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('read-only');
    expect(promptStore.getById(operatorLayer.id)?.content).toBe(beforeContent);
  });

  it('treats mutable constitution save as a no-op when constitution has no mutable layers', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard('seeded foundation');
    const service = new AdminPromptsDataService({ promptStore });
    const result = service.saveConstitutionMutableLayers(JSON.stringify({
      mutableLayers: [],
    }));

    expect(result.ok).toBe(true);
    expect(result.message).toContain('No mutable constitution layers');
    expect(result.snapshot?.mutableLayers).toEqual([]);
  });

  it('returns Character Foundation snapshot with prompt-soil sections', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard(composeDefaultFoundationTemplate());

    const service = new AdminPromptsDataService({ promptStore });
    const snapshot = service.getFoundationSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.sections.some(section => section.id === 'identity' && section.enabled)).toBe(true);
    expect(snapshot?.sections.some(section => section.id === 'mes_example' && !section.enabled)).toBe(true);
  });

  it('saves Character Foundation through the dedicated prompt-soil route', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    promptStore.seedFromCharacterCard(composeDefaultFoundationTemplate());

    const service = new AdminPromptsDataService({ promptStore });
    const snapshot = service.getFoundationSnapshot();
    expect(snapshot).not.toBeNull();

    const result = service.saveFoundationSections(JSON.stringify({
      sections: snapshot!.sections.map(section => (
        section.id === 'description'
          ? { ...section, enabled: false }
          : section.id === 'identity'
            ? { ...section, content: 'You are {{char}}, held together by prompt soil.' }
            : section
      )),
    }));

    expect(result.ok).toBe(true);
    const foundation = promptStore.getByType('base')[0];
    expect(foundation.content).toContain('<identity>');
    expect(foundation.content).toContain('held together by prompt soil');
    expect(foundation.content).not.toContain('<description>');
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
