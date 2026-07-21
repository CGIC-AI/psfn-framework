/**
 * Lightweight per-phase timing capture for slow integration suites.
 *
 * Heavy Postgres-backed certification/restore suites routinely brush against
 * their timeout margins with zero visibility into where the wall-clock time
 * went. `PhaseTimer` records named spans and prints the collected timings:
 *
 *  - always on failure (so a timeout/assertion failure carries the phase
 *    breakdown that explains it), and
 *  - on success only when `PSFN_TEST_TIMINGS=1` (or the constructor override)
 *    is set, so green CI runs stay quiet.
 *
 * The helper is deliberately generic — it knows nothing about backups or
 * restores — so other suites can adopt it. It never swallows errors: `measure`
 * records the span in a `finally` and re-throws.
 *
 * Known limitation: this is best-effort in-process instrumentation, so a hard
 * worker kill (e.g. a vitest test-timeout that tears down the worker thread
 * before the suite's cleanup path runs) can still produce no output at all.
 */

export interface PhaseTiming {
  readonly name: string;
  readonly durationMs: number;
}

export interface PhaseTimerOptions {
  /**
   * Force timing output regardless of the environment flag. When omitted the
   * timer honours `PSFN_TEST_TIMINGS` from the process environment.
   */
  readonly emitOnSuccess?: boolean;
  /**
   * Sink for the formatted report. Defaults to a direct stdout write, which the
   * vitest reporter surfaces reliably (its console interception can otherwise
   * swallow `console.*` output from worker threads).
   */
  readonly sink?: (line: string) => void;
}

const TIMINGS_ENV_FLAG = 'PSFN_TEST_TIMINGS';

function timingsFlagEnabled(): boolean {
  const raw = process.env[TIMINGS_ENV_FLAG]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

interface OpenSpan {
  readonly name: string;
  readonly startedAt: number;
}

export class PhaseTimer {
  private readonly spans: PhaseTiming[] = [];
  private readonly openSpans = new Set<OpenSpan>();
  private readonly emitOnSuccess: boolean;
  private readonly sink: (line: string) => void;

  constructor(
    private readonly label: string,
    options: PhaseTimerOptions = {},
  ) {
    this.emitOnSuccess = options.emitOnSuccess ?? timingsFlagEnabled();
    this.sink = options.sink ?? ((line: string) => {
      process.stdout.write(`${line}\n`);
    });
  }

  /**
   * Time an async phase, recording its duration even when it throws.
   */
  async measure<T>(name: string, work: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      this.spans.push({ name, durationMs: Math.max(0, performance.now() - startedAt) });
    }
  }

  /**
   * Manually open a span; the returned callback closes it. Useful when the work
   * cannot be wrapped in a single callback. A span that is never closed (because
   * the work threw between `begin` and the close callback) is surfaced by
   * `report` as an explicit in-progress entry rather than being silently lost.
   */
  begin(name: string): () => void {
    const startedAt = performance.now();
    const open: OpenSpan = { name, startedAt };
    this.openSpans.add(open);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.openSpans.delete(open);
      this.spans.push({ name, durationMs: Math.max(0, performance.now() - startedAt) });
    };
  }

  entries(): readonly PhaseTiming[] {
    return this.spans;
  }

  totalMs(): number {
    return this.spans.reduce((sum, span) => sum + span.durationMs, 0);
  }

  format(): string {
    const now = performance.now();
    const rows = [
      ...this.spans.map(span => ({ name: span.name, durationMs: span.durationMs, inProgress: false })),
      ...[...this.openSpans].map(span => ({
        name: span.name,
        durationMs: Math.max(0, now - span.startedAt),
        inProgress: true,
      })),
    ];
    const nameWidth = rows.reduce((width, row) => Math.max(width, row.name.length), 0);
    const lines = rows.map(row => {
      const base = `  ${row.name.padEnd(nameWidth)}  ${row.durationMs.toFixed(1).padStart(9)} ms`;
      return row.inProgress ? `${base}  (in progress at report)` : base;
    });
    const header = `[phase-timings] ${this.label} — total ${this.totalMs().toFixed(1)} ms`;
    return [header, ...lines].join('\n');
  }

  /**
   * Emit the collected timings. Always prints on failure; on success prints only
   * when timing output is enabled. Any span still open at report time (a `begin`
   * whose close callback never ran) is included as an in-progress entry so the
   * phase that threw is not lost. No-op when nothing has been recorded.
   */
  report(outcome: { failed: boolean }): void {
    if (this.spans.length === 0 && this.openSpans.size === 0) return;
    if (!outcome.failed && !this.emitOnSuccess) return;
    this.sink(this.format());
  }
}
