import { randomUUID } from 'node:crypto';
import type { EmbeddingService } from '../../../agent/contracts.js';
import type { ContactStore } from '../../../contacts/store.js';
import { DEFAULT_COMPANION_NAME } from '../../../identity/companion-naming.js';
import { isInternalMemoryArtifact } from '../../../memory/internal-artifacts.js';
import type { MemoryLink } from '../../../memory/store.js';
import type { MemoryStorePort } from '../../../memory/memory-store-port.js';
import {
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  VALID_MEMORY_TYPES,
  type MemoryType,
} from '../../../memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../trust/types.js';
import {
  buildManagedScopeEvidence,
  buildManagedScopeRepairPreview,
  collectManagedScopeDescriptors,
  parseManagedScopeParams,
  toManagedScopeDescriptor,
  type AdminMemoryManagedScopeKind,
} from './memory-scope-evidence.js';
import type {
  AdminBulkMutationResult,
  AdminMemoryDetailData,
  AdminMemoryLinkResult,
  AdminMemoryListData,
  AdminMemoryScopeDetailData,
  AdminMemoryScopeRepairView,
  AdminMemorySearchResult,
  AdminMemoryService,
  MemoryMutationResult,
} from './types.js';

const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;
const MAX_MEMORY_FILTER_SCAN = 100_000;

function parseMemoryTypeFilter(value: string | null | undefined): MemoryType | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_MEMORY_TYPES.includes(normalized as MemoryType)
    ? normalized as MemoryType
    : undefined;
}

function parseSensitivityFilter(value: string | null | undefined): SensitivityLevel | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  return VALID_SENSITIVITY_LEVELS.includes(normalized as SensitivityLevel)
    ? normalized as SensitivityLevel
    : undefined;
}

function parseDateFilter(value: string | null | undefined, boundary: 'start' | 'end'): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number.parseInt(dateOnly[1], 10);
    const monthIndex = Number.parseInt(dateOnly[2], 10) - 1;
    const day = Number.parseInt(dateOnly[3], 10);
    const validatedDate = new Date(Date.UTC(year, monthIndex, day));
    if (
      validatedDate.getUTCFullYear() !== year
      || validatedDate.getUTCMonth() !== monthIndex
      || validatedDate.getUTCDate() !== day
    ) {
      return undefined;
    }
    if (boundary === 'start') {
      return Date.UTC(year, monthIndex, day, 0, 0, 0, 0);
    }
    return Date.UTC(year, monthIndex, day, 23, 59, 59, 999);
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
}

function memoryTimestamp(memory: { extractedAt?: number; createdAt?: number }): number {
  return memory.extractedAt ?? memory.createdAt ?? 0;
}

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

function compareMemoryRecency(
  left: { extractedAt?: number; createdAt?: number; id: string },
  right: { extractedAt?: number; createdAt?: number; id: string },
): number {
  const timestampDelta = memoryTimestamp(right) - memoryTimestamp(left);
  if (timestampDelta !== 0) return timestampDelta;
  return right.id.localeCompare(left.id);
}

export class AdminMemoryDataService implements AdminMemoryService {
  constructor(private readonly deps: {
    memoryStore: MemoryStorePort;
    contactStore?: ContactStore | null;
    embeddingService?: EmbeddingService | null;
    resolveCompanionName?: () => string;
    appendAuditTimelineEntry?: (
      actionType: 'memory_mutation',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
    ) => void;
  }) {}

  private resolveCompanionName(): string {
    return this.deps.resolveCompanionName?.() ?? DEFAULT_COMPANION_NAME;
  }

  private buildContactSummaryMap(): Map<string, { id: string; displayName: string }> {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    for (const contact of contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  private listManagedScopeMemories(): ReturnType<MemoryStorePort['getAllActiveMemories']> {
    return this.deps.memoryStore
      .getAllActiveMemories(MAX_MEMORY_FILTER_SCAN)
      .filter(memory => !isInternalMemoryArtifact(memory));
  }

  private buildScopeAssignments(
    memory: AdminMemoryDetailData['memory'],
  ): AdminMemoryDetailData['scopeAssignments'] {
    return collectManagedScopeDescriptors(memory).map(scope => ({
      ...scope,
      evidence: buildManagedScopeEvidence(memory, scope),
    }));
  }

  private buildScopeRepair(memory: AdminMemoryDetailData['memory']): AdminMemoryScopeRepairView {
    const preview = buildManagedScopeRepairPreview(memory);
    return {
      needsRepair: preview.needsRepair,
      ...(preview.scopeRef ? { suggestedScopeRef: preview.scopeRef } : {}),
      suggestedScopeTags: preview.scopeTags,
      notes: preview.notes,
    };
  }

  listMemories(params?: URLSearchParams): AdminMemoryListData {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_MEMORY_LIST_LIMIT,
      1,
      MAX_MEMORY_LIST_LIMIT,
    );
    const offset = parsePositiveInteger(params?.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const typeFilter = parseMemoryTypeFilter(params?.get('type'));
    const sensitivityFilter = parseSensitivityFilter(params?.get('sensitivity'));
    const startDate = parseDateFilter(params?.get('startDate'), 'start');
    const endDate = parseDateFilter(params?.get('endDate'), 'end');

    const filtered = this.deps.memoryStore
      .getAllActiveMemories(MAX_MEMORY_FILTER_SCAN)
      .filter((memory) => {
        if (isInternalMemoryArtifact(memory)) return false;
        if (typeFilter && memory.type !== typeFilter) return false;
        if (sensitivityFilter && memory.sensitivity !== sensitivityFilter) return false;
        const createdAt = memoryTimestamp(memory);
        if (startDate !== undefined && createdAt < startDate) return false;
        if (endDate !== undefined && createdAt > endDate) return false;
        return true;
      })
      .sort((a, b) => {
        return compareMemoryRecency(a, b);
      });

    const total = filtered.length;
    const memories = filtered.slice(offset, offset + limit);
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
      scopeAssignments: this.buildScopeAssignments(memory),
      scopeRepair: this.buildScopeRepair(memory),
    };
  }

  listManagedScopes(params?: URLSearchParams) {
    const kindFilterRaw = params?.get('kind')?.trim().toLowerCase();
    const kindFilter = kindFilterRaw === 'project' || kindFilterRaw === 'north_star'
      ? kindFilterRaw as AdminMemoryManagedScopeKind
      : undefined;
    const summaryMap = new Map<string, {
      kind: AdminMemoryManagedScopeKind;
      id: string;
      label?: string;
      canonicalTag: string;
      memoryIds: Set<string>;
      needsRepairCount: number;
    }>();

    for (const memory of this.listManagedScopeMemories()) {
      const scopeDescriptors = collectManagedScopeDescriptors(memory)
        .filter(scope => !kindFilter || scope.kind === kindFilter);
      if (scopeDescriptors.length === 0) continue;
      const repair = buildManagedScopeRepairPreview(memory);
      for (const scope of scopeDescriptors) {
        const key = `${scope.kind}:${scope.id}`;
        const existing = summaryMap.get(key);
        if (!existing) {
          summaryMap.set(key, {
            ...scope,
            memoryIds: new Set([memory.id]),
            needsRepairCount: repair.needsRepair ? 1 : 0,
          });
          continue;
        }
        existing.memoryIds.add(memory.id);
        if (!existing.label && scope.label) existing.label = scope.label;
        if (repair.needsRepair) existing.needsRepairCount += 1;
      }
    }

    return {
      scopes: [...summaryMap.values()]
        .map(scope => ({
          kind: scope.kind,
          id: scope.id,
          ...(scope.label ? { label: scope.label } : {}),
          canonicalTag: scope.canonicalTag,
          memoryCount: scope.memoryIds.size,
          needsRepairCount: scope.needsRepairCount,
        }))
        .sort((left, right) => {
          if (right.memoryCount !== left.memoryCount) return right.memoryCount - left.memoryCount;
          return left.canonicalTag.localeCompare(right.canonicalTag);
        }),
    };
  }

  getManagedScopeDetail(kind: string, id: string): AdminMemoryScopeDetailData | null {
    const scope = parseManagedScopeParams(kind, id);
    if (!scope) return null;

    const memories = this.listManagedScopeMemories()
      .filter(memory => collectManagedScopeDescriptors(memory).some(descriptor => (
        descriptor.kind === scope.kind && descriptor.id === scope.id
      )))
      .sort(compareMemoryRecency)
      .map(memory => ({
        memory,
        evidence: buildManagedScopeEvidence(memory, scope),
        repair: this.buildScopeRepair(memory),
      }));

    if (memories.length === 0) return null;

    const labels = memories
      .map(item => toManagedScopeDescriptor(item.memory.scopeRef))
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .filter(value => value.kind === scope.kind && value.id === scope.id && Boolean(value.label))
      .map(value => value.label!);

    return {
      scope: {
        kind: scope.kind,
        id: scope.id,
        ...(labels[0] ? { label: labels[0] } : {}),
        canonicalTag: scope.canonicalTag,
        memoryCount: memories.length,
        needsRepairCount: memories.filter(item => item.repair.needsRepair).length,
      },
      memories,
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
      results: this.deps.memoryStore
        .searchByEmbedding(embedding, 0.1, 50)
        .filter(memory => !isInternalMemoryArtifact(memory)),
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
      `${this.resolveCompanionName()} superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return { ok: true };
  }

  updateMemoryScope(
    id: string,
    fields: {
      scopeRef?: { kind?: string; id?: string; label?: string } | null;
      scopeTags?: string[];
      repair?: boolean;
    },
  ) {
    const memory = this.deps.memoryStore.getById(id);
    if (!memory) {
      return {
        ok: false,
        message: 'Memory not found',
      };
    }

    const explicitScopeRef = fields.scopeRef === null ? undefined : normalizeMemoryScopeRef(fields.scopeRef ?? undefined);
    if (fields.scopeRef !== undefined && fields.scopeRef !== null && !explicitScopeRef) {
      return {
        ok: false,
        message: 'Invalid scopeRef',
      };
    }
    const explicitScopeTags = fields.scopeTags !== undefined
      ? normalizeMemoryScopeTags(fields.scopeTags)
      : undefined;

    const repairPreview = buildManagedScopeRepairPreview({
      scopeRef: explicitScopeRef ?? memory.scopeRef,
      scopeTags: explicitScopeTags ?? memory.scopeTags,
    });

    const nextScopeRef = fields.repair
      ? repairPreview.scopeRef
      : (fields.scopeRef !== undefined ? explicitScopeRef : memory.scopeRef);
    const nextScopeTags = fields.repair
      ? repairPreview.scopeTags
      : (explicitScopeTags ?? memory.scopeTags ?? []);

    this.deps.memoryStore.updateMemory(memory.id, {
      scopeRef: nextScopeRef,
      scopeTags: nextScopeTags,
    });

    const updated = this.deps.memoryStore.getById(memory.id);
    if (!updated) {
      return {
        ok: false,
        message: 'Memory update failed',
      };
    }

    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `${this.resolveCompanionName()} updated scope tags for memory "${updated.id}".`,
      [
        `scopeRef=${updated.scopeRef ? `${updated.scopeRef.kind}:${updated.scopeRef.id}` : 'none'}`,
        `scopeTags=${(updated.scopeTags ?? []).join(',') || 'none'}`,
        fields.repair ? 'repair=true' : null,
      ],
    );

    return {
      ok: true,
      memory: updated,
      scopeAssignments: this.buildScopeAssignments(updated),
      scopeRepair: this.buildScopeRepair(updated),
    };
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
