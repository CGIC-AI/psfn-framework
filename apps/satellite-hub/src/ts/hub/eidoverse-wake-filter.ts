export type EidoversePingKind =
  | "mention"
  | "whisper"
  | "approach"
  | "reach"
  | "touch"
  | "depart"
  | "presence"
  | "catchup"
  | "digest"
  | "say";

export type EidoverseWakeTreatment = "wake" | "suppress" | "debounce";

export interface EidoversePingInput {
  kind: EidoversePingKind;
  pingLine: string;
  /** Producer advice is retained as evidence only; the Hub table remains authoritative. */
  producerSuggestedTreatment?: unknown;
}

export interface EidoverseWakeEvent {
  kind: EidoversePingKind;
  pingLine: string;
}

export interface EidoverseWakeFilterConfig {
  ambientSayDebounceMs: number;
}

export interface EidoverseWakeFilterCallbacks {
  onWake?(event: EidoverseWakeEvent): void | Promise<void>;
  onAmbient?(event: EidoverseWakeEvent): void | Promise<void>;
  onError?(operation: "ambient_delivery"): void;
}

export interface EidoversePendingPingsSource {
  pendingPings(): Promise<readonly string[]>;
}

export interface EidoversePendingPingsPollConfig {
  pendingPingsPollIntervalMs: number;
}

export type EidoversePollDelay = (delayMs: number, signal: AbortSignal) => Promise<void>;

interface EidoversePendingPingsPollerOptions {
  delay?: EidoversePollDelay;
  onError?: (operation: "pending_pings") => void;
}

const WAKE_TREATMENTS: Readonly<Record<EidoversePingKind, EidoverseWakeTreatment>> = {
  mention: "wake",
  whisper: "wake",
  approach: "wake",
  reach: "wake",
  touch: "wake",
  depart: "suppress",
  presence: "suppress",
  catchup: "suppress",
  digest: "suppress",
  say: "debounce",
};

/**
 * Applies Hub-owned wake policy. Producer treatment suggestions are accepted as
 * input for protocol parity but never override this table.
 */
export class EidoverseWakeFilter {
  private ambientTimer: NodeJS.Timeout | null = null;
  private pendingAmbient: EidoverseWakeEvent | null = null;

  constructor(
    private readonly config: EidoverseWakeFilterConfig,
    private readonly callbacks: EidoverseWakeFilterCallbacks,
  ) {}

  treatmentFor(kind: EidoversePingKind): EidoverseWakeTreatment {
    return WAKE_TREATMENTS[kind];
  }

  async accept(input: EidoversePingInput): Promise<void> {
    const event: EidoverseWakeEvent = {
      kind: input.kind,
      pingLine: input.pingLine,
    };
    switch (this.treatmentFor(input.kind)) {
      case "wake":
        await this.callbacks.onWake?.(event);
        return;
      case "suppress":
        return;
      case "debounce":
        this.debounceAmbient(event);
    }
  }

  close(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = null;
    this.pendingAmbient = null;
  }

  private debounceAmbient(event: EidoverseWakeEvent): void {
    this.pendingAmbient = event;
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = null;
      const pending = this.pendingAmbient;
      this.pendingAmbient = null;
      if (!pending || !this.callbacks.onAmbient) return;
      void Promise.resolve(this.callbacks.onAmbient(pending)).catch(() => {
        if (this.callbacks.onError) {
          this.callbacks.onError("ambient_delivery");
        } else {
          console.warn("Eidoverse ambient delivery failed");
        }
      });
    }, this.config.ambientSayDebounceMs);
  }
}

/**
 * Strictly recognizes the executable `pingLine` renderings exposed by the
 * plain-MCP pending_pings tool. Unknown text is not promoted into a wake.
 */
export function classifyPendingPingLine(pingLine: string): EidoversePingKind | null {
  if (/^@ [^:\n]+ whispers: /.test(pingLine)) return "whisper";
  if (/^@ [^:\n]+: /.test(pingLine)) return "mention";
  if (/^≈ .+ walked up to you$/.test(pingLine)) return "approach";
  if (/^≈ .+ reaches toward .+$/.test(pingLine)) return "reach";
  if (/^≈ .+ touches .+$/.test(pingLine)) return "touch";
  if (/^≈ .+ (?:walked away|is no longer nearby)$/.test(pingLine)) return "depart";
  return null;
}

/** Sequential polling prevents a slow pending_pings request from overlapping itself. */
export class EidoversePendingPingsPoller {
  private controller: AbortController | null = null;
  private runTask: Promise<void> | null = null;
  private readonly delay: EidoversePollDelay;

  constructor(
    private readonly source: EidoversePendingPingsSource,
    private readonly filter: EidoverseWakeFilter,
    private readonly config: EidoversePendingPingsPollConfig,
    private readonly options: EidoversePendingPingsPollerOptions = {},
  ) {
    this.delay = options.delay ?? abortableDelay;
  }

  start(): void {
    if (this.runTask) throw new Error("Eidoverse pending_pings poller is already started");
    this.controller = new AbortController();
    this.runTask = this.run(this.controller.signal);
  }

  async close(): Promise<void> {
    this.controller?.abort();
    await this.runTask;
    this.runTask = null;
    this.controller = null;
    this.filter.close();
  }

  async pollOnce(): Promise<void> {
    const lines = await this.source.pendingPings();
    for (const pingLine of lines) {
      const kind = classifyPendingPingLine(pingLine);
      if (!kind) continue;
      await this.filter.accept({ kind, pingLine });
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.pollOnce();
      } catch {
        if (this.options.onError) {
          this.options.onError("pending_pings");
        } else {
          console.warn("Eidoverse pending_pings poll failed");
        }
      }
      if (signal.aborted) return;
      await this.delay(this.config.pendingPingsPollIntervalMs, signal);
    }
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
