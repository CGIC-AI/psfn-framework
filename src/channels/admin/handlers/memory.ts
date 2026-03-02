import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import { randomUUID } from 'node:crypto';
import * as tpl from '../templates.js';
import { parsePositiveInteger } from '../utils.js';

const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;

export class AdminMemoryHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  memoryList(params?: URLSearchParams): string {
    const legacy = this.legacy as any;
    const { limit, offset } = this.resolveMemoryListPagination(params);
    const memories = legacy.memoryStore.listActiveMemories({ limit, offset });
    const total = legacy.memoryStore.countActiveMemories();
    return tpl.layout(
      'Memory Blossoms',
      tpl.memoryListPage(
        memories,
        this.buildContactSummaryMap(legacy),
        {
          limit,
          offset,
          total,
          hasPrevious: offset > 0,
          hasNext: offset + memories.length < total,
        },
      ),
      'memory',
    );
  }

  memoryDetail(id: string): string | null {
    const legacy = this.legacy as any;
    const memory = legacy.memoryStore.getById(id);
    if (!memory) return null;
    const linkedContact = memory.contactId
      ? this.buildContactSummaryMap(legacy).get(memory.contactId)
      : undefined;
    return tpl.layout(
      `Memory: ${memory.text.slice(0, 40)}...`,
      tpl.memoryDetailPage(memory, linkedContact),
      'memory',
    );
  }

  memoryListFragment(params?: URLSearchParams): string {
    const legacy = this.legacy as any;
    const { limit, offset } = this.resolveMemoryListPagination(params);
    const memories = legacy.memoryStore.listActiveMemories({ limit, offset });
    const contactsById = this.buildContactSummaryMap(legacy);
    return memories.length > 0
      ? memories.map((memory: any) => (
        tpl.memoryRow(
          memory,
          memory.contactId ? contactsById.get(memory.contactId) : undefined,
        )
      )).join('')
      : '<tr><td colspan="8" class="empty">No memories found</td></tr>';
  }

  async memorySearch(query: string): Promise<string> {
    const legacy = this.legacy as any;
    if (!legacy.embeddingService) {
      return '<tr><td colspan="8" class="empty">Embedding service not available</td></tr>';
    }
    const embedding = await legacy.embeddingService.embed(query);
    const results = legacy.memoryStore.searchByEmbedding(embedding, 0.1, 50);
    const contactsById = this.buildContactSummaryMap(legacy);
    return results.length > 0
      ? results.map((memory: any) => (
        tpl.memoryRow(
          memory,
          memory.contactId ? contactsById.get(memory.contactId) : undefined,
        )
      )).join('')
      : '<tr><td colspan="8" class="empty">No matching memories</td></tr>';
  }

  memorySupersede(id: string): string {
    const legacy = this.legacy as any;
    const memory = legacy.memoryStore.getById(id);
    if (!memory) {
      legacy.appendAuditTimelineEntry(
        'memory_mutation',
        'denied',
        `Memory supersede failed: memory "${id}" was not found.`,
      );
      return '';
    }
    legacy.memoryStore.updateMemory(id, { supersededBy: `admin-${randomUUID()}` });
    legacy.appendAuditTimelineEntry(
      'memory_mutation',
      'allowed',
      `Purrsephone superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return '';
  }

  private buildContactSummaryMap(legacy: any): Map<string, { id: string; displayName: string }> {
    if (!legacy.contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    for (const contact of legacy.contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  private resolveMemoryListPagination(params?: URLSearchParams): {
    limit: number;
    offset: number;
  } {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_MEMORY_LIST_LIMIT,
      1,
      MAX_MEMORY_LIST_LIMIT,
    );
    const offset = parsePositiveInteger(params?.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    return { limit, offset };
  }
}
