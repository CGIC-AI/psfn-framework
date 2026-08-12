import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../../shared/utils/types.js';
import { requireAutomataClass } from './registry-contract.js';
import type {
  AutomataSessionPurgeSurface,
  ExactSessionPurgeInput,
  ExactSessionPurgePort,
  ExactSessionPurgeReport,
  ExactSessionPurgeSurfaceReport,
  PermanentReferenceCustodyPort,
} from './retention-contract.js';
import type { SessionClassification } from './session-classification.js';

export const EXACT_SESSION_PURGE_SURFACE_ORDER = [
  'redis_tail_pointers',
  'transcript_projection',
  'turn_records',
  'journal_rolls',
  'journals',
  'channel_index',
] as const satisfies readonly AutomataSessionPurgeSurface[];

export interface ExactSessionPurgeResolvedTarget {
  classification: SessionClassification;
  channelId: string;
  tailChannelKey: string;
  turnRecordChannelId: string;
  activeJournalFilename: string;
  rolledJournalFilenames: string[];
}

export interface ExactSessionPurgeTargetAuthorityPort {
  resolveAndAuthorize(input: ExactSessionPurgeInput): Promise<ExactSessionPurgeResolvedTarget>;
  revalidate(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<void>;
}

export interface ExactSessionPurgeExclusiveFencePort {
  runExclusive<T>(input: ExactSessionPurgeInput, operation: () => Promise<T>): Promise<T>;
}

export interface ExactSessionSurfaceDeleteResult {
  status: 'removed' | 'already_absent';
  removedCount: number;
}

export interface ExactSessionSurfacePurgePort {
  remove(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<ExactSessionSurfaceDeleteResult>;
  isAbsent(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<boolean>;
}

interface ExactSessionPurgeSagaSurfaceState {
  status: 'not_started' | 'pending' | 'completed';
  attempts: number;
  removedCount: number;
  completion: 'removed' | 'already_absent' | null;
  lastErrorDigest: string | null;
}

export interface ExactSessionPurgeSagaRecord {
  schemaVersion: 1;
  companionId: string;
  sessionId: string;
  runId: string;
  targetRevision: string;
  preserveReferences: string[];
  target: ExactSessionPurgeResolvedTarget;
  status: 'in_progress' | 'completed';
  revision: number;
  surfaces: Record<AutomataSessionPurgeSurface, ExactSessionPurgeSagaSurfaceState>;
}

export interface ExactSessionPurgeSagaStorePort {
  load(companionId: string, sessionId: string): Promise<ExactSessionPurgeSagaRecord | null>;
  create(record: ExactSessionPurgeSagaRecord): Promise<void>;
  update(record: ExactSessionPurgeSagaRecord, previousRevision: number): Promise<void>;
}

function cloneSaga(record: ExactSessionPurgeSagaRecord): ExactSessionPurgeSagaRecord {
  return {
    ...record,
    preserveReferences: [...record.preserveReferences],
    target: {
      ...record.target,
      classification: { ...record.target.classification },
      rolledJournalFilenames: [...record.target.rolledJournalFilenames],
    },
    surfaces: Object.fromEntries(EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => [
      surface,
      { ...record.surfaces[surface] },
    ])) as ExactSessionPurgeSagaRecord['surfaces'],
  };
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Exact-session purge ${field} must be a non-empty string`);
  return normalized;
}

function safeInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Exact-session purge ${field} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const expectedSet = new Set(expected);
  const unknown = Object.keys(value).filter(key => !expectedSet.has(key));
  const missing = expected.filter(key => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`Exact-session purge ${field} has an invalid shape`);
  }
}

/** Strict restart decoder for the Postgres saga store. */
export function parseExactSessionPurgeSagaRecord(value: unknown): ExactSessionPurgeSagaRecord {
  if (!isRecord(value)) throw new Error('Exact-session purge saga must be an object');
  exactKeys(value, [
    'schemaVersion',
    'companionId',
    'sessionId',
    'runId',
    'targetRevision',
    'preserveReferences',
    'target',
    'status',
    'revision',
    'surfaces',
  ], 'saga');
  if (value.schemaVersion !== 1) throw new Error('Exact-session purge saga schemaVersion is unknown');
  if (value.status !== 'in_progress' && value.status !== 'completed') {
    throw new Error('Exact-session purge saga status is unknown');
  }
  if (!Array.isArray(value.preserveReferences)) {
    throw new Error('Exact-session purge saga preserveReferences must be an array');
  }
  if (!isRecord(value.target) || !isRecord(value.target.classification)) {
    throw new Error('Exact-session purge saga target is invalid');
  }
  exactKeys(value.target, [
    'classification',
    'channelId',
    'tailChannelKey',
    'turnRecordChannelId',
    'activeJournalFilename',
    'rolledJournalFilenames',
  ], 'target');
  const classification = value.target.classification;
  exactKeys(classification, [
    'schemaVersion',
    'companionId',
    'sessionId',
    'ownership',
    'runId',
    'automatonClass',
    'workerGeneration',
    'classifiedAtMs',
    'retentionDeadlineMs',
  ], 'target.classification');
  if (classification.schemaVersion !== 1 || classification.ownership !== 'automata') {
    throw new Error('Exact-session purge saga target must be an automata classification');
  }
  if (!Array.isArray(value.target.rolledJournalFilenames)) {
    throw new Error('Exact-session purge saga rolledJournalFilenames must be an array');
  }
  const rawSurfaces = value.surfaces;
  if (!isRecord(rawSurfaces)) throw new Error('Exact-session purge saga surfaces are invalid');
  exactKeys(rawSurfaces, EXACT_SESSION_PURGE_SURFACE_ORDER, 'surfaces');
  const surfaces = Object.fromEntries(EXACT_SESSION_PURGE_SURFACE_ORDER.map((surface) => {
    const raw = rawSurfaces[surface];
    if (!isRecord(raw)) throw new Error(`Exact-session purge saga surface ${surface} is invalid`);
    exactKeys(raw, [
      'status',
      'attempts',
      'removedCount',
      'completion',
      'lastErrorDigest',
    ], `surface ${surface}`);
    if (!['not_started', 'pending', 'completed'].includes(String(raw.status))) {
      throw new Error(`Exact-session purge saga surface ${surface} status is unknown`);
    }
    if (raw.completion !== null && raw.completion !== 'removed' && raw.completion !== 'already_absent') {
      throw new Error(`Exact-session purge saga surface ${surface} completion is unknown`);
    }
    if (raw.lastErrorDigest !== null && (
      typeof raw.lastErrorDigest !== 'string'
      || !/^[0-9a-f]{64}$/u.test(raw.lastErrorDigest)
    )) {
      throw new Error(`Exact-session purge saga surface ${surface} error digest is invalid`);
    }
    return [surface, {
      status: raw.status as ExactSessionPurgeSagaSurfaceState['status'],
      attempts: safeInteger(raw.attempts, `surface ${surface} attempts`),
      removedCount: safeInteger(raw.removedCount, `surface ${surface} removedCount`),
      completion: raw.completion as ExactSessionPurgeSagaSurfaceState['completion'],
      lastErrorDigest: raw.lastErrorDigest as string | null,
    }];
  })) as ExactSessionPurgeSagaRecord['surfaces'];
  const parsed: ExactSessionPurgeSagaRecord = {
    schemaVersion: 1,
    companionId: requiredText(value.companionId as string, 'saga companionId'),
    sessionId: requiredText(value.sessionId as string, 'saga sessionId'),
    runId: requiredText(value.runId as string, 'saga runId'),
    targetRevision: requiredText(value.targetRevision as string, 'saga targetRevision'),
    preserveReferences: uniqueReferences(value.preserveReferences as string[]),
    target: {
      classification: {
        schemaVersion: 1,
        companionId: requiredText(classification.companionId as string, 'classification companionId'),
        sessionId: requiredText(classification.sessionId as string, 'classification sessionId'),
        ownership: 'automata',
        runId: requiredText(classification.runId as string, 'classification runId'),
        automatonClass: requireAutomataClass(requiredText(
          classification.automatonClass as string,
          'classification automatonClass',
        )),
        workerGeneration: safeInteger(classification.workerGeneration, 'workerGeneration', 1),
        classifiedAtMs: safeInteger(classification.classifiedAtMs, 'classifiedAtMs'),
        retentionDeadlineMs: safeInteger(classification.retentionDeadlineMs, 'retentionDeadlineMs'),
      },
      channelId: requiredText(value.target.channelId as string, 'target channelId'),
      tailChannelKey: requiredText(value.target.tailChannelKey as string, 'target tailChannelKey'),
      turnRecordChannelId: requiredText(
        value.target.turnRecordChannelId as string,
        'target turnRecordChannelId',
      ),
      activeJournalFilename: requiredText(
        value.target.activeJournalFilename as string,
        'target activeJournalFilename',
      ),
      rolledJournalFilenames: (value.target.rolledJournalFilenames as unknown[]).map(
        (filename, index) => requiredText(filename as string, `target rolledJournalFilenames[${index}]`),
      ),
    },
    status: value.status,
    revision: safeInteger(value.revision, 'saga revision', 1),
    surfaces,
  };
  assertAutomataTarget({
    companionId: parsed.companionId,
    sessionId: parsed.sessionId,
    runId: parsed.runId,
    targetRevision: parsed.targetRevision,
    preserveReferences: parsed.preserveReferences,
  }, parsed.target);
  return parsed;
}

function uniqueReferences(references: readonly string[]): string[] {
  return [...new Set(references.map((reference, index) => (
    requiredText(reference, `preserveReferences[${index}]`)
  )))].sort();
}

function initialSurfaceState(): ExactSessionPurgeSagaSurfaceState {
  return {
    status: 'not_started',
    attempts: 0,
    removedCount: 0,
    completion: null,
    lastErrorDigest: null,
  };
}

function initialSaga(
  input: ExactSessionPurgeInput,
  target: ExactSessionPurgeResolvedTarget,
): ExactSessionPurgeSagaRecord {
  return {
    schemaVersion: 1,
    companionId: input.companionId,
    sessionId: input.sessionId,
    runId: input.runId,
    targetRevision: input.targetRevision,
    preserveReferences: uniqueReferences(input.preserveReferences),
    target,
    status: 'in_progress',
    revision: 1,
    surfaces: Object.fromEntries(EXACT_SESSION_PURGE_SURFACE_ORDER.map(surface => [
      surface,
      initialSurfaceState(),
    ])) as ExactSessionPurgeSagaRecord['surfaces'],
  };
}

function errorDigest(error: unknown): string {
  const detail = error instanceof Error
    ? `${error.name}:${error.message}`
    : `${typeof error}:${String(error)}`;
  return createHash('sha256').update(detail).digest('hex');
}

function assertAutomataTarget(
  input: ExactSessionPurgeInput,
  target: ExactSessionPurgeResolvedTarget,
): void {
  const classification = target.classification;
  if (classification.ownership !== 'automata') {
    throw new Error(
      `Exact-session purge refuses protected ${classification.ownership} session ${input.sessionId}`,
    );
  }
  if (
    classification.companionId !== input.companionId
    || classification.sessionId !== input.sessionId
    || classification.runId !== input.runId
  ) {
    throw new Error('Exact-session purge target classification does not match its requested identity');
  }
  requiredText(target.channelId, 'channelId');
  requiredText(target.tailChannelKey, 'tailChannelKey');
  requiredText(target.turnRecordChannelId, 'turnRecordChannelId');
  requiredText(target.activeJournalFilename, 'activeJournalFilename');
  const rolls = target.rolledJournalFilenames.map((filename, index) => (
    requiredText(filename, `rolledJournalFilenames[${index}]`)
  ));
  if (new Set(rolls).size !== rolls.length || rolls.includes(target.activeJournalFilename)) {
    throw new Error('Exact-session purge journal file family is ambiguous');
  }
}

function assertSagaMatchesInput(
  saga: ExactSessionPurgeSagaRecord,
  input: ExactSessionPurgeInput,
): void {
  const expected = {
    companionId: input.companionId,
    sessionId: input.sessionId,
    runId: input.runId,
    targetRevision: input.targetRevision,
    preserveReferences: uniqueReferences(input.preserveReferences),
  };
  const actual = {
    companionId: saga.companionId,
    sessionId: saga.sessionId,
    runId: saga.runId,
    targetRevision: saga.targetRevision,
    preserveReferences: saga.preserveReferences,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('Exact-session purge request conflicts with its durable saga');
  }
  assertAutomataTarget(input, saga.target);
}

function validateDeleteResult(result: ExactSessionSurfaceDeleteResult): void {
  if (
    !Number.isSafeInteger(result.removedCount)
    || result.removedCount < 0
    || (result.status === 'already_absent' && result.removedCount !== 0)
  ) {
    throw new Error('Exact-session purge surface returned an invalid deletion result');
  }
}

function reportFromSaga(
  saga: ExactSessionPurgeSagaRecord,
  status: ExactSessionPurgeReport['status'],
): ExactSessionPurgeReport {
  return {
    companionId: saga.companionId,
    sessionId: saga.sessionId,
    runId: saga.runId,
    targetRevision: saga.targetRevision,
    status,
    surfaces: EXACT_SESSION_PURGE_SURFACE_ORDER.map((surface): ExactSessionPurgeSurfaceReport => {
      const state = saga.surfaces[surface];
      if (state.status !== 'completed' || state.completion === null) {
        throw new Error(`Exact-session purge surface ${surface} is not complete`);
      }
      return {
        surface,
        status: state.completion,
        removedCount: state.removedCount,
      };
    }),
    verifiedPreservedReferences: [...saga.preserveReferences],
  };
}

export class ExactSessionPurgeIncompleteError extends Error {
  override readonly name = 'ExactSessionPurgeIncompleteError';

  constructor(
    readonly saga: ExactSessionPurgeSagaRecord,
    readonly failedSurface: AutomataSessionPurgeSurface | null,
    cause: unknown,
  ) {
    super(
      failedSurface
        ? `Exact-session purge remains incomplete after ${failedSurface} failed`
        : 'Exact-session purge remains incomplete',
      { cause },
    );
  }
}

export class InMemoryExactSessionPurgeSagaStore implements ExactSessionPurgeSagaStorePort {
  private readonly records = new Map<string, ExactSessionPurgeSagaRecord>();

  async load(companionId: string, sessionId: string): Promise<ExactSessionPurgeSagaRecord | null> {
    const record = this.records.get(`${companionId}\u0000${sessionId}`);
    return record ? cloneSaga(record) : null;
  }

  async create(record: ExactSessionPurgeSagaRecord): Promise<void> {
    const key = `${record.companionId}\u0000${record.sessionId}`;
    if (this.records.has(key)) throw new Error('Exact-session purge saga already exists');
    this.records.set(key, cloneSaga(record));
  }

  async update(record: ExactSessionPurgeSagaRecord, previousRevision: number): Promise<void> {
    const key = `${record.companionId}\u0000${record.sessionId}`;
    const current = this.records.get(key);
    if (!current || current.revision !== previousRevision) {
      throw new Error('Exact-session purge saga changed concurrently');
    }
    this.records.set(key, cloneSaga(record));
  }
}

/**
 * Durable forward-recovery saga. Cross-store rollback is impossible: every
 * surface is idempotently driven to verified absence, with pending/completed
 * state persisted around each irreversible delete. Success is unreachable
 * until all six surfaces and every permanent reference are re-verified.
 */
export class ProductionExactSessionPurge implements ExactSessionPurgePort {
  constructor(private readonly ports: {
    authority: ExactSessionPurgeTargetAuthorityPort;
    custody: PermanentReferenceCustodyPort;
    fence: ExactSessionPurgeExclusiveFencePort;
    sagaStore: ExactSessionPurgeSagaStorePort;
    surfaces: Record<AutomataSessionPurgeSurface, ExactSessionSurfacePurgePort>;
  }) {}

  async purgeExactSession(input: ExactSessionPurgeInput): Promise<ExactSessionPurgeReport> {
    this.validateInput(input);
    return await this.ports.fence.runExclusive(input, async () => (
      await this.purgeUnderFence(input)
    ));
  }

  private async purgeUnderFence(input: ExactSessionPurgeInput): Promise<ExactSessionPurgeReport> {
    let saga = await this.ports.sagaStore.load(input.companionId, input.sessionId);
    if (!saga) {
      const target = await this.ports.authority.resolveAndAuthorize(input);
      assertAutomataTarget(input, target);
      saga = initialSaga(input, target);
      await this.ports.sagaStore.create(saga);
    } else {
      assertSagaMatchesInput(saga, input);
    }

    await this.ports.authority.revalidate(input, saga.target);
    await this.ports.custody.assertResolvable(saga.preserveReferences);
    if (saga.status === 'completed') {
      await this.verifyAllAbsent(input, saga);
      await this.ports.custody.assertResolvable(saga.preserveReferences);
      return reportFromSaga(saga, 'already_purged');
    }

    for (const surface of EXACT_SESSION_PURGE_SURFACE_ORDER) {
      if (saga.surfaces[surface].status === 'completed') continue;
      try {
        saga = await this.markSurfacePending(saga, surface);
      } catch (error) {
        throw new ExactSessionPurgeIncompleteError(cloneSaga(saga), surface, error);
      }
      try {
        // This is the final authorization read immediately before each
        // irreversible mutation. The exclusive fence must also serialize every
        // proof/source writer capable of changing targetRevision.
        await this.ports.authority.revalidate(input, saga.target);
        const result = await this.ports.surfaces[surface].remove(input, saga.target);
        validateDeleteResult(result);
        if (!await this.ports.surfaces[surface].isAbsent(input, saga.target)) {
          throw new Error(`Exact-session purge surface ${surface} still contains target data`);
        }
        saga = await this.markSurfaceCompleted(saga, surface, result);
      } catch (error) {
        saga = await this.markSurfaceFailed(saga, surface, error);
        throw new ExactSessionPurgeIncompleteError(cloneSaga(saga), surface, error);
      }
    }

    try {
      await this.verifyAllAbsent(input, saga);
      await this.ports.custody.assertResolvable(saga.preserveReferences);
      await this.ports.authority.revalidate(input, saga.target);
    } catch (error) {
      throw new ExactSessionPurgeIncompleteError(cloneSaga(saga), null, error);
    }
    saga = await this.completeSaga(saga);
    return reportFromSaga(saga, 'purged');
  }

  private validateInput(input: ExactSessionPurgeInput): void {
    requiredText(input.companionId, 'companionId');
    requiredText(input.sessionId, 'sessionId');
    requiredText(input.runId, 'runId');
    requiredText(input.targetRevision, 'targetRevision');
    uniqueReferences(input.preserveReferences);
  }

  private async verifyAllAbsent(
    input: ExactSessionPurgeInput,
    saga: ExactSessionPurgeSagaRecord,
  ): Promise<void> {
    for (const surface of EXACT_SESSION_PURGE_SURFACE_ORDER) {
      if (!await this.ports.surfaces[surface].isAbsent(input, saga.target)) {
        throw new Error(`Exact-session purge surface ${surface} was not absent at final verification`);
      }
    }
  }

  private async markSurfacePending(
    saga: ExactSessionPurgeSagaRecord,
    surface: AutomataSessionPurgeSurface,
  ): Promise<ExactSessionPurgeSagaRecord> {
    const previousRevision = saga.revision;
    const next = cloneSaga(saga);
    next.revision += 1;
    next.surfaces[surface] = {
      ...next.surfaces[surface],
      status: 'pending',
      attempts: next.surfaces[surface].attempts + 1,
      lastErrorDigest: null,
    };
    await this.ports.sagaStore.update(next, previousRevision);
    return next;
  }

  private async markSurfaceCompleted(
    saga: ExactSessionPurgeSagaRecord,
    surface: AutomataSessionPurgeSurface,
    result: ExactSessionSurfaceDeleteResult,
  ): Promise<ExactSessionPurgeSagaRecord> {
    const previousRevision = saga.revision;
    const next = cloneSaga(saga);
    next.revision += 1;
    next.surfaces[surface] = {
      ...next.surfaces[surface],
      status: 'completed',
      removedCount: result.removedCount,
      completion: result.status,
      lastErrorDigest: null,
    };
    await this.ports.sagaStore.update(next, previousRevision);
    return next;
  }

  private async markSurfaceFailed(
    saga: ExactSessionPurgeSagaRecord,
    surface: AutomataSessionPurgeSurface,
    error: unknown,
  ): Promise<ExactSessionPurgeSagaRecord> {
    const previousRevision = saga.revision;
    const next = cloneSaga(saga);
    next.revision += 1;
    next.surfaces[surface] = {
      ...next.surfaces[surface],
      status: 'pending',
      lastErrorDigest: errorDigest(error),
    };
    await this.ports.sagaStore.update(next, previousRevision);
    return next;
  }

  private async completeSaga(
    saga: ExactSessionPurgeSagaRecord,
  ): Promise<ExactSessionPurgeSagaRecord> {
    const previousRevision = saga.revision;
    const next = cloneSaga(saga);
    next.revision += 1;
    next.status = 'completed';
    await this.ports.sagaStore.update(next, previousRevision);
    return next;
  }
}
