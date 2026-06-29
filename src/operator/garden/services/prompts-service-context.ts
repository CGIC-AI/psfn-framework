import { createHash } from 'node:crypto';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import { DEFAULT_COMPANION_NAME } from '../../../core/identity/companion-naming.js';
import {
  PROMPT_LAYER_ROLES,
  type CompanionValuesLayerSnapshot,
  type PromptLayer,
  type PromptLayerRole,
} from '../../../core/identity/prompt-types.js';
import {
  validateRuntimePromptLayerCoverage,
} from '../../../core/identity/runtime-prompt-layers.js';
import {
  getPromptRuntimeBlockDefinition,
  PromptRuntimeLayoutStore,
  validatePromptRuntimeEditableBlockContents,
  type PromptRuntimeBlockId,
  type PromptRuntimeEditableBlockId,
} from '../../../core/identity/prompt-runtime.js';
import {
  IMMUTABLE_HUMAN_SAFETY_AMENDMENTS,
  buildImmutableHumanSafetySection,
} from '../../../core/identity/prompt-composer.js';
import type {
  PromptLayerMetadataUpdate,
} from '../../../core/identity/prompt-store.js';
import type {
  PromptLayerStatePort,
  PromptRegistryStatePort,
} from '../../../core/identity/prompt-state-port.js';
import {
  isCanonicalCharacterFoundationLayer,
} from '../../../core/identity/canonical-foundation.js';
import {
  NORTH_STAR_SCOPES,
  type NorthStarScope,
  type NorthStarStore,
} from '../../../faculties/north-star/store.js';
import {
  containsStructuredPromptSections,
  getMalformedStructuredPromptErrors,
  parseStructuredPromptForm,
} from '../prompt-structured-content.js';
import {
  FOUNDATION_SECTION_DEFINITIONS,
  type FoundationSectionId,
} from '../../../core/identity/foundation-sections.js';
import type {
  AdminConstitutionCompanionLayer,
  AdminConstitutionImmutableBlock,
  AdminConstitutionMutableLayer,
  AdminConstitutionSnapshotData,
} from './types.js';

export const CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX = 'constitution:immutable:';
export const CONSTITUTION_COMPANION_LAYER_ID = 'constitution:companion-derived-values';
type FoundationSectionIdentifier = (typeof FOUNDATION_SECTION_DEFINITIONS)[number]['identifier'];
const FOUNDATION_SECTION_IDENTIFIER_SET = new Set<string>(
  FOUNDATION_SECTION_DEFINITIONS.map(section => section.identifier),
);

export interface AdminPromptsDataServiceDeps {
  promptStore: PromptLayerStatePort;
  promptRegistry?: PromptRegistryStatePort | null;
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
  promptRuntimeLayoutStore?: PromptRuntimeLayoutStore | null;
}

export interface ConstitutionMutableLayerPatchInput {
  id: string;
  content?: string;
  enabled?: boolean;
  identifier?: string | null;
  role?: string | null;
  promptOrder?: number | null;
}

export interface FoundationSectionPatchInput {
  id: FoundationSectionId;
  content: string;
  enabled: boolean;
}

export interface NorthStarItemInput {
  id?: string;
  title: string;
  content: string;
  scope: NorthStarScope;
  enabled: boolean;
}

export class AdminPromptsServiceContext {
  constructor(readonly deps: AdminPromptsDataServiceDeps) {}

  resolveCompanionName(): string {
    return this.deps.resolveCompanionName?.() ?? DEFAULT_COMPANION_NAME;
  }

  hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  parseBody(body: string): URLSearchParams {
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

  injectPromptEditSystemNote(note: string): void {
    if (!this.deps.sessionStore || !this.deps.sessionManager) return;
    const targetChannels = [...new Set(
      this.deps.sessionStore
        .listChannels()
        .map(channel => channel.channelId)
        .filter(
          channelId => !channelId.startsWith('internal:')
            && !channelId.startsWith('subagent:')
            && !channelId.startsWith('shard:'),
        ),
    )];

    for (const channelId of targetChannels) {
      this.deps.sessionManager.appendSystemNote(channelId, note);
    }
  }

  resolvePromptLayerContent(params: URLSearchParams): { content?: string } | { error: string } {
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

  resolvePromptLayerPriority(
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

  buildRuntimePromptLayerValidationMessage(
    layers: readonly Pick<PromptLayer, 'type' | 'identifier' | 'content' | 'enabled'>[],
  ): string | null {
    const validation = validateRuntimePromptLayerCoverage(layers);
    if (validation.ok) {
      return null;
    }

    const formatIssue = (
      issue: { identifier: string; name: string },
    ): string => `${issue.identifier} (${issue.name})`;
    const missing = validation.issues
      .filter(issue => issue.reason === 'missing')
      .map(formatIssue);
    const invalid = validation.issues
      .filter(issue => issue.reason !== 'missing')
      .map(formatIssue);
    const parts: string[] = [];

    if (missing.length > 0) {
      parts.push(
        `missing required runtime prompt signal${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      );
    }
    if (invalid.length > 0) {
      parts.push(
        `invalid required runtime prompt signal${invalid.length === 1 ? '' : 's'}: ${invalid.join(', ')} (required runtime prompt signals must stay covered by enabled runtime layers with non-empty content)`,
      );
    }

    return `Cannot save runtime prompt changes: ${parts.join('; ')}`;
  }

  buildRuntimePromptBlockEditabilityMessage(blockId: string): string {
    const definition = getPromptRuntimeBlockDefinition(blockId as PromptRuntimeBlockId);
    if (!definition) {
      return `Unknown runtime block "${blockId}"`;
    }
    if (definition.schema.providerManaged) {
      return `block "${definition.id}" (${definition.label}) is provider-managed and cannot be edited`;
    }
    if (definition.schema.immutable) {
      return `block "${definition.id}" (${definition.label}) is immutable and cannot be edited`;
    }
    return `block "${definition.id}" (${definition.label}) is not companion-editable`;
  }

  buildRuntimePromptBlockValidationMessage(
    blocks: Partial<Record<PromptRuntimeEditableBlockId, string>>,
  ): string | null {
    const validation = validatePromptRuntimeEditableBlockContents(blocks);
    if (validation.ok) {
      return null;
    }

    const formatIssue = (
      issue: { id: PromptRuntimeEditableBlockId; label: string },
    ): string => `${issue.id} (${issue.label})`;
    const missing = validation.issues
      .filter(issue => issue.reason === 'missing')
      .map(formatIssue);
    const blank = validation.issues
      .filter(issue => issue.reason === 'empty')
      .map(formatIssue);
    const parts: string[] = [];

    if (missing.length > 0) {
      parts.push(
        `missing required companion-editable runtime block${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      );
    }
    if (blank.length > 0) {
      parts.push(
        `blank required companion-editable runtime block${blank.length === 1 ? '' : 's'}: ${blank.join(', ')}`,
      );
    }

    return `Cannot save runtime prompt changes: ${parts.join('; ')}`;
  }

  replacePromptLayerPreview(
    nextLayer: Pick<PromptLayer, 'id' | 'type' | 'identifier' | 'content' | 'enabled'>,
  ): Array<Pick<PromptLayer, 'id' | 'type' | 'identifier' | 'content' | 'enabled'>> {
    return this.deps.promptStore.getAll().map(layer => layer.id === nextLayer.id ? nextLayer : layer);
  }

  getPromptRegistry(): PromptRegistryStatePort {
    const registry = this.deps.promptRegistry;
    if (!registry) {
      throw new Error('Prompt registry is not configured');
    }
    return registry;
  }

  getFoundationLayers() {
    const layers = this.deps.promptStore.getAll().filter(layer => isCanonicalCharacterFoundationLayer(layer));
    const orderByIdentifier = new Map(
      FOUNDATION_SECTION_DEFINITIONS.map((section, index) => [section.identifier, index] as const),
    );
    const resolveOrder = (identifier: string | undefined): number => (
      identifier && FOUNDATION_SECTION_IDENTIFIER_SET.has(identifier)
        ? orderByIdentifier.get(identifier as FoundationSectionIdentifier) ?? Number.MAX_SAFE_INTEGER
        : Number.MAX_SAFE_INTEGER
    );
    return layers.sort((left, right) => {
      const leftOrder = resolveOrder(left.identifier);
      const rightOrder = resolveOrder(right.identifier);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.priority - right.priority;
    });
  }

  buildImmutableConstitutionBlocks(): AdminConstitutionImmutableBlock[] {
    return IMMUTABLE_HUMAN_SAFETY_AMENDMENTS.map((amendment, index) => ({
      id: `${CONSTITUTION_IMMUTABLE_LAYER_ID_PREFIX}${String(index + 1)}`,
      title: `Immutable Amendment ${String(index + 1)}`,
      content: amendment,
      editable: false as const,
    }));
  }

  buildConstitutionPreview(
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

  resolveCompanionLayerSnapshot(): AdminConstitutionCompanionLayer | null {
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

  getNorthStarStore(): NorthStarStore | null {
    return this.deps.northStarStore ?? null;
  }

  parseNorthStarItemInput(value: unknown): NorthStarItemInput | { error: string } {
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
}
