export interface ShutdownLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ShutdownSequenceStep {
  step: string;
  action: () => void | Promise<void>;
  maxAttempts?: number;
  /** Stop the sequence when this step exhausts its bounded attempts. */
  failClosed?: boolean;
}

export async function runShutdownStep(
  step: string,
  action: () => void | Promise<void>,
  logger: ShutdownLogger,
  maxAttempts = 2,
  failClosed = false,
): Promise<void> {
  const attempts = Math.max(1, Math.floor(maxAttempts));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await action();
      if (attempt > 1) {
        logger.info('Shutdown step recovered after retry', {
          step,
          attempt,
          maxAttempts: attempts,
        });
      }
      return;
    } catch (error) {
      if (attempt < attempts) {
        logger.warn('Shutdown step failed; retrying', {
          step,
          attempt,
          maxAttempts: attempts,
          error: String(error),
        });
        continue;
      }
      logger.error(failClosed
        ? 'Shutdown step failed; aborting shutdown'
        : 'Shutdown step failed; continuing shutdown', {
        step,
        attempt,
        maxAttempts: attempts,
        error: String(error),
      });
      if (failClosed) throw error;
    }
  }
}

export async function runShutdownSequence(
  steps: readonly ShutdownSequenceStep[],
  logger: ShutdownLogger,
): Promise<void> {
  for (const shutdownStep of steps) {
    await runShutdownStep(
      shutdownStep.step,
      shutdownStep.action,
      logger,
      shutdownStep.maxAttempts,
      shutdownStep.failClosed,
    );
  }
}

/**
 * Share concurrent shutdown callers, cache a completed shutdown, and allow a
 * later caller to retry after a failed attempt. The operation itself owns its
 * bounded internal retries; this wrapper prevents one rejected promise from
 * poisoning every future production shutdown request.
 */
export function createRetryableShutdown(
  operation: () => Promise<void>,
): () => Promise<void> {
  let current: Promise<void> | null = null;
  let completed = false;
  return async () => {
    if (completed) return;
    const attempt = current ?? operation();
    current = attempt;
    try {
      await attempt;
      completed = true;
    } catch (error) {
      if (current === attempt) current = null;
      throw error;
    }
  };
}
