import type {
  AutomataRedeliveryCandidate,
  AutomataRunRedeliveryOracle,
} from '../../../faculties/automata/run-registry.js';
import {
  memoryExtractionTurnIdFromRunId,
  memoryExtractionTurnRunId,
} from '../../../faculties/memory/extraction/memory-extraction-automata-run.js';
import {
  BACKGROUND_WORK_LEASE_EXPIRY_LIMIT,
  type BackgroundWorkKind,
  type BackgroundWorkState,
} from './types.js';

const INTENTION_POST_TURN_HOOKS_RUN_PREFIX = 'intention-post-turn-hooks:';

function intentionRequestIdFromRunId(runId: string): string | undefined {
  if (!runId.startsWith(INTENTION_POST_TURN_HOOKS_RUN_PREFIX)) return undefined;
  const attemptSeparator = runId.lastIndexOf(':');
  if (attemptSeparator <= INTENTION_POST_TURN_HOOKS_RUN_PREFIX.length) return undefined;
  return runId.slice(INTENTION_POST_TURN_HOOKS_RUN_PREFIX.length, attemptSeparator);
}

/**
 * The run id one intention post-turn hooks attempt opens: the canonical source
 * request plus the job's durable attempt, so a redelivered job or a restart
 * within the same attempt re-enters its own run, while a genuine retry (which
 * increments the attempt) opens a fresh run.
 */
export function intentionPostTurnHooksRunId(sourceRequestId: string, attemptCount: number): string {
  return `${INTENTION_POST_TURN_HOOKS_RUN_PREFIX}${sourceRequestId}:${attemptCount}`;
}

/**
 * The durable-job fields that decide which Automata runs a non-terminal
 * background-work job will re-enter and whether it will ever run again.
 */
export interface BackgroundWorkRunLinkageJob {
  jobId: string;
  kind: string;
  state: BackgroundWorkState;
  sourceRequestId: string;
  sourceTurnId: string;
  attemptCount: number;
  leaseExpiresAtMs?: number;
  leaseExpiryCount: number;
  /** A `started` effect receipt exists: lease expiry records an unknown outcome. */
  boundaryCrossed: boolean;
}

/** Identity keys a linkage query matches against the job's own columns. */
export interface BackgroundWorkRunLinkageKeys {
  sourceRequestIds: readonly string[];
  jobIds: readonly string[];
  sourceTurnIds: readonly string[];
}

export interface BackgroundWorkRunLinkagePort {
  /** Non-terminal jobs whose request, job, or turn id is one of the keys. */
  listNonTerminalJobsForRunLinkage(keys: BackgroundWorkRunLinkageKeys): Promise<BackgroundWorkRunLinkageJob[]>;
}

/**
 * Every run id a job of this kind can open or re-enter when redelivered. A
 * kind without a derivation re-enters nothing, so its orphaned runs fail.
 *
 * Memory extraction names its run from the source turn context: the source
 * request id, the welfare-granting job id, or the turn-derived attempt ref
 * (see the extraction orchestrator), so each of those is owned by the job.
 * The same derivation names the runs a dead-lettered job leaves behind
 * (psfn-framework-vxllk).
 */
export function backgroundWorkLinkedRunIds(
  job: Pick<BackgroundWorkRunLinkageJob, 'jobId' | 'kind' | 'sourceRequestId' | 'sourceTurnId' | 'attemptCount'>,
): string[] {
  const kind = job.kind as BackgroundWorkKind;
  switch (kind) {
    case 'memory_extraction':
      return [job.sourceRequestId, job.jobId, memoryExtractionTurnRunId(job.sourceTurnId)];
    case 'intention_post_turn_hooks':
      return [intentionPostTurnHooksRunId(job.sourceRequestId, job.attemptCount)];
    case 'emotion_appraisal':
    case 'auto_compaction':
      return [];
    default:
      throw new Error(`Unknown background-work kind "${job.kind}" in run linkage.`);
  }
}

export const RUN_CLASS_JOB_KIND: Readonly<Record<string, BackgroundWorkKind>> = {
  'memory.extraction': 'memory_extraction',
  'background.intention_post_turn_hooks': 'intention_post_turn_hooks',
  'background.emotion_appraisal': 'emotion_appraisal',
  'background.auto_compaction': 'auto_compaction',
};

/**
 * Whether the supervisor will ever claim this job again. Mirrors the expiry
 * sweep: a running job whose lease has expired is re-leased only when it never
 * crossed an effect boundary and has lease-expiry budget left; otherwise the
 * first supervisor tick fails it without reaching the Automata lifecycle. An
 * unexpired lease may still belong to a live previous process, so it is kept.
 */
function willRunAgain(job: BackgroundWorkRunLinkageJob, nowMs: number): boolean {
  switch (job.state) {
    case 'queued':
    case 'deferred':
    case 'retry_wait':
      return true;
    case 'running':
      if (job.leaseExpiresAtMs === undefined) {
        throw new Error(`Running background-work job "${job.jobId}" has no lease expiry.`);
      }
      if (job.leaseExpiresAtMs > nowMs) return true;
      return !job.boundaryCrossed && job.leaseExpiryCount + 1 < BACKGROUND_WORK_LEASE_EXPIRY_LIMIT;
    default:
      return false;
  }
}

function linkageKeys(candidates: readonly AutomataRedeliveryCandidate[]): BackgroundWorkRunLinkageKeys {
  const sourceRequestIds = new Set<string>();
  const jobIds = new Set<string>();
  const sourceTurnIds = new Set<string>();
  for (const candidate of candidates) {
    const kind = RUN_CLASS_JOB_KIND[candidate.automatonClass];
    for (const runId of candidate.lineageRunIds) {
      if (kind === 'memory_extraction') {
        sourceRequestIds.add(runId);
        jobIds.add(runId);
        const turnId = memoryExtractionTurnIdFromRunId(runId);
        if (turnId !== undefined) sourceTurnIds.add(turnId);
      } else if (kind === 'intention_post_turn_hooks') {
        const requestId = intentionRequestIdFromRunId(runId);
        if (requestId !== undefined) sourceRequestIds.add(requestId);
      }
    }
  }
  return {
    sourceRequestIds: [...sourceRequestIds],
    jobIds: [...jobIds],
    sourceTurnIds: [...sourceTurnIds],
  };
}

/**
 * Restart authority for `lease_retry` Automata runs, backed by the durable
 * background-work queue: a run is redelivered only when a non-terminal job of
 * the run's own kind will run again and re-enter that exact run id.
 */
export function createBackgroundWorkRunRedeliveryOracle(
  store: BackgroundWorkRunLinkagePort,
): AutomataRunRedeliveryOracle {
  return {
    async findRedeliveredRunIds(candidates, nowMs) {
      for (const candidate of candidates) {
        if (!RUN_CLASS_JOB_KIND[candidate.automatonClass]) {
          throw new Error(`Automata class "${candidate.automatonClass}" has no background-work redelivery owner.`);
        }
      }
      const keys = linkageKeys(candidates);
      const redelivered = new Set<string>();
      if (keys.sourceRequestIds.length + keys.jobIds.length + keys.sourceTurnIds.length === 0) return redelivered;
      const requested = new Map<string, BackgroundWorkKind>();
      for (const candidate of candidates) {
        for (const runId of candidate.lineageRunIds) {
          requested.set(runId, RUN_CLASS_JOB_KIND[candidate.automatonClass]!);
        }
      }
      for (const job of await store.listNonTerminalJobsForRunLinkage(keys)) {
        if (!willRunAgain(job, nowMs)) continue;
        for (const runId of backgroundWorkLinkedRunIds(job)) {
          if (requested.get(runId) === job.kind) redelivered.add(runId);
        }
      }
      return redelivered;
    },
  };
}
