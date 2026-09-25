import type { LayerType } from '../../../core/identity/prompt-types.js';
import type { PromptLayerUpdatePatch } from '../../../core/identity/prompt-store.js';
import type { PromptRuntimeSystemPromptBlockId } from '../../../core/identity/prompt-runtime.js';
import type { PromptUpdateResult } from './types.js';
import type { AdminPromptsServiceContext } from './prompts-service-context.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import {
  operatorLayerIdentifierError,
  resolveOperatorLayerWriter,
} from './prompt-operator-layer-authority.js';

export class PromptsLayerService {
  constructor(private readonly context: AdminPromptsServiceContext) {}

  createPromptLayer(body: string, requestContext?: GardenRequestContext): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const name = params.get('name')?.trim();
    const type = params.get('type')?.trim() as LayerType | undefined;
    const content = params.get('content') ?? '';

    if (!name) {
      return { ok: false, message: 'name is required' };
    }
    if (!type) {
      return { ok: false, message: 'type is required' };
    }

    const validTypes: LayerType[] = ['runtime', 'channel', 'task', 'operator'];
    if (!validTypes.includes(type)) {
      return { ok: false, message: `type must be one of: ${validTypes.join(', ')}` };
    }

    const resolvedMetadata = this.context.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      return { ok: false, message: resolvedMetadata.error };
    }

    let operatorActor: string | undefined;
    if (type === 'operator') {
      const writer = resolveOperatorLayerWriter(requestContext);
      if (!writer.ok) return { ok: false, message: writer.message };
      if (params.get('channelType')?.trim() || params.get('taskKind')?.trim()) {
        return { ok: false, message: 'Operator prompt layers apply everywhere; channelType/taskKind are not allowed' };
      }
      const identifierError = operatorLayerIdentifierError(
        resolvedMetadata.metadata.identifier ?? undefined,
        this.context.deps.promptStore.getAll(),
      );
      if (identifierError) return { ok: false, message: identifierError };
      operatorActor = writer.actor;
    }

    const priority = parseInt(params.get('priority') ?? '0', 10);
    const normalizedPriority = Number.isFinite(priority) ? priority : 0;
    const channelType = params.get('channelType')?.trim() || undefined;
    const taskKind = params.get('taskKind')?.trim() || undefined;

    if (type === 'runtime') {
      const validationMessage = this.context.buildRuntimePromptLayerValidationMessage([
        ...this.context.deps.promptStore.getAll(),
        {
          type,
          identifier: resolvedMetadata.metadata.identifier,
          content,
          enabled: true,
        },
      ]);
      if (validationMessage) {
        return { ok: false, message: validationMessage };
      }
    }

    try {
      const layer = this.context.deps.promptStore.create({
        type,
        name,
        content,
        priority: normalizedPriority,
        channelType,
        taskKind,
        identifier: resolvedMetadata.metadata.identifier,
        role: resolvedMetadata.metadata.role,
        promptOrder: resolvedMetadata.metadata.promptOrder,
        updatedBy: 'admin',
      });

      this.context.injectPromptEditSystemNote(
        `Admin created ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      this.context.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `Admin created ${layer.type} prompt layer "${layer.name}".`,
        [
          `layerId=${layer.id}`,
          `version=${layer.version}`,
          operatorActor ? `operatorActor=${operatorActor}` : null,
        ],
        requestContext,
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

  updatePromptLayer(body: string, requestContext?: GardenRequestContext): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const layerId = params.get('layerId') ?? params.get('id') ?? '';
    const name = params.get('name')?.trim();

    const resolved = this.context.resolvePromptLayerContent(params);
    if ('error' in resolved) {
      return { ok: false, message: resolved.error };
    }

    const resolvedMetadata = this.context.resolvePromptLayerMetadata(params);
    if ('error' in resolvedMetadata) {
      return { ok: false, message: resolvedMetadata.error };
    }

    const resolvedPriority = this.context.resolvePromptLayerPriority(params);
    if ('error' in resolvedPriority) {
      return { ok: false, message: resolvedPriority.error };
    }

    const hasMetadata = Object.keys(resolvedMetadata.metadata).length > 0;
    const hasContent = resolved.content !== undefined;
    const hasName = Boolean(name);
    const hasPriority = resolvedPriority.priority !== undefined;
    const hasIdentifier = Object.prototype.hasOwnProperty.call(resolvedMetadata.metadata, 'identifier');
    if (!hasName && !hasContent && !hasMetadata && !hasPriority) {
      return { ok: false, message: 'No prompt update fields provided' };
    }

    const existingLayer = this.context.deps.promptStore.getById(layerId);
    if (!existingLayer) {
      return { ok: false, message: `Prompt layer not found: ${layerId}` };
    }

    const operatorActor = this.operatorLayerActor(existingLayer.type, requestContext);
    if (operatorActor && !operatorActor.ok) return { ok: false, message: operatorActor.message };
    if (existingLayer.type === 'operator' && hasIdentifier) {
      const identifierError = operatorLayerIdentifierError(
        resolvedMetadata.metadata.identifier ?? undefined,
        this.context.deps.promptStore.getAll(),
        existingLayer.id,
      );
      if (identifierError) return { ok: false, message: identifierError };
    }

    if (existingLayer.type === 'runtime') {
      const validationMessage = this.context.buildRuntimePromptLayerValidationMessage(this.context.replacePromptLayerPreview({
        id: existingLayer.id,
        type: existingLayer.type,
        identifier: hasIdentifier ? resolvedMetadata.metadata.identifier : existingLayer.identifier,
        content: hasContent ? (resolved.content ?? '') : existingLayer.content,
        enabled: existingLayer.enabled,
      }));
      if (validationMessage) {
        return { ok: false, message: validationMessage };
      }
    }

    const patch: PromptLayerUpdatePatch = {};
    if (hasName) patch.name = name;
    if (hasContent) patch.content = resolved.content;
    if (hasMetadata) patch.metadata = resolvedMetadata.metadata;
    if (hasPriority) patch.priority = resolvedPriority.priority;

    try {
      const layer = this.context.deps.promptStore.update(
        layerId,
        patch,
        'admin',
        'Admin prompt-layer edit via Garden API',
      );
      this.context.injectPromptEditSystemNote(
        `Admin updated ${layer.type} prompt layer "${layer.name}" (v${layer.version}).`,
      );
      this.context.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `${this.context.resolveCompanionName()} edited ${layer.type} prompt layer "${layer.name}".`,
        [
          `layerId=${layer.id}`,
          `version=${layer.version}`,
          operatorActor?.ok ? `operatorActor=${operatorActor.actor}` : null,
        ],
        requestContext,
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
    const promptStore = this.context.deps.promptStore;
    const promptRuntimeLayoutStore = this.context.deps.promptRuntimeLayoutStore ?? null;
    const params = this.context.parseBody(body);
    const rawLayerIds = params.get('layerIds');
    const rawRuntimeBlockIds = params.get('runtimeBlockIds');

    let layerIds: string[] = [];
    if (rawLayerIds) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawLayerIds);
      } catch {
        return { ok: false, message: 'layerIds must be a JSON array of layer IDs' };
      }
      if (!Array.isArray(parsed)) {
        return { ok: false, message: 'layerIds must be a JSON array of layer IDs' };
      }

      for (const entry of parsed) {
        if (typeof entry !== 'string' || !entry.trim()) {
          return { ok: false, message: 'layerIds entries must be non-empty strings' };
        }
        layerIds.push(entry.trim());
      }
    }

    let runtimeBlockIds: PromptRuntimeSystemPromptBlockId[] = [];
    if (rawRuntimeBlockIds) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawRuntimeBlockIds);
      } catch {
        return { ok: false, message: 'runtimeBlockIds must be a JSON array of runtime block IDs' };
      }
      if (!Array.isArray(parsed)) {
        return { ok: false, message: 'runtimeBlockIds must be a JSON array of runtime block IDs' };
      }
      for (const entry of parsed) {
        if (typeof entry !== 'string' || !entry.trim()) {
          return { ok: false, message: 'runtimeBlockIds entries must be non-empty strings' };
        }
        runtimeBlockIds.push(entry.trim() as PromptRuntimeSystemPromptBlockId);
      }
    }

    if (layerIds.length === 0 && runtimeBlockIds.length === 0) {
      return { ok: false, message: 'layerIds or runtimeBlockIds is required' };
    }

    try {
      const touched = layerIds.length > 0
        ? promptStore.reorderByLayerIds(
          layerIds,
          'admin',
          'Admin prompt-layer reorder via Garden API',
        )
        : [];
      const runtimeLayoutTouched = promptRuntimeLayoutStore && runtimeBlockIds.length > 0
        ? promptRuntimeLayoutStore.reorderSystemPromptBlocks(runtimeBlockIds, 'admin')
        : null;

      if (touched.length > 0 || runtimeLayoutTouched) {
        const noteParts = [
          touched.length > 0
            ? `${touched.length} prompt layer${touched.length === 1 ? '' : 's'}`
            : null,
          runtimeLayoutTouched
            ? `${runtimeLayoutTouched.systemPromptBlockOrder.length} runtime prompt block${runtimeLayoutTouched.systemPromptBlockOrder.length === 1 ? '' : 's'}`
            : null,
        ].filter((entry): entry is string => entry != null);
        this.context.injectPromptEditSystemNote(
          `Admin reordered ${noteParts.join(' and ')}.`,
        );
      }

      const summaryParts = [
        touched.length > 0
          ? `Reordered ${touched.length} prompt layer${touched.length === 1 ? '' : 's'}`
          : null,
        runtimeLayoutTouched
          ? 'updated runtime prompt block order'
          : null,
      ].filter((entry): entry is string => entry != null);

      return {
        ok: true,
        message: summaryParts.length > 0
          ? summaryParts.join('; ')
          : 'Prompt stack already in requested order',
      };
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }
  }

  updatePromptRegistry(body: string): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const key = params.get('key') ?? '';
    const content = params.get('content') ?? '';
    try {
      const staticPrompt = this.context.getPromptRegistry().update(key, content, 'admin');
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

  togglePromptLayer(body: string, requestContext?: GardenRequestContext): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const layerId = params.get('layerId') ?? '';

    const existingLayer = this.context.deps.promptStore.getById(layerId);
    if (!existingLayer) {
      return { ok: false, message: `Prompt layer not found: ${layerId}` };
    }
    const operatorActor = this.operatorLayerActor(existingLayer.type, requestContext);
    if (operatorActor && !operatorActor.ok) return { ok: false, message: operatorActor.message };

    if (existingLayer.type === 'runtime') {
      const validationMessage = this.context.buildRuntimePromptLayerValidationMessage(this.context.replacePromptLayerPreview({
        id: existingLayer.id,
        type: existingLayer.type,
        identifier: existingLayer.identifier,
        content: existingLayer.content,
        enabled: !existingLayer.enabled,
      }));
      if (validationMessage) {
        return { ok: false, message: validationMessage };
      }
    }

    try {
      this.context.deps.promptStore.toggle(layerId);
      const toggledLayer = this.context.deps.promptStore.getById(layerId);
      if (operatorActor?.ok && toggledLayer) {
        this.context.deps.appendAuditTimelineEntry?.(
          'identity_edit',
          'allowed',
          `Admin ${toggledLayer.enabled ? 'enabled' : 'disabled'} operator prompt layer "${toggledLayer.name}".`,
          [`layerId=${toggledLayer.id}`, `operatorActor=${operatorActor.actor}`],
          requestContext,
        );
      }
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

  /**
   * Delete an operator-authored prompt layer (psfn-framework-c5e65). Only
   * operator layers are deletable here; the system-seeded temporal rules layer
   * is disabled instead of deleted, since startup re-seeds it.
   */
  deletePromptLayer(body: string, requestContext?: GardenRequestContext): PromptUpdateResult {
    const params = this.context.parseBody(body);
    const layerId = params.get('layerId') ?? '';
    const existingLayer = this.context.deps.promptStore.getById(layerId);
    if (!existingLayer) {
      return { ok: false, message: `Prompt layer not found: ${layerId}` };
    }
    if (existingLayer.type !== 'operator') {
      return { ok: false, message: 'Only operator prompt layers can be deleted through this route' };
    }
    const writer = resolveOperatorLayerWriter(requestContext);
    if (!writer.ok) return { ok: false, message: writer.message };
    if (existingLayer.updatedBy === 'system' || existingLayer.updatedBy.startsWith('system:')) {
      return { ok: false, message: 'System-seeded operator prompt layers are re-seeded; disable them instead' };
    }
    try {
      this.context.deps.promptStore.delete(existingLayer.id);
      this.context.injectPromptEditSystemNote(
        `Admin deleted operator prompt layer "${existingLayer.name}".`,
      );
      this.context.deps.appendAuditTimelineEntry?.(
        'identity_edit',
        'allowed',
        `Admin deleted operator prompt layer "${existingLayer.name}".`,
        [
          `layerId=${existingLayer.id}`,
          `version=${existingLayer.version}`,
          `operatorActor=${writer.actor}`,
        ],
        requestContext,
      );
      return { ok: true, message: `Deleted "${existingLayer.name}"` };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  }

  /** Operator-layer writes require the audited operator; other types are unaffected. */
  private operatorLayerActor(
    type: LayerType,
    requestContext: GardenRequestContext | undefined,
  ): ReturnType<typeof resolveOperatorLayerWriter> | null {
    return type === 'operator' ? resolveOperatorLayerWriter(requestContext) : null;
  }
}
