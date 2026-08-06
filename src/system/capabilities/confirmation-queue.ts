import { randomUUID } from 'node:crypto';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type {
  ApprovalAttribution,
  ApprovalSourceSystem,
} from '../../shared/contracts/approval-envelope.js';

export const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type ConfirmationDecision = 'approve' | 'deny' | 'modify';

export type ConfirmationResolutionAuthority = 'operator';

export interface ConfirmationResolverIdentity {
  kind: 'companion' | 'operator';
  id: string;
}

export interface ConfirmationExecutionContext {
  resolver?: ConfirmationResolverIdentity;
}

export interface ConfirmedApprovalExecution {
  readonly approvalId: string;
  readonly decision: Extract<ConfirmationDecision, 'approve' | 'modify'>;
  readonly resolver?: ConfirmationResolverIdentity;
}

/**
 * Runtime proof that an executor is running inside this queue's one terminal
 * approve/modify dispatch. A structural object or captured context is not
 * authority: records exist only for the duration of the executor call.
 */
const confirmedApprovalExecutions =
  new WeakMap<ConfirmationExecutionContext, ConfirmedApprovalExecution>();

export function readConfirmedApprovalExecution(
  context: ConfirmationExecutionContext,
  approvalId: string,
): ConfirmedApprovalExecution {
  const confirmed = confirmedApprovalExecutions.get(context);
  if (!confirmed || confirmed.approvalId !== approvalId) {
    throw new Error('Confirmation execution is not backed by the resolved approval');
  }
  return {
    approvalId: confirmed.approvalId,
    decision: confirmed.decision,
    ...(confirmed.resolver ? { resolver: { ...confirmed.resolver } } : {}),
  };
}

/**
 * Immutable server-derived approval ownership. `companionId` is the parent
 * routing/authorization key; `shardId` is provenance only. Approval surfaces
 * must scope by this record rather than by browser fields or presentation
 * attribution.
 */
export interface ConfirmationApprovalOwner {
  companionId: string;
  shardId?: string;
}

/**
 * Signals that the queued side effect committed before a post-execution
 * durability/audit step failed. The queue must never describe this as
 * unexecuted: callers can then retry a non-idempotent mutation.
 */
export class ConfirmationExecutionCommittedError extends Error {
  readonly executed = true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ConfirmationExecutionCommittedError';
  }
}

export type ConfirmationResolutionStatus =
  | 'approved'
  | 'denied'
  | 'modified'
  | 'expired'
  | 'failed'
  | 'not_found';

export interface ConfirmationQueueEntry {
  id: string;
  method: string;
  action: string;
  scope: string;
  params: Record<string, unknown>;
  companionReason: string;
  resolutionAuthority?: ConfirmationResolutionAuthority;
  requestedAt: number;
  expiresAt: number;
  /**
   * Unified-approval-envelope provenance (bead psfn-framework-13sk / ct0v).
   * Optional and immutable: additive metadata the enqueuer resolved server-side
   * (e.g. the gateway confirmation gate). Ordinary entries omit both fields and
   * behave exactly as before. `attribution.parentId`, when present, MUST equal
   * the authenticated owner — the emission observer enforces that fail-closed.
   */
  sourceSystem?: ApprovalSourceSystem;
  attribution?: ApprovalAttribution;
  approvalOwner?: ConfirmationApprovalOwner;
}

export interface ConfirmationQueueHistoryEntry extends Partial<ConfirmationQueueEntry> {
  id: string;
  status: ConfirmationResolutionStatus;
  resolvedAt: number;
  executed: boolean;
  message: string;
  decision?: ConfirmationDecision;
  appliedParams?: Record<string, unknown>;
  error?: string;
  resolver?: ConfirmationResolverIdentity;
}

export interface ConfirmationQueueRequest {
  method: string;
  action: string;
  scope: string;
  params: Record<string, unknown>;
  companionReason: string;
  resolutionAuthority?: ConfirmationResolutionAuthority;
  expiresInMs?: number;
  /** Optional unified-envelope provenance; see {@link ConfirmationQueueEntry}. */
  sourceSystem?: ApprovalSourceSystem;
  attribution?: ApprovalAttribution;
  /** Optional trusted owner; approval boundaries must derive and validate it. */
  approvalOwner?: ConfirmationApprovalOwner;
}

export interface ConfirmationResolveRequest {
  id: string;
  decision: ConfirmationDecision;
  modifiedParams?: Record<string, unknown>;
}

export interface ConfirmationResolveResult {
  id: string;
  status: ConfirmationResolutionStatus;
  message: string;
  executed: boolean;
}

/**
 * Resolution outcome delivered to a queue observer. `not_found` never reaches
 * observers — it does not correspond to a live entry. A failed `modify` with
 * invalid params also does not notify: the entry stays pending.
 */
export interface ConfirmationQueueResolutionOutcome {
  id: string;
  status: Exclude<ConfirmationResolutionStatus, 'not_found'>;
  resolvedAt: number;
  executed: boolean;
  decision?: ConfirmationDecision;
  resolver?: ConfirmationResolverIdentity;
  entry: ConfirmationQueueEntry;
}

export type ConfirmationQueueTerminalOutcome =
  ConfirmationQueueResolutionOutcome & {
    status: 'denied' | 'expired';
    executed: false;
  };

/**
 * Lifecycle observer for the confirmation queue — the single choke point for
 * approval enqueue/resolve/expiry (w9hj.1 companion relay emission seam).
 * `beforeTerminalized` is a synchronous commit guard: it MAY throw, in which
 * case the queue retains the pending entry and emits no resolution. The other
 * callbacks MUST NOT throw; wire asynchronous work (event-bus emission)
 * behind them.
 */
export interface ConfirmationQueueObserver {
  beforeTerminalized?(outcome: ConfirmationQueueTerminalOutcome): void;
  onEnqueued?(entry: ConfirmationQueueEntry): void;
  onResolved?(outcome: ConfirmationQueueResolutionOutcome): void;
}

export interface ConfirmationQueueOptions {
  defaultExpiryMs?: number;
  now?: () => number;
  idFactory?: () => string;
  observer?: ConfirmationQueueObserver;
}

type ConfirmationExecutor = (
  params: Record<string, unknown>,
  entry: ConfirmationQueueEntry,
  context: ConfirmationExecutionContext,
) => Promise<unknown>;

interface PendingEntry {
  entry: ConfirmationQueueEntry;
  execute: ConfirmationExecutor;
  onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
  retainOnExecutionFailure?: boolean;
  renewOnExpiry?: boolean;
  failedResolution?: {
    decision: ConfirmationDecision;
    resolver?: ConfirmationResolverIdentity;
  };
}

function cloneAttribution(input: ApprovalAttribution): ApprovalAttribution {
  return {
    parentLabel: input.parentLabel,
    parentId: input.parentId,
    ...(input.shardLabel !== undefined ? { shardLabel: input.shardLabel } : {}),
    ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
  };
}

function cloneApprovalOwner(input: ConfirmationApprovalOwner): ConfirmationApprovalOwner {
  return {
    companionId: input.companionId,
    ...(input.shardId !== undefined ? { shardId: input.shardId } : {}),
  };
}

function throwUnrepresentableConfirmationParam(path: string, detail: string): never {
  throw new TypeError(`Confirmation params ${path} ${detail}`);
}

function assertConfirmationParamWireRepresentable(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>,
): void {
  if (
    value === null
    || value === undefined
    || typeof value === 'string'
    || typeof value === 'boolean'
  ) {
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throwUnrepresentableConfirmationParam(path, 'must be a finite JSON number');
    }
    return;
  }
  if (typeof value !== 'object') {
    throwUnrepresentableConfirmationParam(path, 'is not JSON wire-representable');
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throwUnrepresentableConfirmationParam(path, 'must be a valid Date');
    }
    return;
  }
  if (ancestors.has(value)) {
    throwUnrepresentableConfirmationParam(path, 'must not contain a cycle');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throwUnrepresentableConfirmationParam(path, 'must not contain symbol keys');
      }
      for (const property of Object.getOwnPropertyNames(value)) {
        if (property === 'length') continue;
        const index = Number(property);
        if (
          !Number.isInteger(index)
          || index < 0
          || index >= value.length
          || String(index) !== property
        ) {
          throwUnrepresentableConfirmationParam(path, 'must not contain non-index array properties');
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        assertConfirmationParamWireRepresentable(value[index], `${path}[${String(index)}]`, ancestors);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throwUnrepresentableConfirmationParam(path, 'must be a plain object, array, or Date');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throwUnrepresentableConfirmationParam(path, 'must not contain symbol keys');
    }
    for (const [key, child] of Object.entries(value)) {
      assertConfirmationParamWireRepresentable(child, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function cloneConfirmationParams(input: Record<string, unknown>): Record<string, unknown> {
  assertConfirmationParamWireRepresentable(input, 'params', new WeakSet<object>());
  return structuredClone(input);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

export class ConfirmationQueue {
  private readonly defaultExpiryMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly observer: ConfirmationQueueObserver | null;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly history: ConfirmationQueueHistoryEntry[] = [];

  constructor(options: ConfirmationQueueOptions = {}) {
    this.defaultExpiryMs = normalizePositiveInt(
      options.defaultExpiryMs,
      DEFAULT_CONFIRMATION_EXPIRY_MS,
    );
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    this.observer = options.observer ?? null;
  }

  private notifyResolved(outcome: ConfirmationQueueResolutionOutcome): void {
    this.observer?.onResolved?.({
      ...outcome,
      entry: this.snapshot(outcome.entry),
    });
  }

  private guardTerminalResolution(outcome: ConfirmationQueueTerminalOutcome): void {
    this.observer?.beforeTerminalized?.({
      ...outcome,
      entry: this.snapshot(outcome.entry),
    });
  }

  enqueue(
    request: ConfirmationQueueRequest,
    execute: ConfirmationExecutor,
    lifecycle: {
      onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
      retainOnExecutionFailure?: boolean;
      renewOnExpiry?: boolean;
    } = {},
  ): ConfirmationQueueEntry {
    this.expirePending();
    const requestedAt = this.now();
    const expiresInMs = normalizePositiveInt(request.expiresInMs, this.defaultExpiryMs);
    const entry: ConfirmationQueueEntry = {
      id: this.idFactory(),
      method: request.method,
      action: request.action,
      scope: request.scope,
      params: cloneConfirmationParams(request.params),
      companionReason: request.companionReason.trim() || 'No companion reason provided.',
      ...(request.resolutionAuthority
        ? { resolutionAuthority: request.resolutionAuthority }
        : {}),
      requestedAt,
      expiresAt: requestedAt + expiresInMs,
      ...(request.sourceSystem ? { sourceSystem: request.sourceSystem } : {}),
      ...(request.attribution ? { attribution: cloneAttribution(request.attribution) } : {}),
      ...(request.approvalOwner
        ? { approvalOwner: cloneApprovalOwner(request.approvalOwner) }
        : {}),
    };
    this.pending.set(entry.id, {
      entry,
      execute,
      ...(lifecycle.onDenied ? { onDenied: lifecycle.onDenied } : {}),
      ...(lifecycle.retainOnExecutionFailure ? { retainOnExecutionFailure: true } : {}),
      ...(lifecycle.renewOnExpiry ? { renewOnExpiry: true } : {}),
    });
    this.observer?.onEnqueued?.(this.snapshot(entry));
    return this.snapshot(entry);
  }

  refreshPending(
    id: string,
    execute: ConfirmationExecutor,
    lifecycle: {
      onDenied?: (outcome: ConfirmationQueueTerminalOutcome) => Promise<void>;
      retainOnExecutionFailure?: boolean;
      renewOnExpiry?: boolean;
    } = {},
  ): ConfirmationQueueEntry {
    this.expirePending();
    const pending = this.pending.get(id);
    if (!pending) throw new Error(`Confirmation request is not pending: ${id}`);
    pending.execute = execute;
    if (lifecycle.onDenied) pending.onDenied = lifecycle.onDenied;
    else delete pending.onDenied;
    if (lifecycle.retainOnExecutionFailure) pending.retainOnExecutionFailure = true;
    else delete pending.retainOnExecutionFailure;
    if (lifecycle.renewOnExpiry) pending.renewOnExpiry = true;
    else delete pending.renewOnExpiry;
    return this.snapshot(pending.entry);
  }

  reconcileRetainedResolution(
    id: string,
    status: 'approved' | 'denied',
  ): ConfirmationResolveResult {
    const pending = this.pending.get(id);
    if (!pending?.failedResolution) {
      throw new Error(`Confirmation request has no retained failed resolution: ${id}`);
    }
    const { decision, resolver } = pending.failedResolution;
    if ((status === 'approved' && decision !== 'approve')
      || (status === 'denied' && decision !== 'deny')) {
      throw new Error(`Retained confirmation ${id} cannot reconcile ${decision} as ${status}`);
    }
    const resolvedAt = this.now();
    if (status === 'denied') {
      this.guardTerminalResolution({
        id,
        status: 'denied',
        resolvedAt,
        executed: false,
        decision,
        ...(resolver ? { resolver } : {}),
        entry: pending.entry,
      });
    }
    this.pending.delete(id);
    const executed = status === 'approved';
    const message = status === 'approved'
      ? 'Action approval reconciled from durable committed state.'
      : 'Action denial reconciled from durable committed state.';
    this.history.push(this.snapshotHistory({
      ...pending.entry,
      status,
      decision,
      resolvedAt,
      executed,
      message,
      ...(resolver ? { resolver } : {}),
    }));
    this.notifyResolved({
      id,
      status,
      resolvedAt,
      executed,
      decision,
      ...(resolver ? { resolver } : {}),
      entry: pending.entry,
    });
    return { id, status, message, executed };
  }

  discardPending(id: string): boolean {
    return this.pending.delete(id);
  }

  listPending(): ConfirmationQueueEntry[] {
    this.expirePending();
    return [...this.pending.values()]
      .map((record) => this.snapshot(record.entry))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  listHistory(): ConfirmationQueueHistoryEntry[] {
    this.expirePending();
    return [...this.history]
      .map((entry) => this.snapshotHistory(entry))
      .sort((a, b) => {
        const delta = b.resolvedAt - a.resolvedAt;
        if (delta !== 0) return delta;
        return a.id.localeCompare(b.id);
      });
  }

  getPending(id: string): ConfirmationQueueEntry | null {
    this.expirePending();
    const found = this.pending.get(id);
    return found ? this.snapshot(found.entry) : null;
  }

  /**
   * Reads only the immutable owner needed to authorize a resolution. Unlike
   * `getPending`, this does not expire first: the subsequent `resolve` call
   * remains responsible for returning the precise `expired` outcome.
   */
  getApprovalOwner(id: string): ConfirmationApprovalOwner | null {
    const found = this.pending.get(id)?.entry.approvalOwner
      ?? this.history.find(entry => entry.id === id)?.approvalOwner;
    return found ? cloneApprovalOwner(found) : null;
  }

  async resolve(
    request: ConfirmationResolveRequest,
    resolver?: ConfirmationResolverIdentity,
  ): Promise<ConfirmationResolveResult> {
    const pending = this.pending.get(request.id);
    if (!pending) {
      this.expirePending();
      return {
        id: request.id,
        status: 'not_found',
        message: 'Confirmation request not found.',
        executed: false,
      };
    }

    const now = this.now();
    if (pending.entry.expiresAt <= now) {
      if (pending.renewOnExpiry) {
        pending.entry = {
          ...pending.entry,
          expiresAt: now + this.defaultExpiryMs,
        };
      } else {
        const outcome: ConfirmationQueueTerminalOutcome = {
          id: request.id,
          status: 'expired',
          resolvedAt: now,
          executed: false,
          decision: request.decision,
          ...(resolver ? { resolver } : {}),
          entry: pending.entry,
        };
        this.guardTerminalResolution(outcome);
        this.pending.delete(request.id);
        this.history.push(this.snapshotHistory({
          ...pending.entry,
          status: 'expired',
          decision: request.decision,
          resolvedAt: now,
          executed: false,
          message: 'Confirmation request expired before resolution.',
          ...(resolver ? { resolver } : {}),
        }));
        this.notifyResolved(outcome);
        this.expirePending();
        return {
          id: request.id,
          status: 'expired',
          message: 'Confirmation request expired before resolution.',
          executed: false,
        };
      }
    }

    if (pending.entry.resolutionAuthority === 'operator' && resolver?.kind !== 'operator') {
      return {
        id: request.id,
        status: 'failed',
        message: 'Confirmation requires an independently authenticated operator resolution.',
        executed: false,
      };
    }

    if (request.decision === 'deny') {
      const outcome: ConfirmationQueueTerminalOutcome = {
        id: request.id,
        status: 'denied',
        resolvedAt: now,
        executed: false,
        decision: request.decision,
        ...(resolver ? { resolver } : {}),
        entry: pending.entry,
      };
      try {
        await pending.onDenied?.(outcome);
      } catch (error) {
        if (pending.retainOnExecutionFailure) {
          pending.failedResolution = {
            decision: request.decision,
            ...(resolver ? { resolver } : {}),
          };
        }
        return {
          id: request.id,
          status: 'failed',
          message: toErrorMessage(error),
          executed: false,
        };
      }
      this.guardTerminalResolution(outcome);
      this.pending.delete(request.id);
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'denied',
        decision: request.decision,
        resolvedAt: now,
        executed: false,
        message: 'Action denied by operator.',
        ...(resolver ? { resolver } : {}),
      }));
      this.notifyResolved(outcome);
      return {
        id: request.id,
        status: 'denied',
        message: 'Action denied by operator.',
        executed: false,
      };
    }

    if (request.decision === 'modify' && !isRecord(request.modifiedParams)) {
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'failed',
        decision: request.decision,
        resolvedAt: now,
        executed: false,
        message: 'Modified params are required and must be a JSON object.',
        ...(resolver ? { resolver } : {}),
      }));
      return {
        id: request.id,
        status: 'failed',
        message: 'Modified params are required and must be a JSON object.',
        executed: false,
      };
    }

    const nextParams = request.decision === 'modify'
      ? cloneConfirmationParams(request.modifiedParams as Record<string, unknown>)
      : cloneConfirmationParams(pending.entry.params);
    const runEntry = this.snapshot({
      ...pending.entry,
      params: nextParams,
    });
    this.pending.delete(request.id);

    const executionContext: ConfirmationExecutionContext = {
      ...(resolver ? { resolver } : {}),
    };
    confirmedApprovalExecutions.set(executionContext, {
      approvalId: runEntry.id,
      decision: request.decision,
      ...(resolver ? { resolver: { ...resolver } } : {}),
    });
    try {
      await pending.execute(nextParams, runEntry, executionContext);
      const resolvedAt = this.now();
      const status = request.decision === 'modify' ? 'modified' : 'approved';
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status,
        decision: request.decision,
        resolvedAt,
        executed: true,
        message: request.decision === 'modify'
          ? 'Action executed with modified parameters.'
          : 'Action approved and executed.',
        appliedParams: nextParams,
        ...(resolver ? { resolver } : {}),
      }));
      this.notifyResolved({
        id: request.id,
        status,
        resolvedAt,
        executed: true,
        decision: request.decision,
        ...(resolver ? { resolver } : {}),
        entry: pending.entry,
      });
      return {
        id: request.id,
        status,
        message: request.decision === 'modify'
          ? 'Action executed with modified parameters.'
          : 'Action approved and executed.',
        executed: true,
      };
    } catch (error) {
      if (pending.retainOnExecutionFailure) {
        pending.failedResolution = {
          decision: request.decision,
          ...(resolver ? { resolver } : {}),
        };
        this.pending.set(request.id, pending);
        return {
          id: request.id,
          status: 'failed',
          message: toErrorMessage(error),
          executed: false,
        };
      }
      const resolvedAt = this.now();
      const executed = error instanceof ConfirmationExecutionCommittedError;
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'failed',
        decision: request.decision,
        resolvedAt,
        executed,
        message: toErrorMessage(error),
        appliedParams: nextParams,
        error: toErrorMessage(error),
        ...(resolver ? { resolver } : {}),
      }));
      this.notifyResolved({
        id: request.id,
        status: 'failed',
        resolvedAt,
        executed,
        decision: request.decision,
        ...(resolver ? { resolver } : {}),
        entry: pending.entry,
      });
      return {
        id: request.id,
        status: 'failed',
        message: toErrorMessage(error),
        executed,
      };
    } finally {
      confirmedApprovalExecutions.delete(executionContext);
    }
  }

  expirePending(): number {
    const now = this.now();
    let expired = 0;
    for (const [id, pending] of this.pending) {
      if (pending.entry.expiresAt <= now) {
        if (pending.renewOnExpiry) {
          pending.entry = {
            ...pending.entry,
            expiresAt: now + this.defaultExpiryMs,
          };
          continue;
        }
        const outcome: ConfirmationQueueTerminalOutcome = {
          id,
          status: 'expired',
          resolvedAt: now,
          executed: false,
          entry: pending.entry,
        };
        this.guardTerminalResolution(outcome);
        this.pending.delete(id);
        this.history.push(this.snapshotHistory({
          ...pending.entry,
          status: 'expired',
          resolvedAt: now,
          executed: false,
          message: 'Confirmation request expired before resolution.',
        }));
        this.notifyResolved(outcome);
        expired += 1;
      }
    }
    return expired;
  }

  private snapshot(entry: ConfirmationQueueEntry): ConfirmationQueueEntry {
    return {
      ...entry,
      params: cloneConfirmationParams(entry.params),
      ...(entry.attribution ? { attribution: cloneAttribution(entry.attribution) } : {}),
      ...(entry.approvalOwner
        ? { approvalOwner: cloneApprovalOwner(entry.approvalOwner) }
        : {}),
    };
  }

  private snapshotHistory(entry: ConfirmationQueueHistoryEntry): ConfirmationQueueHistoryEntry {
    return {
      ...entry,
      ...(entry.params ? { params: cloneConfirmationParams(entry.params) } : {}),
      ...(entry.appliedParams ? { appliedParams: cloneConfirmationParams(entry.appliedParams) } : {}),
      ...(entry.attribution ? { attribution: cloneAttribution(entry.attribution) } : {}),
      ...(entry.approvalOwner
        ? { approvalOwner: cloneApprovalOwner(entry.approvalOwner) }
        : {}),
    };
  }
}
