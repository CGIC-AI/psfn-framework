import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  MemorySubjectAuthorizationDeniedError,
  parseMemorySubjectQueryAuthorization,
  type MemorySubjectClassification,
  type MemorySubjectQueryAuthorization,
} from '../shared/contracts/memory-subject.js';
import type {
  MemoryAdminListOptions,
  MemoryAdminPrivacySummary,
  MemoryDeleteVersion,
  MemoryStoreStats,
  MemoryStoreUpdatePatch,
  MemorySubjectAdminQuery,
  MemorySubjectAdminResult,
  MemorySubjectAuthorizedDelete,
  MemorySubjectAuthorizedMutation,
  MemorySubjectAuthorizedQuery,
  MemorySubjectAuthorizedQueryResult,
  MemorySubjectAuthorizedRestore,
  MemorySubjectAuthorizedWrite,
} from '../faculties/memory/memory-store-port.js';
import {
  ADMIN_DURABLE_MEMORY_TAGS,
  ADMIN_PREFERENCE_MEMORY_TAGS,
} from '../faculties/memory/postgres-store/admin.js';
import { classifyMemorySubject } from '../faculties/memory/subject-classification.js';
import { isInternalMemoryArtifact } from '../faculties/memory/internal-artifacts.js';
import type { MemoryScopeQuery, PurrMemory } from '../faculties/memory/types.js';

type Awaitable<T> = T | Promise<T>;

export interface InMemorySubjectStoreBackend {
  getAllActiveMemories(limit?: number): Awaitable<PurrMemory[]>;
  getById(id: string): Awaitable<PurrMemory | undefined>;
  getDeleteVersion(deleteId: string): Awaitable<MemoryDeleteVersion | undefined>;
  persistMemoryWrite(input: Omit<MemorySubjectAuthorizedWrite, 'authorization'>): Awaitable<void>;
  searchByEmbedding(
    embedding: Float32Array,
    threshold: number,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Awaitable<Array<PurrMemory & { similarity: number }>>;
  searchByText(
    query: string,
    limit: number,
    scopeQuery?: MemoryScopeQuery,
  ): Awaitable<Array<PurrMemory & { similarity: number }>>;
  softDeleteMemory(
    id: string,
    options?: MemorySubjectAuthorizedDelete['options'],
  ): Awaitable<MemoryDeleteVersion | null>;
  undoSoftDelete(
    deleteId: string,
    options?: MemorySubjectAuthorizedRestore['options'],
  ): Awaitable<MemoryDeleteVersion | null>;
  updateMemory(id: string, updates: MemoryStoreUpdatePatch): Awaitable<void>;
}

export interface InMemorySubjectMutationStoreBackend {
  getById(id: string): PurrMemory | undefined;
  runInTransaction<T>(handler: () => T): T;
  updateMemory(id: string, updates: MemoryStoreUpdatePatch): void;
}

function actionMatchesSelector(input: MemorySubjectAuthorizedQuery): boolean {
  const { action } = input.authorization;
  switch (input.selector.kind) {
    case 'list':
      return ['list', 'snippet', 'export', 'prompt_preview'].includes(action);
    case 'detail':
    case 'details_batch':
      return ['detail', 'snippet', 'export', 'prompt_preview'].includes(action);
    case 'text_search':
      return ['search', 'snippet', 'export', 'prompt_preview'].includes(action);
    case 'embedding_search':
      return action === 'embedding';
    case 'count':
      return action === 'count';
  }
}

function matchesScope(memory: PurrMemory, scopeQuery?: MemoryScopeQuery): boolean {
  if (!scopeQuery) return true;
  const refs = scopeQuery.refs ?? [];
  const tags = scopeQuery.tags ?? [];
  const refMatches = refs.length === 0 || refs.some(ref => (
    memory.scopeRef?.kind === ref.kind && memory.scopeRef.id === ref.id
  ));
  const tagMatches = tags.length === 0 || tags.some(tag => memory.scopeTags?.includes(tag));
  return scopeQuery.mode === 'only'
    ? refMatches && tagMatches
    : refMatches || tagMatches;
}

function classify(memory: PurrMemory): MemorySubjectClassification {
  return classifyMemorySubject(memory, {
    memoryRevision: 1,
    embedding: memory.embedding,
    now: memory.extractedAt,
  });
}

function isAuthorized(
  memory: PurrMemory,
  input: MemorySubjectQueryAuthorization,
): boolean {
  const authorization = parseMemorySubjectQueryAuthorization(input);
  if (authorization.classifierVersion !== MEMORY_SUBJECT_CLASSIFIER_VERSION) return false;
  const classification = classify(memory);
  if (
    classification.status !== 'current'
    || classification.classifierVersion !== authorization.classifierVersion
    || ['ambiguous', 'unattributed', 'unbound_person'].includes(classification.subjectClass)
    || !authorization.allowedSubjectClasses.includes(classification.subjectClass)
  ) {
    return false;
  }
  if (!authorization.allowedSubjectClasses.includes('companion_private')
    && isInternalMemoryArtifact(memory)) return false;

  const viewerIsSubject = classification.subjectContactIds.some(contactId => (
    authorization.viewerContactIds.includes(contactId)
  ));
  const relationAllowed = (
    classification.subjectClass === 'single_contact'
    && viewerIsSubject
    && authorization.allowedViewerRelations.includes('self')
  ) || (
    (classification.subjectClass === 'multiple_contacts' || classification.subjectClass === 'shared_room')
    && viewerIsSubject
    && authorization.allowedViewerRelations.includes('co_subject')
  ) || (
    classification.subjectContactIds.length > 0
    && !viewerIsSubject
    && authorization.allowedViewerRelations.includes('other')
  ) || (
    classification.subjectContactIds.length === 0
    && authorization.allowedViewerRelations.includes('none')
  );
  if (!relationAllowed) return false;

  return authorization.grantBindings.length === 0 || authorization.grantBindings.some(binding => (
    binding.memoryId === classification.memoryId
    && binding.memoryRevision === classification.memoryRevision
    && binding.classifierVersion === classification.classifierVersion
    && binding.evidenceDigest === classification.evidenceDigest
  ));
}

function page<T>(values: T[], limit = 50, offset = 0): T[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return values.slice(safeOffset, safeOffset + safeLimit);
}

export async function queryInMemoryAuthorizedSubjects(
  store: InMemorySubjectStoreBackend,
  input: MemorySubjectAuthorizedQuery,
): Promise<MemorySubjectAuthorizedQueryResult> {
  if (!actionMatchesSelector(input)) {
    throw new Error(
      `Memory subject authorization action ${input.authorization.action} does not permit ${input.selector.kind}`,
    );
  }
  const authorized = (await store.getAllActiveMemories())
    .filter(memory => isAuthorized(memory, input.authorization));
  const { selector } = input;

  if (selector.kind === 'count') {
    return {
      memories: [],
      total: authorized.filter(memory => matchesScope(memory, selector.scopeQuery)).length,
    };
  }

  if (selector.kind === 'detail') {
    const memory = authorized.find(candidate => candidate.id === selector.memoryId);
    return {
      memories: memory ? [{ ...memory, similarity: 1 }] : [],
      total: memory ? 1 : 0,
    };
  }

  if (selector.kind === 'details_batch') {
    const requested = new Set(
      selector.memoryIds.map(id => id.trim()).filter(Boolean),
    );
    const matches = authorized.filter(memory => requested.has(memory.id));
    return {
      memories: matches.map(memory => ({ ...memory, similarity: 1 })),
      total: matches.length,
    };
  }

  if (selector.kind === 'text_search') {
    const authorizedIds = new Set(authorized.map(memory => memory.id));
    const matches = (await store.searchByText(
      selector.query,
      10_000,
      selector.scopeQuery,
    )).filter(memory => authorizedIds.has(memory.id));
    return {
      memories: page(matches, selector.limit, selector.offset),
      total: matches.length,
    };
  }

  if (selector.kind === 'embedding_search') {
    const authorizedIds = new Set(authorized.map(memory => memory.id));
    const matches = (await store.searchByEmbedding(
      selector.embedding,
      selector.threshold,
      10_000,
      selector.scopeQuery,
    )).filter(memory => authorizedIds.has(memory.id));
    return {
      memories: page(matches, selector.limit, selector.offset),
      total: matches.length,
    };
  }

  const matches = authorized.filter(memory => matchesScope(memory, selector.scopeQuery));
  return {
    memories: page(matches, selector.limit, selector.offset).map(memory => ({
      ...memory,
      similarity: 1,
    })),
    total: matches.length,
  };
}

// ---------------------------------------------------------------------------
// Subject-authorized admin aggregation reference (a27w.5).
//
// Pure-JS reference for the operator admin surface's counts, filters, stats,
// and channel/contact slices, matching the semantics the Postgres
// `subject-admin-queries` module reproduces in SQL. The preference predicate is
// tags-only and the retention filter is exact equality (NOT the operator raw
// store's text-regex-inclusive semantics). Exported so the equivalence test can
// use it as an independent oracle against the SQL path.
// ---------------------------------------------------------------------------

const ADMIN_PREFERENCE_TAG_SET = new Set<string>(ADMIN_PREFERENCE_MEMORY_TAGS);
const ADMIN_DURABLE_TAG_SET = new Set<string>(ADMIN_DURABLE_MEMORY_TAGS);

export function subjectAdminIsPreference(memory: PurrMemory): boolean {
  return memory.type !== 'boundary' && memory.tags.some((tag) => {
    const normalized = tag.toLowerCase();
    return ADMIN_PREFERENCE_TAG_SET.has(normalized) || normalized.startsWith('preference:');
  });
}

export function subjectAdminIsDurable(memory: PurrMemory): boolean {
  return memory.retentionClass === 'durable'
    || memory.tags.some(tag => ADMIN_DURABLE_TAG_SET.has(tag.toLowerCase()));
}

export function subjectAdminPrivacySummary(
  memories: readonly PurrMemory[],
): MemoryAdminPrivacySummary {
  const sensitivityCounts: Record<string, number> = {};
  for (const memory of memories) {
    sensitivityCounts[memory.sensitivity] = (sensitivityCounts[memory.sensitivity] ?? 0) + 1;
  }
  return {
    activeMemoryCount: memories.length,
    highSensitivityCount: memories.filter(memory => (
      memory.sensitivity === 'intimate' || memory.sensitivity === 'confidential'
    )).length,
    consentGatedCount: memories.filter(memory => memory.consentFlags?.allowRecall === false).length,
    contactLinkedCount: memories.filter(memory => Boolean(memory.contactId)).length,
    scopedCount: memories.filter(memory => Boolean(memory.scopeRef || memory.scopeTags?.length)).length,
    preferenceCount: memories.filter(subjectAdminIsPreference).length,
    durablePreferenceCount: memories
      .filter(memory => subjectAdminIsPreference(memory) && subjectAdminIsDurable(memory)).length,
    sensitivityCounts,
  };
}

export function subjectAdminStats(memories: readonly PurrMemory[]): MemoryStoreStats {
  const byType: Record<string, number> = {};
  let salienceSum = 0;
  for (const memory of memories) {
    byType[memory.type] = (byType[memory.type] ?? 0) + 1;
    salienceSum += memory.salience;
  }
  return {
    total: memories.length,
    byType,
    avgSalience: memories.length === 0 ? 0 : salienceSum / memories.length,
  };
}

export function subjectAdminFilter(
  memories: readonly PurrMemory[],
  options: MemoryAdminListOptions,
): PurrMemory[] {
  return memories.filter(memory => (
    (options.type === undefined || memory.type === options.type)
    && (options.sensitivity === undefined || memory.sensitivity === options.sensitivity)
    && (options.retentionClass === undefined || memory.retentionClass === options.retentionClass)
    && (options.preferenceOnly !== true || subjectAdminIsPreference(memory))
    && (options.startDate === undefined || memory.extractedAt >= options.startDate)
    && (options.endDate === undefined || memory.extractedAt <= options.endDate)
  ));
}

export async function queryInMemoryAuthorizedAdmin(
  store: InMemorySubjectStoreBackend,
  input: MemorySubjectAdminQuery,
): Promise<MemorySubjectAdminResult> {
  const allActive = await store.getAllActiveMemories();
  const authorized = allActive
    .filter(memory => isAuthorized(memory, input.authorization))
    .sort((left, right) => right.extractedAt - left.extractedAt || right.id.localeCompare(left.id));
  const { selector } = input;
  switch (selector.kind) {
    case 'stats':
      return { kind: 'stats', stats: subjectAdminStats(authorized) };
    case 'privacy_summary':
      return {
        kind: 'privacy_summary',
        privacySummary: subjectAdminPrivacySummary(
          authorized.filter(memory => !isInternalMemoryArtifact(memory)),
        ),
      };
    case 'channel_prefix': {
      const memories = authorized
        .filter(memory => memory.sourceRef.startsWith(`${selector.channelId}:`))
        .slice(0, selector.limit)
        .map(memory => ({ ...memory, similarity: 1 }));
      return { kind: 'memories', memories, total: memories.length };
    }
    case 'contact_filter': {
      const memories = authorized
        .filter(memory => memory.contactId === selector.contactId)
        .slice(0, selector.limit)
        .map(memory => ({ ...memory, similarity: 1 }));
      return { kind: 'memories', memories, total: memories.length };
    }
    case 'admin_page': {
      const options = selector.options ?? {};
      const all = authorized.filter(memory => !isInternalMemoryArtifact(memory));
      const filtered = subjectAdminFilter(all, options);
      const allFiltered = subjectAdminFilter(
        allActive.filter(memory => !isInternalMemoryArtifact(memory)),
        options,
      );
      const offset = Math.max(0, Math.floor(options.offset ?? 0));
      const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
      return {
        kind: 'memories',
        memories: filtered.slice(offset, offset + limit).map(memory => ({ ...memory, similarity: 1 })),
        total: filtered.length,
        withheldBySubjectAuthorizationCount: allFiltered.length - filtered.length,
      };
    }
  }
}

export async function mutateInMemoryAuthorizedSubjects(
  store: InMemorySubjectMutationStoreBackend,
  input: MemorySubjectAuthorizedMutation,
): Promise<number> {
  const authorization = parseMemorySubjectQueryAuthorization(input.authorization);
  if (authorization.action !== 'update' && authorization.action !== 'bulk_mutation') {
    throw new Error('Memory subject authorization action does not permit mutation');
  }
  const memoryIds = [...new Set(input.memoryIds.flatMap(id => {
    const normalized = id.trim();
    return normalized ? [normalized] : [];
  }))].sort();
  if (memoryIds.length === 0) return 0;
  if (authorization.classifierVersion !== MEMORY_SUBJECT_CLASSIFIER_VERSION) {
    throw new Error(
      `Memory subject authorization classifier version ${authorization.classifierVersion} is stale or unsupported`,
    );
  }
  return store.runInTransaction(() => {
    for (const memoryId of memoryIds) {
      const memory = store.getById(memoryId);
      if (
        !memory
        || memory.deletedAt
        || memory.supersededBy
        || !isAuthorized(memory, authorization)
      ) {
        throw new MemorySubjectAuthorizationDeniedError();
      }
    }
    for (const memoryId of memoryIds) {
      store.updateMemory(memoryId, input.updates);
    }
    return memoryIds.length;
  });
}

export async function persistInMemoryAuthorizedSubject(
  store: InMemorySubjectStoreBackend,
  input: MemorySubjectAuthorizedWrite,
): Promise<void> {
  if (input.authorization.action !== 'bulk_mutation' || !isAuthorized(input.memory, input.authorization)) {
    throw new MemorySubjectAuthorizationDeniedError();
  }
  for (const memoryId of input.supersededMemoryIds ?? []) {
    const memory = await store.getById(memoryId);
    if (!memory || !isAuthorized(memory, input.authorization)) {
      throw new MemorySubjectAuthorizationDeniedError();
    }
  }
  await store.persistMemoryWrite({
    memory: input.memory,
    embedding: input.embedding,
    ...(input.supersededMemoryIds ? { supersededMemoryIds: input.supersededMemoryIds } : {}),
  });
}

export async function softDeleteInMemoryAuthorizedSubject(
  store: InMemorySubjectStoreBackend,
  input: MemorySubjectAuthorizedDelete,
): Promise<MemoryDeleteVersion | null> {
  const memory = await store.getById(input.memoryId);
  if (!memory || !isAuthorized(memory, input.authorization)) return null;
  return await store.softDeleteMemory(input.memoryId, input.options);
}

export async function undoDeleteInMemoryAuthorizedSubject(
  store: InMemorySubjectStoreBackend,
  input: MemorySubjectAuthorizedRestore,
): Promise<MemoryDeleteVersion | null> {
  const version = await store.getDeleteVersion(input.deleteId);
  if (!version || !isAuthorized(version.snapshot, input.authorization)) return null;
  return await store.undoSoftDelete(input.deleteId, input.options);
}

export async function classifyInMemorySubject(
  store: InMemorySubjectStoreBackend,
  memoryId: string,
): Promise<MemorySubjectClassification | undefined> {
  const memory = await store.getById(memoryId);
  return memory ? classify(memory) : undefined;
}
