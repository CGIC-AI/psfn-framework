import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../shared/contracts/memory-subject.js';
import type {
  MemorySubjectGrantBinding,
  MemorySubjectQueryAuthorization,
} from '../../shared/contracts/memory-subject.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';
import { MEMORY_SUBJECT_DETAILS_BATCH_MAX } from './postgres-store/subject-queries.js';
import type {
  MemoryAdminListOptions,
  MemoryAdminPrivacySummary,
  MemoryStoreStats,
  MemoryStorePort,
  MemorySubjectAdminQuery,
  MemorySubjectAdminResult,
} from './memory-store-port.js';
import type { PurrMemory } from './types.js';

export interface MemorySubjectAccessContext {
  /** Must come from resolved ingress/contact context, never tool or request parameters. */
  viewerContactId?: string;
  /** Additional contacts proven by the authorization layer to be co-subjects. */
  viewerCoSubjectContactIds?: readonly string[];
  /** Exact JIT bindings supplied only after gateway grant consumption. */
  grantBindings?: readonly MemorySubjectGrantBinding[];
  /** Only process-local companion work may opt into companion-private rows. */
  companionInternal?: boolean;
  /**
   * Add companion-private rows to product recall candidate queries. This is
   * not a disclosure grant: the retriever's room, trust, sensitivity, consent,
   * and policy gates still decide whether any candidate reaches a prompt.
   */
  includeCompanionPrivateRecallCandidates?: boolean;
  /** Owner-facing aggregate only; never widens row authorization. */
  reportWithheldByAuthorization?: boolean;
  /**
   * D1 admin projection (operator ruling 2026-07-30). Set only from a signed
   * fleet actor context for owner/admin roles — never from request input:
   * - `sole_admin`: every subject class and relation is visible; nothing about
   *   the deployment's single operator is hidden from them.
   * - `multi_admin`: every class/relation is visible EXCEPT intimate or
   *   confidential rows derived from humans other than the viewer, which stay
   *   hidden until an audited escalation sets `escalated`.
   * Absent (or a non-admin role) keeps the narrow single-contact/self scope.
   */
  adminAccessMode?: 'sole_admin' | 'multi_admin';
  /** True only when the gateway consumed an audited escalation grant for this request. */
  escalated?: boolean;
}

const COMPANION_PRIVATE_RECALL_ACTIONS = new Set<MemorySubjectQueryAuthorization['action']>([
  'list',
  'detail',
  'search',
  'embedding',
]);

export function memorySubjectAccessContextFromCorrelation(
  context: Partial<CorrelationMetadata> | undefined,
): MemorySubjectAccessContext {
  const viewerContactId = context?.viewerMemorySubjectContactId?.trim();
  return {
    ...(viewerContactId ? { viewerContactId } : {}),
    companionInternal: !viewerContactId
      && (context?.requesterProvenance === 'self_directed' || context?.requesterProvenance === 'system'),
  };
}

function normalizedSubject(context: MemorySubjectAccessContext): string | undefined {
  const contactId = context.viewerContactId?.trim();
  if (contactId) return contactId;
  return context.companionInternal ? 'companion:internal' : undefined;
}

function normalizedViewerContacts(context: MemorySubjectAccessContext): string[] {
  const contacts = [
    context.viewerContactId,
    ...(context.viewerCoSubjectContactIds ?? []),
  ].map(value => value?.trim()).filter((value): value is string => Boolean(value));
  return [...new Set(contacts)].sort();
}

function authorization(
  context: MemorySubjectAccessContext,
  action: MemorySubjectQueryAuthorization['action'],
): MemorySubjectQueryAuthorization | undefined {
  const subject = normalizedSubject(context);
  if (!subject) return undefined;
  const companionInternal = context.companionInternal && !context.viewerContactId?.trim();
  const viewerContactIds = companionInternal
    ? [subject]
    : normalizedViewerContacts(context);
  if (viewerContactIds.length === 0) return undefined;
  const includeCompanionPrivateRecall = Boolean(
    context.viewerContactId?.trim()
    && context.includeCompanionPrivateRecallCandidates
    && COMPANION_PRIVATE_RECALL_ACTIONS.has(action),
  );
  const adminAccessMode = !companionInternal && context.viewerContactId?.trim()
    ? context.adminAccessMode
    : undefined;
  if (adminAccessMode === 'sole_admin' || adminAccessMode === 'multi_admin') {
    return {
      action,
      viewerContactIds,
      allowedSubjectClasses: [
        'single_contact', 'multiple_contacts', 'shared_room', 'companion_private',
      ],
      allowedViewerRelations: ['self', 'co_subject', 'other', 'none'],
      classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
      grantBindings: [...(context.grantBindings ?? [])],
      ...(adminAccessMode === 'multi_admin' && context.escalated !== true
        ? { excludeHighSensitivityOtherRelation: true }
        : {}),
    };
  }
  return {
    action,
    viewerContactIds,
    allowedSubjectClasses: companionInternal
      ? ['companion_private']
      : includeCompanionPrivateRecall
        ? ['single_contact', 'multiple_contacts', 'companion_private']
        : ['single_contact'],
    allowedViewerRelations: companionInternal
      ? ['none']
      : includeCompanionPrivateRecall
        ? ['self', 'co_subject', 'none']
        : ['self'],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [...(context.grantBindings ?? [])],
  };
}

function deniedMutation(): never {
  throw new Error('Memory access requires a trusted memory subject');
}

async function listAllAuthorized(
  store: MemoryStorePort,
  context: MemorySubjectAccessContext,
): Promise<PurrMemory[]> {
  const auth = authorization(context, 'list');
  if (!auth) return [];
  const memories: PurrMemory[] = [];
  let offset = 0;
  for (;;) {
    const page = await store.queryAuthorizedMemorySubjects({
      authorization: auth,
      selector: { kind: 'list', limit: 500, offset },
    });
    memories.push(...page.memories);
    offset += page.memories.length;
    if (page.memories.length === 0 || offset >= page.total) return memories;
  }
}

function emptyPrivacySummary(): MemoryAdminPrivacySummary {
  return {
    activeMemoryCount: 0,
    highSensitivityCount: 0,
    consentGatedCount: 0,
    contactLinkedCount: 0,
    scopedCount: 0,
    preferenceCount: 0,
    durablePreferenceCount: 0,
    sensitivityCounts: {},
  };
}

function emptyStats(): MemoryStoreStats {
  return { total: 0, byType: {}, avgSalience: 0 };
}

/**
 * Fail-closed empty aggregate for an unauthorized caller, shaped to the
 * requested selector so no caller can observe a memory it is not authorized
 * for.
 */
function emptyAdminResult(
  kind: MemorySubjectAdminQuery['selector']['kind'],
): MemorySubjectAdminResult {
  switch (kind) {
    case 'privacy_summary':
      return { kind: 'privacy_summary', privacySummary: emptyPrivacySummary() };
    case 'admin_stats':
    case 'stats':
      return { kind: 'stats', stats: emptyStats() };
    default:
      return { kind: 'memories', memories: [], total: 0 };
  }
}

/**
 * Garden-facing subject-authorized stats over the same operator-visible corpus
 * as `listAdminMemories`. The ordinary subject store `getStats` deliberately
 * retains its broader active-corpus semantics for non-Garden consumers.
 */
export async function getSubjectAuthorizedAdminMemoryStats(
  store: MemoryStorePort,
  context: MemorySubjectAccessContext,
): Promise<MemoryStoreStats> {
  const auth = authorization(context, 'count');
  if (!auth) return emptyStats();
  const result = await store.aggregateAuthorizedMemorySubjects({
    authorization: auth,
    selector: { kind: 'admin_stats' },
  });
  if (result.kind !== 'stats') {
    throw new Error('Unexpected subject admin aggregate result shape');
  }
  return result.stats;
}

/**
 * Default-deny policy classification for every {@link MemoryStorePort} member
 * (a27w.6). This `Record<keyof MemoryStorePort, …>` is the exhaustiveness gate:
 * adding a method to `MemoryStorePort` fails to compile until it is classified
 * here, so a new backend method can never silently inherit raw (unauthorized)
 * behavior through the proxy — the 5ixyj-class footgun.
 *
 * - `authorized`: has an explicit subject-authorization projection or denial in
 *   the proxy `get` trap below.
 * - `pass-through-safe`: forwards to the raw store because it exposes no
 *   contact-subject rows (each entry documents why it is safe).
 *
 * At runtime the trap consults this map: only `pass-through-safe` methods reach
 * the raw store; anything else that resolves to a callable is refused loudly.
 */
export type SubjectProxyMethodPolicy = 'authorized' | 'pass-through-safe';

export const MEMORY_STORE_METHOD_POLICY: Record<keyof MemoryStorePort, SubjectProxyMethodPolicy> = {
  // --- authorized: explicit projection / denial in the proxy trap below ---
  insertMemory: 'authorized',
  persistMemoryWrite: 'authorized',
  searchByEmbedding: 'authorized',
  searchByText: 'authorized',
  updateMemory: 'authorized',
  recordPatchEvent: 'authorized',
  getAllActiveMemories: 'authorized',
  listMemories: 'authorized',
  listActiveMemories: 'authorized',
  listAdminMemories: 'authorized',
  getAdminMemoryPrivacySummary: 'authorized',
  countActiveMemories: 'authorized',
  getById: 'authorized',
  getByIds: 'authorized',
  softDeleteMemory: 'authorized',
  undoSoftDelete: 'authorized',
  getDeleteVersion: 'authorized',
  recordAbstractionLink: 'authorized',
  getAbstractionLinksForSourceMemory: 'authorized',
  getAbstractionLinksForAbstractedMemory: 'authorized',
  recordEvolutionLink: 'authorized',
  getEvolutionLinksForSourceMemory: 'authorized',
  getEvolutionLinksForTargetMemory: 'authorized',
  getStats: 'authorized',
  getMemoriesByChannel: 'authorized',
  getMemoriesByContact: 'authorized',
  linkMemories: 'authorized',
  unlinkMemories: 'authorized',
  getLinkedMemories: 'authorized',
  bulkDelete: 'authorized',
  bulkUpdate: 'authorized',
  bulkUpdateSalience: 'authorized',
  upsertContactProfile: 'authorized',
  getContactProfile: 'authorized',
  listContactProfiles: 'authorized',
  upsertMemoryMaintenanceReview: 'authorized',
  listMemoryMaintenanceReviews: 'authorized',
  getMemoryMaintenanceReview: 'authorized',
  getMemoryMaintenanceDiagnostics: 'authorized',
  listActiveMemoryEmbeddingsSince: 'authorized',
  queryAuthorizedMemorySubjects: 'authorized',
  aggregateAuthorizedMemorySubjects: 'authorized',
  mutateAuthorizedMemorySubjects: 'authorized',
  persistAuthorizedMemoryWrite: 'authorized',
  softDeleteAuthorizedMemorySubject: 'authorized',
  undoAuthorizedMemorySubjectDelete: 'authorized',
  getMemorySubjectClassification: 'authorized',
  backfillMemorySubjectClassifications: 'authorized',
  // --- pass-through-safe: exposes no contact-subject rows ---
  // Process-local monotonic counters (retrieval-cache / salience-decay
  // invalidation signals). They carry no memory content and are feature-detected
  // by their consumers; the bead requires the retrieval-cache getter keep working.
  getSalienceMaintenanceRevision: 'pass-through-safe',
  getRetrievalCorpusVersion: 'pass-through-safe',
  // Startup aggregate counts only; no memory identity, body, or subject rows.
  getStartupMemorySubjectClassificationCoverage: 'pass-through-safe',
  // Capability-free transaction boundary. Used by MemoryWriter.patch/patchMemory
  // through the subject store (memory tool action=patch). The operations inside
  // the handler run through this same authorized proxy (e.g. updateMemory ->
  // mutateAuthorizedMemorySubjects), so wrapping them in a DB transaction adds
  // atomicity without granting any unauthorized read or write.
  runInTransaction: 'pass-through-safe',
  // Companion-owned working scratchpad (ScratchpadProvider). Distinct ownership
  // contract from contact-subject memories: entries are process/companion-local
  // notes keyed by entry id, never per-contact subject rows, and the scratchpad
  // tool operates on this same store. No subject predicate applies.
  addScratchpadEntry: 'pass-through-safe',
  replaceScratchpadEntry: 'pass-through-safe',
  appendScratchpadEntry: 'pass-through-safe',
  removeScratchpadEntry: 'pass-through-safe',
  getScratchpadEntry: 'pass-through-safe',
  listScratchpadEntries: 'pass-through-safe',
};

/**
 * Project the broad maintenance store into a subject-scoped product store.
 * Named reads and mutations at every sensitivity never fall back to the
 * hydrated/raw methods. The proxy is DEFAULT-DENY (a27w.6): a MemoryStorePort
 * method without an explicit projection here — or a future/unclassified method —
 * is refused at the proxy boundary rather than silently forwarded to the raw
 * store. See {@link MEMORY_STORE_METHOD_POLICY}.
 */
export function createSubjectAuthorizedMemoryStore(
  store: MemoryStorePort,
  context: MemorySubjectAccessContext | (() => MemorySubjectAccessContext),
): MemoryStorePort {
  const currentContext = (): MemorySubjectAccessContext => (
    typeof context === 'function' ? context() : context
  );
  return new Proxy(store, {
    get(target, property) {
      if (property === 'queryAuthorizedMemorySubjects') {
        return async (input: Parameters<MemoryStorePort['queryAuthorizedMemorySubjects']>[0]) => {
          const auth = authorization(currentContext(), input.authorization.action);
          if (!auth) return { memories: [], total: 0 };
          return await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: input.selector,
          });
        };
      }
      if (property === 'aggregateAuthorizedMemorySubjects') {
        return async (input: MemorySubjectAdminQuery): Promise<MemorySubjectAdminResult> => {
          const auth = authorization(currentContext(), input.authorization.action);
          if (!auth) return emptyAdminResult(input.selector.kind);
          return await target.aggregateAuthorizedMemorySubjects({
            authorization: auth,
            selector: input.selector,
          });
        };
      }
      if (property === 'mutateAuthorizedMemorySubjects') {
        return async (input: Parameters<MemoryStorePort['mutateAuthorizedMemorySubjects']>[0]) => {
          const auth = authorization(currentContext(), input.authorization.action);
          if (!auth) deniedMutation();
          return await target.mutateAuthorizedMemorySubjects({
            authorization: auth,
            memoryIds: input.memoryIds,
            updates: input.updates,
          });
        };
      }
      if (property === 'persistAuthorizedMemoryWrite') {
        return async (input: Parameters<MemoryStorePort['persistAuthorizedMemoryWrite']>[0]) => {
          const subject = normalizedSubject(currentContext());
          if (!subject) deniedMutation();
          const auth = authorization(currentContext(), 'bulk_mutation');
          if (!auth) deniedMutation();
          await target.persistAuthorizedMemoryWrite({
            authorization: auth,
            memory: {
              ...input.memory,
              provenance: { ...(input.memory.provenance ?? {}), subjectContactId: subject },
            },
            embedding: input.embedding,
            ...(input.supersededMemoryIds
              ? { supersededMemoryIds: input.supersededMemoryIds }
              : {}),
          });
        };
      }
      if (property === 'softDeleteAuthorizedMemorySubject') {
        return async (input: Parameters<MemoryStorePort['softDeleteAuthorizedMemorySubject']>[0]) => {
          const auth = authorization(currentContext(), 'update');
          if (!auth) deniedMutation();
          return await target.softDeleteAuthorizedMemorySubject({
            authorization: auth,
            memoryId: input.memoryId,
            ...(input.options ? { options: input.options } : {}),
          });
        };
      }
      if (property === 'undoAuthorizedMemorySubjectDelete') {
        return async (input: Parameters<MemoryStorePort['undoAuthorizedMemorySubjectDelete']>[0]) => {
          const auth = authorization(currentContext(), 'update');
          if (!auth) deniedMutation();
          return await target.undoAuthorizedMemorySubjectDelete({
            authorization: auth,
            deleteId: input.deleteId,
            ...(input.options ? { options: input.options } : {}),
          });
        };
      }
      if (property === 'insertMemory') {
        return async (memory: PurrMemory, embedding: Float32Array) => {
          const subject = normalizedSubject(currentContext());
          if (!subject) deniedMutation();
          await target.insertMemory({
            ...memory,
            provenance: { ...(memory.provenance ?? {}), subjectContactId: subject },
          }, embedding);
        };
      }
      if (property === 'persistMemoryWrite') {
        return async (input: Parameters<MemoryStorePort['persistMemoryWrite']>[0]) => {
          const subject = normalizedSubject(currentContext());
          if (!subject) deniedMutation();
          const auth = authorization(currentContext(), 'bulk_mutation');
          if (!auth) deniedMutation();
          await target.persistAuthorizedMemoryWrite({
            authorization: auth,
            memory: {
              ...input.memory,
              provenance: { ...(input.memory.provenance ?? {}), subjectContactId: subject },
            },
            embedding: input.embedding,
            ...(input.supersededMemoryIds
              ? { supersededMemoryIds: input.supersededMemoryIds }
              : {}),
          });
        };
      }
      if (property === 'searchByEmbedding') {
        // The authorized projection always enforces subject authorization by
        // routing to `queryAuthorizedMemorySubjects` (hard WHERE), so the
        // caller's declared authorization stance is intentionally ignored here:
        // a `bypass-system-internal` request that reaches an authorized store is
        // still enforced (fail closed), and a `subject-enforced` request is
        // honored as intended.
        return async (
          embedding: Float32Array,
          threshold: number,
          limit: number,
          scopeQuery: Parameters<MemoryStorePort['searchByEmbedding']>[3],
          _authorization?: Parameters<MemoryStorePort['searchByEmbedding']>[4],
        ) => {
          const auth = authorization(currentContext(), 'embedding');
          if (!auth) return [];
          return (await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: {
              kind: 'embedding_search',
              embedding,
              threshold,
              limit,
              ...(scopeQuery ? { scopeQuery } : {}),
            },
          })).memories;
        };
      }
      if (property === 'searchByText') {
        return async (
          query: string,
          limit: number,
          scopeQuery?: Parameters<MemoryStorePort['searchByText']>[2],
        ) => {
          const auth = authorization(currentContext(), 'search');
          if (!auth) return [];
          return (await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'text_search', query, limit, ...(scopeQuery ? { scopeQuery } : {}) },
          })).memories;
        };
      }
      if (property === 'countActiveMemories') {
        return async () => {
          const auth = authorization(currentContext(), 'count');
          if (!auth) return 0;
          return (await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'count' },
          })).total;
        };
      }
      if (property === 'getById') {
        return async (memoryId: string) => {
          const auth = authorization(currentContext(), 'detail');
          if (!auth) return undefined;
          return (await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'detail', memoryId },
          })).memories[0];
        };
      }
      if (property === 'getByIds') {
        return async (ids: readonly string[]) => {
          const auth = authorization(currentContext(), 'detail');
          if (!auth) return [];
          const normalized = [...new Set(
            ids.map(id => id.trim()).filter(Boolean),
          )];
          if (normalized.length === 0) return [];
          // Resolve the authorized subset in bounded batches. Each batch routes
          // through the same hard-WHERE authorization primitive as getById, so a
          // memory the caller is not authorized for is excluded identically —
          // batching never widens access. A batch query failure propagates (no
          // fallback to raw/unauthorized reads): fail closed.
          const authorizedById = new Map<string, PurrMemory>();
          for (let start = 0; start < normalized.length; start += MEMORY_SUBJECT_DETAILS_BATCH_MAX) {
            const chunk = normalized.slice(start, start + MEMORY_SUBJECT_DETAILS_BATCH_MAX);
            const page = await target.queryAuthorizedMemorySubjects({
              authorization: auth,
              selector: { kind: 'details_batch', memoryIds: chunk },
            });
            for (const memory of page.memories) authorizedById.set(memory.id, memory);
          }
          // Preserve the caller's requested order; misses are silently absent.
          const result: PurrMemory[] = [];
          for (const id of normalized) {
            const memory = authorizedById.get(id);
            if (memory) result.push(memory);
          }
          return result;
        };
      }
      if (property === 'getAllActiveMemories') {
        return async (limit = 10_000) => (await listAllAuthorized(target, currentContext())).slice(0, limit);
      }
      if (property === 'listMemories' || property === 'listActiveMemories') {
        return async (options: { limit?: number; offset?: number } = {}) => {
          const auth = authorization(currentContext(), 'list');
          if (!auth) return [];
          return (await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'list', limit: options.limit, offset: options.offset },
          })).memories;
        };
      }
      if (property === 'listAdminMemories') {
        // a27w.5: page + filtered total + privacy summary computed in Postgres
        // with the subject authorization predicate applied inside each query,
        // instead of hydrating the whole authorized corpus and filtering in JS.
        return async (options: MemoryAdminListOptions = {}) => {
          const listAuth = authorization(currentContext(), 'list');
          const countAuth = authorization(currentContext(), 'count');
          if (!listAuth || !countAuth) {
            return { memories: [], total: 0, privacySummary: emptyPrivacySummary() };
          }
          const page = await target.aggregateAuthorizedMemorySubjects({
            authorization: listAuth,
            selector: { kind: 'admin_page', options },
          });
          const summary = await target.aggregateAuthorizedMemorySubjects({
            authorization: countAuth,
            selector: { kind: 'privacy_summary' },
          });
          if (page.kind !== 'memories' || summary.kind !== 'privacy_summary') {
            throw new Error('Unexpected subject admin aggregate result shape');
          }
          return {
            memories: page.memories,
            total: page.total,
            privacySummary: summary.privacySummary,
            ...(currentContext().reportWithheldByAuthorization
              ? {
                withheldBySubjectAuthorizationCount:
                  page.withheldBySubjectAuthorizationCount ?? 0,
              }
              : {}),
          };
        };
      }
      if (property === 'getAdminMemoryPrivacySummary') {
        return async () => {
          const auth = authorization(currentContext(), 'count');
          if (!auth) return emptyPrivacySummary();
          const result = await target.aggregateAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'privacy_summary' },
          });
          if (result.kind !== 'privacy_summary') {
            throw new Error('Unexpected subject admin aggregate result shape');
          }
          return result.privacySummary;
        };
      }
      if (property === 'getStats') {
        return async () => {
          const auth = authorization(currentContext(), 'count');
          if (!auth) return emptyStats();
          const result = await target.aggregateAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'stats' },
          });
          if (result.kind !== 'stats') {
            throw new Error('Unexpected subject admin aggregate result shape');
          }
          return result.stats;
        };
      }
      if (property === 'getMemoriesByChannel') {
        return async (channelId: string, limit: number) => {
          const auth = authorization(currentContext(), 'list');
          if (!auth) return [];
          const result = await target.aggregateAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'channel_prefix', channelId, limit },
          });
          if (result.kind !== 'memories') {
            throw new Error('Unexpected subject admin aggregate result shape');
          }
          return result.memories;
        };
      }
      if (property === 'getMemoriesByContact') {
        return async (contactId: string, limit: number) => {
          const auth = authorization(currentContext(), 'list');
          if (!auth) return [];
          const result = await target.aggregateAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'contact_filter', contactId, limit },
          });
          if (result.kind !== 'memories') {
            throw new Error('Unexpected subject admin aggregate result shape');
          }
          return result.memories;
        };
      }
      if (property === 'getContactProfile') {
        return async (contactId: string) => {
          const viewerContactId = currentContext().viewerContactId?.trim();
          if (!viewerContactId || contactId.trim() !== viewerContactId) return undefined;
          return await target.getContactProfile(viewerContactId);
        };
      }
      if (property === 'listContactProfiles') {
        return async () => {
          const viewerContactId = currentContext().viewerContactId?.trim();
          if (!viewerContactId) return [];
          const profile = await target.getContactProfile(viewerContactId);
          return profile ? [profile] : [];
        };
      }
      if (property === 'upsertContactProfile') {
        return async (profile: Parameters<MemoryStorePort['upsertContactProfile']>[0]) => {
          const viewerContactId = currentContext().viewerContactId?.trim();
          if (!viewerContactId || profile.contactId !== viewerContactId) deniedMutation();
          await target.upsertContactProfile(profile);
        };
      }
      if (property === 'updateMemory') {
        return async (memoryId: string, updates: Parameters<MemoryStorePort['updateMemory']>[1]) => {
          const auth = authorization(currentContext(), 'update');
          if (!auth) deniedMutation();
          await target.mutateAuthorizedMemorySubjects({ authorization: auth, memoryIds: [memoryId], updates });
        };
      }
      if (property === 'bulkUpdate') {
        return async (memoryIds: string[], fields: Parameters<MemoryStorePort['bulkUpdate']>[1]) => {
          const auth = authorization(currentContext(), 'bulk_mutation');
          if (!auth) deniedMutation();
          return await target.mutateAuthorizedMemorySubjects({
            authorization: auth,
            memoryIds,
            updates: fields,
          });
        };
      }
      if (property === 'bulkDelete') {
        return async (memoryIds: string[]) => {
          const auth = authorization(currentContext(), 'bulk_mutation');
          if (!auth) deniedMutation();
          return await target.mutateAuthorizedMemorySubjects({
            authorization: auth,
            memoryIds,
            updates: {
              deletedAt: Date.now(),
              deletedBy: 'admin:bulk',
              deleteReason: 'bulk delete',
            },
          });
        };
      }
      if (property === 'bulkUpdateSalience') {
        // Salience decay is a process-local maintenance lane and must keep the
        // raw store explicitly; exposing it here would bypass subject checks.
        return async () => deniedMutation();
      }
      if (property === 'softDeleteMemory') {
        return async (memoryId: string, options: Parameters<MemoryStorePort['softDeleteMemory']>[1] = {}) => {
          const auth = authorization(currentContext(), 'update');
          if (!auth) deniedMutation();
          return await target.softDeleteAuthorizedMemorySubject({
            authorization: auth,
            memoryId,
            options,
          });
        };
      }
      if (property === 'undoSoftDelete') {
        return async (deleteId: string, options: Parameters<MemoryStorePort['undoSoftDelete']>[1] = {}) => {
          const auth = authorization(currentContext(), 'update');
          if (!auth) deniedMutation();
          return await target.undoAuthorizedMemorySubjectDelete({
            authorization: auth,
            deleteId,
            options,
          });
        };
      }
      if (property === 'getDeleteVersion') {
        return async () => undefined;
      }
      if (
        property === 'getLinkedMemories'
        || property === 'getEvolutionLinksForSourceMemory'
        || property === 'getEvolutionLinksForTargetMemory'
        || property === 'getAbstractionLinksForSourceMemory'
        || property === 'getAbstractionLinksForAbstractedMemory'
      ) {
        return async (...args: unknown[]) => {
          const auth = authorization(currentContext(), 'detail');
          const sourceMemoryId = String(args[0] ?? '').trim();
          if (!auth || !sourceMemoryId) return [];
          const source = await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'detail', memoryId: sourceMemoryId },
          });
          if (source.total !== 1) return [];
          const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => unknown;
          const links = await method.apply(target, args);
          if (!Array.isArray(links)) return [];
          // Normalize each link's referenced endpoints once, then authorize every
          // distinct endpoint across all links in bounded batches instead of one
          // detail query per endpoint. The source is already proven authorized.
          const linkReferencedIds = links.map(link => {
            if (!link || typeof link !== 'object') return undefined;
            const row = link as Record<string, unknown>;
            const referencedIds = [
              row.id1,
              row.id2,
              row.sourceMemoryId,
              row.targetMemoryId,
              row.abstractedMemoryId,
            ]
              .filter((value): value is string => typeof value === 'string')
              .map(value => value.trim())
              .filter(Boolean);
            return referencedIds.length === 0 ? undefined : referencedIds;
          });
          const idsToAuthorize = [...new Set(
            linkReferencedIds.flatMap(ids => ids ?? []).filter(id => id !== sourceMemoryId),
          )];
          const authorizedIds = new Set<string>([sourceMemoryId]);
          for (let start = 0; start < idsToAuthorize.length; start += MEMORY_SUBJECT_DETAILS_BATCH_MAX) {
            const chunk = idsToAuthorize.slice(start, start + MEMORY_SUBJECT_DETAILS_BATCH_MAX);
            const page = await target.queryAuthorizedMemorySubjects({
              authorization: auth,
              selector: { kind: 'details_batch', memoryIds: chunk },
            });
            for (const memory of page.memories) authorizedIds.add(memory.id);
          }
          const visible: unknown[] = [];
          for (let index = 0; index < links.length; index++) {
            const referencedIds = linkReferencedIds[index];
            if (!referencedIds) continue;
            if (referencedIds.every(id => authorizedIds.has(id))) visible.push(links[index]);
          }
          return visible;
        };
      }
      if (
        property === 'linkMemories'
        || property === 'unlinkMemories'
        || property === 'recordEvolutionLink'
        || property === 'recordAbstractionLink'
      ) {
        return async (...args: unknown[]) => {
          const auth = authorization(currentContext(), 'detail');
          if (!auth) deniedMutation();
          const memoryIds = property === 'recordEvolutionLink'
            ? [
              (args[0] as { sourceMemoryId: string }).sourceMemoryId,
              (args[0] as { targetMemoryId: string }).targetMemoryId,
            ]
            : property === 'recordAbstractionLink'
              ? [
                (args[0] as { sourceMemoryId: string }).sourceMemoryId,
                (args[0] as { abstractedMemoryId: string }).abstractedMemoryId,
              ]
              : [String(args[0] ?? ''), String(args[1] ?? '')];
          for (const memoryId of memoryIds) {
            const selected = await target.queryAuthorizedMemorySubjects({
              authorization: auth,
              selector: { kind: 'detail', memoryId },
            });
            if (selected.total !== 1) deniedMutation();
          }
          const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => unknown;
          return await method.apply(target, args);
        };
      }
      if (property === 'listActiveMemoryEmbeddingsSince') {
        return async () => [];
      }
      if (property === 'listMemoryMaintenanceReviews') {
        return async () => [];
      }
      if (property === 'getMemoryMaintenanceReview') {
        return async () => undefined;
      }
      if (property === 'upsertMemoryMaintenanceReview') {
        return async () => deniedMutation();
      }
      if (property === 'getMemoryMaintenanceDiagnostics') {
        return async () => ({
          reviewCount: 0,
          pendingReviewCount: 0,
          reviewCountsByKind: {},
          reviewCountsByStatus: {},
          oldestPendingReviewAgeMs: 0,
          averagePendingReviewAgeMs: 0,
          evolutionDecisionCount: 0,
          evolutionDecisionCountsByRelation: {
            supersedes: 0,
            updates: 0,
            negates: 0,
            conflicts_with: 0,
          },
          supersessionDecisionCount: 0,
          conflictDecisionCount: 0,
        });
      }
      if (property === 'getMemorySubjectClassification') {
        return async (memoryId: string) => {
          const auth = authorization(currentContext(), 'detail');
          if (!auth) return undefined;
          const selected = await target.queryAuthorizedMemorySubjects({
            authorization: auth,
            selector: { kind: 'detail', memoryId },
          });
          return selected.total === 1
            ? await target.getMemorySubjectClassification(memoryId)
            : undefined;
        };
      }
      if (property === 'backfillMemorySubjectClassifications') {
        return async () => deniedMutation();
      }
      if (property === 'recordPatchEvent') {
        // Audit patch-event write. Reachable only through the subject-backed
        // MemoryWriter.patchMemory path (memory tool action=patch), which first
        // proves the target memory via an authorized getById before this runs.
        // Fail closed: an unsubjected caller cannot append patch events.
        return async (event: Parameters<MemoryStorePort['recordPatchEvent']>[0]) => {
          if (!normalizedSubject(currentContext())) deniedMutation();
          await target.recordPatchEvent(event);
        };
      }
      // --- DEFAULT-DENY boundary (a27w.6) ---
      // Every MemoryStorePort member is classified in MEMORY_STORE_METHOD_POLICY;
      // authorized ones returned above. A symbol key is a JS-internal
      // (then / toStringTag / util.inspect), never a port method — pass it through.
      if (typeof property === 'symbol') {
        return Reflect.get(target, property, target) as unknown;
      }
      if (MEMORY_STORE_METHOD_POLICY[property as keyof MemoryStorePort] === 'pass-through-safe') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value === 'function') {
        // A callable on the raw store with no subject-authorization projection: a
        // newly added / unclassified MemoryStorePort method (or a denial) lands
        // here and fails closed instead of silently forwarding. Loud + greppable.
        return (): never => {
          throw new Error(
            'subject-authorized-memory-proxy default-deny: refusing unauthorized/unhandled '
            + `MemoryStorePort method "${String(property)}" — it has no subject-authorization `
            + 'projection. Add an explicit handler and classify it in '
            + 'MEMORY_STORE_METHOD_POLICY before use (fail closed).',
          );
        };
      }
      // Non-callable, unclassified key (JS internals like `constructor`, or an
      // absent property resolving to undefined). The port exposes no subject data
      // as a bare value property, so returning it cannot disclose a memory.
      return value;
    },
  });
}
