import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PromptLayerStore } from '../../../core/identity/prompt-store.js';
import { IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER } from '../../../core/identity/prompt-composer.js';
import { composeDefaultFoundationTemplate } from '../../../core/identity/foundation-sections.js';
import { createPromptStatePort } from '../../../core/identity/prompt-state-port.js';
import { PromptRuntimeLayoutStore } from '../../../core/identity/prompt-runtime.js';
import { getRuntimePromptLayerDefinitions } from '../../../core/identity/runtime-prompt-layers.js';
import { NorthStarStore } from '../../../faculties/north-star/store.js';
import { AdminPromptsDataService } from './prompts-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-prompts-service-'));
  return tempDir;
}

function seedRuntimePromptLayers(promptStore: PromptLayerStore): Map<string, string> {
  const layerIds = new Map<string, string>();
  for (const definition of getRuntimePromptLayerDefinitions()) {
    const layer = promptStore.create({
      type: 'runtime',
      name: definition.name,
      identifier: definition.identifier,
      role: 'system',
      promptOrder: definition.priority,
      priority: definition.priority,
      content: definition.content,
      updatedBy: 'system',
    });
    layerIds.set(definition.identifier, layer.id);
  }
  return layerIds;
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

  it('fails closed when saving a runtime layer would clear required runtime prompt signals', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const runtimeLayerIds = seedRuntimePromptLayers(promptStore);

    const service = new AdminPromptsDataService({ promptStore });
    const runtimeStateLayerId = runtimeLayerIds.get('runtime.state');
    expect(runtimeStateLayerId).toBeTruthy();
    const before = promptStore.getById(runtimeStateLayerId!);

    const result = service.updatePromptLayer(JSON.stringify({
      layerId: runtimeStateLayerId,
      content: '   ',
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('runtime.last_message_received');
    expect(result.message).toContain('Last Message Received');
    expect(promptStore.getById(runtimeStateLayerId!)?.content).toBe(before?.content);
  });

  it('allows optional runtime prompt layers to be omitted by disabling them', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const runtimeLayerIds = seedRuntimePromptLayers(promptStore);

    const service = new AdminPromptsDataService({ promptStore });
    const optionalLayerId = runtimeLayerIds.get('runtime.attention');
    expect(optionalLayerId).toBeTruthy();

    const result = service.togglePromptLayer(JSON.stringify({
      layerId: optionalLayerId,
    }));

    expect(result.ok).toBe(true);
    expect(promptStore.getById(optionalLayerId!)?.enabled).toBe(false);
  });

  it('fails closed when rollback would restore invalid required runtime prompt coverage', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const runtimeLayerIds = seedRuntimePromptLayers(promptStore);
    const runtimeStateLayerId = runtimeLayerIds.get('runtime.state');
    expect(runtimeStateLayerId).toBeTruthy();

    promptStore.update(
      runtimeStateLayerId!,
      { content: '' },
      'test',
      'blank runtime layer',
    );
    promptStore.update(
      runtimeStateLayerId!,
      { content: '<runtime_state>Recovered runtime coverage.</runtime_state>' },
      'test',
      'restore runtime layer',
    );

    const service = new AdminPromptsDataService({ promptStore });
    const result = service.rollbackPromptLayer(JSON.stringify({
      layerId: runtimeStateLayerId,
      version: 2,
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('runtime.last_message_received');
    expect(promptStore.getById(runtimeStateLayerId!)?.content).toContain('Recovered runtime coverage.');
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
    expect(nonNullSnapshot.immutableBlocks).toHaveLength(4);
    expect(nonNullSnapshot.immutableBlocks.map(block => block.editable)).toEqual([false, false, false, false]);
    expect(nonNullSnapshot.companionLayer?.editable).toBe(false);
    expect(nonNullSnapshot.mutableLayers).toHaveLength(0);
    expect(nonNullSnapshot.preview.text).toContain(IMMUTABLE_HUMAN_SAFETY_LAYER_HEADER);
    expect(nonNullSnapshot.preview.text).not.toContain('operator constitution content');
    expect(nonNullSnapshot.preview.text).not.toContain('seeded foundation');
  });

  it('lists runtime-derived prompt blocks with persisted effective order', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
      join(root, 'prompt-runtime-layout.json'),
    );
    promptRuntimeLayoutStore.reorderSystemPromptBlocks([
      'session.continuity',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
    ], 'admin');

    const service = new AdminPromptsDataService({
      promptStore,
      promptRuntimeLayoutStore,
    });

    const listed = service.listPrompts();
    expect(listed.runtimeBlocks.map(block => block.id)).toEqual([
      'session.continuity',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
      'session.current_messages',
      'tools.active_schemas',
    ]);
    expect(listed.runtimeBlocks.find(block => block.id === 'session.current_messages')).toMatchObject({
      schemaClassification: 'immutable_provider_managed',
      required: true,
      immutable: true,
      providerManaged: true,
      reorderable: false,
      placement: 'context_messages',
    });
    expect(listed.runtimeBlocks.find(block => block.id === 'runtime.scratchpad')).toMatchObject({
      schemaClassification: 'optional_runtime_aware',
      required: false,
      immutable: false,
      providerManaged: false,
    });
    expect(listed.runtimeLayerCoverage.ok).toBe(false);
    expect(listed.runtimeLayerCoverage.entries.find(entry => entry.identifier === 'runtime.last_message_received')).toMatchObject({
      classification: 'required_runtime_aware',
      required: true,
      status: 'missing',
    });
    expect(listed.runtimeMacroHints.find(entry => entry.token === '{{runtime_current_datetime_human}}')).toMatchObject({
      description: expect.any(String),
      example: expect.any(String),
    });
  });

  it('lists and saves companion-editable runtime guidance blocks without exposing immutable blocks', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
      join(root, 'prompt-runtime-layout.json'),
    );
    promptRuntimeLayoutStore.setEditableBlockContent(
      'runtime.persona_adaptation',
      'Companion personality override.',
      'admin',
    );

    const service = new AdminPromptsDataService({
      promptStore,
      promptRuntimeLayoutStore,
    });

    const listed = service.listPrompts();
    const editable = listed.runtimeBlocks.find(block => block.id === 'runtime.persona_adaptation');
    const locked = listed.runtimeBlocks.find(block => block.id === 'session.current_messages');

    expect(editable).toMatchObject({
      schemaClassification: 'required_runtime_aware',
      required: true,
      immutable: false,
      companionEditable: true,
      customContent: 'Companion personality override.',
    });
    expect(locked).toMatchObject({
      schemaClassification: 'immutable_provider_managed',
      required: true,
      immutable: true,
      providerManaged: true,
      companionEditable: false,
      customContent: undefined,
    });

    const saveResult = service.saveRuntimePromptBlocks(JSON.stringify({
      blocks: [
        {
          id: 'runtime.context',
          content: 'Companion runtime context override.',
        },
      ],
    }));

    expect(saveResult.ok).toBe(true);
    expect(saveResult.updated).toEqual(['runtime.context']);
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.context')).toBe(
      'Companion runtime context override.',
    );
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.persona_adaptation')).toBe(
      'Companion personality override.',
    );

    const blockedResult = service.saveRuntimePromptBlocks(JSON.stringify({
      blocks: [
        {
          id: 'runtime.persona_adaptation',
          content: 'Should not persist.',
        },
        {
          id: 'session.current_messages',
          content: 'forbidden edit',
        },
      ],
    }));

    expect(blockedResult.ok).toBe(false);
    expect(blockedResult.message).toContain('session.current_messages');
    expect(blockedResult.message).toContain('provider-managed');
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.context')).toBe(
      'Companion runtime context override.',
    );
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.persona_adaptation')).toBe(
      'Companion personality override.',
    );
  });

  it('fails closed when runtime block save omits a required editable block that would remain empty', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
      join(root, 'prompt-runtime-layout.json'),
    );
    const service = new AdminPromptsDataService({
      promptStore,
      promptRuntimeLayoutStore,
    });

    const result = service.saveRuntimePromptBlocks(JSON.stringify({
      blocks: [
        {
          id: 'runtime.context',
          content: 'Companion runtime context override.',
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('runtime.persona_adaptation');
    expect(result.message).toContain('Persona Adaptation');
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.context')).toBe('');
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.persona_adaptation')).toBe('');
  });

  it('fails closed when clearing a required editable runtime block with blank content', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
      join(root, 'prompt-runtime-layout.json'),
    );
    promptRuntimeLayoutStore.setEditableBlockContents({
      'runtime.persona_adaptation': 'Companion personality override.',
      'runtime.context': 'Companion runtime context override.',
    }, 'admin');
    const service = new AdminPromptsDataService({
      promptStore,
      promptRuntimeLayoutStore,
    });

    const result = service.saveRuntimePromptBlocks(JSON.stringify({
      blocks: [
        {
          id: 'runtime.persona_adaptation',
          content: '   ',
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('runtime.persona_adaptation');
    expect(result.message).toContain('required and cannot be blank');
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.persona_adaptation')).toBe(
      'Companion personality override.',
    );
    expect(promptRuntimeLayoutStore.getEditableBlockContent('runtime.context')).toBe(
      'Companion runtime context override.',
    );
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

  it('reorders runtime-derived system-prompt blocks through the Garden API service', () => {
    const root = makeTempDir();
    const promptStore = new PromptLayerStore(
      join(root, 'prompt-layers.json'),
      join(root, 'prompt-history.jsonl'),
    );
    const promptRuntimeLayoutStore = new PromptRuntimeLayoutStore(
      join(root, 'prompt-runtime-layout.json'),
    );

    const service = new AdminPromptsDataService({
      promptStore,
      promptRuntimeLayoutStore,
    });

    const result = service.reorderPromptLayers(JSON.stringify({
      runtimeBlockIds: [
        'session.continuity',
        'memory.core',
        'memory.retrieval',
        'runtime.persona_adaptation',
        'runtime.context',
        'runtime.scratchpad',
        'session.compaction_summary',
        'session.focus_knowledge',
      ],
    }));

    expect(result.ok).toBe(true);
    expect(promptRuntimeLayoutStore.getSystemPromptBlockOrder()).toEqual([
      'session.continuity',
      'memory.core',
      'memory.retrieval',
      'runtime.persona_adaptation',
      'runtime.context',
      'runtime.scratchpad',
      'session.compaction_summary',
      'session.focus_knowledge',
    ]);
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
    const promptState = createPromptStatePort({});
    const service = new AdminPromptsDataService({
      promptStore: promptState.layers,
      promptRegistry: promptState.registry,
      northStarStore,
    });

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
