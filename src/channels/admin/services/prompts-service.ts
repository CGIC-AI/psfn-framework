import type { SessionManager } from '../../../session/manager.js';
import type { SessionStore } from '../../../session/store.js';
import {
  PROMPT_LAYER_ROLES,
  type PromptLayerRole,
} from '../../../identity/prompt-types.js';
import type { PromptLayerMetadataUpdate, PromptLayerStore } from '../../../identity/prompt-store.js';
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

  private resolvePromptLayerContent(params: URLSearchParams): { content: string } | { error: string } {
    if (containsStructuredPromptSections(params)) {
      const structured = parseStructuredPromptForm(params);
      if (!structured.ok) return { error: structured.error };
      return { content: structured.content };
    }

    const content = params.get('content') ?? '';
    const malformedStructuredErrors = getMalformedStructuredPromptErrors(content);
    if (malformedStructuredErrors.length > 0) {
      return { error: `Malformed structured prompt content: ${malformedStructuredErrors.join(' ')}` };
    }

    return { content };
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

    try {
      const layer = promptStore.update(
        layerId,
        resolved.content,
        'admin',
        resolvedMetadata.metadata,
        'Admin prompt-layer edit via Garden API',
      );
      this.injectPromptEditSystemNote(
        `Admin updated ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      this.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `PSFN edited ${layer.type} prompt layer "${layer.name}".`,
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
    const resolved = this.resolvePromptLayerContent(params);
    if ('error' in resolved) return null;

    const layer = promptStore.getById(layerId);
    if (!layer) return null;
    return {
      oldContent: layer.content,
      newContent: resolved.content,
    };
  }
}
