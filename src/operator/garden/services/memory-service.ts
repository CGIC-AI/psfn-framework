import { randomUUID } from 'node:crypto';
import type { EmbeddingProviderPort } from '../../../core/agent/contracts.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { DEFAULT_COMPANION_NAME } from '../../../core/identity/companion-naming.js';
import { isInternalMemoryArtifact } from '../../../faculties/memory/internal-artifacts.js';
import type {
  MemoryAdminPrivacySummary as StoreMemoryAdminPrivacySummary,
  MemoryBulkUpdatePatch,
  MemoryLink,
  MemoryStorePort,
} from '../../../faculties/memory/memory-store-port.js';
import {
  normalizeMemoryScopeRef,
  normalizeMemoryScopeTags,
  VALID_MEMORY_TYPES,
  type MemoryRetentionClass,
  type MemoryType,
} from '../../../faculties/memory/types.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../system/trust/types.js';
import {
  collectSharedBackgroundUnion,
  SHARED_BACKGROUND_DEFAULT_LIMIT,
  SHARED_BACKGROUND_MAX_LIMIT,
} from '../../../faculties/memory/retrieval/shared-background.js';
import { AdminMemoryBodyGate } from './memory-body-gate.js';
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
  AdminMemoryElevationStatus,
  AdminMemoryLinkResult,
  AdminMemoryListData,
  AdminMemoryPrivacySummary,
  AdminMemorySearchResult,
  AdminMemoryService,
  AdminSharedBackgroundResult,
  AdminMemoryScopeDetailData,
  AdminMemoryScopeListData,
  AdminMemoryScopeMutationResult,
  AdminMemoryScopeRepairView,
  MemoryMutationResult,
} from './types.js';

const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;
const MAX_MANAGED_SCOPE_MEMORY_SCAN = 100_000;

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

function parseRetentionFilter(value: string | null | undefined): MemoryRetentionClass | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'standard' || normalized === 'durable') return normalized;
  return undefined;
}

function parseBooleanFilter(value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
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

function isActiveMemoryView(memory: { supersededBy?: unknown; deletedAt?: unknown }): boolean {
  return memory.supersededBy == null && memory.deletedAt == null;
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

function buildPrivacySummary(
  summary: StoreMemoryAdminPrivacySummary,
  matchingMemoryCount: number,
  pageMemoryCount: number,
): AdminMemoryPrivacySummary {
  return {
    activeMemoryCount: summary.activeMemoryCount,
    matchingMemoryCount,
    pageMemoryCount,
    highSensitivityCount: summary.highSensitivityCount,
    consentGatedCount: summary.consentGatedCount,
    contactLinkedCount: summary.contactLinkedCount,
    scopedCount: summary.scopedCount,
    preferenceCount: summary.preferenceCount,
    durablePreferenceCount: summary.durablePreferenceCount,
    sensitivityCounts: summary.sensitivityCounts,
  };
}

export class AdminMemoryDataService implements AdminMemoryService {
  private readonly bodyGate: AdminMemoryBodyGate;

  constructor(private readonly deps: {
    memoryStore: MemoryStorePort;
    contactStore?: ContactStorePort | null;
    embeddingService?: EmbeddingProviderPort | null;
    resolveCompanionName?: () => string;
    appendAuditTimelineEntry?: (
      actionType: 'memory_mutation' | 'memory_access',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
    ) => void;
    now?: () => number;
  }) {
    this.bodyGate = new AdminMemoryBodyGate(deps.now ? { now: deps.now } : undefined);
  }

  private resolveCompanionName(): string {
    return this.deps.resolveCompanionName?.() ?? DEFAULT_COMPANION_NAME;
  }

  private async buildContactSummaryMap(): Promise<Map<string, { id: string; displayName: string }>> {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    for (const contact of await contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  private async listManagedScopeMemories() {
    return (await this.deps.memoryStore.listAdminMemories({
      limit: MAX_MANAGED_SCOPE_MEMORY_SCAN,
      offset: 0,
    })).memories;
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

  async listMemories(params?: URLSearchParams): Promise<AdminMemoryListData> {
    const limit = parsePositiveInteger(
      params?.get('limit'),
      DEFAULT_MEMORY_LIST_LIMIT,
      1,
      MAX_MEMORY_LIST_LIMIT,
    );
    const offset = parsePositiveInteger(params?.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const typeFilter = parseMemoryTypeFilter(params?.get('type'));
    const sensitivityFilter = parseSensitivityFilter(params?.get('sensitivity'));
    const retentionFilter = parseRetentionFilter(params?.get('retention'));
    const preferenceOnly = parseBooleanFilter(params?.get('preference'));
    const startDate = parseDateFilter(params?.get('startDate'), 'start');
    const endDate = parseDateFilter(params?.get('endDate'), 'end');

    const result = await this.deps.memoryStore.listAdminMemories({
      limit,
      offset,
      ...(typeFilter ? { type: typeFilter } : {}),
      ...(sensitivityFilter ? { sensitivity: sensitivityFilter } : {}),
      ...(retentionFilter ? { retentionClass: retentionFilter } : {}),
      ...(preferenceOnly ? { preferenceOnly: true } : {}),
      ...(startDate !== undefined ? { startDate } : {}),
      ...(endDate !== undefined ? { endDate } : {}),
    });
    const memories = result.memories;
    const total = result.total;
    return {
      memories: memories.map(memory => this.bodyGate.toAdminView(memory)),
      contactsById: await this.buildContactSummaryMap(),
      privacySummary: buildPrivacySummary(result.privacySummary, total, memories.length),
      pagination: {
        limit,
        offset,
        total,
        hasPrevious: offset > 0,
        hasNext: offset + memories.length < total,
      },
      elevation: this.bodyGate.status(),
    };
  }

  async getMemoryDetail(id: string): Promise<AdminMemoryDetailData | null> {
    const memory = await this.deps.memoryStore.getById(id);
    if (!memory) return null;
    const linkedContact = memory.contactId
      ? (await this.buildContactSummaryMap()).get(memory.contactId)
      : undefined;
    return {
      memory: this.bodyGate.toAdminView(memory),
      linkedContact,
      scopeAssignments: this.buildScopeAssignments(memory),
      scopeRepair: this.buildScopeRepair(memory),
      elevation: this.bodyGate.status(),
    };
  }

  getBodyElevationStatus(): AdminMemoryElevationStatus {
    return this.bodyGate.status();
  }

  elevateBodyAccess(): AdminMemoryElevationStatus {
    const status = this.bodyGate.elevate();
    const ttlMinutes = Math.round(status.ttlMs / 60_000);
    this.deps.appendAuditTimelineEntry?.(
      'memory_access',
      'allowed',
      `Operator elevated Garden memory body access for ${ttlMinutes} minutes; intimate/confidential memory bodies are visible.`,
      [status.expiresAt !== undefined ? `expiresAt=${new Date(status.expiresAt).toISOString()}` : null],
    );
    return status;
  }

  dropBodyElevation(): AdminMemoryElevationStatus {
    const status = this.bodyGate.dropElevation();
    this.deps.appendAuditTimelineEntry?.(
      'memory_access',
      'allowed',
      'Operator ended Garden memory body access elevation; intimate/confidential memory bodies are redacted again.',
    );
    return status;
  }

  async revealMemory(id: string): Promise<AdminMemoryDetailData | null> {
    const memory = await this.deps.memoryStore.getById(id);
    if (!memory) {
      this.deps.appendAuditTimelineEntry?.(
        'memory_access',
        'denied',
        `Memory reveal failed: memory "${id}" was not found.`,
      );
      return null;
    }

    const wasRedacted = !this.bodyGate.canReadBody(memory);
    this.bodyGate.recordReveal(memory.id);
    if (wasRedacted) {
      this.deps.appendAuditTimelineEntry?.(
        'memory_access',
        'allowed',
        `Operator revealed ${memory.sensitivity} memory "${memory.id}" body (${memory.text.length} chars).`,
        [`source=${memory.sourceRef}`],
      );
    }
    return this.getMemoryDetail(id);
  }

  async listManagedScopes(params?: URLSearchParams): Promise<AdminMemoryScopeListData> {
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

    for (const memory of await this.listManagedScopeMemories()) {
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

  async getManagedScopeDetail(kind: string, id: string): Promise<AdminMemoryScopeDetailData | null> {
    const scope = parseManagedScopeParams(kind, id);
    if (!scope) return null;

    const memories = (await this.listManagedScopeMemories())
      .filter(memory => collectManagedScopeDescriptors(memory).some(descriptor => (
        descriptor.kind === scope.kind && descriptor.id === scope.id
      )))
      .sort(compareMemoryRecency)
      .map(memory => ({
        memory: this.bodyGate.toAdminView(memory),
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
      elevation: this.bodyGate.status(),
    };
  }

  async searchMemories(query: string): Promise<AdminMemorySearchResult> {
    const privacySummary = await this.deps.memoryStore.getAdminMemoryPrivacySummary();
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) {
      return {
        query,
        results: [],
        contactsById: await this.buildContactSummaryMap(),
        privacySummary: buildPrivacySummary(privacySummary, 0, 0),
        elevation: this.bodyGate.status(),
      };
    }
    const embedding = await embeddingService.embed(query);
    const results = (await this.deps.memoryStore
      .searchByEmbedding(embedding, 0.1, 50))
      .filter(isActiveMemoryView)
      .filter(memory => !isInternalMemoryArtifact(memory));
    return {
      query,
      results: results.map(memory => this.bodyGate.toAdminView(memory)),
      contactsById: await this.buildContactSummaryMap(),
      privacySummary: buildPrivacySummary(privacySummary, results.length, results.length),
      elevation: this.bodyGate.status(),
    };
  }

  async sharedBackground(
    contactAId: string,
    contactBId: string,
    limit?: number,
  ): Promise<AdminSharedBackgroundResult> {
    const effectiveLimit = Math.min(
      Math.max(1, Number.isFinite(limit) ? Math.floor(limit as number) : SHARED_BACKGROUND_DEFAULT_LIMIT),
      SHARED_BACKGROUND_MAX_LIMIT,
    );
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return {
        contactAId,
        contactBId,
        resolved: false,
        missingContactIds: [contactAId, contactBId],
        items: [],
        contactsById: new Map(),
        totalCandidates: 0,
        truncated: false,
        limit: effectiveLimit,
        elevation: this.bodyGate.status(),
      };
    }

    const union = await collectSharedBackgroundUnion(
      { memoryStore: this.deps.memoryStore, contactStore },
      { contactAId, contactBId },
    );
    const items = union.candidates.slice(0, effectiveLimit).map(candidate => ({
      // Body redaction inherited from the E3.5 admin body gate.
      memory: this.bodyGate.toAdminView(candidate.memory),
      sources: candidate.sources,
      score: candidate.score,
    }));

    return {
      contactAId: union.contactAId,
      contactBId: union.contactBId,
      ...(union.contactADisplayName ? { contactADisplayName: union.contactADisplayName } : {}),
      ...(union.contactBDisplayName ? { contactBDisplayName: union.contactBDisplayName } : {}),
      resolved: union.resolved,
      missingContactIds: union.missingContactIds,
      items,
      contactsById: await this.buildContactSummaryMap(),
      totalCandidates: union.candidates.length,
      truncated: union.candidates.length > effectiveLimit,
      limit: effectiveLimit,
      elevation: this.bodyGate.status(),
    };
  }

  async supersedeMemory(id: string): Promise<MemoryMutationResult> {
    const memory = await this.deps.memoryStore.getById(id);
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

    await this.deps.memoryStore.updateMemory(id, { supersededBy: `admin-${randomUUID()}` });
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `${this.resolveCompanionName()} superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return { ok: true };
  }

  async updateMemoryScope(
    id: string,
    fields: {
      scopeRef?: { kind?: string; id?: string; label?: string } | null;
      scopeTags?: string[];
      repair?: boolean;
    },
  ): Promise<AdminMemoryScopeMutationResult> {
    const memory = await this.deps.memoryStore.getById(id);
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

    await this.deps.memoryStore.updateMemory(memory.id, {
      scopeRef: nextScopeRef,
      scopeTags: nextScopeTags,
    });

    const updated = await this.deps.memoryStore.getById(memory.id);
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
      memory: this.bodyGate.toAdminView(updated),
      scopeAssignments: this.buildScopeAssignments(updated),
      scopeRepair: this.buildScopeRepair(updated),
    };
  }

  async linkMemories(id1: string, id2: string, linkType?: string): Promise<AdminMemoryLinkResult> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) {
      return { ok: false, message: 'Both memory IDs are required' };
    }
    if (normalizedId1 === normalizedId2) {
      return { ok: false, message: 'Cannot link a memory to itself' };
    }
    // Verify both memories exist
    if (!await this.deps.memoryStore.getById(normalizedId1)) {
      return { ok: false, message: `Memory "${normalizedId1}" not found` };
    }
    if (!await this.deps.memoryStore.getById(normalizedId2)) {
      return { ok: false, message: `Memory "${normalizedId2}" not found` };
    }

    const link = await this.deps.memoryStore.linkMemories(normalizedId1, normalizedId2, linkType);
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

  async unlinkMemories(id1: string, id2: string): Promise<MemoryMutationResult> {
    const normalizedId1 = id1.trim();
    const normalizedId2 = id2.trim();
    if (!normalizedId1 || !normalizedId2) {
      return { ok: false, message: 'Both memory IDs are required' };
    }

    const removed = await this.deps.memoryStore.unlinkMemories(normalizedId1, normalizedId2);
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

  async getMemoryLinks(id: string): Promise<MemoryLink[]> {
    return await this.deps.memoryStore.getLinkedMemories(id);
  }

  async bulkDelete(ids: string[]): Promise<AdminBulkMutationResult> {
    if (!ids.length) {
      return { ok: false, count: 0, message: 'No IDs provided' };
    }
    if (ids.length > 500) {
      return { ok: false, count: 0, message: 'Bulk delete limited to 500 items' };
    }

    const count = await this.deps.memoryStore.bulkDelete(ids);
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Bulk deleted ${count} memories (${ids.length} requested).`,
    );
    return { ok: true, count };
  }

  async bulkUpdate(
    ids: string[],
    fields: { memoryType?: string; sensitivity?: string; retentionClass?: string },
  ): Promise<AdminBulkMutationResult> {
    if (!ids.length) {
      return { ok: false, count: 0, message: 'No IDs provided' };
    }
    if (ids.length > 500) {
      return { ok: false, count: 0, message: 'Bulk update limited to 500 items' };
    }

    const storeFields: MemoryBulkUpdatePatch = {};
    let retentionClass: MemoryRetentionClass | undefined;

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

    if (fields.retentionClass !== undefined) {
      const normalized = fields.retentionClass.trim().toLowerCase();
      if (normalized !== 'standard' && normalized !== 'durable') {
        return { ok: false, count: 0, message: `Invalid retention class: ${fields.retentionClass}` };
      }
      retentionClass = normalized as MemoryRetentionClass;
    }

    if (Object.keys(storeFields).length === 0 && retentionClass === undefined) {
      return { ok: false, count: 0, message: 'No valid fields to update' };
    }

    if (retentionClass !== undefined) {
      storeFields.retentionClass = retentionClass;
    }

    const count = await this.deps.memoryStore.bulkUpdate(ids, storeFields);
    this.deps.appendAuditTimelineEntry?.(
      'memory_mutation',
      'allowed',
      `Bulk updated ${count} memories (${ids.length} requested, fields: ${[
        ...Object.keys(storeFields),
        ...(retentionClass ? ['retentionClass'] : []),
      ].join(', ')}).`,
    );
    return { ok: true, count };
  }
}
