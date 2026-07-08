import type { PromptLayerUpdatePatch } from '../../../core/identity/prompt-store.js';
import { MAX_NORTH_STAR_ITEMS } from '../../../faculties/north-star/store.js';
import {
  FOUNDATION_SECTION_DEFINITIONS,
  composeFoundationSectionTemplate,
  decomposeFoundationLayerContent,
  type FoundationSectionId,
} from '../../../core/identity/foundation-sections.js';
import type {
  AdminConstitutionMutableLayer,
  AdminConstitutionSnapshotData,
  AdminFoundationSnapshotData,
  AdminNorthStarSnapshotData,
  ConstitutionUpdateResult,
  FoundationUpdateResult,
  NorthStarUpdateResult,
} from './types.js';
import {
  CONSTITUTION_COMPANION_LAYER_ID,
  CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX,
  type AdminPromptsServiceContext,
  type ConstitutionMutableLayerPatchInput,
  type FoundationSectionPatchInput,
  type NorthStarItemInput,
} from './prompts-service-context.js';

export class PromptsSnapshotService {
  constructor(private readonly context: AdminPromptsServiceContext) {}

  getNorthStarSnapshot(): AdminNorthStarSnapshotData | null {
    const northStarStore = this.context.getNorthStarStore();
    if (!northStarStore) return null;

    const previewText = northStarStore.buildPromptLayer()?.content ?? '';
    return {
      items: northStarStore.list().map(item => ({ ...item })),
      limit: MAX_NORTH_STAR_ITEMS,
      preview: {
        text: previewText,
        hash: this.context.hashText(previewText),
      },
    };
  }

  getFoundationSnapshot(): AdminFoundationSnapshotData | null {
    const foundationLayers = this.context.getFoundationLayers();
    if (foundationLayers.length === 0) return null;

    const layersByIdentifier = new Map(
      foundationLayers
        .map(layer => [layer.identifier, layer] as const)
        .filter((entry): entry is [string, typeof foundationLayers[number]] => Boolean(entry[0])),
    );
    const sections = FOUNDATION_SECTION_DEFINITIONS.map((definition) => {
      const layer = layersByIdentifier.get(definition.identifier);
      const parsed = layer
        ? decomposeFoundationLayerContent(definition.id, layer.content)
        : {
          id: definition.id,
          title: definition.title,
          content: definition.defaultContent,
          enabled: definition.defaultEnabled,
          defaultEnabled: definition.defaultEnabled,
        };
      return {
        ...parsed,
        enabled: layer?.enabled ?? definition.defaultEnabled,
        defaultEnabled: definition.defaultEnabled,
      };
    });
    const previewText = foundationLayers
      .filter(layer => layer.enabled)
      .map(layer => layer.content.trim())
      .filter(content => content.length > 0)
      .join('\n\n');

    return {
      layerId: foundationLayers[0]?.id ?? 'foundation:composite',
      layerName: 'Character Foundation',
      sections,
      preview: {
        text: previewText,
        hash: this.context.hashText(previewText),
      },
    };
  }

  getConstitutionSnapshot(): AdminConstitutionSnapshotData {
    const immutableBlocks = this.context.buildImmutableConstitutionBlocks();
    const companionLayer = this.context.resolveCompanionLayerSnapshot();
    const mutableLayers: AdminConstitutionMutableLayer[] = [];

    return {
      immutableBlocks,
      companionLayer,
      mutableLayers,
      preview: this.context.buildConstitutionPreview(mutableLayers, companionLayer),
    };
  }

  private parseFoundationSectionPatch(
    value: unknown,
  ): FoundationSectionPatchInput | { error: string } {
    if (!value || typeof value !== 'object') {
      return { error: 'sections entries must be objects' };
    }

    const section = value as Record<string, unknown>;
    if (typeof section.id !== 'string' || !FOUNDATION_SECTION_DEFINITIONS.some(entry => entry.id === section.id)) {
      return { error: 'sections entries require a valid section id' };
    }
    if (typeof section.content !== 'string') {
      return { error: `foundation section "${section.id}" content must be a string` };
    }
    if (typeof section.enabled !== 'boolean') {
      return { error: `foundation section "${section.id}" enabled must be a boolean` };
    }

    return {
      id: section.id as FoundationSectionId,
      content: section.content,
      enabled: section.enabled,
    };
  }

  saveFoundationSections(body: string): FoundationUpdateResult {
    const foundationLayers = this.context.getFoundationLayers();
    if (foundationLayers.length === 0) {
      return { ok: false, message: 'Character Foundation is not configured' };
    }

    const params = this.context.parseBody(body);
    const rawSections = params.get('sections');
    if (!rawSections) {
      return { ok: false, message: 'sections is required' };
    }

    let parsedSections: unknown;
    try {
      parsedSections = JSON.parse(rawSections);
    } catch {
      return { ok: false, message: 'sections must be a JSON array' };
    }

    if (!Array.isArray(parsedSections)) {
      return { ok: false, message: 'sections must be a JSON array' };
    }

    if (parsedSections.length !== FOUNDATION_SECTION_DEFINITIONS.length) {
      return { ok: false, message: 'sections must include every foundation section exactly once' };
    }

    const sectionPatches: FoundationSectionPatchInput[] = [];
    const seen = new Set<FoundationSectionId>();
    for (const entry of parsedSections) {
      const parsedEntry = this.parseFoundationSectionPatch(entry);
      if ('error' in parsedEntry) {
        return { ok: false, message: parsedEntry.error };
      }
      if (seen.has(parsedEntry.id)) {
        return { ok: false, message: `Duplicate foundation section id: ${parsedEntry.id}` };
      }
      seen.add(parsedEntry.id);
      sectionPatches.push(parsedEntry);
    }

    try {
      const layersByIdentifier = new Map(
        foundationLayers
          .map(layer => [layer.identifier, layer] as const)
          .filter((entry): entry is [string, typeof foundationLayers[number]] => Boolean(entry[0])),
      );
      for (let index = 0; index < sectionPatches.length; index += 1) {
        const section = sectionPatches[index];
        const definition = FOUNDATION_SECTION_DEFINITIONS.find(entry => entry.id === section.id)!;
        const content = composeFoundationSectionTemplate(section);
        const priority = index * 10;
        const existing = layersByIdentifier.get(definition.identifier);
        if (!existing) {
          this.context.deps.promptStore.create({
            type: 'base',
            name: definition.layerName,
            enabled: section.enabled,
            identifier: definition.identifier,
            role: 'system',
            promptOrder: priority,
            content,
            priority,
            updatedBy: 'admin',
          });
          continue;
        }

        const metadataPatch = {
          ...(existing.identifier !== definition.identifier ? { identifier: definition.identifier } : {}),
          ...(existing.role !== 'system' ? { role: 'system' as const } : {}),
          ...(existing.promptOrder !== priority ? { promptOrder: priority } : {}),
        };
        const patch = {
          ...(existing.content !== content ? { content } : {}),
          ...(existing.priority !== priority ? { priority } : {}),
          ...(Object.keys(metadataPatch).length > 0 ? { metadata: metadataPatch } : {}),
        };
        if (Object.keys(patch).length > 0) {
          this.context.deps.promptStore.update(
            existing.id,
            patch,
            'admin',
            'Admin Character Foundation edit via Garden API',
          );
        }
        if (existing.enabled !== section.enabled) {
          this.context.deps.promptStore.toggle(existing.id);
        }
      }
      this.context.injectPromptEditSystemNote(
        'Admin updated Character Foundation prompt soil.',
      );
      this.context.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        'Admin updated Character Foundation sections.',
        foundationLayers.map(layer => `layerId=${layer.id}`),
      );
    } catch (error) {
      return { ok: false, message: String(error) };
    }

    const snapshot = this.getFoundationSnapshot();
    return {
      ok: true,
      message: 'Saved Character Foundation sections',
      ...(snapshot ? { snapshot } : {}),
    };
  }

  private parseConstitutionMutableLayerPatch(
    value: unknown,
  ): ConstitutionMutableLayerPatchInput | { error: string } {
    if (!value || typeof value !== 'object') {
      return { error: 'mutableLayers entries must be objects' };
    }
    const patch = value as Record<string, unknown>;
    if (typeof patch.id !== 'string' || patch.id.trim().length === 0) {
      return { error: 'mutableLayers entries require a non-empty id' };
    }

    const layerPatch: ConstitutionMutableLayerPatchInput = {
      id: patch.id.trim(),
    };

    if (Object.prototype.hasOwnProperty.call(patch, 'content')) {
      if (typeof patch.content !== 'string') {
        return { error: `mutable layer "${layerPatch.id}" content must be a string` };
      }
      layerPatch.content = patch.content;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
      if (typeof patch.enabled !== 'boolean') {
        return { error: `mutable layer "${layerPatch.id}" enabled must be a boolean` };
      }
      layerPatch.enabled = patch.enabled;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'identifier')) {
      if (!(typeof patch.identifier === 'string' || patch.identifier === null)) {
        return { error: `mutable layer "${layerPatch.id}" identifier must be a string or null` };
      }
      layerPatch.identifier = patch.identifier as string | null;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
      if (!(typeof patch.role === 'string' || patch.role === null)) {
        return { error: `mutable layer "${layerPatch.id}" role must be a string or null` };
      }
      layerPatch.role = patch.role as string | null;
    }

    if (Object.prototype.hasOwnProperty.call(patch, 'promptOrder')) {
      if (!(typeof patch.promptOrder === 'number' || patch.promptOrder === null)) {
        return { error: `mutable layer "${layerPatch.id}" promptOrder must be a number or null` };
      }
      if (typeof patch.promptOrder === 'number'
        && (!Number.isInteger(patch.promptOrder) || patch.promptOrder < 0)) {
        return { error: `mutable layer "${layerPatch.id}" promptOrder must be an integer >= 0` };
      }
      layerPatch.promptOrder = patch.promptOrder as number | null;
    }

    return layerPatch;
  }

  saveConstitutionMutableLayers(body: string): ConstitutionUpdateResult {
    const params = this.context.parseBody(body);
    if (params.has('immutableBlocks') || params.has('companionLayer')) {
      return { ok: false, message: 'Immutable constitution layers are read-only and cannot be edited' };
    }

    const rawMutableLayers = params.get('mutableLayers');
    if (!rawMutableLayers) {
      return { ok: false, message: 'mutableLayers is required' };
    }

    let parsedLayers: unknown;
    try {
      parsedLayers = JSON.parse(rawMutableLayers);
    } catch {
      return { ok: false, message: 'mutableLayers must be a JSON array' };
    }

    if (!Array.isArray(parsedLayers)) {
      return { ok: false, message: 'mutableLayers must be a JSON array' };
    }

    for (const entry of parsedLayers) {
      if (!entry || typeof entry !== 'object') continue;
      const candidateId = typeof (entry as { id?: unknown }).id === 'string'
        ? ((entry as { id: string }).id).trim()
        : '';
      if (candidateId.startsWith(CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX)
        || candidateId === CONSTITUTION_COMPANION_LAYER_ID) {
        return { ok: false, message: 'Immutable constitution layers are read-only and cannot be edited' };
      }
    }

    const currentSnapshot = this.getConstitutionSnapshot();
    const existingLayerIds = new Set(currentSnapshot.mutableLayers.map(layer => layer.id));
    if (existingLayerIds.size === 0) {
      if (parsedLayers.length !== 0) {
        return { ok: false, message: 'Mutable constitution layers are not exposed through Constitution Builder' };
      }
      return {
        ok: true,
        message: 'No mutable constitution layers to update',
        snapshot: currentSnapshot,
      };
    }

    if (parsedLayers.length !== existingLayerIds.size) {
      return { ok: false, message: 'mutableLayers must include every mutable layer exactly once' };
    }
    const mutableLayerPatches: ConstitutionMutableLayerPatchInput[] = [];
    const seen = new Set<string>();
    for (const entry of parsedLayers) {
      const parsedEntry = this.parseConstitutionMutableLayerPatch(entry);
      if ('error' in parsedEntry) {
        return { ok: false, message: parsedEntry.error };
      }

      if (parsedEntry.id.startsWith(CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX)
        || parsedEntry.id === CONSTITUTION_COMPANION_LAYER_ID) {
        return { ok: false, message: 'Immutable constitution layers are read-only and cannot be edited' };
      }

      if (!existingLayerIds.has(parsedEntry.id)) {
        return { ok: false, message: `Prompt layer not found: ${parsedEntry.id}` };
      }
      if (seen.has(parsedEntry.id)) {
        return { ok: false, message: `Duplicate mutable layer id: ${parsedEntry.id}` };
      }
      seen.add(parsedEntry.id);
      mutableLayerPatches.push(parsedEntry);
    }

    try {
      const currentOrder = this.context.deps.promptStore
        .getAll()
        .sort((left, right) => left.priority - right.priority);
      const nextLayerIds: string[] = [];
      let insertedOperators = false;
      for (const layer of currentOrder) {
        if (layer.type === 'operator') {
          if (!insertedOperators) {
            nextLayerIds.push(...mutableLayerPatches.map(entry => entry.id));
            insertedOperators = true;
          }
          continue;
        }
        nextLayerIds.push(layer.id);
      }
      this.context.deps.promptStore.reorderByLayerIds(
        nextLayerIds,
        'admin',
        'Admin constitution layer reorder via Garden API',
      );
    } catch (error) {
      return { ok: false, message: String(error) };
    }

    for (const patchEntry of mutableLayerPatches) {
      const layer = this.context.deps.promptStore.getById(patchEntry.id);
      if (!layer) {
        return { ok: false, message: `Prompt layer not found: ${patchEntry.id}` };
      }

      const metadataParams = new URLSearchParams();
      if (Object.prototype.hasOwnProperty.call(patchEntry, 'identifier')) {
        metadataParams.set('identifier', patchEntry.identifier ?? '');
      }
      if (Object.prototype.hasOwnProperty.call(patchEntry, 'role')) {
        metadataParams.set('role', patchEntry.role ?? '');
      }
      if (Object.prototype.hasOwnProperty.call(patchEntry, 'promptOrder')) {
        metadataParams.set('promptOrder', patchEntry.promptOrder == null ? '' : String(patchEntry.promptOrder));
      }
      const resolvedMetadata = this.context.resolvePromptLayerMetadata(metadataParams);
      if ('error' in resolvedMetadata) {
        return { ok: false, message: resolvedMetadata.error };
      }

      const updatePatch: PromptLayerUpdatePatch = {};
      if (patchEntry.content !== undefined && patchEntry.content !== layer.content) {
        updatePatch.content = patchEntry.content;
      }

      if (Object.keys(resolvedMetadata.metadata).length > 0) {
        updatePatch.metadata = resolvedMetadata.metadata;
      }

      if (Object.keys(updatePatch).length > 0) {
        try {
          this.context.deps.promptStore.update(
            patchEntry.id,
            updatePatch,
            'admin',
            'Admin constitution mutable-layer edit via Garden API',
          );
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      }

      if (patchEntry.enabled !== undefined && patchEntry.enabled !== layer.enabled) {
        try {
          this.context.deps.promptStore.toggle(patchEntry.id);
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      }
    }

    return {
      ok: true,
      message: 'Saved mutable constitution layers',
      snapshot: this.getConstitutionSnapshot(),
    };
  }

  saveNorthStarItems(body: string): NorthStarUpdateResult {
    const northStarStore = this.context.getNorthStarStore();
    if (!northStarStore) {
      return { ok: false, message: 'North Star store not configured' };
    }

    const params = this.context.parseBody(body);
    const rawItems = params.get('items');
    if (!rawItems) {
      return { ok: false, message: 'items is required' };
    }

    let parsedItems: unknown;
    try {
      parsedItems = JSON.parse(rawItems);
    } catch {
      return { ok: false, message: 'items must be a JSON array' };
    }

    if (!Array.isArray(parsedItems)) {
      return { ok: false, message: 'items must be a JSON array' };
    }
    if (parsedItems.length > MAX_NORTH_STAR_ITEMS) {
      return { ok: false, message: `North Star is limited to ${String(MAX_NORTH_STAR_ITEMS)} items` };
    }

    const existingItems = northStarStore.list();
    const existingById = new Map(existingItems.map(item => [item.id, item]));
    const parsedInputs: NorthStarItemInput[] = [];
    const seenIds = new Set<string>();

    for (const entry of parsedItems) {
      const parsedEntry = this.context.parseNorthStarItemInput(entry);
      if ('error' in parsedEntry) {
        return { ok: false, message: parsedEntry.error };
      }
      if (parsedEntry.id) {
        if (!existingById.has(parsedEntry.id)) {
          return { ok: false, message: `North Star item not found: ${parsedEntry.id}` };
        }
        if (seenIds.has(parsedEntry.id)) {
          return { ok: false, message: `Duplicate North Star item id: ${parsedEntry.id}` };
        }
        seenIds.add(parsedEntry.id);
      }
      parsedInputs.push(parsedEntry);
    }

    const retainedIds = new Set(parsedInputs.flatMap(entry => entry.id ? [entry.id] : []));
    for (const item of existingItems) {
      if (!retainedIds.has(item.id)) {
        try {
          northStarStore.delete(item.id);
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      }
    }

    const createdIds: string[] = [];
    for (const entry of parsedInputs) {
      if (entry.id) {
        const existing = northStarStore.getById(entry.id);
        if (!existing) {
          return { ok: false, message: `North Star item not found: ${entry.id}` };
        }
        const needsUpdate = (
          existing.title !== entry.title
          || existing.content !== entry.content
          || existing.scope !== entry.scope
          || existing.enabled !== entry.enabled
        );
        if (!needsUpdate) {
          continue;
        }
        try {
          northStarStore.update(entry.id, {
            title: entry.title,
            content: entry.content,
            scope: entry.scope,
            enabled: entry.enabled,
          }, 'admin');
        } catch (error) {
          return { ok: false, message: String(error) };
        }
        continue;
      }

      try {
        const created = northStarStore.create({
          title: entry.title,
          content: entry.content,
          scope: entry.scope,
          enabled: entry.enabled,
          updatedBy: 'admin',
        });
        createdIds.push(created.id);
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    }

    const desiredOrder: string[] = [];
    let createdIndex = 0;
    for (const entry of parsedInputs) {
      if (entry.id) {
        desiredOrder.push(entry.id);
        continue;
      }
      const createdId = createdIds[createdIndex];
      createdIndex += 1;
      if (!createdId) {
        return { ok: false, message: 'Failed to resolve created North Star item order' };
      }
      desiredOrder.push(createdId);
    }

    if (desiredOrder.length > 0) {
      try {
        northStarStore.reorder(desiredOrder, 'admin');
      } catch (error) {
        return { ok: false, message: String(error) };
      }
    }

    const snapshot = this.getNorthStarSnapshot();
    if (!snapshot) {
      return { ok: false, message: 'Failed to load North Star snapshot after save' };
    }

    this.context.injectPromptEditSystemNote('Admin updated North Star guidance.');
    return {
      ok: true,
      message: 'Saved North Star guidance',
      snapshot,
    };
  }
}
