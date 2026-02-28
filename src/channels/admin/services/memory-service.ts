import { randomUUID } from 'node:crypto';
import type { EmbeddingService } from '../../../agent/contracts.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { MemoryLink, MemoryStore } from '../../../memory/store.js';
import { VALID_MEMORY_TYPES, type MemoryType } from '../../../memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../trust/types.js';
import type {
  AdminBulkMutationResult,
  AdminMemoryDetailData,
  AdminMemoryLinkResult,
  AdminMemoryListData,
  AdminMemorySearchResult,
  AdminMemoryService,
  MemoryMutationResult,
} from './types.js';

const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;

function parsePositiveInteger(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export class AdminMemoryDataService implements AdminMemoryService {
  constructor(private readonly deps: {
    memoryStore: MemoryStore;
    contactStore?: ContactStore | null;
    embeddingService?: EmbeddingService | null;
    appendAuditTimelineEntry?: (
      actionType: 'memory_mutation',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
    ) => void;
  }) {}

  private buildContactSummaryMap(): Map<string, { id: string; displayName: string }> {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    for (const contact of contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  listMemories(params?: URLSearchParams): AdminMemoryListData {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_MEMORY_LIST_LIMIT,
      1,
      MAX_MEMORY_LIST_LIMIT,
    );
    const offset = parsePositiveInteger(params?.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const memories = this.deps.memoryStore.listActiveMemories({ limit, offset });
    const total = this.deps.memoryStore.countActiveMemories();
    return {
      memories,
      contactsById: this.buildContactSummaryMap(),
      pagination: {
        limit,
        offset,
        total,
        hasPrevious: offset > 0,
        hasNext: offset + memories.length < total,
      },
    };
  }

  getMemoryDetail(id: string): AdminMemoryDetailData | null {
    const memory = this.deps.memoryStore.getById(id);
    if (!memory) return null;
    const linkedContact = memory.contactId
      ? this.buildContactSummaryMap().get(memory.contactId)
      : undefined;
    return {
      memory,
      linkedContact,
    };
  }

  async searchMemories(query: string): Promise<AdminMemorySearchResult> {
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) {
      return {
        query,
        results: [],
        contactsById: this.buildContactSummaryMap(),
      };
    }
    const embedding = await embeddingService.embed(query);
    return {
      query,
      results: this.deps.memoryStore.searchByEmbedding(embedding, 0.1, 50),
      contactsById: this.buildContactSummaryMap(),
    };
  }

  supersedeMemory(id: string): MemoryMutationResult {
    const memory = this.deps.memoryStore.getById(id);
    if (!memory) {
      this.deps.appendAuditTimelineEntry?.(
        'memory_mutation',
        'denied',
        `Memory supersede failed: memory "${id}" was not found.`,
      );
      return {
        ok: false,
        message: 'Memory not found',
      };
    }

    this.deps.memoryStore.updateMemory(id, { supersededBy: `admin-${randomUUID()}` });
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `PSFN superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return { ok: true };
  }

  linkMemories(id1: string, id2: string, linkType?: string): AdminMemoryLinkResult {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) {
      return { ok: false, message: 'Both memory IDs are required' };
    }
    if (normalizedId1 === normalizedId2) {
      return { ok: false, message: 'Cannot link a memory to itself' };
    }
    // Verify both memories exist
    if (!this.deps.memoryStore.getById(normalizedId1)) {
      return { ok: false, message: `Memory "${normalizedId1}" not found` };
    }
    if (!this.deps.memoryStore.getById(normalizedId2)) {
      return { ok: false, message: `Memory "${normalizedId2}" not found` };
    }

    const link = this.deps.memoryStore.linkMemories(normalizedId1, normalizedId2, linkType);
    if (!link) {
      return { ok: false, message: 'Link already exists or could not be created' };
    }

    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Linked memories "${link.id1}" and "${link.id2}" (type: ${link.linkType}).`,
    );
    return { ok: true, link };
  }

  unlinkMemories(id1: string, id2: string): MemoryMutationResult {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) {
      return { ok: false, message: 'Both memory IDs are required' };
    }

    const removed = this.deps.memoryStore.unlinkMemories(normalizedId1, normalizedId2);
    if (!removed) {
      return { ok: false, message: 'Link not found' };
    }

    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Unlinked memories "${normalizedId1}" and "${normalizedId2}".`,
    );
    return { ok: true };
  }

  getMemoryLinks(id: string): MemoryLink[] {
    return this.deps.memoryStore.getLinkedMemories(id);
  }

  bulkDelete(ids: string[]): AdminBulkMutationResult {
    if (!ids.length) {
      return { ok: false, count: 0, message: 'No IDs provided' };
    }
    if (ids.length > 500) {
      return { ok: false, count: 0, message: 'Bulk delete limited to 500 items' };
    }

    const count = this.deps.memoryStore.bulkDelete(ids);
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Bulk deleted ${count} memories (${ids.length} requested).`,
    );
    return { ok: true, count };
  }

  bulkUpdate(ids: string[], fields: { memoryType?: string; sensitivity?: string }): AdminBulkMutationResult {
    if (!ids.length) {
      return { ok: false, count: 0, message: 'No IDs provided' };
    }
    if (ids.length > 500) {
      return { ok: false, count: 0, message: 'Bulk update limited to 500 items' };
    }

    const storeFields: Partial<Pick<import('../../../memory/types.js').PurrMemory, 'type' | 'sensitivity'>> = {};

    if (fields.memoryType !== undefined) {
      const normalized = fields.memoryType.trim().toLowerCase();
      if (!VALID_MEMORY_TYPES.includes(normalized as MemoryType)) {
        return { ok: false, count: 0, message: `Invalid memory type: ${fields.memoryType}` };
      }
      storeFields.type = normalized as MemoryType;
    }

    if (fields.sensitivity !== undefined) {
      const normalized = fields.sensitivity.trim().toLowerCase();
      if (!VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)) {
        return { ok: false, count: 0, message: `Invalid sensitivity level: ${fields.sensitivity}` };
      }
      storeFields.sensitivity = normalized as SensitivityLevel;
    }

    if (Object.keys(storeFields).length === 0) {
      return { ok: false, count: 0, message: 'No valid fields to update' };
    }

    const count = this.deps.memoryStore.bulkUpdate(ids, storeFields);
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Bulk updated ${count} memories (${ids.length} requested, fields: ${Object.keys(storeFields).join(', ')}).`,
    );
    return { ok: true, count };
  }
}
