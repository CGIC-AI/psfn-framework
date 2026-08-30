export type TouchStimulusKind = 'headpat' | 'petting' | 'hug' | 'kiss';
export type TouchRegion = 'head' | 'cheek' | 'body';

export interface TouchInteraction {
  kind: TouchStimulusKind;
  region: TouchRegion;
  count: number;
  durationMs: number;
}

export type TouchInteractionInput = Omit<TouchInteraction, 'count'>;

export interface TouchInteractionCoalescerOptions {
  emit: (interaction: TouchInteraction) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  quietMs?: number;
}

export type HeadpatCoalescerOptions = TouchInteractionCoalescerOptions;

const DEFAULT_QUIET_MS = 3_000;
const MAX_COUNT = 20;
const MAX_DURATION_MS = 60_000;

/**
 * Coalesces repeated instances of one typed affection gesture. A different
 * kind or region flushes the current group first so upstream never receives
 * an ambiguous mixed interaction.
 */
export class TouchInteractionCoalescer {
  private readonly emit: (interaction: TouchInteraction) => void;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly quietMs: number;
  private timer: unknown;
  private count = 0;
  private startedAt = 0;
  private lastInteractionAt = 0;
  private longestGestureMs = 0;
  private active: Pick<TouchInteraction, 'kind' | 'region'> | null = null;

  constructor(options: TouchInteractionCoalescerOptions) {
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  }

  record(interaction: TouchInteractionInput): void {
    if (this.active
      && (this.active.kind !== interaction.kind || this.active.region !== interaction.region)) {
      this.flush();
    }

    const interactionAt = this.now();
    if (this.count === 0) {
      this.startedAt = interactionAt;
      this.active = { kind: interaction.kind, region: interaction.region };
    }
    this.lastInteractionAt = interactionAt;
    this.longestGestureMs = Math.max(this.longestGestureMs, interaction.durationMs);
    this.count = Math.min(this.count + 1, MAX_COUNT);
    this.clearTimer();
    this.timer = this.schedule(() => this.flush(), this.quietMs);
  }

  destroy(): void {
    this.clearTimer();
    this.reset();
  }

  private flush(): void {
    this.clearTimer();
    if (this.count === 0 || !this.active) return;
    this.emit({
      ...this.active,
      count: this.count,
      durationMs: Math.min(
        Math.max(this.lastInteractionAt - this.startedAt, this.longestGestureMs, 0),
        MAX_DURATION_MS,
      ),
    });
    this.reset();
  }

  private reset(): void {
    this.count = 0;
    this.longestGestureMs = 0;
    this.active = null;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}

/** Retained mini-sprite adapter for the original headpat-only button. */
export class HeadpatCoalescer extends TouchInteractionCoalescer {
  tap(): void {
    this.record({ kind: 'headpat', region: 'head', durationMs: 0 });
  }
}
