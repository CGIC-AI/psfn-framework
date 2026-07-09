import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Turn-scoped registry of paid deliverables produced during an agent turn that
 * have not yet been handed to chat egress. A "paid deliverable" is any charged
 * surface that yielded a user-facing artifact (at minimum paidImageGeneration
 * results). The registry lets an in-turn tool (for example response_control)
 * detect that ending the turn with no reply would silently drop a paid artifact
 * the user paid for, without coupling that tool to any specific artifact domain.
 *
 * The store is established once around the agent invocation for a turn. Tools
 * that produce a charged deliverable note it here; the response-disposition tool
 * reads it before honoring an intentional no-reply.
 */
export interface PendingPaidDeliverable {
  /** Charge surface that produced the artifact, e.g. 'paidImageGeneration'. */
  surface: string;
  /** Tool that produced the artifact, e.g. 'selfie_create' or 'generate_image'. */
  toolName?: string;
  /** Tool call id that produced the artifact, when known. */
  toolCallId?: string;
  /** Stable identifier for the artifact (provider request id or file name). */
  identifier?: string;
  /** Number of artifacts produced by this deliverable. */
  artifactCount?: number;
  /** Artifact class when the deliverable can be rehydrated for outbound chat. */
  artifactKind?: 'image';
  /** Provider that produced the artifact, when domain-specific recovery needs it. */
  provider?: string;
  /** Generation mode, when domain-specific recovery needs it. */
  mode?: string;
  /** Model that produced the artifact, when known. */
  model?: string;
  /** Local or remote image assets that can be attached if the transcript is incomplete. */
  artifacts?: PendingPaidDeliverableArtifact[];
}

export interface PendingPaidDeliverableArtifact {
  url: string;
  contentType?: string;
  fileName?: string;
  localPath?: string;
}

interface PaidDeliverableTrackingState {
  pending: PendingPaidDeliverable[];
}

const paidDeliverableStorage = new AsyncLocalStorage<PaidDeliverableTrackingState>();

/**
 * Establish a fresh turn-scoped paid-deliverable registry for the duration of
 * `fn`. Nested tool executions observe the same store.
 */
export function runWithPaidDeliverableTracking<T>(fn: () => Promise<T>): Promise<T> {
  return paidDeliverableStorage.run({ pending: [] }, fn);
}

/**
 * Record that a charged deliverable was produced in the current turn. No-op when
 * called outside an active tracking scope (for example maintenance or subagent
 * contexts that never reach chat egress).
 */
export function notePendingPaidDeliverable(entry: PendingPaidDeliverable): void {
  const state = paidDeliverableStorage.getStore();
  if (!state) {
    return;
  }
  state.pending.push({ ...entry });
}

/**
 * Snapshot the paid deliverables produced so far in the current turn. Returns an
 * empty list when called outside an active tracking scope.
 */
export function listPendingPaidDeliverables(): readonly PendingPaidDeliverable[] {
  const state = paidDeliverableStorage.getStore();
  if (!state) {
    return [];
  }
  return state.pending.map((entry) => ({
    ...entry,
    ...(entry.artifacts ? { artifacts: entry.artifacts.map((artifact) => ({ ...artifact })) } : {}),
  }));
}
