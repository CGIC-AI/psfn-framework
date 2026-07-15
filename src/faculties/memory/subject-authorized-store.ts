import { MEMORY_SUBJECT_CLASSIFIER_VERSION } from '../../shared/contracts/memory-subject.js';
import type { MemorySubjectQueryAuthorization } from '../../shared/contracts/memory-subject.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime.js';
import {
  ADMIN_DURABLE_MEMORY_TAGS,
  ADMIN_PREFERENCE_MEMORY_TAGS,
} from './postgres-store/admin.js';
import type {
  MemoryAdminListOptions,
  MemoryAdminPrivacySummary,
  MemoryStorePort,
} from './memory-store-port.js';
import type { PurrMemory } from './types.js';
import { isInternalMemoryArtifact } from './internal-artifacts.js';

export interface MemorySubjectAccessContext {
  /** Must come from resolved ingress/contact context, never tool or request parameters. */
  viewerContactId?: string;
  /** Only process-local companion work may opt into companion-private rows. */
  companionInternal?: boolean;
}

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

function authorization(
  context: MemorySubjectAccessContext,
  action: MemorySubjectQueryAuthorization['action'],
): MemorySubjectQueryAuthorization | undefined {
  const subject = normalizedSubject(context);
  if (!subject) return undefined;
  return {
    action,
    viewerContactIds: [subject],
    allowedSubjectClasses: context.companionInternal && !context.viewerContactId?.trim()
      ? ['companion_private']
      : ['single_contact', 'multiple_contacts'],
    allowedViewerRelations: context.companionInternal && !context.viewerContactId?.trim()
      ? ['none']
      : ['self', 'co_subject'],
    classifierVersion: MEMORY_SUBJECT_CLASSIFIER_VERSION,
    grantBindings: [],
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

function isPreference(memory: PurrMemory): boolean {
  const preferenceTags = new Set<string>(ADMIN_PREFERENCE_MEMORY_TAGS);
  return memory.type !== 'boundary' && memory.tags.some(tag => (
    preferenceTags.has(tag.toLowerCase()) || tag.toLowerCase().startsWith('preference:')
  ));
}

function isDurable(memory: PurrMemory): boolean {
  const durableTags = new Set<string>(ADMIN_DURABLE_MEMORY_TAGS);
  return memory.retentionClass === 'durable'
    || memory.tags.some(tag => durableTags.has(tag.toLowerCase()));
}

function privacySummary(memories: readonly PurrMemory[]): MemoryAdminPrivacySummary {
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
    preferenceCount: memories.filter(isPreference).length,
    durablePreferenceCount: memories.filter(memory => isPreference(memory) && isDurable(memory)).length,
    sensitivityCounts,
  };
}

function filterAdminMemories(
  memories: readonly PurrMemory[],
  options: MemoryAdminListOptions,
): PurrMemory[] {
  return memories.filter(memory => (
    (options.type === undefined || memory.type === options.type)
    && (options.sensitivity === undefined || memory.sensitivity === options.sensitivity)
    && (options.retentionClass === undefined || memory.retentionClass === options.retentionClass)
    && (options.preferenceOnly !== true || isPreference(memory))
    && (options.startDate === undefined || memory.extractedAt >= options.startDate)
    && (options.endDate === undefined || memory.extractedAt <= options.endDate)
  ));
}

/**
 * Project the broad maintenance store into a subject-scoped product store.
 * Sensitive reads and mutations never fall back to the hydrated/raw methods.
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
        return async (
          embedding: Float32Array,
          threshold: number,
          limit: number,
          scopeQuery?: Parameters<MemoryStorePort['searchByEmbedding']>[3],
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
        return async (options: MemoryAdminListOptions = {}) => {
          const all = (await listAllAuthorized(target, currentContext()))
            .filter(memory => !isInternalMemoryArtifact(memory));
          const filtered = filterAdminMemories(all, options);
          const offset = Math.max(0, Math.floor(options.offset ?? 0));
          const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
          return {
            memories: filtered.slice(offset, offset + limit),
            total: filtered.length,
            privacySummary: privacySummary(all),
          };
        };
      }
      if (property === 'getAdminMemoryPrivacySummary') {
        return async () => privacySummary(
          (await listAllAuthorized(target, currentContext()))
            .filter(memory => !isInternalMemoryArtifact(memory)),
        );
      }
      if (property === 'getStats') {
        return async () => {
          const memories = await listAllAuthorized(target, currentContext());
          const byType: Record<string, number> = {};
          for (const memory of memories) byType[memory.type] = (byType[memory.type] ?? 0) + 1;
          return {
            total: memories.length,
            byType,
            avgSalience: memories.length === 0
              ? 0
              : memories.reduce((sum, memory) => sum + memory.salience, 0) / memories.length,
          };
        };
      }
      if (property === 'getMemoriesByChannel') {
        return async (channelId: string, limit: number) => (
          await listAllAuthorized(target, currentContext())
        ).filter(memory => memory.sourceRef.startsWith(`${channelId}:`)).slice(0, limit);
      }
      if (property === 'getMemoriesByContact') {
        return async (contactId: string, limit: number) => (
          await listAllAuthorized(target, currentContext())
        ).filter(memory => memory.contactId === contactId).slice(0, limit);
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
          if (!normalizedSubject(currentContext())) return [];
          const method = Reflect.get(target, property, target) as (...methodArgs: unknown[]) => unknown;
          return await method.apply(target, args);
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
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
