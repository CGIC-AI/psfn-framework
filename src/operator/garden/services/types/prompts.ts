import type { PromptLayerMetadataUpdate } from '../../../../core/identity/prompt-store.js';
import type {
  PromptRegistryEntry,
  PromptRegistryHistoryEntry,
} from '../../../../core/identity/prompt-registry.js';
import type {
  PromptRuntimeBlockId,
  PromptRuntimeBlockPlacement,
  PromptRuntimeBlockSchemaClassification,
  PromptRuntimeBlockVisibility,
  PromptRuntimeEditableBlockId,
  PromptRuntimeMacroHint,
} from '../../../../core/identity/prompt-runtime.js';
import type {
  PromptHistoryEntry,
  PromptLayer,
} from '../../../../core/identity/prompt-types.js';
import type { RuntimePromptLayerSchemaClassification } from '../../../../core/identity/runtime-prompt-layers.js';
import type {
  NorthStarItem,
  NorthStarScope,
} from '../../../../faculties/north-star/store.js';

export interface AdminPromptListData {
  layers: PromptLayer[];
  staticPrompts: PromptRegistryEntry[];
  runtimeBlocks: AdminPromptRuntimeBlock[];
  runtimeLayerCoverage: AdminRuntimePromptLayerCoverage;
  runtimeMacroHints: AdminPromptRuntimeMacroHint[];
}

export interface AdminPromptRuntimeBlock {
  id: PromptRuntimeBlockId;
  label: string;
  description: string;
  source: string;
  schemaClassification: PromptRuntimeBlockSchemaClassification;
  required: boolean;
  immutable: boolean;
  providerManaged: boolean;
  placement: PromptRuntimeBlockPlacement;
  visibility: PromptRuntimeBlockVisibility;
  reorderable: boolean;
  contentVisible: boolean;
  companionEditable: boolean;
  customContent?: string;
  lockedReason?: string;
  effectiveOrder: number;
}

export interface AdminRuntimePromptLayerCoverageEntry {
  identifier: string;
  name: string;
  classification: RuntimePromptLayerSchemaClassification;
  required: boolean;
  status: 'valid' | 'missing' | 'disabled' | 'empty';
  layerId?: string;
}

export interface AdminRuntimePromptLayerCoverage {
  ok: boolean;
  entries: AdminRuntimePromptLayerCoverageEntry[];
}

export interface AdminPromptRuntimeMacroHint extends PromptRuntimeMacroHint {}

export interface AdminConstitutionImmutableBlock {
  id: string;
  title: string;
  content: string;
  editable: false;
}

export interface AdminConstitutionCompanionLayer {
  id: string;
  title: string;
  content: string;
  provenanceRefs: string[];
  historyVersions: number[];
  entryIds: string[];
  editable: false;
}

export interface AdminConstitutionMutableLayer extends PromptLayer {
  editable: boolean;
  readOnlyReason?: string;
}

export interface AdminFoundationSection {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  defaultEnabled: boolean;
}

export interface AdminFoundationPreview {
  text: string;
  hash: string;
}

export interface AdminFoundationSnapshotData {
  layerId: string;
  layerName: string;
  sections: AdminFoundationSection[];
  preview: AdminFoundationPreview;
}

export interface AdminConstitutionPreview {
  text: string;
  hash: string;
  staticPrefix: string;
  dynamicSuffix: string;
}

export interface AdminConstitutionSnapshotData {
  immutableBlocks: AdminConstitutionImmutableBlock[];
  companionLayer: AdminConstitutionCompanionLayer | null;
  mutableLayers: AdminConstitutionMutableLayer[];
  preview: AdminConstitutionPreview;
}

export interface AdminNorthStarItem extends NorthStarItem {
  scope: NorthStarScope;
}

export interface AdminNorthStarPreview {
  text: string;
  hash: string;
}

export interface AdminNorthStarSnapshotData {
  items: AdminNorthStarItem[];
  limit: number;
  preview: AdminNorthStarPreview;
}

export interface AdminPromptDetailData {
  layer?: PromptLayer;
  layerHistory?: PromptHistoryEntry[];
  staticPrompt?: PromptRegistryEntry;
  staticPromptHistory?: PromptRegistryHistoryEntry[];
}

export interface PromptUpdateResult {
  ok: boolean;
  message: string;
  layer?: PromptLayer;
  staticPrompt?: PromptRegistryEntry;
}

export interface ConstitutionUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminConstitutionSnapshotData;
}

export interface FoundationUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminFoundationSnapshotData;
}

export interface NorthStarUpdateResult {
  ok: boolean;
  message: string;
  snapshot?: AdminNorthStarSnapshotData;
}

export interface RuntimePromptUpdateResult {
  ok: boolean;
  message: string;
  updated?: PromptRuntimeEditableBlockId[];
}

export interface AdminPromptsService {
  listPrompts(): AdminPromptListData;
  getFoundationSnapshot(): AdminFoundationSnapshotData | null;
  saveFoundationSections(body: string): FoundationUpdateResult;
  getConstitutionSnapshot(): AdminConstitutionSnapshotData;
  saveConstitutionMutableLayers(body: string): ConstitutionUpdateResult;
  getNorthStarSnapshot(): AdminNorthStarSnapshotData | null;
  saveNorthStarItems(body: string): NorthStarUpdateResult;
  saveRuntimePromptBlocks(body: string): RuntimePromptUpdateResult;
  getPromptDetail(layerId: string): AdminPromptDetailData | null;
  getStaticPromptDetail(key: string): AdminPromptDetailData | null;
  createPromptLayer(body: string): PromptUpdateResult;
  updatePromptLayer(body: string): PromptUpdateResult;
  updatePromptRegistry(body: string): PromptUpdateResult;
  togglePromptLayer(body: string): PromptUpdateResult;
  rollbackPromptLayer(body: string): PromptUpdateResult;
  rollbackPromptRegistry(body: string): PromptUpdateResult;
  previewPromptLayerDiff(body: string): { oldContent: string; newContent: string } | null;
  resolvePromptLayerMetadata(params: URLSearchParams): { metadata: PromptLayerMetadataUpdate } | { error: string };
  reorderPromptLayers(body: string): PromptUpdateResult;
}
