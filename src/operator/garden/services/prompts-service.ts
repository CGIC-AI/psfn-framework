import type { PromptLayerMetadataUpdate } from '../../../core/identity/prompt-store.js';
import type {
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
  RuntimePromptUpdateResult,
} from './types.js';
import {
  AdminPromptsServiceContext,
  type AdminPromptsDataServiceDeps,
} from './prompts-service-context.js';
import { PromptsHistoryService } from './prompts-history-service.js';
import { PromptsLayerService } from './prompts-layer-service.js';
import { PromptsRuntimeService } from './prompts-runtime-service.js';
import { PromptsSnapshotService } from './prompts-snapshot-service.js';

export class AdminPromptsDataService implements AdminPromptsService {
  private readonly context: AdminPromptsServiceContext;
  private readonly history: PromptsHistoryService;
  private readonly layers: PromptsLayerService;
  private readonly runtime: PromptsRuntimeService;
  private readonly snapshots: PromptsSnapshotService;

  constructor(deps: AdminPromptsDataServiceDeps) {
    this.context = new AdminPromptsServiceContext(deps);
    this.history = new PromptsHistoryService(this.context);
    this.layers = new PromptsLayerService(this.context);
    this.runtime = new PromptsRuntimeService(this.context);
    this.snapshots = new PromptsSnapshotService(this.context);
  }

  listPrompts(): AdminPromptListData {
    return this.runtime.listPrompts();
  }

  getFoundationSnapshot(): AdminFoundationSnapshotData | null {
    return this.snapshots.getFoundationSnapshot();
  }

  saveFoundationSections(body: string): FoundationUpdateResult {
    return this.snapshots.saveFoundationSections(body);
  }

  getConstitutionSnapshot(): AdminConstitutionSnapshotData {
    return this.snapshots.getConstitutionSnapshot();
  }

  saveConstitutionMutableLayers(body: string): ConstitutionUpdateResult {
    return this.snapshots.saveConstitutionMutableLayers(body);
  }

  getNorthStarSnapshot(): AdminNorthStarSnapshotData | null {
    return this.snapshots.getNorthStarSnapshot();
  }

  saveNorthStarItems(body: string): NorthStarUpdateResult {
    return this.snapshots.saveNorthStarItems(body);
  }

  saveRuntimePromptBlocks(body: string): RuntimePromptUpdateResult {
    return this.runtime.saveRuntimePromptBlocks(body);
  }

  getPromptDetail(layerId: string): AdminPromptDetailData | null {
    return this.history.getPromptDetail(layerId);
  }

  getStaticPromptDetail(key: string): AdminPromptDetailData | null {
    return this.history.getStaticPromptDetail(key);
  }

  createPromptLayer(body: string): PromptUpdateResult {
    return this.layers.createPromptLayer(body);
  }

  updatePromptLayer(body: string): PromptUpdateResult {
    return this.layers.updatePromptLayer(body);
  }

  updatePromptRegistry(body: string): PromptUpdateResult {
    return this.layers.updatePromptRegistry(body);
  }

  togglePromptLayer(body: string): PromptUpdateResult {
    return this.layers.togglePromptLayer(body);
  }

  rollbackPromptLayer(body: string): PromptUpdateResult {
    return this.history.rollbackPromptLayer(body);
  }

  rollbackPromptRegistry(body: string): PromptUpdateResult {
    return this.history.rollbackPromptRegistry(body);
  }

  previewPromptLayerDiff(body: string): { oldContent: string; newContent: string } | null {
    return this.history.previewPromptLayerDiff(body);
  }

  resolvePromptLayerMetadata(
    params: URLSearchParams,
  ): { metadata: PromptLayerMetadataUpdate } | { error: string } {
    return this.context.resolvePromptLayerMetadata(params);
  }

  reorderPromptLayers(body: string): PromptUpdateResult {
    return this.layers.reorderPromptLayers(body);
  }
}
