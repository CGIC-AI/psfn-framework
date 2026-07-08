import {
  getRequiredRuntimePromptSignalManifest,
  validateRuntimePromptLayerCoverage,
} from '../../../core/identity/runtime-prompt-layers.js';
import {
  PROMPT_RUNTIME_MACRO_HINTS,
  getPromptRuntimeBlockDefinition,
  getPromptRuntimeBlockDefinitions,
  isPromptRuntimeBlockCompanionEditable,
  type PromptRuntimeBlockId,
  type PromptRuntimeEditableBlockId,
  type PromptRuntimeSystemPromptBlockId,
} from '../../../core/identity/prompt-runtime.js';
import type {
  AdminPromptListData,
  AdminPromptRuntimeBlock,
  AdminRuntimePromptLayerCoverage,
  AdminRuntimePromptLayerCoverageEntry,
  RuntimePromptUpdateResult,
} from './types.js';
import type { AdminPromptsServiceContext } from './prompts-service-context.js';

export class PromptsRuntimeService {
  constructor(private readonly context: AdminPromptsServiceContext) {}

  listPrompts(): AdminPromptListData {
    const runtimeBlocks = this.listRuntimeBlocks();
    return {
      layers: this.context.deps.promptStore.getAll(),
      staticPrompts: this.context.deps.promptRegistry?.list() ?? [],
      runtimeBlocks,
      runtimeLayerCoverage: this.listRuntimeLayerCoverage(),
      runtimeMacroHints: PROMPT_RUNTIME_MACRO_HINTS.map((hint) => ({ ...hint })),
    };
  }

  private listRuntimeBlocks(): AdminPromptRuntimeBlock[] {
    const defaultSystemOrder = getPromptRuntimeBlockDefinitions()
      .filter(block => block.placement === 'system_prompt' && block.reorderable)
      .map(block => block.id as PromptRuntimeSystemPromptBlockId);
    const runtimeLayout = this.context.deps.promptRuntimeLayoutStore?.getLayout();
    const systemOrder = runtimeLayout?.systemPromptBlockOrder ?? defaultSystemOrder;
    const systemOrderIndex = new Map(systemOrder.map((id, index) => [id, index]));
    const customContentByBlockId = runtimeLayout?.editableBlockContent ?? {};

    return getPromptRuntimeBlockDefinitions()
      .map((block): AdminPromptRuntimeBlock => ({
        id: block.id,
        label: block.label,
        description: block.description,
        source: block.source,
        schemaClassification: block.schema.classification,
        required: block.schema.required,
        immutable: block.schema.immutable,
        providerManaged: block.schema.providerManaged,
        placement: block.placement,
        visibility: block.visibility,
        reorderable: block.reorderable,
        contentVisible: block.contentVisible,
        lockedReason: block.lockedReason,
        companionEditable: block.companionEditable === true,
        effectiveOrder: block.placement === 'system_prompt'
          ? (
              block.reorderable
                ? (systemOrderIndex.get(block.id as PromptRuntimeSystemPromptBlockId) ?? Number.MAX_SAFE_INTEGER)
                : systemOrder.length
            )
          : (
              block.placement === 'context_messages'
                ? systemOrder.length + 1
                : systemOrder.length + 2
          ),
        customContent: block.companionEditable === true
          ? (customContentByBlockId[block.id as PromptRuntimeEditableBlockId] ?? '')
          : undefined,
      }))
      .sort((left, right) => {
        if (left.effectiveOrder !== right.effectiveOrder) {
          return left.effectiveOrder - right.effectiveOrder;
        }
        return left.label.localeCompare(right.label);
      });
  }

  private listRuntimeLayerCoverage(): AdminRuntimePromptLayerCoverage {
    const layers = this.context.deps.promptStore.getAll();
    const validation = validateRuntimePromptLayerCoverage(layers);
    const issueByIdentifier = new Map<string, AdminRuntimePromptLayerCoverageEntry['status']>(
      validation.issues.map((issue) => [issue.identifier, issue.reason] as const),
    );

    return {
      ok: validation.ok,
      entries: getRequiredRuntimePromptSignalManifest().map((definition) => {
        const layer = layers.find((entry) => (
          entry.type === 'runtime'
          && entry.identifier === definition.identifier
        ));
        return {
          identifier: definition.identifier,
          name: definition.name,
          classification: definition.classification,
          required: definition.required,
          status: issueByIdentifier.get(definition.identifier) ?? 'valid',
          ...(layer ? { layerId: layer.id } : {}),
        };
      }),
    };
  }

  saveRuntimePromptBlocks(body: string): RuntimePromptUpdateResult {
    const promptRuntimeLayoutStore = this.context.deps.promptRuntimeLayoutStore;
    if (!promptRuntimeLayoutStore) {
      return { ok: false, message: 'Runtime prompt layout store is not configured' };
    }

    const params = this.context.parseBody(body);
    const rawBlocks = params.get('blocks');
    if (!rawBlocks) {
      return { ok: false, message: 'blocks is required' };
    }

    let parsedBlocks: unknown;
    try {
      parsedBlocks = JSON.parse(rawBlocks);
    } catch {
      return { ok: false, message: 'blocks must be a JSON array' };
    }

    if (!Array.isArray(parsedBlocks)) {
      return { ok: false, message: 'blocks must be a JSON array' };
    }

    const updated: PromptRuntimeEditableBlockId[] = [];
    const nextContent: Partial<Record<PromptRuntimeEditableBlockId, string>> = {};
    const mergedContent = promptRuntimeLayoutStore.getEditableBlockContentMap();
    const seen = new Set<PromptRuntimeEditableBlockId>();
    for (const entry of parsedBlocks) {
      if (!entry || typeof entry !== 'object') {
        return { ok: false, message: 'blocks entries must be objects' };
      }
      const block = entry as Record<string, unknown>;
      if (typeof block.id !== 'string' || !block.id.trim()) {
        return { ok: false, message: 'blocks entries require a valid block id' };
      }
      if (typeof block.content !== 'string') {
        return { ok: false, message: `block "${block.id}" content must be a string` };
      }
      const definition = getPromptRuntimeBlockDefinition(block.id as PromptRuntimeBlockId);
      if (!definition || !isPromptRuntimeBlockCompanionEditable(definition)) {
        return { ok: false, message: this.context.buildRuntimePromptBlockEditabilityMessage(block.id) };
      }

      const editableId = definition.id as PromptRuntimeEditableBlockId;
      if (seen.has(editableId)) {
        return { ok: false, message: `duplicate runtime block id: ${editableId}` };
      }

      const trimmedContent = block.content.trim();
      if (definition.schema.required && trimmedContent.length === 0) {
        return {
          ok: false,
          message: `block "${editableId}" (${definition.label}) is required and cannot be blank`,
        };
      }

      seen.add(editableId);
      nextContent[editableId] = block.content;
      if (trimmedContent.length > 0) {
        mergedContent[editableId] = trimmedContent;
      } else {
        delete mergedContent[editableId];
      }
      updated.push(editableId);
    }

    const validationMessage = this.context.buildRuntimePromptBlockValidationMessage(mergedContent);
    if (validationMessage) {
      return { ok: false, message: validationMessage };
    }

    try {
      if (updated.length > 0) {
        promptRuntimeLayoutStore.setEditableBlockContents(nextContent, 'admin');
      }
    } catch (error) {
      return {
        ok: false,
        message: String(error),
      };
    }

    if (updated.length > 0) {
      this.context.injectPromptEditSystemNote(`Admin updated ${updated.length} companion runtime guidance block${updated.length === 1 ? '' : 's'}.`);
    }

    return {
      ok: true,
      message: updated.length > 0
        ? `Updated ${updated.length} runtime guidance block${updated.length === 1 ? '' : 's'}`
        : 'No runtime guidance blocks updated',
      updated,
    };
  }
}
