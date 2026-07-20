const INITIAL_DELAY_MS = 12_000;
const POLL_MS = 5_000;
const UPDATE_MIN_INTERVAL_MS = 20_000;

interface LongRunningToolStatusTrackerOptions {
  isProcessing(channelId: string): boolean;
  sendStatus(channelId: string, text: string): Promise<void>;
  clearStatus(channelId: string): Promise<void>;
}

interface LongRunningToolState {
  channelId: string;
  toolName: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  lastStatusAt: number;
  statusSent: boolean;
  inFlight: boolean;
}

export class LongRunningToolStatusTracker {
  private readonly states = new Map<string, LongRunningToolState>();

  constructor(private readonly options: LongRunningToolStatusTrackerOptions) {}

  start(toolCallId: string, channelId: string, toolName: string): void {
    if (!this.options.isProcessing(channelId)) return;
    if (!this.isLongRunningTool(toolName)) return;
    if (this.states.has(toolCallId)) return;

    this.states.set(toolCallId, {
      channelId,
      toolName,
      startedAt: Date.now(),
      timer: setInterval(() => {
        this.tick(toolCallId).catch(() => undefined);
      }, POLL_MS),
      lastStatusAt: 0,
      statusSent: false,
      inFlight: false,
    });
  }

  async stop(toolCallId: string, channelId: string, toolName: string): Promise<void> {
    if (!this.isLongRunningTool(toolName)) return;

    const state = this.states.get(toolCallId);
    if (state) {
      clearInterval(state.timer);
      this.states.delete(toolCallId);
    }
    if (this.hasActiveToolForChannel(channelId)) return;
    await this.options.clearStatus(channelId);
  }

  clearChannel(channelId: string): void {
    for (const [toolCallId, state] of this.states.entries()) {
      if (state.channelId !== channelId) continue;
      clearInterval(state.timer);
      this.states.delete(toolCallId);
    }
  }

  dispose(): void {
    for (const state of this.states.values()) {
      clearInterval(state.timer);
    }
    this.states.clear();
  }

  private isLongRunningTool(toolName: string): boolean {
    return toolName === 'analysis_workbench';
  }

  private hasActiveToolForChannel(channelId: string): boolean {
    for (const state of this.states.values()) {
      if (state.channelId === channelId) return true;
    }
    return false;
  }

  private buildStatusText(toolName: string, elapsedMs: number): string {
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
    if (toolName === 'analysis_workbench') {
      return `Still analyzing large-context material (${elapsedSeconds}s elapsed)...`;
    }
    return `Still running ${toolName} (${elapsedSeconds}s elapsed)...`;
  }

  private async tick(toolCallId: string): Promise<void> {
    const state = this.states.get(toolCallId);
    if (!state) return;
    if (state.inFlight) return;
    if (!this.options.isProcessing(state.channelId)) return;

    const now = Date.now();
    const elapsedMs = now - state.startedAt;
    if (!state.statusSent && elapsedMs < INITIAL_DELAY_MS) return;
    if (state.statusSent && now - state.lastStatusAt < UPDATE_MIN_INTERVAL_MS) return;

    state.inFlight = true;
    try {
      await this.options.sendStatus(
        state.channelId,
        this.buildStatusText(state.toolName, elapsedMs),
      );
      state.statusSent = true;
      state.lastStatusAt = now;
    } finally {
      state.inFlight = false;
    }
  }
}
