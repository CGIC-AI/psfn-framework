import { createHash } from 'node:crypto';
import type { SessionManager } from '../../../session/manager.js';
import type { SessionStore } from '../../../session/store.js';
import { DEFAULT_COMPANION_NAME } from '../../../core/identity/companion-naming.js';
import {
  PROMPT_LAYER_ROLES,
  type CompanionValuesLayerSnapshot,
  type LayerType,
  type PromptLayerRole,
} from '../../../core/identity/prompt-types.js';
import {
  IMMUTABLE_HUMAN_SAFETY_AMENDMENTS,
  buildImmutableHumanSafetySection,
} from '../../../core/identity/prompt-composer.js';
import type {
  PromptLayerMetadataUpdate,
  PromptLayerStore,
  PromptLayerUpdatePatch,
} from '../../../core/identity/prompt-store.js';
import type { PromptRegistryStore } from '../../../core/identity/prompt-registry.js';
import {
  isCanonicalCharacterFoundationLayer,
} from '../../../core/identity/canonical-foundation.js';
import {
  MAX_NORTH_STAR_ITEMS,
  NORTH_STAR_SCOPES,
  type NorthStarScope,
  type NorthStarStore,
} from '../../../north-star/store.js';
import {
  containsStructuredPromptSections,
  getMalformedStructuredPromptErrors,
  parseStructuredPromptForm,
} from '../prompt-structured-content.js';
import {
  FOUNDATION_SECTION_DEFINITIONS,
  composeFoundationSectionTemplate,
  decomposeFoundationLayerContent,
  type FoundationSectionId,
} from '../../../core/identity/foundation-sections.js';
import type {
  AdminConstitutionCompanionLayer,
  AdminConstitutionImmutableBlock,
  AdminConstitutionMutableLayer,
  AdminConstitutionSnapshotData,
  AdminFoundationSnapshotData,
  AdminNorthStarSnapshotData,
  AdminPromptDetailData,
  AdminPromptListData,
  AdminPromptsService,
  ConstitutionUpdateResult,
  FoundationUpdateResult,
  NorthStarUpdateResult,
  PromptUpdateResult,
} from './types.js';

const CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX = 'constitution:immutable:';
const CONSTITUTION_COMPANION_LAYER_ID = 'constitution:companion-derived-values';

interface ConstitutionMutableLayerPatchInput {
  id: string;
  content?: string;
  enabled?: boolean;
  identifier?: string | null;
  role?: string | null;
  promptOrder?: number | null;
}

interface FoundationSectionPatchInput {
  id: FoundationSectionId;
  content: string;
  enabled: boolean;
}

interface NorthStarItemInput {
  id?: string;
  title: string;
  content: string;
  scope: NorthStarScope;
  enabled: boolean;
}

export class AdminPromptsDataService implements AdminPromptsService {
  constructor(private readonly deps: {
    promptStore?: PromptLayerStore | null;
    promptRegistry?: PromptRegistryStore | null;
    northStarStore?: NorthStarStore | null;
    sessionStore?: SessionStore | null;
    sessionManager?: SessionManager | null;
    resolveCompanionName?: () => string;
    appendAuditTimelineEntry?: (
      actionType: 'identity_edit',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
    ) => void;
    companionValuesLayerProvider?: () => CompanionValuesLayerSnapshot | null;
  }) {}

  private resolveCompanionName(): string {
    return this.deps.resolveCompanionName?.() ?? DEFAULT_COMPANION_NAME;
  }

  private hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  private parseBody(body: string): URLSearchParams {
    const trimmed = body.trim();
    if (trimmed.startsWith('{')) {
      const json = JSON.parse(trimmed) as Record<string, unknown>;
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(json)) {
        if (value === undefined || value === null) continue;
        params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      return params;
    }
    return new URLSearchParams(body);
  }

  private injectPromptEditSystemNote(note: string): void {
    if (!this.deps.sessionStore || !this.deps.sessionManager) return;
    const targetChannels = [...new Set(
      this.deps.sessionStore
        .listChannels()
        .map(channel => channel.channelId)
        .filter(channelId => !channelId.startsWith('internal:') && !channelId.startsWith('shard:')),
    )];

    for (const channelId of targetChannels) {
      this.deps.sessionManager.appendSystemNote(channelId, note);
    }
  }

  private resolvePromptLayerContent(params: URLSearchParams): { content?: string } | { error: string } {
    if (containsStructuredPromptSections(params)) {
      const structured = parseStructuredPromptForm(params);
      if (!structured.ok) return { error: structured.error };
      return { content: structured.content };
    }

    if (!params.has('content')) {
      return {};
    }

    const content = params.get('content') ?? '';
    const malformedStructuredErrors = getMalformedStructuredPromptErrors(content);
    if (malformedStructuredErrors.length > 0) {
      return { error: `Malformed structured prompt content: ${malformedStructuredErrors.join(' ')}` };
    }

    return { content };
  }

  private resolvePromptLayerPriority(
    params: URLSearchParams,
  ): { priority?: number } | { error: string } {
    if (!params.has('priority')) {
      return {};
    }

    const rawPriority = params.get('priority');
    const value = rawPriority?.trim() ?? '';
    if (!/^-?\d+$/.test(value)) {
      return { error: 'priority must be an integer' };
    }

    return { priority: parseInt(value, 10) };
  }

  resolvePromptLayerMetadata(
    params: URLSearchParams,
  ): { metadata: PromptLayerMetadataUpdate } | { error: string } {
    const metadata: PromptLayerMetadataUpdate = {};

    if (params.has('identifier')) {
      const rawIdentifier = params.get('identifier');
      metadata.identifier = rawIdentifier?.trim() ? rawIdentifier.trim() : undefined;
    }

    if (params.has('role')) {
      const rawRole = params.get('role');
      const role = rawRole?.trim() ?? '';
      if (role.length === 0) {
        metadata.role = undefined;
      } else if (!PROMPT_LAYER_ROLES.includes(role as PromptLayerRole)) {
        return { error: `role must be one of: ${PROMPT_LAYER_ROLES.join(', ')}` };
      } else {
        metadata.role = role as PromptLayerRole;
      }
    }

    if (params.has('promptOrder')) {
      const rawPromptOrder = params.get('promptOrder');
      const value = rawPromptOrder?.trim() ?? '';
      if (value.length === 0) {
        metadata.promptOrder = undefined;
      } else if (!/^\d+$/.test(value)) {
        return { error: 'promptOrder must be an integer >= 0' };
      } else {
        metadata.promptOrder = parseInt(value, 10);
      }
    }

    return { metadata };
  }

  listPrompts(): AdminPromptListData {
    return {
      layers: this.deps.promptStore?.getAll() ?? [],
      staticPrompts: this.deps.promptRegistry?.list() ?? [],
    };
  }

  private buildImmutableConstitutionBlocks(): AdminConstitutionImmutableBlock[] {
    return IMMUTABLE_HUMAN_SAFETY_AMENDMENTS.map((amendment, index) => ({
      id: `${CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX}${String(index + 1)}`,
      title: `Immutable Amendment ${String(index + 1)}`,
      content: amendment,
      editable: false as const,
    }));
  }

  private getFoundationLayers() {
    const promptStore = this.deps.promptStore;
    if (!promptStore) return [];
    const layers = promptStore.getAll().filter(layer => isCanonicalCharacterFoundationLayer(layer));
    const orderByIdentifier = new Map(
      FOUNDATION_SECTION_DEFINITIONS.map((section, index) => [section.identifier, index] as const),
    );
    return layers.sort((left, right) => {
      const leftOrder = left.identifier ? (orderByIdentifier.get(left.identifier) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      const rightOrder = right.identifier ? (orderByIdentifier.get(right.identifier) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.priority - right.priority;
    });
  }

  private buildConstitutionPreview(
    mutableLayers: readonly Pick<AdminConstitutionMutableLayer, 'content' | 'enabled'>[],
    companionLayer: AdminConstitutionCompanionLayer | null,
  ): AdminConstitutionSnapshotData['preview'] {
    const sections: string[] = [buildImmutableHumanSafetySection()];

    if (companionLayer?.content.trim()) {
      sections.push(companionLayer.content.trim());
    }

    for (const layer of mutableLayers) {
      if (!layer.enabled) continue;
      const trimmed = layer.content.trim();
      if (!trimmed) continue;
      sections.push(trimmed);
    }

    const text = sections.filter(section => section.trim().length > 0).join('\n\n');
    return {
      text,
      hash: this.hashText(text),
      staticPrefix: text,
      dynamicSuffix: '',
    };
  }

  private resolveCompanionLayerSnapshot(): AdminConstitutionCompanionLayer | null {
    const provider = this.deps.companionValuesLayerProvider;
    if (!provider) return null;

    try {
      const snapshot = provider();
      if (!snapshot) return null;
      const content = snapshot.content.trim();
      if (!content) return null;
      return {
        id: CONSTITUTION_COMPANION_LAYER_ID,
        title: 'Companion-Derived Values Layer',
        content,
        provenanceRefs: snapshot.provenanceRefs
          .map(entry => entry.trim())
          .filter(entry => entry.length > 0),
        historyVersions: snapshot.historyVersions
          .filter(entry => Number.isFinite(entry))
          .map(entry => Math.floor(entry)),
        entryIds: snapshot.entryIds
          .map(entry => entry.trim())
          .filter(entry => entry.length > 0),
        editable: false as const,
      };
    } catch {
      return null;
    }
  }

  private getNorthStarStore(): NorthStarStore | null {
    return this.deps.northStarStore ?? null;
  }

  private parseNorthStarItemInput(value: unknown): NorthStarItemInput | { error: string } {
    if (!value || typeof value !== 'object') {
      return { error: 'items entries must be objects' };
    }

    const item = value as Record<string, unknown>;
    const parsed: NorthStarItemInput = {
      title: '',
      content: '',
      scope: 'shared',
      enabled: true,
    };

    if (Object.prototype.hasOwnProperty.call(item, 'id')) {
      if (typeof item.id !== 'string' || item.id.trim().length === 0) {
        return { error: 'items entries with id must use a non-empty string id' };
      }
      parsed.id = item.id.trim();
    }

    if (typeof item.title !== 'string' || item.title.trim().length === 0) {
      return { error: 'items entries require a non-empty title' };
    }
    parsed.title = item.title.trim();

    if (typeof item.content !== 'string' || item.content.trim().length === 0) {
      return { error: `North Star item "${parsed.title}" requires non-empty content` };
    }
    parsed.content = item.content.trim();

    if (typeof item.scope !== 'string' || !NORTH_STAR_SCOPES.includes(item.scope as NorthStarScope)) {
      return { error: `North Star item "${parsed.title}" scope must be one of: ${NORTH_STAR_SCOPES.join(', ')}` };
    }
    parsed.scope = item.scope as NorthStarScope;

    if (Object.prototype.hasOwnProperty.call(item, 'enabled')) {
      if (typeof item.enabled !== 'boolean') {
        return { error: `North Star item "${parsed.title}" enabled must be a boolean` };
      }
      parsed.enabled = item.enabled;
    }

    return parsed;
  }

  getNorthStarSnapshot(): AdminNorthStarSnapshotData | null {
    const northStarStore = this.getNorthStarStore();
    if (!northStarStore) return null;

    const previewText = northStarStore.buildPromptLayer()?.content ?? '';
    return {
      items: northStarStore.list().map(item => ({ ...item })),
      limit: MAX_NORTH_STAR_ITEMS,
      preview: {
        text: previewText,
        hash: this.hashText(previewText),
      },
    };
  }

  getFoundationSnapshot(): AdminFoundationSnapshotData | null {
    const foundationLayers = this.getFoundationLayers();
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
        hash: this.hashText(previewText),
      },
    };
  }

  getConstitutionSnapshot(): AdminConstitutionSnapshotData | null {
    const promptStore = this.deps.promptStore;
    if (!promptStore) return null;

    const immutableBlocks = this.buildImmutableConstitutionBlocks();
    const companionLayer = this.resolveCompanionLayerSnapshot();
    const mutableLayers: AdminConstitutionMutableLayer[] = [];

    return {
      immutableBlocks,
      companionLayer,
      mutableLayers,
      preview: this.buildConstitutionPreview(mutableLayers, companionLayer),
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
    const promptStore = this.deps.promptStore;
    const foundationLayers = this.getFoundationLayers();
    if (!promptStore || foundationLayers.length === 0) {
      return { ok: false, message: 'Character Foundation is not configured' };
    }

    const params = this.parseBody(body);
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
          promptStore.create({
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
          promptStore.update(
            existing.id,
            patch,
            'admin',
            'Admin Character Foundation edit via Garden API',
          );
        }
        if (existing.enabled !== section.enabled) {
          promptStore.toggle(existing.id);
        }
      }
      this.injectPromptEditSystemNote(
        'Admin updated Character Foundation prompt soil.',
      );
      this.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        'Admin updated Character Foundation sections.',
        foundationLayers.map(layer => `layerId=${layer.id}`),
      );
    } catch (error) {
      return { ok: false, message: String(error) };
    }

    const snapshot = this.getFoundationSnapshot();
    if (!snapshot) {
      return { ok: false, message: 'Failed to load Character Foundation after save' };
    }

    return {
      ok: true,
      message: 'Saved Character Foundation sections',
      snapshot,
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
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
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
    const existingLayerIds = new Set((currentSnapshot?.mutableLayers ?? []).map(layer => layer.id));
    if (existingLayerIds.size === 0) {
      if (parsedLayers.length !== 0) {
        return { ok: false, message: 'Mutable constitution layers are not exposed through Constitution Builder' };
      }
      if (!currentSnapshot) {
        return { ok: false, message: 'Failed to load constitution snapshot after save' };
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
    if (existingLayerIds.size === 0 && parsedLayers.length === 0) {
      const snapshot = this.getConstitutionSnapshot();
      if (!snapshot) {
        return { ok: false, message: 'Failed to load constitution snapshot after save' };
      }
      return {
        ok: true,
        message: 'No mutable constitution layers to update',
        snapshot,
      };
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
      const currentOrder = promptStore
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
      promptStore.reorderByLayerIds(
        nextLayerIds,
        'admin',
        'Admin constitution layer reorder via Garden API',
      );
    } catch (error) {
      return { ok: false, message: String(error) };
    }

    for (const patchEntry of mutableLayerPatches) {
      const layer = promptStore.getById(patchEntry.id);
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
      const resolvedMetadata = this.resolvePromptLayerMetadata(metadataParams);
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
          promptStore.update(
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
          promptStore.toggle(patchEntry.id);
        } catch (error) {
          return { ok: false, message: String(error) };
        }
      }
    }

    const snapshot = this.getConstitutionSnapshot();
    if (!snapshot) {
      return { ok: false, message: 'Failed to load constitution snapshot after save' };
    }

    return {
      ok: true,
      message: 'Saved mutable constitution layers',
      snapshot,
    };
  }

  saveNorthStarItems(body: string): NorthStarUpdateResult {
    const northStarStore = this.getNorthStarStore();
    if (!northStarStore) {
      return { ok: false, message: 'North Star store not configured' };
    }

    const params = this.parseBody(body);
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
      const parsedEntry = this.parseNorthStarItemInput(entry);
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

    this.injectPromptEditSystemNote('Admin updated North Star goals.');
    return {
      ok: true,
      message: 'Saved North Star goals',
      snapshot,
    };
  }

  createPromptLayer(body: string): PromptUpdateResult {
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
    const name = params.get('name')?.trim();
    const type = params.get('type')?.trim() as LayerType | undefined;
    const content = params.get('content') ?? '';

    if (!name) {
      return { ok: false, message: 'name is required' };
    }
    if (!type) {
      return { ok: false, message: 'type is required' };
    }

    const validTypes: LayerType[] = ['runtime', 'channel', 'task'];
    if (!validTypes.includes(type)) {
      return { ok: false, message: `type must be one of: ${validTypes.join(', ')}` };
    }

    const resolvedMetadata = this.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      return { ok: false, message: resolvedMetadata.error };
    }

    const priority = parseInt(params.get('priority') ?? '0', 10);
    const channelType = params.get('channelType')?.trim() || undefined;
    const taskKind = params.get('taskKind')?.trim() || undefined;

    try {
      const layer = promptStore.create({
        type,
        name,
        content,
        priority: Number.isFinite(priority) ? priority : 0,
        channelType,
        taskKind,
        identifier: resolvedMetadata.metadata.identifier,
        role: resolvedMetadata.metadata.role,
        promptOrder: resolvedMetadata.metadata.promptOrder,
        updatedBy: 'admin',
      });

      this.injectPromptEditSystemNote(
        `Admin created ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      this.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `Admin created ${layer.type} prompt layer "${layer.name}".`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );

      return {
        ok: true,
        message: `Created "${layer.name}" (${layer.type})`,
        layer,
      };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }

  getPromptDetail(layerId: string): AdminPromptDetailData | null {
    const promptStore = this.deps.promptStore;
    if (!promptStore) return null;
    const layer = promptStore.getById(layerId);
    if (!layer) return null;
    return {
      layer,
      layerHistory: promptStore.getLayerHistory(layerId),
    };
  }

  getStaticPromptDetail(key: string): AdminPromptDetailData | null {
    const promptRegistry = this.deps.promptRegistry;
    if (!promptRegistry) return null;
    const staticPrompt = promptRegistry.getByKey(key);
    if (!staticPrompt) return null;
    return {
      staticPrompt,
      staticPromptHistory: promptRegistry.getPromptHistory(key),
    };
  }

  updatePromptLayer(body: string): PromptUpdateResult {
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
    const layerId = params.get('layerId') ?? params.get('id') ?? '';
    const name = params.get('name')?.trim();

    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) {
      return { ok: false, message: resolved.error };
    }

    const resolvedMetadata = this.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      return { ok: false, message: resolvedMetadata.error };
    }

    const resolvedPriority = this.resolvePromptLayerPriority(params);
    if ('error' in resolvedPriority) {
      return { ok: false, message: resolvedPriority.error };
    }

    const hasMetadata = Object.keys(resolvedMetadata.metadata).length > 0;
    const hasContent = resolved.content !== undefined;
    const hasName = Boolean(name);
    const hasPriority = resolvedPriority.priority !== undefined;
    if (!hasName && !hasContent && !hasMetadata && !hasPriority) {
      return { ok: false, message: 'No prompt update fields provided' };
    }

    const patch: PromptLayerUpdatePatch = {};
    if (hasName) patch.name = name;
    if (hasContent) patch.content = resolved.content;
    if (hasMetadata) patch.metadata = resolvedMetadata.metadata;
    if (hasPriority) patch.priority = resolvedPriority.priority;

    try {
      const layer = promptStore.update(
        layerId,
        patch,
        'admin',
        'Admin prompt-layer edit via Garden API',
      );
      this.injectPromptEditSystemNote(
        `Admin updated ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      this.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `${this.resolveCompanionName()} edited ${layer.type} prompt layer "${layer.name}".`,
        [`layerId=${layer.id}`, `version=${layer.version}`],
      );
      return {
        ok: true,
        message: `Updated "${layer.name}" to v${layer.version}`,
        layer,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  reorderPromptLayers(body: string): PromptUpdateResult {
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
    const rawLayerIds = params.get('layerIds');
    if (!rawLayerIds) {
      return { ok: false, message: 'layerIds is required' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLayerIds);
    } catch {
      return { ok: false, message: 'layerIds must be a JSON array of layer IDs' };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, message: 'layerIds must be a JSON array of layer IDs' };
    }

    const layerIds: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string' || !entry.trim()) {
        return { ok: false, message: 'layerIds entries must be non-empty strings' };
      }
      layerIds.push(entry.trim());
    }

    try {
      const touched = promptStore.reorderByLayerIds(
        layerIds,
        'admin',
        'Admin prompt-layer reorder via Garden API',
      );

      if (touched.length > 0) {
        this.injectPromptEditSystemNote(
          `Admin reordered ${touched.length} prompt layer${touched.length === 1 ? '' : 's'}.`,
        );
      }

      return {
        ok: true,
        message: touched.length > 0
          ? `Reordered ${touched.length} prompt layer${touched.length === 1 ? '' : 's'}`
          : 'Prompt layers already in requested order',
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  updatePromptRegistry(body: string): PromptUpdateResult {
    const promptRegistry = this.deps.promptRegistry;
    if (!promptRegistry) {
      return { ok: false, message: 'Prompt registry not configured' };
    }

    const params = this.parseBody(body);
    const key = params.get('key') ?? '';
    const content = params.get('content') ?? '';
    try {
      const staticPrompt = promptRegistry.update(key, content, 'admin');
      return {
        ok: true,
        message: `Updated "${staticPrompt.key}" to v${staticPrompt.version}`,
        staticPrompt,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  togglePromptLayer(body: string): PromptUpdateResult {
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
    const layerId = params.get('layerId') ?? '';

    try {
      promptStore.toggle(layerId);
      const toggledLayer = promptStore.getById(layerId);
      return {
        ok: true,
        message: `Toggled "${toggledLayer?.name ?? layerId}"`,
        layer: toggledLayer ?? undefined,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  rollbackPromptLayer(body: string): PromptUpdateResult {
    const promptStore = this.deps.promptStore;
    if (!promptStore) {
      return { ok: false, message: 'Prompt store not configured' };
    }

    const params = this.parseBody(body);
    const layerId = params.get('layerId') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);
    try {
      const rolledBackLayer = promptStore.rollback(layerId, version);
      this.injectPromptEditSystemNote(
        `Admin rolled back ${rolledBackLayer.type} prompt layer "${rolledBackLayer.name}" using v${version} content (now v${rolledBackLayer.version}).`,
      );
      return {
        ok: true,
        message: `Rolled back "${rolledBackLayer.name}" to content from v${version}`,
        layer: rolledBackLayer,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  rollbackPromptRegistry(body: string): PromptUpdateResult {
    const promptRegistry = this.deps.promptRegistry;
    if (!promptRegistry) {
      return { ok: false, message: 'Prompt registry not configured' };
    }

    const params = this.parseBody(body);
    const key = params.get('key') ?? '';
    const version = parseInt(params.get('version') ?? '0', 10);

    try {
      const staticPrompt = promptRegistry.rollback(key, version);
      return {
        ok: true,
        message: `Rolled back "${staticPrompt.key}" to content from v${version}`,
        staticPrompt,
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  previewPromptLayerDiff(body: string): { oldContent: string; newContent: string } | null {
    const promptStore = this.deps.promptStore;
    if (!promptStore) return null;

    const params = this.parseBody(body);
    const layerId = params.get('layerId') ?? '';
    const layer = promptStore.getById(layerId);
    if (!layer) return null;

    const layerHistory = promptStore.getLayerHistory(layerId);
    if (layerHistory.length === 0) return null;

    const previousVersion = layer.version - 1;
    const previousEntry = layerHistory.find(entry => entry.version === previousVersion)
      ?? layerHistory[layerHistory.length - 1];

    return {
      oldContent: previousEntry.previousContent,
      newContent: layer.content,
    };
  }
}
