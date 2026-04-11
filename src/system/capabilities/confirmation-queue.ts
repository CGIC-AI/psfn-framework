import { randomUUID } from 'node:crypto';
import { isRecord } from '../../shared/utils/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

export const DEFAULT_CONFIRMATION_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type ConfirmationDecision = 'approve' | 'deny' | 'modify';

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
  requestedAt: number;
  expiresAt: number;
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
}

export interface ConfirmationQueueRequest {
  method: string;
  action: string;
  scope: string;
  params: Record<string, unknown>;
  companionReason: string;
  expiresInMs?: number;
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

export interface ConfirmationQueueOptions {
  defaultExpiryMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

type ConfirmationExecutor = (
  params: Record<string, unknown>,
  entry: ConfirmationQueueEntry,
) => Promise<unknown>;

interface PendingEntry {
  entry: ConfirmationQueueEntry;
  execute: ConfirmationExecutor;
}

function cloneRecord(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  } catch {
    return { ...input };
  }
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
  private readonly pending = new Map<string, PendingEntry>();
  private readonly history: ConfirmationQueueHistoryEntry[] = [];

  constructor(options: ConfirmationQueueOptions = {}) {
    this.defaultExpiryMs = normalizePositiveInt(
      options.defaultExpiryMs,
      DEFAULT_CONFIRMATION_EXPIRY_MS,
    );
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  enqueue(
    request: ConfirmationQueueRequest,
    execute: ConfirmationExecutor,
  ): ConfirmationQueueEntry {
    this.expirePending();
    const requestedAt = this.now();
    const expiresInMs = normalizePositiveInt(request.expiresInMs, this.defaultExpiryMs);
    const entry: ConfirmationQueueEntry = {
      id: this.idFactory(),
      method: request.method,
      action: request.action,
      scope: request.scope,
      params: cloneRecord(request.params),
      companionReason: request.companionReason.trim() || 'No companion reason provided.',
      requestedAt,
      expiresAt: requestedAt + expiresInMs,
    };
    this.pending.set(entry.id, { entry, execute });
    return this.snapshot(entry);
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

  async resolve(request: ConfirmationResolveRequest): Promise<ConfirmationResolveResult> {
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
      this.pending.delete(request.id);
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'expired',
        decision: request.decision,
        resolvedAt: now,
        executed: false,
        message: 'Confirmation request expired before resolution.',
      }));
      this.expirePending();
      return {
        id: request.id,
        status: 'expired',
        message: 'Confirmation request expired before resolution.',
        executed: false,
      };
    }

    if (request.decision === 'deny') {
      this.pending.delete(request.id);
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'denied',
        decision: request.decision,
        resolvedAt: now,
        executed: false,
        message: 'Action denied by operator.',
      }));
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
      }));
      return {
        id: request.id,
        status: 'failed',
        message: 'Modified params are required and must be a JSON object.',
        executed: false,
      };
    }

    const nextParams = request.decision === 'modify'
      ? cloneRecord(request.modifiedParams as Record<string, unknown>)
      : cloneRecord(pending.entry.params);
    const runEntry = this.snapshot({
      ...pending.entry,
      params: nextParams,
    });
    this.pending.delete(request.id);

    try {
      await pending.execute(nextParams, runEntry);
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: request.decision === 'modify' ? 'modified' : 'approved',
        decision: request.decision,
        resolvedAt: this.now(),
        executed: true,
        message: request.decision === 'modify'
          ? 'Action executed with modified parameters.'
          : 'Action approved and executed.',
        appliedParams: nextParams,
      }));
      return {
        id: request.id,
        status: request.decision === 'modify' ? 'modified' : 'approved',
        message: request.decision === 'modify'
          ? 'Action executed with modified parameters.'
          : 'Action approved and executed.',
        executed: true,
      };
    } catch (error) {
      this.history.push(this.snapshotHistory({
        ...pending.entry,
        status: 'failed',
        decision: request.decision,
        resolvedAt: this.now(),
        executed: false,
        message: toErrorMessage(error),
        appliedParams: nextParams,
        error: toErrorMessage(error),
      }));
      return {
        id: request.id,
        status: 'failed',
        message: toErrorMessage(error),
        executed: false,
      };
    }
  }

  expirePending(): number {
    const now = this.now();
    let expired = 0;
    for (const [id, pending] of this.pending) {
      if (pending.entry.expiresAt <= now) {
        this.pending.delete(id);
        this.history.push(this.snapshotHistory({
          ...pending.entry,
          status: 'expired',
          resolvedAt: now,
          executed: false,
          message: 'Confirmation request expired before resolution.',
        }));
        expired += 1;
      }
    }
    return expired;
  }

  private snapshot(entry: ConfirmationQueueEntry): ConfirmationQueueEntry {
    return {
      ...entry,
      params: cloneRecord(entry.params),
    };
  }

  private snapshotHistory(entry: ConfirmationQueueHistoryEntry): ConfirmationQueueHistoryEntry {
    return {
      ...entry,
      ...(entry.params ? { params: cloneRecord(entry.params) } : {}),
      ...(entry.appliedParams ? { appliedParams: cloneRecord(entry.appliedParams) } : {}),
    };
  }
}
