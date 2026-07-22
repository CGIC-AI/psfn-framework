import {
  MEMORY_SUBJECT_CLASSIFIER_VERSION,
  MemorySubjectAuthorizationDeniedError,
  parseMemorySubjectQueryAuthorization,
  type MemorySubjectClassification,
  type MemorySubjectQueryAuthorization,
} from '../shared/contracts/memory-subject.js';
import type {
  MemoryDeleteVersion,
  MemoryStoreUpdatePatch,
  MemorySubjectAuthorizedDelete,
  MemorySubjectAuthorizedMutation,
  MemorySubjectAuthorizedQuery,
  MemorySubjectAuthorizedQueryResult,
  MemorySubjectAuthorizedRestore,
  MemorySubjectAuthorizedWrite,
} from '../faculties/memory/memory-store-port.js';
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
