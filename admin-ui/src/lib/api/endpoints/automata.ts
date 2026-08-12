import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';

export type AutomataRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type AutomataVerificationStatus = 'pending' | 'rejected' | 'verified';

export interface AutomataClassView {
  id: string;
  workerKind: 'subagent' | 'shard' | 'background' | 'scheduler' | 'post_turn';
  trigger: string;
  busEligibility: 'eligible' | 'excluded';
  retentionMs: number;
  failureClass: string;
  concurrencyClass: string;
}

export interface AutomataRunView {
  companionId: string;
  runId: string;
  automatonClass: string;
  workerId: string;
  workerGeneration: number;
  taskId: string;
  taskLabel: string;
  sessionIds: string[];
  artifactCount: number;
  artifactCustody: Record<'discarded' | 'durable' | 'pending', number>;
  status: AutomataRunStatus;
  statusReason: string;
  createdAtMs: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  retentionDeadlineMs: number;
}

export interface AutomataFindingView {
  claim: string;
  provenance: 'computed' | 'fetched' | 'recalled' | 'testimony';
  verificationStatus: AutomataVerificationStatus;
  confidence?: number;
  evidence: Array<{
    kind: 'artifact' | 'command' | 'external' | 'session-span';
    summary: string;
    digest?: string;
    referenceDigest: string;
  }>;
}

export interface AutomataEventView {
  eventId: string;
  sequence: number;
  occurredAt: string;
  type: 'finding' | 'relation';
  context: {
    automatonClass: string;
    runId: string;
    taskId: string;
    parentRunId?: string;
    sessionCount: number;
    artifactCount: number;
  };
  finding?: AutomataFindingView;
  relation?: {
    targetEventId: string;
    kind: 'corrects' | 'retracts' | 'supersedes';
    reason: string;
    replacement?: AutomataFindingView;
  };
}

export interface AutomataSnapshot {
  classes: AutomataClassView[];
  runs: AutomataRunView[];
  runPage: { offset: number; limit: number; hasMore: boolean };
  bus: {
    available: boolean;
    health: {
      condition: 'degraded' | 'healthy' | 'unavailable';
      freshness: 'fresh' | 'stale' | 'unknown';
      observedAt: string | null;
      lastEventAt: string | null;
      indexState: 'building' | 'degraded' | 'ready' | 'unavailable';
      reindexState: 'current' | 'required' | 'running';
      pendingIndexCount: number;
      oldestPendingAt?: string;
      lastIndexFailureAt?: string;
      degradationReasons: string[];
    };
    events: AutomataEventView[];
    currentFindings: Array<{
      eventId: string;
      sequence: number;
      occurredAt: string;
      sourceEventType: 'finding' | 'relation';
      context: AutomataEventView['context'];
      finding: AutomataFindingView;
    }>;
    correctionHistory: Array<{
      targetEventId: string;
      relation: 'corrects' | 'retracts' | 'supersedes';
      byEventId: string;
    }>;
    page: { offset: number; limit: number; hasMore: boolean };
  };
  extensions: {
    managementPanels: Array<{
      id: string;
      label: string;
      description: string;
      mode: 'read_only';
    }>;
  };
}

export interface AutomataQuery {
  status?: AutomataRunStatus | '';
  classId?: string;
  taskId?: string;
  limit?: number;
  runOffset?: number;
  busLimit?: number;
  busOffset?: number;
  busClassId?: string;
  busRunId?: string;
  busTaskId?: string;
  eventId?: string;
  verificationStatus?: AutomataVerificationStatus | '';
}

export function buildAutomataPath(query: AutomataQuery = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  return withQuery('/api/admin/automata', params);
}

export function getAutomataSnapshot(query: AutomataQuery = {}): Promise<AutomataSnapshot> {
  return apiGet<AutomataSnapshot>(buildAutomataPath(query));
}

export type AutomataPageState = 'loading' | 'error' | 'empty' | 'ready' | 'stale' | 'degraded';

export function resolveAutomataPageState(input: {
  loading: boolean;
  error: string;
  snapshot: AutomataSnapshot | null;
}): AutomataPageState {
  if (input.loading && input.snapshot === null) return 'loading';
  if (input.error && input.snapshot === null) return 'error';
  if (input.snapshot === null) return 'empty';
  if (input.snapshot.bus.health.condition !== 'healthy') return 'degraded';
  if (input.snapshot.bus.health.freshness === 'stale') return 'stale';
  if (input.snapshot.runs.length === 0 && input.snapshot.bus.events.length === 0) return 'empty';
  return 'ready';
}
