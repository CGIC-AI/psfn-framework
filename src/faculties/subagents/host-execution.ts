/**
 * Host-executed automata attempts (`SubagentHostExecutionPort`).
 *
 * An automaton is an ephemeral shared worker. Core derives its task and its
 * Bus scope from its source (the subagent spawn: `SubagentFaculty.spawn` opens
 * the governed run, resolves the role, and forms the bound `automata_bus`
 * tool), and a host that runs its own agents (e.g. Hermes)
 * may execute it as one of its own subagents:
 *
 * - every task runs as a sequence of attempts; each attempt is claimed by one
 *   host instance and gets a fresh iteration budget (at most the policy's) and
 *   a fresh per-attempt credential that core ingress binds to that attempt;
 * - a child the host loses (reported lost, failed, or not renewed within the
 *   lease) ends the attempt and revokes its credential; the task then gets
 *   the next attempt until the hard attempt cap, which ends it failed;
 * - the attempt's only persistence is the Automata Bus, through the governed
 *   tool core formed for the run; its writes carry stable write keys, so a
 *   write repeated by a later attempt is the same Bus event;
 * - attempts of different tasks are independent: there is no global lock or
 *   single worker; the only exclusivity is one live attempt per task.
 *
 * When no host execution port is configured, `SubagentFaculty` runs every
 * subagent in-process as usual.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';

export interface HostedAutomataPolicy {
  /** Attempts a task gets; when the last one ends without a result the task ends failed. */
  readonly maxAttempts: number;
  /** An attempt the host has not renewed (heartbeat, Bus call) within this time is lost. */
  readonly leaseMs: number;
  /** The largest per-attempt iteration budget a host may declare for its child. */
  readonly maxIterations: number;
}

/** What core derived from the automaton's source; the host gets the goal and context only. */
export interface HostedAutomatonTask {
  readonly subagentId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly automatonClass: string;
  readonly name: string;
  readonly goal: string;
  readonly context: string | null;
  /** The governed `automata_bus` tool bound to the run's scope, or null when the run has no Bus access. */
  readonly busTool: SubstrateAgentTool | null;
}

export type HostedAutomatonOutcome =
  | { readonly kind: 'completed'; readonly summary: string; readonly model: string; readonly apiCalls: number; readonly attempts: number }
  | {
    readonly kind: 'failed';
    readonly reason: 'attempt_cap_exhausted' | 'host_execution_closed';
    readonly lastFailure: string;
    readonly attempts: number;
  }
  | { readonly kind: 'cancelled'; readonly reason: string; readonly attempts: number };

/** The SubagentFaculty seam: run a task's attempts on the host, or cancel them. */
export interface SubagentHostExecutionPort {
  execute(task: HostedAutomatonTask): Promise<HostedAutomatonOutcome>;
  cancel(subagentId: string, reason: string): void;
}

export interface HostedAttemptClaim {
  readonly attemptId: string;
  readonly subagentId: string;
  readonly name: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly goal: string;
  readonly context: string | null;
  /** This attempt's budget: the iteration budget the host declared for its child. */
  readonly budget: { readonly maxIterations: number };
  /** Bearer for this attempt only; core ingress refuses it once the attempt ends. */
  readonly credential: string;
  readonly leaseMs: number;
  readonly busAccess: boolean;
}

export type HostedAttemptReport =
  | { readonly kind: 'succeeded'; readonly summary: string; readonly model: string | null; readonly apiCalls: number }
  | { readonly kind: 'failed'; readonly code: string }
  /** The host no longer has the child (unknown handle, process exit, no reconnect). */
  | { readonly kind: 'lost'; readonly code: string }
  | { readonly kind: 'cancelled' };

export type HostedAttemptRefusal =
  | 'unknown_attempt'
  | 'attempt_ended'
  | 'not_attempt_owner'
  | 'budget_exceeds_policy'
  | 'invalid'
  | 'no_bus_access'
  | 'cancel_requested';

export type HostedResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: HostedAttemptRefusal; readonly message: string };

export interface HostedAttemptStatus {
  readonly status: 'active' | 'cancel_requested';
  readonly attempt: number;
}

export interface HostedReportAnswer {
  readonly attempt: number;
  /** What became of the task: the next attempt is queued (`retry`), or it ended. */
  readonly next: 'retry' | 'completed' | 'failed' | 'cancelled';
}

export type HostedAutomataEvent =
  | { readonly kind: 'attempt_claimed'; readonly subagentId: string; readonly attempt: number; readonly owner: string; readonly maxIterations: number }
  | { readonly kind: 'attempt_ended'; readonly subagentId: string; readonly attempt: number; readonly end: string }
  | { readonly kind: 'task_ended'; readonly subagentId: string; readonly outcome: HostedAutomatonOutcome['kind']; readonly attempts: number };

interface AttemptState {
  readonly attemptId: string;
  readonly number: number;
  readonly owner: string;
  readonly digest: string;
  readonly maxIterations: number;
  leaseExpiresAt: number;
  ended: string | null;
  busCalls: number;
}

interface TaskState {
  readonly task: HostedAutomatonTask;
  readonly attempts: AttemptState[];
  waiting: boolean;
  cancelReason: string | null;
  lastFailure: string;
  outcome: HostedAutomatonOutcome | null;
  readonly resolve: (outcome: HostedAutomatonOutcome) => void;
}

export interface HostedAutomataExecutorOptions {
  readonly now?: () => number;
  readonly mintCredential?: () => string;
  readonly onEvent?: (event: HostedAutomataEvent) => void;
  /** Sweep for expired leases on a timer (default true); tests sweep explicitly. */
  readonly sweepTimer?: boolean;
  /** Bound on recently ended credentials remembered for explicit `attempt_ended` diagnostics. */
  readonly rememberedEndedAttempts?: number;
}

const OUTCOME_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const DEFAULT_REMEMBERED_ENDED_ATTEMPTS = 1024;

function digestOf(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

function refuse<T>(refusal: HostedAttemptRefusal, message: string): HostedResult<T> {
  return { ok: false, refusal, message };
}

function validatePolicy(policy: HostedAutomataPolicy): HostedAutomataPolicy {
  for (const [field, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`hosted automata ${field} must be a positive integer`);
    }
  }
  return { ...policy };
}

function textOf(content: readonly unknown[]): string {
  return content
    .map((block: unknown) => {
      const part = block as { type?: unknown; text?: unknown };
      return part.type === 'text' && typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

export class HostedAutomataExecutor implements SubagentHostExecutionPort {
  private readonly policy: HostedAutomataPolicy;
  private readonly now: () => number;
  private readonly mintCredential: () => string;
  private readonly onEvent: (event: HostedAutomataEvent) => void;
  private readonly rememberedEndedAttempts: number;
  private readonly tasks = new Map<string, TaskState>();
  /** Tasks waiting for an attempt to be claimed, oldest first. */
  private readonly queue: string[] = [];
  /** Live attempts by credential digest. */
  private readonly byDigest = new Map<string, { task: TaskState; attempt: AttemptState }>();
  /** Recently ended attempts by credential digest, so a late call is told why it is refused. */
  private readonly endedDigests = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval> | null;
  private closed = false;

  constructor(policy: HostedAutomataPolicy, options: HostedAutomataExecutorOptions = {}) {
    this.policy = validatePolicy(policy);
    this.now = options.now ?? Date.now;
    this.mintCredential = options.mintCredential ?? (() => randomBytes(32).toString('base64url'));
    this.onEvent = options.onEvent ?? (() => undefined);
    this.rememberedEndedAttempts = options.rememberedEndedAttempts ?? DEFAULT_REMEMBERED_ENDED_ATTEMPTS;
    if (options.sweepTimer === false) {
      this.timer = null;
    } else {
      this.timer = setInterval(() => this.sweep(), this.policy.leaseMs);
      this.timer.unref();
    }
  }

  get maxAttempts(): number {
    return this.policy.maxAttempts;
  }

  // -- the faculty side ------------------------------------------------------

  execute(task: HostedAutomatonTask): Promise<HostedAutomatonOutcome> {
    if (this.closed) {
      return Promise.resolve({ kind: 'failed', reason: 'host_execution_closed', lastFailure: 'host execution is closed', attempts: 0 });
    }
    if (this.tasks.has(task.subagentId)) throw new Error(`hosted automaton ${task.subagentId} is already executing`);
    return new Promise<HostedAutomatonOutcome>((resolve) => {
      const state: TaskState = { task, attempts: [], waiting: true, cancelReason: null, lastFailure: '', outcome: null, resolve };
      this.tasks.set(task.subagentId, state);
      this.queue.push(task.subagentId);
    });
  }

  cancel(subagentId: string, reason: string): void {
    const state = this.tasks.get(subagentId);
    if (state === undefined || state.outcome !== null) return;
    state.cancelReason = reason;
    // A waiting task has no child to stop; a live attempt learns of the
    // request at its next heartbeat and ends when the host reports or its
    // lease runs out.
    if (state.waiting) this.finish(state, { kind: 'cancelled', reason, attempts: state.attempts.length });
  }

  // -- the ingress side ------------------------------------------------------

  /** Claims up to `limit` waiting tasks for `owner`, each as its next attempt with its own credential. */
  claim(owner: string, input: { readonly maxIterations: number; readonly limit: number }): HostedResult<readonly HostedAttemptClaim[]> {
    this.sweep();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) return refuse('invalid', 'limit must be a positive integer');
    if (!Number.isSafeInteger(input.maxIterations) || input.maxIterations < 1) {
      return refuse('invalid', 'maxIterations must be a positive integer');
    }
    if (input.maxIterations > this.policy.maxIterations) {
      return refuse(
        'budget_exceeds_policy',
        `the host's per-attempt budget (${input.maxIterations} iterations) exceeds the policy's ${this.policy.maxIterations}`,
      );
    }
    const claims: HostedAttemptClaim[] = [];
    while (claims.length < input.limit && this.queue.length > 0) {
      const subagentId = this.queue.shift()!;
      const state = this.tasks.get(subagentId);
      if (state === undefined || state.outcome !== null || !state.waiting) continue;
      const credential = this.mintCredential();
      const attempt: AttemptState = {
        attemptId: `${subagentId}:attempt:${state.attempts.length + 1}`,
        number: state.attempts.length + 1,
        owner,
        digest: digestOf(credential),
        maxIterations: input.maxIterations,
        leaseExpiresAt: this.now() + this.policy.leaseMs,
        ended: null,
        busCalls: 0,
      };
      state.attempts.push(attempt);
      state.waiting = false;
      this.byDigest.set(attempt.digest, { task: state, attempt });
      this.onEvent({ kind: 'attempt_claimed', subagentId, attempt: attempt.number, owner, maxIterations: attempt.maxIterations });
      claims.push({
        attemptId: attempt.attemptId,
        subagentId,
        name: state.task.name,
        attempt: attempt.number,
        maxAttempts: this.policy.maxAttempts,
        goal: state.task.goal,
        context: state.task.context,
        budget: { maxIterations: attempt.maxIterations },
        credential,
        leaseMs: this.policy.leaseMs,
        busAccess: state.task.busTool !== null,
      });
    }
    return { ok: true, value: claims };
  }

  /** Renews the attempt's lease; says whether core asked for the child to stop. */
  heartbeat(owner: string, credential: string): HostedResult<HostedAttemptStatus> {
    const found = this.live(owner, credential);
    if (!found.ok) return found;
    const { task, attempt } = found.value;
    attempt.leaseExpiresAt = this.now() + this.policy.leaseMs;
    return { ok: true, value: { status: task.cancelReason === null ? 'active' : 'cancel_requested', attempt: attempt.number } };
  }

  /** One Bus operation of the attempt's child, run by the governed tool core formed for the run. */
  async callBus(owner: string, credential: string, args: Readonly<Record<string, unknown>>): Promise<HostedResult<{ text: string; isError: boolean }>> {
    const found = this.live(owner, credential);
    if (!found.ok) return found;
    const { task, attempt } = found.value;
    if (task.cancelReason !== null) return refuse('cancel_requested', 'core asked this attempt to stop');
    const tool = task.task.busTool;
    if (tool === null) return refuse('no_bus_access', 'this automaton has no Automata Bus access');
    attempt.leaseExpiresAt = this.now() + this.policy.leaseMs;
    attempt.busCalls += 1;
    const result = await tool.execute(`${attempt.attemptId}:bus:${attempt.busCalls}`, { ...args });
    const details = result.details as { isError?: unknown } | undefined;
    return { ok: true, value: { text: textOf(result.content), isError: details?.isError === true } };
  }

  /** The host's account of how the attempt's child ended. */
  report(owner: string, credential: string, report: HostedAttemptReport): HostedResult<HostedReportAnswer> {
    const found = this.live(owner, credential);
    if (!found.ok) return found;
    const { task, attempt } = found.value;
    if ((report.kind === 'failed' || report.kind === 'lost') && !OUTCOME_CODE.test(report.code)) {
      return refuse('invalid', 'code must be 1-64 characters of [a-z0-9_] starting with a letter');
    }
    if (report.kind === 'succeeded' && (!Number.isSafeInteger(report.apiCalls) || report.apiCalls < 0)) {
      return refuse('invalid', 'apiCalls must be a non-negative integer');
    }
    const end = report.kind === 'succeeded' ? 'succeeded'
      : report.kind === 'cancelled' ? 'cancelled'
        : `${report.kind}:${report.code}`;
    this.endAttempt(task, attempt, end);
    if (report.kind === 'succeeded' && task.cancelReason === null) {
      this.finish(task, {
        kind: 'completed',
        summary: report.summary,
        model: report.model ?? '',
        apiCalls: report.apiCalls,
        attempts: attempt.number,
      });
      return { ok: true, value: { attempt: attempt.number, next: 'completed' } };
    }
    return { ok: true, value: { attempt: attempt.number, next: this.afterFailedAttempt(task, end) } };
  }

  /** Ends every attempt whose lease ran out: its child is lost. */
  sweep(): void {
    const now = this.now();
    for (const { task, attempt } of [...this.byDigest.values()]) {
      if (attempt.leaseExpiresAt <= now) {
        this.endAttempt(task, attempt, 'lost:lease_expired');
        this.afterFailedAttempt(task, 'lost:lease_expired');
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    for (const state of this.tasks.values()) {
      for (const attempt of state.attempts) if (attempt.ended === null) this.endAttempt(state, attempt, 'lost:host_execution_closed');
      if (state.outcome === null) {
        this.finish(state, { kind: 'failed', reason: 'host_execution_closed', lastFailure: 'host execution closed', attempts: state.attempts.length });
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private live(owner: string, credential: string): HostedResult<{ task: TaskState; attempt: AttemptState }> {
    this.sweep();
    if (typeof credential !== 'string' || credential.length === 0) return refuse('unknown_attempt', 'no attempt credential');
    const digest = digestOf(credential);
    const ended = this.endedDigests.get(digest);
    if (ended !== undefined) return refuse('attempt_ended', `the attempt ended (${ended})`);
    const found = this.byDigest.get(digest);
    if (found === undefined) return refuse('unknown_attempt', 'the credential names no attempt');
    if (found.attempt.owner !== owner) return refuse('not_attempt_owner', 'only the host instance that claimed the attempt acts for it');
    return { ok: true, value: found };
  }

  private endAttempt(task: TaskState, attempt: AttemptState, end: string): void {
    if (attempt.ended !== null) return;
    attempt.ended = end;
    // The credential is revoked: it leaves the live index for good.
    this.byDigest.delete(attempt.digest);
    this.endedDigests.set(attempt.digest, end);
    while (this.endedDigests.size > this.rememberedEndedAttempts) {
      const oldest = this.endedDigests.keys().next().value;
      if (oldest === undefined) break;
      this.endedDigests.delete(oldest);
    }
    this.onEvent({ kind: 'attempt_ended', subagentId: task.task.subagentId, attempt: attempt.number, end });
  }

  private afterFailedAttempt(task: TaskState, end: string): HostedReportAnswer['next'] {
    task.lastFailure = end;
    if (task.outcome !== null) return task.outcome.kind === 'completed' ? 'completed' : task.outcome.kind;
    if (task.cancelReason !== null) {
      this.finish(task, { kind: 'cancelled', reason: task.cancelReason, attempts: task.attempts.length });
      return 'cancelled';
    }
    if (task.attempts.length >= this.policy.maxAttempts) {
      this.finish(task, { kind: 'failed', reason: 'attempt_cap_exhausted', lastFailure: end, attempts: task.attempts.length });
      return 'failed';
    }
    task.waiting = true;
    this.queue.push(task.task.subagentId);
    return 'retry';
  }

  private finish(task: TaskState, outcome: HostedAutomatonOutcome): void {
    if (task.outcome !== null) return;
    task.outcome = outcome;
    task.waiting = false;
    const index = this.queue.indexOf(task.task.subagentId);
    if (index !== -1) this.queue.splice(index, 1);
    // Every credential of the task is refused from now on.
    for (const attempt of task.attempts) this.endAttempt(task, attempt, `task_${outcome.kind}`);
    this.tasks.delete(task.task.subagentId);
    this.onEvent({ kind: 'task_ended', subagentId: task.task.subagentId, outcome: outcome.kind, attempts: outcome.attempts });
    task.resolve(outcome);
  }
}
