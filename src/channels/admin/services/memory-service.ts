import { randomUUID } from 'node:crypto';
import type { EmbeddingService } from '../../../agent/contracts.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { MemoryStore } from '../../../memory/store.js';
import type {
  AdminMemoryDetailData,
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
      `Purrsephone superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return { ok: true };
  }
}
