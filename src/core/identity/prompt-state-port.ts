import type {
  PromptLayerMetadataUpdate,
  PromptLayerUpdatePatch,
} from './prompt-store.js';
import type {
  PromptRegistryEntry,
  PromptRegistryHistoryEntry,
  PromptRegistryKey,
} from './prompt-registry.js';
import type {
  LayerType,
  PromptHistoryEntry,
  PromptLayer,
  PromptLayerRole,
} from './prompt-types.js';

export interface PromptLayerStatePort {
  readonly count: number;
  getAll(): PromptLayer[];
  getById(id: string): PromptLayer | undefined;
  getByType(type: LayerType): PromptLayer[];
  create(params: {
    type: LayerType;
    name: string;
    content: string;
    enabled?: boolean;
    identifier?: string;
    role?: PromptLayerRole;
    promptOrder?: number;
    priority?: number;
    channelType?: string;
    taskKind?: string;
    updatedBy?: string;
  }): PromptLayer;
  update(
    id: string,
    content: string,
    updatedBy: string,
    metadata?: PromptLayerMetadataUpdate,
    reason?: string,
  ): PromptLayer;
  update(
    id: string,
    patch: PromptLayerUpdatePatch,
    updatedBy: string,
    reason?: string,
  ): PromptLayer;
  reorderByLayerIds(layerIds: string[], updatedBy: string, reason?: string): PromptLayer[];
  toggle(id: string): PromptLayer;
  delete(id: string): void;
  getLayerHistory(layerId: string): PromptHistoryEntry[];
  rollback(layerId: string, version: number): PromptLayer;
  seedFromCharacterCard(systemPrompt: string): boolean;
}

export interface PromptRegistryStatePort {
  list(): PromptRegistryEntry[];
  getByKey(key: string): PromptRegistryEntry | undefined;
  getPrompt(key: PromptRegistryKey): string;
  update(key: string, text: string, updatedBy: string): PromptRegistryEntry;
  rollback(key: string, version: number): PromptRegistryEntry;
  getPromptHistory(key: string): PromptRegistryHistoryEntry[];
}

export interface PromptStatePort {
  layers: PromptLayerStatePort | null;
  registry: PromptRegistryStatePort | null;
}

export function createPromptLayerStatePort(store: PromptLayerStatePort): PromptLayerStatePort {
  return {
    get count() {
      return store.count;
    },
    getAll: () => store.getAll(),
    getById: (id) => store.getById(id),
    getByType: (type) => store.getByType(type),
    create: (params) => store.create(params),
    update: (
      id: string,
      contentOrPatch: string | PromptLayerUpdatePatch,
      updatedBy: string,
      metadataOrReason?: PromptLayerMetadataUpdate | string,
      reasonArg?: string,
    ) => (
      typeof contentOrPatch === 'string'
        ? store.update(id, contentOrPatch, updatedBy, metadataOrReason as PromptLayerMetadataUpdate | undefined, reasonArg)
        : store.update(id, contentOrPatch, updatedBy, typeof metadataOrReason === 'string' ? metadataOrReason : reasonArg)
    ),
    reorderByLayerIds: (layerIds, updatedBy, reason) => store.reorderByLayerIds(layerIds, updatedBy, reason),
    toggle: (id) => store.toggle(id),
    delete: (id) => store.delete(id),
    getLayerHistory: (layerId) => store.getLayerHistory(layerId),
    rollback: (layerId, version) => store.rollback(layerId, version),
    seedFromCharacterCard: (systemPrompt) => store.seedFromCharacterCard(systemPrompt),
  };
}

export function createPromptRegistryStatePort(store: PromptRegistryStatePort): PromptRegistryStatePort {
  return {
    list: () => store.list(),
    getByKey: (key) => store.getByKey(key),
    getPrompt: (key) => store.getPrompt(key),
    update: (key, text, updatedBy) => store.update(key, text, updatedBy),
    rollback: (key, version) => store.rollback(key, version),
    getPromptHistory: (key) => store.getPromptHistory(key),
  };
}

export function createPromptStatePort(options: {
  layers?: PromptLayerStatePort | null;
  registry?: PromptRegistryStatePort | null;
}): PromptStatePort {
  return {
    layers: options.layers ? createPromptLayerStatePort(options.layers) : null,
    registry: options.registry ? createPromptRegistryStatePort(options.registry) : null,
  };
}
