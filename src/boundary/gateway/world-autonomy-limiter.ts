const AUTONOMY_COOLDOWN_MS = 10_000;
const AUTONOMY_HOURLY_LIMIT = 20;
const ONE_HOUR_MS = 60 * 60 * 1_000;

interface AutonomyWindow {
  lastActionAt: number;
  attempts: number[];
}

export class WorldAutonomyLimitError extends Error {}

/** Process-local backstop; Home Assistant idempotency remains Hub-owned. */
export class WorldAutonomyLimiter {
  private readonly windows = new Map<string, AutonomyWindow>();

  authorize(key: string, now = Date.now()): void {
    const current = this.windows.get(key) ?? { lastActionAt: 0, attempts: [] };
    const attempts = current.attempts.filter((timestamp) => now - timestamp < ONE_HOUR_MS);
    if (current.lastActionAt > 0 && now - current.lastActionAt < AUTONOMY_COOLDOWN_MS) {
      throw new WorldAutonomyLimitError('autonomous light action is in cooldown');
    }
    if (attempts.length >= AUTONOMY_HOURLY_LIMIT) {
      throw new WorldAutonomyLimitError('autonomous light action hourly limit reached');
    }
    this.windows.set(key, { lastActionAt: now, attempts: [...attempts, now] });
  }
}

export const worldAutonomyLimiter = new WorldAutonomyLimiter();
