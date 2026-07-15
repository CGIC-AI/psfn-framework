export interface TouchInteraction {
  kind: 'headpat';
  region: 'head';
  count: number;
  durationMs: number;
}

export interface HeadpatCoalescerOptions {
  emit: (interaction: TouchInteraction) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  quietMs?: number;
}

const DEFAULT_QUIET_MS = 3_000;
const MAX_COUNT = 20;
const MAX_DURATION_MS = 60_000;

export class HeadpatCoalescer {
  private readonly emit: (interaction: TouchInteraction) => void;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly quietMs: number;
  private timer: unknown;
  private count = 0;
  private startedAt = 0;
  private lastTapAt = 0;

  constructor(options: HeadpatCoalescerOptions) {
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  }

  tap(): void {
    const tappedAt = this.now();
    if (this.count === 0) {
      this.startedAt = tappedAt;
    }
    this.lastTapAt = tappedAt;
    this.count = Math.min(this.count + 1, MAX_COUNT);
    this.clearTimer();
    this.timer = this.schedule(() => this.flush(), this.quietMs);
  }

  destroy(): void {
    this.clearTimer();
    this.count = 0;
  }

  private flush(): void {
    this.timer = undefined;
    if (this.count === 0) return;
    const interaction: TouchInteraction = {
      kind: 'headpat',
      region: 'head',
      count: this.count,
      durationMs: Math.min(Math.max(this.lastTapAt - this.startedAt, 0), MAX_DURATION_MS),
    };
    this.count = 0;
    this.emit(interaction);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.cancel(this.timer);
    this.timer = undefined;
  }
}
