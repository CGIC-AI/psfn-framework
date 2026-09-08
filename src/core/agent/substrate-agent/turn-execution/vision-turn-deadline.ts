import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';

const log = createComponentLogger('SubstrateAgent');

/**
 * The single vision budget for one turn. Covers attachment fetch (with gateway
 * DNS retries) plus the vision model call; 30s proved too tight on slow
 * deployments where the model finished at ~70s.
 *
 * One budget, one PHASE. Perception staging (which runs before retrieval since
 * lpxg3.1) anchors it at the vision review; `invokeAgentForTurn` anchors a
 * fresh one at prompt-stage start for the answer call, and vision recovery
 * anchors its own again. Stretching a single anchored deadline across all of
 * them would let retrieval and prompt assembly starve the answer call and then
 * report the turn as vision-unavailable, which is not what happened.
 */
export const VISION_TURN_TIMEOUT_MS = 120_000;

/**
 * Typed vision-deadline expiry. Callers that must distinguish "the budget ran
 * out" from "the vision path failed" (perception staging, AC5's honest
 * uncertainty) check this instead of matching on message text.
 */
export class VisionTurnTimeoutError extends Error {
  readonly stage: string;

  constructor(stage: string) {
    super(`Vision turn timed out after ${String(VISION_TURN_TIMEOUT_MS)}ms`);
    this.name = 'VisionTurnTimeoutError';
    this.stage = stage;
  }
}

/** One turn's vision deadline, or `null` on a turn with no image inputs. */
export function resolveVisionTurnDeadlineAt(input: {
  hasVisionInputs: boolean;
  anchorMs: number;
}): number | null {
  return input.hasVisionInputs ? input.anchorMs + VISION_TURN_TIMEOUT_MS : null;
}

export async function runWithVisionTurnTimeout<T>({
  channelId,
  deadlineAt,
  stage,
  onTimeout,
  run,
}: {
  channelId: string;
  deadlineAt: number | null;
  stage: string;
  onTimeout?: (() => void) | undefined;
  run: () => Promise<T>;
}): Promise<T> {
  if (deadlineAt == null) {
    return run();
  }

  const remainingMs = deadlineAt - Date.now();
  const timeoutError = new VisionTurnTimeoutError(stage);
  if (remainingMs <= 0) {
    log.warn('Vision turn exceeded its deadline before stage start', {
      channelId,
      stage,
      timeoutMs: VISION_TURN_TIMEOUT_MS,
    });
    if (onTimeout) {
      try {
        onTimeout();
      } catch (error) {
        log.warn('Vision turn timeout cleanup failed', {
          channelId,
          stage,
          error: toErrorMessage(error),
        });
      }
    }
    throw timeoutError;
  }

  let timeoutHandle!: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      log.warn('Vision turn timed out; aborting stage', {
        channelId,
        stage,
        timeoutMs: VISION_TURN_TIMEOUT_MS,
      });
      if (onTimeout) {
        try {
          onTimeout();
        } catch (error) {
          log.warn('Vision turn timeout cleanup failed', {
            channelId,
            stage,
            error: toErrorMessage(error),
          });
        }
      }
      reject(timeoutError);
    }, remainingMs);
  });
  try {
    return await Promise.race([run(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
