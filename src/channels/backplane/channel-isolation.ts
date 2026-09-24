// ── Channel surface isolation (bead psfn-framework-6cs5j) ──
//
// Operator rule: no channel may ever take anything else down. Every channel
// surface the gateway owns — built-in adapters and plugin-host instances alike —
// runs its load/init/start/stop through this supervisor, which contains the
// failure to that one surface:
//
//   * the failing surface is marked `degraded` (a retry is scheduled) or
//     `disabled` (it refused to run: a non-retryable error, a spent retry
//     budget, or a load/init/wiring failure);
//   * the failure is logged and handed to the injected reporter, which the
//     gateway projects into the content-free health plane;
//   * no method rejects, so every other surface still starts, runs, and stops.
//
// A channel's own admission stays fail-closed: a misconfigured surface refuses
// to run itself. What changes is the blast radius — it no longer refuses the
// gateway and every sibling channel with it.

import type { CompanionId } from '../../shared/routing/companion-id.js';
import { toError } from '../../shared/utils/errors.js';
import { backoffMs } from '../../shared/utils/timing.js';

type ChannelSurfacePhase = 'load' | 'init' | 'start' | 'stop' | 'runtime';

type ChannelSurfaceState =
  | 'pending'
  | 'running'
  | 'degraded'
  | 'disabled'
  | 'stopped';

export interface ChannelSurfaceIdentity {
  surfaceId: string;
  companionId?: CompanionId;
}

export interface ChannelSurfaceFailure extends ChannelSurfaceIdentity {
  phase: ChannelSurfacePhase;
  error: Error;
  /** Start attempts made so far; zero for failures outside the start path. */
  attempt: number;
  /** True when the surface is now disabled and will not be retried. */
  terminal: boolean;
}

/** Owner-provided retry policy; `maxAttempts` 0 means unbounded attempts. */
export interface ChannelSurfaceRetryPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

interface ChannelSurfaceSupervisorLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

interface ChannelSurfaceSupervisorOptions {
  log: ChannelSurfaceSupervisorLogger;
  retry: ChannelSurfaceRetryPolicy;
  isRetryable: (error: Error) => boolean;
  report: (failure: ChannelSurfaceFailure) => void | Promise<void>;
}

interface ChannelSurfaceStartSpec extends ChannelSurfaceIdentity {
  start: () => Promise<void>;
  /** Releases partial state after a failed attempt, before any retry. */
  cleanup?: () => Promise<void>;
  onStarted?: (attempts: number) => void;
}

interface SurfaceEntry extends ChannelSurfaceIdentity {
  state: ChannelSurfaceState;
  attempts: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
  /** A failed start already ran its cleanup; stop must not repeat it. */
  cleanedUp: boolean;
  stopping: boolean;
}

export class ChannelSurfaceSupervisor {
  readonly #options: ChannelSurfaceSupervisorOptions;
  readonly #entries = new Map<string, SurfaceEntry>();

  constructor(options: ChannelSurfaceSupervisorOptions) {
    this.#options = options;
  }

  stateOf(surfaceId: string): ChannelSurfaceState | undefined {
    return this.#entries.get(surfaceId)?.state;
  }

  /** The surface refused to run (load or wiring failure); it is never started. */
  disable(identity: ChannelSurfaceIdentity, phase: ChannelSurfacePhase, error: unknown): void {
    const entry = this.#entry(identity);
    entry.state = 'disabled';
    // Never initialized or started, so there is nothing for stop to release.
    entry.cleanedUp = true;
    this.#fail(entry, phase, toError(error), true);
  }

  /** Runs a surface's init; a failure disables that surface only. */
  async init(identity: ChannelSurfaceIdentity, init: () => Promise<void>): Promise<void> {
    const entry = this.#entry(identity);
    if (entry.state === 'disabled') return;
    try {
      await init();
    } catch (error) {
      entry.state = 'disabled';
      this.#fail(entry, 'init', toError(error), true);
    }
  }

  /**
   * Awaits the first start attempt; a retryable failure schedules bounded
   * background retries so the caller can move on to the next surface.
   */
  async start(spec: ChannelSurfaceStartSpec): Promise<void> {
    const entry = this.#entry(spec);
    if (entry.state === 'disabled' || entry.state === 'running') return;
    entry.stopping = false;
    await this.#attempt(entry, spec);
  }

  /** A running surface failed outside its lifecycle calls (e.g. a client error). */
  reportRuntimeFailure(identity: ChannelSurfaceIdentity, error: unknown): void {
    const entry = this.#entry(identity);
    this.#fail(entry, 'runtime', toError(error), false);
  }

  /** Stops one surface; a failure is reported and never blocks other surfaces. */
  async stop(identity: ChannelSurfaceIdentity, stop: () => Promise<void>): Promise<void> {
    const entry = this.#entry(identity);
    entry.stopping = true;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = undefined;
    }
    if (entry.inFlight) await entry.inFlight;
    const alreadyReleased = entry.state === 'stopped'
      || ((entry.state === 'degraded' || entry.state === 'disabled') && entry.cleanedUp);
    if (!alreadyReleased) {
      try {
        await stop();
      } catch (error) {
        this.#fail(entry, 'stop', toError(error), false);
      }
    }
    if (entry.state !== 'disabled') entry.state = 'stopped';
  }

  #entry(identity: ChannelSurfaceIdentity): SurfaceEntry {
    const existing = this.#entries.get(identity.surfaceId);
    if (existing) return existing;
    const created: SurfaceEntry = {
      surfaceId: identity.surfaceId,
      ...(identity.companionId ? { companionId: identity.companionId } : {}),
      state: 'pending',
      attempts: 0,
      cleanedUp: false,
      stopping: false,
    };
    this.#entries.set(identity.surfaceId, created);
    return created;
  }

  async #attempt(entry: SurfaceEntry, spec: ChannelSurfaceStartSpec): Promise<void> {
    entry.attempts += 1;
    const run = this.#runAttempt(entry, spec);
    entry.inFlight = run;
    try {
      await run;
    } finally {
      if (entry.inFlight === run) entry.inFlight = undefined;
    }
  }

  async #runAttempt(entry: SurfaceEntry, spec: ChannelSurfaceStartSpec): Promise<void> {
    try {
      await spec.start();
      entry.state = 'running';
      entry.cleanedUp = false;
      if (entry.attempts > 1) {
        this.#options.log.info('Channel surface recovered after retries', {
          surfaceId: entry.surfaceId,
          attempts: entry.attempts,
        });
      }
      spec.onStarted?.(entry.attempts);
      return;
    } catch (error) {
      const failure = toError(error);
      if (spec.cleanup) {
        try {
          await spec.cleanup();
        } catch (cleanupError) {
          this.#options.log.error('Channel surface cleanup after failed start failed', {
            surfaceId: entry.surfaceId,
            error: toError(cleanupError).message,
          });
        }
      }
      entry.cleanedUp = true;
      if (entry.stopping) {
        // Shutdown overtook an in-flight retry: not a new channel fault.
        entry.state = 'stopped';
        this.#options.log.warn('Channel surface start abandoned during shutdown', {
          surfaceId: entry.surfaceId,
          attempt: entry.attempts,
          error: failure.message,
        });
        return;
      }
      const { maxAttempts } = this.#options.retry;
      const budgetLeft = maxAttempts <= 0 || entry.attempts < maxAttempts;
      const terminal = !budgetLeft || !this.#options.isRetryable(failure);
      entry.state = terminal ? 'disabled' : 'degraded';
      this.#fail(entry, 'start', failure, terminal);
      if (!terminal) this.#scheduleRetry(entry, spec);
    }
  }

  #scheduleRetry(entry: SurfaceEntry, spec: ChannelSurfaceStartSpec): void {
    const { baseDelayMs, maxDelayMs, maxAttempts } = this.#options.retry;
    const delayMs = backoffMs(baseDelayMs, entry.attempts - 1, maxDelayMs);
    this.#options.log.warn('Channel surface start failed; retrying in background', {
      surfaceId: entry.surfaceId,
      attempt: entry.attempts,
      maxAttempts: maxAttempts > 0 ? maxAttempts : 'unbounded',
      delayMs,
    });
    const timer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.stopping) return;
      void this.#attempt(entry, spec);
    }, delayMs);
    timer.unref();
    entry.retryTimer = timer;
  }

  #fail(entry: SurfaceEntry, phase: ChannelSurfacePhase, error: Error, terminal: boolean): void {
    this.#options.log.error(
      terminal
        ? 'Channel surface disabled; other channels continue'
        : 'Channel surface failed; other channels continue',
      {
        surfaceId: entry.surfaceId,
        phase,
        attempt: entry.attempts,
        state: entry.state,
        error: error.message,
      },
    );
    const failure: ChannelSurfaceFailure = {
      surfaceId: entry.surfaceId,
      ...(entry.companionId ? { companionId: entry.companionId } : {}),
      phase,
      error,
      attempt: entry.attempts,
      terminal,
    };
    const onReportError = (reportError: unknown): void => {
      this.#options.log.error('Channel surface failure report failed', {
        surfaceId: entry.surfaceId,
        phase,
        error: toError(reportError).message,
      });
    };
    try {
      const reported = this.#options.report(failure);
      if (reported instanceof Promise) reported.catch(onReportError);
    } catch (reportError) {
      onReportError(reportError);
    }
  }
}
