import { createHash, randomUUID } from 'node:crypto';
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
  type PurrMemory,
} from '../../../faculties/memory/types.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { VALID_SENSITIVITY_LEVELS, type SensitivityLevel } from '../../../system/trust/types.js';
import {
  collectSharedBackgroundUnion,
  SHARED_BACKGROUND_DEFAULT_LIMIT,
  SHARED_BACKGROUND_MAX_LIMIT,
} from '../../../faculties/memory/retrieval/shared-background.js';
import {
  AdminMemoryBodyGate,
  type FleetMemoryBodyAuthorizationContext,
} from './memory-body-gate.js';
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
  AdminMemorySessionKey,
  AdminMemorySessionService,
  AdminSharedBackgroundResult,
  AdminMemoryScopeDetailData,
  AdminMemoryScopeListData,
  AdminMemoryScopeMutationResult,
  AdminMemoryScopeRepairView,
  MemoryMutationResult,
} from './types.js';
import { createSubjectAuthorizedMemoryStore } from '../../../faculties/memory/subject-authorized-store.js';
import type { GardenRequestContext } from '../garden-request-context.js';
import type { FleetGardenRequestContext } from '../garden-request-context.js';
import {
  parseMemorySubjectJitRequest,
  type MemorySubjectJitRequest,
} from '../../../shared/contracts/memory-subject-jit.js';

const log = createComponentLogger('AdminMemoryService');

const DEFAULT_MEMORY_LIST_LIMIT = 50;
const MAX_MEMORY_LIST_LIMIT = 200;
const MAX_MANAGED_SCOPE_MEMORY_SCAN = 100_000;
/** Matches the store-side listAdminMemories clamp so every page is full. */
const MANAGED_SCOPE_MEMORY_PAGE_SIZE = 500;

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

function isNullish(value: unknown): boolean {
  return Object.is(value, null) || Object.is(value, undefined);
}

function isActiveMemoryView(memory: { supersededBy?: unknown; deletedAt?: unknown }): boolean {
  return isNullish(memory.supersededBy) && isNullish(memory.deletedAt);
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
    fleetMemoryStore?: MemoryStorePort;
    contactStore?: ContactStorePort | null;
    embeddingService?: EmbeddingProviderPort | null;
    resolveCompanionName?: () => string;
    appendAuditTimelineEntry?: (
      actionType: 'memory_mutation' | 'memory_access',
      decision: 'allowed' | 'denied',
      narrative: string,
      details?: Array<string | null | undefined>,
      context?: GardenRequestContext,
    ) => void;
    now?: () => number;
  }, bodyGate?: AdminMemoryBodyGate, private readonly requestContext?: GardenRequestContext) {
    this.bodyGate = bodyGate ?? new AdminMemoryBodyGate(deps.now ? { now: deps.now } : undefined);
  }

  forRequest(
    context: GardenRequestContext | undefined,
    legacySessionKey: AdminMemorySessionKey = null,
  ): AdminMemorySessionService {
    if (!context || context.kind !== 'fleet_principal') return this.forSession(legacySessionKey);
    if (context.resource.area !== 'memory'
      || (context.subjectRelation !== 'self' && context.subjectRelation !== 'self_or_co_subject')) {
      throw new Error('Garden memory access requires an exact request-local subject relation');
    }
    const sessionKey = [
      'fleet',
      context.actor.principalId,
      context.actor.sessionRecordId,
      context.versions.authorityGeneration,
      context.versions.globalAuthEpoch,
      context.versions.sessionAuthnVersion,
      context.versions.sessionAuthzVersion,
      context.versions.bindingVersion,
      context.versions.grantVersion,
      context.versions.policyVersion,
    ].join(':');
    const scoped = new AdminMemoryDataService({
      ...this.deps,
      memoryStore: createSubjectAuthorizedMemoryStore(
        this.deps.fleetMemoryStore ?? this.deps.memoryStore,
        Object.freeze({
          viewerContactId: context.actor.contactId,
        }),
      ),
    }, this.bodyGate, context);
    const service = scoped.forSession(sessionKey);
    const fleetSafeService: AdminMemorySessionService = Object.freeze({
      ...service,
      getBodyElevationStatus: () => ({ elevated: false, ttlMs: 0 }),
      elevateBodyAccess: () => {
        throw new Error('Session-wide memory JIT is unavailable for fleet principals');
      },
      dropBodyElevation: () => ({ elevated: false, ttlMs: 0 }),
      revealMemory: async () => {
        throw new Error('Memory reveal requires an exact consumed subject JIT grant');
      },
    });
    if (context.action !== 'memory.jit.self') return fleetSafeService;
    if (context.resource.routeId !== 'POST /api/admin/memory/:id/reveal'
      || context.subjectRelation !== 'self_or_co_subject') {
      return fleetSafeService;
    }
    return Object.freeze({
      ...fleetSafeService,
      revealMemory: (id, jitRequest) => scoped.revealFleetMemory(context, id, jitRequest),
    });
  }

  forSession(sessionKey: AdminMemorySessionKey): AdminMemorySessionService {
    return {
      listMemories: params => this.listMemories(sessionKey, params),
      getMemoryDetail: id => this.getMemoryDetail(sessionKey, id),
      listManagedScopes: params => this.listManagedScopes(params),
      getManagedScopeDetail: (kind, id) => this.getManagedScopeDetail(sessionKey, kind, id),
      searchMemories: query => this.searchMemories(sessionKey, query),
      sharedBackground: (contactAId, contactBId, limit) => (
        this.sharedBackground(sessionKey, contactAId, contactBId, limit)
      ),
      supersedeMemory: id => this.supersedeMemory(id),
      updateMemoryScope: (id, fields) => this.updateMemoryScope(sessionKey, id, fields),
      linkMemories: (id1, id2, linkType) => this.linkMemories(id1, id2, linkType),
      unlinkMemories: (id1, id2) => this.unlinkMemories(id1, id2),
      getMemoryLinks: id => this.getMemoryLinks(id),
      bulkDelete: ids => this.bulkDelete(ids),
      bulkUpdate: (ids, fields) => this.bulkUpdate(ids, fields),
      getBodyElevationStatus: () => this.getBodyElevationStatus(sessionKey),
      elevateBodyAccess: () => this.elevateBodyAccess(sessionKey),
      dropBodyElevation: () => this.dropBodyElevation(sessionKey),
      revealMemory: (id, jitRequest) => this.revealMemory(sessionKey, id, jitRequest),
    };
  }

  private fleetBodyContext(
    context: FleetGardenRequestContext,
    memoryId?: string,
  ): Omit<FleetMemoryBodyAuthorizationContext,
    'action' | 'resourceMemoryId' | 'assurance' | 'requestExpiresAtSeconds'>
    & Partial<Pick<FleetMemoryBodyAuthorizationContext,
      'action' | 'resourceMemoryId' | 'assurance' | 'requestExpiresAtSeconds'>> {
    return {
      principalId: context.actor.principalId,
      browserSessionId: context.actor.sessionRecordId,
      companionId: context.resource.companionId ?? '',
      viewerContactId: context.actor.contactId,
      viewerRelation: 'self',
      authorityGeneration: context.versions.authorityGeneration,
      globalAuthEpoch: context.versions.globalAuthEpoch,
      sessionAuthnVersion: context.versions.sessionAuthnVersion,
      sessionAuthzVersion: context.versions.sessionAuthzVersion,
      bindingVersion: context.versions.bindingVersion,
      grantVersion: context.versions.grantVersion,
      policyVersion: context.versions.policyVersion,
      ...(memoryId ? {
        action: 'memory.jit.self' as const,
        resourceMemoryId: memoryId,
        assurance: context.actor.sessionAssurance === 'webauthn_uv'
          ? 'webauthn_uv' as const
          : undefined,
        requestExpiresAtSeconds: context.expiresAt,
      } : {}),
    };
  }

  private async toRequestMemoryView(
    sessionKey: AdminMemorySessionKey,
    memory: PurrMemory,
  ): Promise<AdminMemoryDetailData['memory']> {
    if (this.requestContext?.kind !== 'fleet_principal') {
      return this.bodyGate.toAdminView(sessionKey, memory);
    }
    const classification = await this.deps.memoryStore.getMemorySubjectClassification(memory.id);
    if (!classification) {
      throw new Error('Memory subject projection changed during Garden view construction');
    }
    return this.bodyGate.toFleetAdminView(
      this.fleetBodyContext(this.requestContext),
      memory,
      classification,
    );
  }

  private resolveCompanionName(): string {
    return this.deps.resolveCompanionName?.() ?? DEFAULT_COMPANION_NAME;
  }

  private appendAudit(
    actionType: 'memory_mutation' | 'memory_access',
    decision: 'allowed' | 'denied',
    narrative: string,
    details?: Array<string | null | undefined>,
  ): void {
    const append = this.deps.appendAuditTimelineEntry;
    if (!append) return;
    if (this.requestContext) {
      append(actionType, decision, narrative, details, this.requestContext);
      return;
    }
    if (details !== undefined) {
      append(actionType, decision, narrative, details);
      return;
    }
    append(actionType, decision, narrative);
  }

  private async buildContactSummaryMap(): Promise<Map<string, { id: string; displayName: string }>> {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return new Map();
    const map = new Map<string, { id: string; displayName: string }>();
    if (this.requestContext?.kind === 'fleet_principal') {
      const contact = await contactStore.getById(this.requestContext.actor.contactId);
      if (contact) map.set(contact.id, { id: contact.id, displayName: contact.displayName });
      return map;
    }
    for (const contact of await contactStore.listAll()) {
      map.set(contact.id, { id: contact.id, displayName: contact.displayName });
    }
    return map;
  }

  private async listManagedScopeMemories(): Promise<PurrMemory[]> {
    // Stores clamp listAdminMemories page sizes (Postgres caps at 500), so a
    // single oversized request silently misses older memories. Page through
    // the store until it is exhausted, bounded by the managed-scope scan cap.
    const collected: PurrMemory[] = [];
    let offset = 0;
    let total = 0;
    while (collected.length < MAX_MANAGED_SCOPE_MEMORY_SCAN) {
      const page = await this.deps.memoryStore.listAdminMemories({
        limit: MANAGED_SCOPE_MEMORY_PAGE_SIZE,
        offset,
      });
      total = page.total;
      if (page.memories.length === 0) break;
      collected.push(...page.memories);
      offset += page.memories.length;
      if (offset >= page.total) break;
    }
    if (collected.length >= MAX_MANAGED_SCOPE_MEMORY_SCAN && total > collected.length) {
      log.warn('Managed-scope memory scan hit its cap; scope counts exclude the overflow', {
        cap: MAX_MANAGED_SCOPE_MEMORY_SCAN,
        total,
      });
      collected.length = MAX_MANAGED_SCOPE_MEMORY_SCAN;
    }
    return collected;
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

  async listMemories(sessionKey: AdminMemorySessionKey, params?: URLSearchParams): Promise<AdminMemoryListData> {
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
      memories: await Promise.all(memories.map(memory => this.toRequestMemoryView(sessionKey, memory))),
      contactsById: await this.buildContactSummaryMap(),
      privacySummary: buildPrivacySummary(result.privacySummary, total, memories.length),
      pagination: {
        limit,
        offset,
        total,
        hasPrevious: offset > 0,
        hasNext: offset + memories.length < total,
      },
      elevation: this.bodyGate.status(sessionKey),
    };
  }

  async getMemoryDetail(sessionKey: AdminMemorySessionKey, id: string): Promise<AdminMemoryDetailData | null> {
    const memory = await this.deps.memoryStore.getById(id);
    if (!memory) return null;
    const linkedContact = memory.contactId
      ? (await this.buildContactSummaryMap()).get(memory.contactId)
      : undefined;
    return {
      memory: await this.toRequestMemoryView(sessionKey, memory),
      linkedContact,
      scopeAssignments: this.buildScopeAssignments(memory),
      scopeRepair: this.buildScopeRepair(memory),
      elevation: this.bodyGate.status(sessionKey),
    };
  }

  getBodyElevationStatus(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    return this.bodyGate.status(sessionKey);
  }

  elevateBodyAccess(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    const status = this.bodyGate.elevate(sessionKey);
    const ttlMinutes = Math.round(status.ttlMs / 60_000);
    this.appendAudit(
      'memory_access',
      'allowed',
      `Operator elevated Garden memory body access for ${ttlMinutes} minutes; intimate/confidential memory bodies are visible.`,
      [status.expiresAt !== undefined ? `expiresAt=${new Date(status.expiresAt).toISOString()}` : null],
    );
    return status;
  }

  dropBodyElevation(sessionKey: AdminMemorySessionKey): AdminMemoryElevationStatus {
    const status = this.bodyGate.dropElevation(sessionKey);
    this.appendAudit(
      'memory_access',
      'allowed',
      'Operator ended Garden memory body access elevation; intimate/confidential memory bodies are redacted again.',
    );
    return status;
  }

  async revealMemory(
    sessionKey: AdminMemorySessionKey,
    id: string,
    _jitRequest?: MemorySubjectJitRequest,
  ): Promise<AdminMemoryDetailData | null> {
    const memory = await this.deps.memoryStore.getById(id);
    if (!memory) {
      this.appendAudit(
        'memory_access',
        'denied',
        `Memory reveal failed: memory "${id}" was not found.`,
      );
      return null;
    }

    const wasRedacted = !this.bodyGate.canReadBody(sessionKey, memory);
    this.bodyGate.recordReveal(sessionKey, memory.id);
    if (wasRedacted) {
      this.appendAudit(
        'memory_access',
        'allowed',
        `Operator revealed ${memory.sensitivity} memory "${memory.id}" body (${memory.text.length} chars).`,
        [`source=${memory.sourceRef}`],
      );
    }
    return this.getMemoryDetail(sessionKey, id);
  }

  private async revealFleetMemory(
    context: FleetGardenRequestContext,
    id: string,
    rawJitRequest: MemorySubjectJitRequest | undefined,
  ): Promise<AdminMemoryDetailData | null> {
    const signedMemoryId = typeof context.resource.pathParams.id === 'string'
      ? context.resource.pathParams.id.trim()
      : undefined;
    const normalizedId = id.trim();
    if (!rawJitRequest || !normalizedId || signedMemoryId !== normalizedId
      || context.actor.sessionAssurance !== 'webauthn_uv') {
      throw new Error('Memory reveal requires exact user-verifying subject JIT authority');
    }
    const jitRequest = parseMemorySubjectJitRequest(rawJitRequest);
    const classification = await this.deps.memoryStore.getMemorySubjectClassification(normalizedId);
    if (!classification) return null;
    const exactStore = createSubjectAuthorizedMemoryStore(
      this.deps.fleetMemoryStore ?? this.deps.memoryStore,
      Object.freeze({
        viewerContactId: context.actor.contactId,
        grantBindings: Object.freeze([{
          memoryId: normalizedId,
          memoryRevision: jitRequest.memoryRevision,
          classifierVersion: jitRequest.classifierVersion,
          evidenceDigest: classification.evidenceDigest,
        }]),
      }),
    );
    const memory = await exactStore.getById(normalizedId);
    if (!memory) return null;
    const bodyContext = this.fleetBodyContext(context, normalizedId);
    if (bodyContext.action !== 'memory.jit.self'
      || bodyContext.resourceMemoryId === undefined
      || bodyContext.assurance !== 'webauthn_uv'
      || bodyContext.requestExpiresAtSeconds === undefined) {
      throw new Error('Memory reveal request authority is incomplete');
    }
    const view = this.bodyGate.toFleetJitView(
      bodyContext as FleetMemoryBodyAuthorizationContext,
      jitRequest,
      memory,
      classification,
    );
    this.appendAudit(
      'memory_access',
      'allowed',
      'Fleet principal exercised a subject-scoped memory reveal grant.',
      [
        `purposeDigest=${createHash('sha256').update(jitRequest.purpose, 'utf8').digest('hex')}`,
        `memoryRevision=${jitRequest.memoryRevision}`,
        `classifierVersion=${jitRequest.classifierVersion}`,
      ],
    );
    const linkedContact = memory.contactId
      ? (await this.buildContactSummaryMap()).get(memory.contactId)
      : undefined;
    return {
      memory: view,
      linkedContact,
      scopeAssignments: this.buildScopeAssignments(memory),
      scopeRepair: this.buildScopeRepair(memory),
      elevation: { elevated: false, ttlMs: 0 },
    };
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

  async getManagedScopeDetail(
    sessionKey: AdminMemorySessionKey,
    kind: string,
    id: string,
  ): Promise<AdminMemoryScopeDetailData | null> {
    const scope = parseManagedScopeParams(kind, id);
    if (!scope) return null;

    const matchedMemories = (await this.listManagedScopeMemories())
      .filter(memory => collectManagedScopeDescriptors(memory).some(descriptor => (
        descriptor.kind === scope.kind && descriptor.id === scope.id
      )))
      .sort(compareMemoryRecency);
    const memories = await Promise.all(matchedMemories.map(async memory => ({
        memory: await this.toRequestMemoryView(sessionKey, memory),
        evidence: buildManagedScopeEvidence(memory, scope),
        repair: this.buildScopeRepair(memory),
      })));

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
      elevation: this.bodyGate.status(sessionKey),
    };
  }

  async searchMemories(sessionKey: AdminMemorySessionKey, query: string): Promise<AdminMemorySearchResult> {
    const privacySummary = await this.deps.memoryStore.getAdminMemoryPrivacySummary();
    const embeddingService = this.deps.embeddingService;
    if (!embeddingService) {
      return {
        query,
        results: [],
        contactsById: await this.buildContactSummaryMap(),
        privacySummary: buildPrivacySummary(privacySummary, 0, 0),
        elevation: this.bodyGate.status(sessionKey),
      };
    }
    const embedding = await embeddingService.embed(query);
    const results = (await this.deps.memoryStore
      .searchByEmbedding(embedding, 0.1, 50))
      .filter(isActiveMemoryView)
      .filter(memory => !isInternalMemoryArtifact(memory));
    return {
      query,
      results: await Promise.all(results.map(memory => this.toRequestMemoryView(sessionKey, memory))),
      contactsById: await this.buildContactSummaryMap(),
      privacySummary: buildPrivacySummary(privacySummary, results.length, results.length),
      elevation: this.bodyGate.status(sessionKey),
    };
  }

  async sharedBackground(
    sessionKey: AdminMemorySessionKey,
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
        elevation: this.bodyGate.status(sessionKey),
      };
    }

    const union = await collectSharedBackgroundUnion(
      { memoryStore: this.deps.memoryStore, contactStore },
      { contactAId, contactBId },
    );
    const items = await Promise.all(union.candidates.slice(0, effectiveLimit).map(async candidate => ({
      // Body redaction inherited from the E3.5 admin body gate.
      memory: await this.toRequestMemoryView(sessionKey, candidate.memory),
      sources: candidate.sources,
      score: candidate.score,
    })));

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
      elevation: this.bodyGate.status(sessionKey),
    };
  }

  async supersedeMemory(id: string): Promise<MemoryMutationResult> {
    const memory = await this.deps.memoryStore.getById(id);
    if (!memory) {
      this.appendAudit(
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
    this.appendAudit(
      'memory_mutation',
      'allowed',
      `${this.resolveCompanionName()} superseded memory "${memory.id}".`,
      [`source=${memory.sourceRef}`],
    );
    return { ok: true };
  }

  async updateMemoryScope(
    sessionKey: AdminMemorySessionKey,
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

    this.appendAudit(
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
      memory: await this.toRequestMemoryView(sessionKey, updated),
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

    this.appendAudit(
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

    this.appendAudit(
      'memory_mutation',
      'allowed',
      `Unlinked memories "${normalizedId1}" and "${normalizedId2}".`,
    );
    return { ok: true };
  }

  async getMemoryLinks(id: string): Promise<MemoryLink[]> {
    if (!await this.deps.memoryStore.getById(id)) return [];
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
    this.appendAudit(
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
    this.appendAudit(
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
