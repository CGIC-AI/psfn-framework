import { createHash } from 'node:crypto';

import type {
  AutomataBusEvent,
  AutomataBusEvidence,
  AutomataBusFindingBody,
  AutomataBusProvenance,
  AutomataBusRelationKind,
  AutomataBusVerificationStatus,
} from '../../../faculties/automata/bus/contract.js';
import type {
  AutomataBusDisposition,
  AutomataBusEffectiveFinding,
} from '../../../faculties/automata/bus/current-state.js';
import type {
  AutomataLessonGroup,
  AutomataLessonProjection,
  AutomataLessonReadScope,
} from '../../../faculties/automata/bus/lesson-projection.js';
import type {
  AutomataRunRecord,
  AutomataRunStatus,
  EffectiveAutomataClassDescriptor,
} from '../../../faculties/automata/registry-contract.js';
import type { AutomataRunRegistry } from '../../../faculties/automata/run-registry.js';
import { SENSITIVITY_LEVELS } from '../../../system/trust/types.js';

type AdminAutomataBusCondition = 'degraded' | 'healthy' | 'unavailable';
type AdminAutomataBusFreshness = 'fresh' | 'stale' | 'unknown';
export type AdminAutomataBusDegradationReason =
  | 'index_building'
  | 'index_lagging'
  | 'index_unavailable'
  | 'read_failed'
  | 'reindex_required'
  | 'source_unavailable';

export interface AdminAutomataBusHealthSource {
  condition: AdminAutomataBusCondition;
  freshness: AdminAutomataBusFreshness;
  observedAt: string | null;
  lastEventAt: string | null;
  indexState: 'building' | 'degraded' | 'ready' | 'unavailable';
  reindexState: 'current' | 'required' | 'running';
  pendingIndexCount: number;
  oldestPendingAt?: string;
  lastIndexFailureAt?: string;
  degradationReasons: readonly AdminAutomataBusDegradationReason[];
}

export interface AdminAutomataBusReadInput {
  companionId: string;
  offset: number;
  limit: number;
  classId?: string;
  runId?: string;
  taskId?: string;
  eventId?: string;
  verificationStatus?: AutomataBusVerificationStatus;
}

/**
 * Narrow companion-scoped read seam. The persistence/query implementation owns
 * filtering and page construction; Garden owns disclosure projection.
 */
export interface AdminAutomataBusReadPort {
  readPage(input: AdminAutomataBusReadInput): Promise<{
    companionId: string;
    events: readonly AutomataBusEvent[];
    currentFindings: readonly AutomataBusEffectiveFinding[];
    dispositions: readonly AutomataBusDisposition[];
    hasMore: boolean;
    eventIdMatched?: boolean;
    health: AdminAutomataBusHealthSource;
  }>;
}

export interface AdminAutomataLessonReadPort {
  query(scope: AutomataLessonReadScope): Promise<AutomataLessonProjection>;
}

export interface AdminAutomataReadPolicy {
  defaultPageLimit: number;
  maxPageLimit: number;
}

interface AdminAutomataRunView {
  companionId: string;
  runId: string;
  automatonClass: string;
  workerId: string;
  workerGeneration: number;
  taskId: string;
  taskLabel: string;
  trigger: string;
  busEligibility: EffectiveAutomataClassDescriptor['busEligibility'];
  parentRunId?: string;
  sourceRunId?: string;
  sessionIds: string[];
  artifactCount: number;
  artifactCustody: Record<'discarded' | 'durable' | 'pending', number>;
  status: AutomataRunStatus;
  statusReason: string;
  outcome?: AutomataRunRecord['outcome'];
  promotionState: AutomataRunRecord['promotionState'];
  foldState: AutomataRunRecord['foldState'];
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  retentionDeadlineMs: number;
  retentionState: 'active_protected' | 'due' | 'retained';
}

interface AdminAutomataEvidenceView {
  kind: AutomataBusEvidence['kind'];
  summary: string;
  digest?: string;
  /** Content-free identity for correlation; the raw reference is never disclosed. */
  referenceDigest: string;
}

interface AdminAutomataFindingView {
  claim: string;
  provenance: AutomataBusProvenance;
  verificationStatus: AutomataBusVerificationStatus;
  confidence?: number;
  evidence: AdminAutomataEvidenceView[];
}

interface AdminAutomataEventContextView {
  automatonClass: string;
  runId: string;
  taskId: string;
  parentRunId?: string;
  sessionCount: number;
  artifactCount: number;
}

interface AdminAutomataEventView {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: 'finding' | 'relation';
  context: AdminAutomataEventContextView;
  finding?: AdminAutomataFindingView;
  relation?: {
    targetEventId: string;
    kind: AutomataBusRelationKind;
    reason: string;
    replacement?: AdminAutomataFindingView;
  };
}

interface AdminAutomataCurrentFindingView {
  eventId: string;
  sequence: number;
  occurredAt: string;
  sourceEventType: 'finding' | 'relation';
  context: AdminAutomataEventContextView;
  finding: AdminAutomataFindingView;
}

export interface AdminAutomataPanelExtension {
  id: string;
  label: string;
  description: string;
  mode: 'read_only';
}

export interface AdminAutomataSnapshot {
  classes: EffectiveAutomataClassDescriptor[];
  runs: AdminAutomataRunView[];
  runPage: { offset: number; limit: number; hasMore: boolean };
  bus: {
    available: boolean;
    health: AdminAutomataBusHealthSource;
    events: AdminAutomataEventView[];
    currentFindings: AdminAutomataCurrentFindingView[];
    correctionHistory: AutomataBusDisposition[];
    page: { offset: number; limit: number; hasMore: boolean };
  };
  lessons: {
    available: boolean;
    condition: 'ready' | 'unavailable';
    degradationReason?: 'read_failed' | 'source_unavailable';
    groups: AutomataLessonGroup[];
    hasMore: boolean;
    sourceFindingCount: number;
    proposalReviewPath: '/api/admin/shared-workspace/proposals';
  };
  extensions: { managementPanels: AdminAutomataPanelExtension[] };
}

export interface AdminAutomataSnapshotOptions {
  status?: string;
  classId?: string;
  taskId?: string;
  limit?: number;
  runOffset?: number;
  busOffset?: number;
  busLimit?: number;
  busClassId?: string;
  busRunId?: string;
  busTaskId?: string;
  eventId?: string;
  verificationStatus?: string;
}

export interface AdminAutomataService {
  getSnapshot(options?: AdminAutomataSnapshotOptions): Promise<AdminAutomataSnapshot>;
}

export class AdminAutomataQueryError extends Error {}
export class AdminAutomataNotFoundError extends Error {}

const VERIFICATION_STATUSES: readonly AutomataBusVerificationStatus[] = [
  'pending',
  'rejected',
  'verified',
];

const UNAVAILABLE_HEALTH = Object.freeze({
  condition: 'unavailable',
  freshness: 'unknown',
  observedAt: null,
  lastEventAt: null,
  indexState: 'unavailable',
  reindexState: 'required',
  pendingIndexCount: 0,
  degradationReasons: ['source_unavailable'] as const,
}) satisfies AdminAutomataBusHealthSource;

const OPERATOR_AUTOMATA_SENSITIVITY = SENSITIVITY_LEVELS[SENSITIVITY_LEVELS.length - 1]!;

function requirePageValue(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new AdminAutomataQueryError(`${label} must be between 1 and ${maximum}`);
  }
  return resolved;
}

function requireOffset(value: number | undefined, label: string): number {
  const resolved = value ?? 0;
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new AdminAutomataQueryError(`${label} must be a non-negative safe integer`);
  }
  return resolved;
}

function requireText(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized) throw new AdminAutomataQueryError(`${label} must be non-empty`);
  return normalized;
}

function requireVerificationStatus(value: string | undefined): AutomataBusVerificationStatus | undefined {
  if (value === undefined) return undefined;
  if (!VERIFICATION_STATUSES.some(candidate => candidate === value)) {
    throw new AdminAutomataQueryError(`Unknown Automata Bus verification status "${value}"`);
  }
  return value as AutomataBusVerificationStatus;
}

function projectRun(
  record: AutomataRunRecord,
  descriptor: EffectiveAutomataClassDescriptor,
  nowMs: number,
): AdminAutomataRunView {
  const artifactCustody = { discarded: 0, durable: 0, pending: 0 };
  for (const artifact of record.artifacts) artifactCustody[artifact.custody] += 1;
  return {
    companionId: record.companionId,
    runId: record.runId,
    automatonClass: record.automatonClass,
    workerId: record.workerId,
    workerGeneration: record.workerGeneration,
    taskId: record.taskId,
    taskLabel: record.taskLabel,
    trigger: descriptor.trigger,
    busEligibility: descriptor.busEligibility,
    ...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
    ...(record.sourceRunId ? { sourceRunId: record.sourceRunId } : {}),
    sessionIds: [...record.sessionIds],
    artifactCount: record.artifacts.length,
    artifactCustody,
    status: record.status,
    statusReason: record.statusReason,
    ...(record.outcome ? { outcome: record.outcome } : {}),
    promotionState: record.promotionState,
    foldState: record.foldState,
    createdAtMs: record.createdAtMs,
    ...(record.startedAtMs === undefined ? {} : { startedAtMs: record.startedAtMs }),
    ...(record.finishedAtMs === undefined ? {} : { finishedAtMs: record.finishedAtMs }),
    retentionDeadlineMs: record.retentionDeadlineMs,
    retentionState: record.status === 'queued' || record.status === 'running'
      ? 'active_protected'
      : record.retentionDeadlineMs <= nowMs
        ? 'due'
        : 'retained',
  };
}

function digestReference(reference: string): string {
  return `sha256:${createHash('sha256').update(reference).digest('hex')}`;
}

function projectFinding(body: AutomataBusFindingBody): AdminAutomataFindingView {
  return {
    claim: body.claim,
    provenance: body.provenance,
    verificationStatus: body.verification.status,
    ...(body.confidence === undefined ? {} : { confidence: body.confidence }),
    evidence: body.evidence.map(evidence => ({
      kind: evidence.kind,
      summary: evidence.summary,
      ...(evidence.digest ? { digest: evidence.digest } : {}),
      referenceDigest: digestReference(evidence.reference),
    })),
  };
}

function projectContext(context: AutomataBusEvent['context']): AdminAutomataEventContextView {
  return {
    automatonClass: context.automatonClass,
    runId: context.runId,
    taskId: context.taskId,
    ...(context.parentRunId ? { parentRunId: context.parentRunId } : {}),
    sessionCount: context.sessionIds.length,
    artifactCount: context.artifactRefs.length,
  };
}

function projectEvent(event: AutomataBusEvent): AdminAutomataEventView {
  const base = {
    eventId: event.eventId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    type: event.type,
    context: projectContext(event.context),
  };
  if (event.type === 'finding') return { ...base, finding: projectFinding(event.body) };
  return {
    ...base,
    relation: {
      targetEventId: event.body.targetEventId,
      kind: event.body.relation,
      reason: event.body.reason,
      ...(event.body.replacement ? { replacement: projectFinding(event.body.replacement) } : {}),
    },
  };
}

function projectCurrentFinding(finding: AutomataBusEffectiveFinding): AdminAutomataCurrentFindingView {
  return {
    eventId: finding.eventId,
    sequence: finding.sequence,
    occurredAt: finding.occurredAt,
    sourceEventType: finding.sourceEventType,
    context: projectContext(finding.context),
    finding: projectFinding(finding.body),
  };
}

function assertCompanionPage(
  companionId: string,
  page: Awaited<ReturnType<AdminAutomataBusReadPort['readPage']>>,
): void {
  if (page.companionId !== companionId) {
    throw new Error('Automata Bus read returned a cross-companion page');
  }
  for (const event of page.events) {
    if (event.companionId !== companionId) {
      throw new Error(`Automata Bus read returned cross-companion event "${event.eventId}"`);
    }
  }
  for (const finding of page.currentFindings) {
    if (finding.companionId !== companionId) {
      throw new Error(`Automata Bus read returned cross-companion finding "${finding.eventId}"`);
    }
  }
}

export class AdminAutomataDataService implements AdminAutomataService {
  constructor(private readonly options: {
    registry: AutomataRunRegistry;
    companionId: string;
    readPolicy: AdminAutomataReadPolicy;
    bus?: AdminAutomataBusReadPort | null;
    lessons?: AdminAutomataLessonReadPort | null;
    managementPanels?: readonly AdminAutomataPanelExtension[];
  }) {
    requirePageValue(
      options.readPolicy.defaultPageLimit,
      options.readPolicy.defaultPageLimit,
      options.readPolicy.maxPageLimit,
      'Automata default page limit',
    );
    requireText(options.companionId, 'Automata companionId');
  }

  async getSnapshot(input: AdminAutomataSnapshotOptions = {}): Promise<AdminAutomataSnapshot> {
    const { registry, companionId, readPolicy } = this.options;
    const limit = requirePageValue(input.limit, readPolicy.defaultPageLimit, readPolicy.maxPageLimit, 'Automata run limit');
    const runOffset = requireOffset(input.runOffset, 'Automata run offset');
    if (runOffset + limit > readPolicy.maxPageLimit) {
      throw new AdminAutomataQueryError(`Automata run page must end at or before ${readPolicy.maxPageLimit}`);
    }
    const runPageEnd = runOffset + limit;
    const runReadLimit = Math.min(runPageEnd + 1, readPolicy.maxPageLimit);
    let requestedRuns: AutomataRunRecord[];
    try {
      requestedRuns = registry.listRuns({
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.classId === undefined ? {} : { classId: input.classId }),
        ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
        limit: runReadLimit,
      });
    } catch (error) {
      throw new AdminAutomataQueryError(error instanceof Error ? error.message : 'Invalid Automata run query');
    }
    const runItems = requestedRuns.slice(runOffset, runPageEnd);
    for (const run of runItems) {
      if (run.companionId !== companionId) throw new Error(`Automata registry returned cross-companion run "${run.runId}"`);
    }

    const busLimit = requirePageValue(input.busLimit, limit, readPolicy.maxPageLimit, 'Automata Bus limit');
    const busOffset = requireOffset(input.busOffset, 'Automata Bus offset');
    const verificationStatus = requireVerificationStatus(input.verificationStatus);
    const eventId = requireText(input.eventId, 'Automata Bus eventId');
    const busClassId = requireText(input.busClassId, 'Automata Bus classId');
    const busRunId = requireText(input.busRunId, 'Automata Bus runId');
    const busTaskId = requireText(input.busTaskId, 'Automata Bus taskId');
    if (busClassId !== undefined) {
      try {
        registry.listRuns({ classId: busClassId, limit: readPolicy.defaultPageLimit });
      } catch (error) {
        throw new AdminAutomataQueryError(error instanceof Error ? error.message : 'Invalid Automata Bus class query');
      }
    }

    let bus: AdminAutomataSnapshot['bus'] = {
      available: false,
      health: { ...UNAVAILABLE_HEALTH, degradationReasons: [...UNAVAILABLE_HEALTH.degradationReasons] },
      events: [],
      currentFindings: [],
      correctionHistory: [],
      page: { offset: busOffset, limit: busLimit, hasMore: false },
    };
    if (this.options.bus) {
      try {
        const page = await this.options.bus.readPage({
          companionId,
          offset: busOffset,
          limit: busLimit,
          ...(busClassId === undefined ? {} : { classId: busClassId }),
          ...(busRunId === undefined ? {} : { runId: busRunId }),
          ...(busTaskId === undefined ? {} : { taskId: busTaskId }),
          ...(eventId === undefined ? {} : { eventId }),
          ...(verificationStatus === undefined ? {} : { verificationStatus }),
        });
        assertCompanionPage(companionId, page);
        if (
          page.events.length > busLimit
          || page.currentFindings.length > busLimit
          || page.dispositions.length > busLimit
        ) {
          throw new Error('Automata Bus read exceeded the requested page bound');
        }
        if (eventId !== undefined && page.eventIdMatched !== true) {
          throw new AdminAutomataNotFoundError(`Unknown Automata Bus event "${eventId}"`);
        }
        bus = {
          available: page.health.condition !== 'unavailable',
          health: { ...page.health, degradationReasons: [...page.health.degradationReasons] },
          events: page.events.map(projectEvent),
          currentFindings: page.currentFindings.map(projectCurrentFinding),
          correctionHistory: page.dispositions.map(disposition => ({ ...disposition })),
          page: { offset: busOffset, limit: busLimit, hasMore: page.hasMore },
        };
      } catch (error) {
        if (error instanceof AdminAutomataNotFoundError) throw error;
        bus = {
          ...bus,
          health: {
            ...UNAVAILABLE_HEALTH,
            degradationReasons: ['read_failed'],
          },
        };
      }
    }

    let lessons: AdminAutomataSnapshot['lessons'] = {
      available: false,
      condition: 'unavailable',
      degradationReason: 'source_unavailable',
      groups: [],
      hasMore: false,
      sourceFindingCount: 0,
      proposalReviewPath: '/api/admin/shared-workspace/proposals',
    };
    const lessonReader = this.options.lessons;
    if (lessonReader) {
      try {
        const projection = await lessonReader.query({
          companionId,
          audience: 'operator',
          maxSensitivity: OPERATOR_AUTOMATA_SENSITIVITY,
        });
        lessons = {
          available: true,
          condition: 'ready',
          groups: projection.groups.map(group => ({
            ...group,
            sourceFindingIds: [...group.sourceFindingIds],
            evidenceIds: [...group.evidenceIds],
            contradiction: {
              ...group.contradiction,
              sourceFindingIds: [...group.contradiction.sourceFindingIds],
            },
          })),
          hasMore: projection.hasMore,
          sourceFindingCount: projection.sourceFindingCount,
          proposalReviewPath: '/api/admin/shared-workspace/proposals',
        };
      } catch {
        lessons = { ...lessons, degradationReason: 'read_failed' };
      }
    }

    const classes = registry.listClasses();
    const classesById = new Map(classes.map(descriptor => [descriptor.id, descriptor]));
    const nowMs = Date.now();
    return {
      classes,
      runs: runItems.map((record) => {
        const descriptor = classesById.get(record.automatonClass);
        if (!descriptor) {
          throw new Error(`Automata registry returned run with unknown class "${record.automatonClass}"`);
        }
        return projectRun(record, descriptor, nowMs);
      }),
      runPage: { offset: runOffset, limit, hasMore: requestedRuns.length > runPageEnd },
      bus,
      lessons,
      extensions: {
        managementPanels: (this.options.managementPanels ?? []).map(panel => ({ ...panel, mode: 'read_only' })),
      },
    };
  }
}
