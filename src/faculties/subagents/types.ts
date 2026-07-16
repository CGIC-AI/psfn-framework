import type { SubagentWorkerLane } from '../../core/agent/worker-lanes.js';
import type { SessionEntry } from '../../core/session/types.js';
import type { LLMWorkSpec, SubstrateMessage, WyomingRoutingMetadata } from '../../shared/contracts/runtime.js';
import type { GatewayRoutingEnvelope } from '../../shared/routing/envelope.js';

export type SubagentTaskLifecycleState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * mmo9.7.7 — the honest terminal outcome of a bounded subagent run, distinct from
 * the task-registry lifecycle machine. A non-`completed` outcome NEVER masquerades
 * as `completed`; it always carries a {@link SubagentPartialResult} so callers can
 * account for the work done and decide whether to resume.
 * - `completed`       the bounded run produced its final output.
 * - `blocked`         execution hit an obstruction/error before completing.
 * - `cancelled`       cancellation was requested mid-flight.
 * - `budget_limited`  the run was curtailed by a declared work-spec budget
 *                     (deadline or output-token ceiling) with turns still unused.
 */
export type SubagentOutcome = 'completed' | 'blocked' | 'cancelled' | 'budget_limited';

export interface SubagentExecutionSourceContext {
  channelId: string;
  requestId?: string;
  turnId?: string;
  originatingTaskId?: string;
  originatingBeadId?: string;
}

export interface SubagentExecutionRequest {
  name: string;
  task: string;
  /**
   * mmo9.7.7 — the typed {@link LLMWorkSpec} carried through the subagent faculty.
   * Threaded onto the bounded worker's model calls (via the mmo9.7.1 client seam)
   * so admission/accounting attribution flows through the existing client
   * boundary, and consulted for the run's budget (deadline / output-token
   * ceilings). Build it with `buildSubagentWorkSpec` so its declared lane
   * reconciles byte-identically with the runtime lane resolver (Law 12.4).
   */
  workSpec: LLMWorkSpec;
  systemPrompt?: string;
  maxTurns?: number;
  capabilities?: readonly string[];
  requiredCapabilities?: readonly string[];
  executionChannelId?: string;
  message?: SubstrateMessage;
  sourceContext?: SubagentExecutionSourceContext;
}

/**
 * mmo9.7.7 — budget headroom remaining at the point a non-completed run stopped.
 * Turn budget is always present; the token/deadline fields appear only when the
 * work spec declared the corresponding ceiling. Exhausted ceilings floor at 0
 * (deadline may report the overshoot as a non-positive value).
 */
export interface SubagentRemainingBudget {
  /** Bounded-loop turns left unused when work stopped (0 when fully consumed). */
  remainingTurns: number;
  /** Output-token headroom under the declared `workSpec.maxOutputTokens`. */
  remainingOutputTokens?: number;
  /** Wall-clock headroom under the declared `workSpec.deadlineMs` (<=0 if over). */
  remainingDeadlineMs?: number;
}

/**
 * mmo9.7.7 — the latest usable partial output captured before a non-completed run
 * stopped, so a caller can resume from or account for the work already done.
 */
export interface SubagentCheckpoint {
  /** Latest assistant content produced before stopping ('' when none). */
  content: string;
  /** Turns completed when the checkpoint was captured. */
  turnsCompleted: number;
  /** Model that produced the checkpoint content ('' when no turn ran). */
  model: string;
  /** Wall-clock capture time (ms). */
  capturedAt: number;
}

/**
 * mmo9.7.7 — carried on every non-`completed` {@link SubagentResult} so outcomes
 * report honestly with remaining budget and the latest checkpoint.
 */
export interface SubagentPartialResult {
  remainingBudget: SubagentRemainingBudget;
  latestCheckpoint: SubagentCheckpoint;
}

export interface WyomingSubagentDelegationRequest {
  message: SubstrateMessage;
  routing?: WyomingRoutingMetadata;
  gatewayRouting?: GatewayRoutingEnvelope;
  subagentName?: string;
}

export interface SubagentTaskRecord {
  subagentId: string;
  name: string;
  task: string;
  workerLane: SubagentWorkerLane;
  channelId: string;
  lifecycleState: SubagentTaskLifecycleState;
  stateReason: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  failureReason?: string;
  capabilities: string[];
  requiredCapabilities: string[];
  sourceContext?: SubagentExecutionSourceContext;
}

export interface SubagentResult {
  subagentId: string;
  name: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  turns: number;
  workerLane: SubagentWorkerLane;
  lifecycleState: Extract<SubagentTaskLifecycleState, 'completed' | 'failed' | 'cancelled'>;
  /**
   * mmo9.7.7 — the honest terminal outcome. Refines `lifecycleState` (which stays
   * the coarse registry machine state): a `budget_limited` run reports a distinct
   * outcome even though the registry records it as a non-completed terminal.
   */
  outcome: SubagentOutcome;
  stateReason: string;
  failureReason?: string;
  /**
   * mmo9.7.7 — present on every non-`completed` outcome (`blocked` | `cancelled` |
   * `budget_limited`); carries remaining budget + latest checkpoint. Absent iff
   * `outcome === 'completed'`.
   */
  partial?: SubagentPartialResult;
  capabilities: string[];
  requiredCapabilities: string[];
}

export interface SubagentRuntimeArtifactView {
  kind: 'final_output';
  content: string;
  timestamp: number;
  sourceMessageId?: number;
}

export interface SubagentRuntimeResumeView {
  channelId: string;
  lifecycleState: SubagentTaskLifecycleState;
  resumable: boolean;
  transcriptAvailable: boolean;
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  lastActivityAt?: number;
  lastMessageId?: number;
}

export interface SubagentRuntimeTaskView {
  task: SubagentTaskRecord;
  transcript: SessionEntry[];
  transcriptMessageCount: number;
  transcriptTruncated: boolean;
  artifacts: SubagentRuntimeArtifactView[];
  resume: SubagentRuntimeResumeView;
}

export interface SubagentRuntimeTaskDetail {
  view: SubagentRuntimeTaskView;
  result?: SubagentResult;
}

export interface SubagentRuntimeSnapshot {
  generatedAt: number;
  activeCount: number;
  activeTasks: SubagentRuntimeTaskView[];
  recentTasks: SubagentRuntimeTaskView[];
}

export interface SubagentRuntimeSnapshotOptions {
  taskLimit?: number;
  transcriptLimit?: number;
}

export interface SubagentRuntimeSnapshotProvider {
  getRuntimeSnapshot(options?: SubagentRuntimeSnapshotOptions): SubagentRuntimeSnapshot;
}
