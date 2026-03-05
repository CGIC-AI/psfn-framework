import type { SessionManager } from '../../../session/manager.js';
import type { SessionStore } from '../../../session/store.js';
import {
  PROMPT_LAYER_ROLES,
  type LayerType,
  type PromptLayerRole,
} from '../../../identity/prompt-types.js';
import type {
  PromptLayerMetadataUpdate,
  PromptLayerStore,
  PromptLayerUpdatePatch,
} from '../../../identity/prompt-store.js';
import type { PromptRegistryStore } from '../../../identity/prompt-registry.js';
import {
  containsStructuredPromptSections,
  getMalformedStructuredPromptErrors,
  parseStructuredPromptForm,
} from '../prompt-structured-content.js';
import type {
  AdminPromptDetailData,
  AdminPromptListData,
  AdminPromptsService,
  PromptUpdateResult,
} from './types.js';

export class AdminPromptsDataService implements AdminPromptsService {
  constructor(private readonly deps: {
    promptStore?: PromptLayerStore | null;
    promptRegistry?: PromptRegistryStore | null;
    sessionStore?: SessionStore | null;
    sessionManager?: SessionManager | null;
    appendAuditTimelineEntry?: (
      actionType: 'identity_edit',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
    ) => void;
  }) {}

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
    const hasPriority = resolvedPriority.priority !== undefined;
    if (!hasContent && !hasMetadata && !hasPriority) {
      return { ok: false, message: 'No prompt update fields provided' };
    }

    const patch: PromptLayerUpdatePatch = {};
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
        `Purrsephone edited ${layer.type} prompt layer "${layer.name}".`,
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
      const layer = promptStore.getById(layerId);
      return {
        ok: true,
        message: `Toggled "${layer?.name ?? layerId}"`,
        layer: layer ?? undefined,
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
      const layer = promptStore.rollback(layerId, version);
      this.injectPromptEditSystemNote(
        `Admin rolled back ${layer.type} prompt layer "${layer.name}" using v${version} content (now v${layer.version}).`,
      );
      return {
        ok: true,
        message: `Rolled back "${layer.name}" to content from v${version}`,
        layer,
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
