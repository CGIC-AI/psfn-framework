import type { CorrelationMetadata, SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';
import { sanitizeDiagnosticText } from '../../../../shared/diagnostics/redaction.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import { isIntakeEnforcingMode } from '../../../../system/config/intake-policy-config.js';
import {
  buildTurnUserContent,
  countVisionTurnImageInputs,
  hasVisionTurnInputs,
  type TurnUserContentBuildResult,
} from '../vision-attachments.js';
import {
  buildTurnPerceptionCue,
  type TurnPerceptionCue,
  type TurnPerceptionStatus,
} from '../perception-cue.js';
import {
  runWithVisionTurnTimeout,
  VisionTurnTimeoutError,
} from './vision-turn-deadline.js';
import type { TurnExecutionRuntime } from './contracts.js';

const log = createComponentLogger('SubstrateAgent');

/**
 * psfn-framework-lpxg3.1 — stage the turn's perception BEFORE retrieval.
 *
 * `buildTurnUserContent` used to run inside `invokeAgentForTurn`, i.e. after
 * `computePreTurnState` had already decided what to remember. That ordering is
 * why an image turn had to suppress memory outright: nothing knew yet what the
 * image was. Staging it here produces the same build result — it is handed
 * straight to `invokeAgentForTurn`, the vision model is NOT called twice — plus
 * a bounded cue the retrieval lanes can read.
 *
 * Staged only for turns that actually carry image inputs. A text turn never
 * enters this path and keeps calling `buildTurnUserContent` from
 * `invokeAgentForTurn` exactly as before.
 */
export interface StagedTurnPerception {
  cue: TurnPerceptionCue;
  /**
   * The built turn user content, or the failure to hand back to
   * `invokeAgentForTurn` so its existing `vision_content_unavailable` fallback
   * runs unchanged. The fallback is deliberately NOT duplicated here.
   */
  outcome:
    | { ok: true; build: TurnUserContentBuildResult }
    | { ok: false; error: unknown; timedOut: boolean };
}

export async function stageCurrentTurnPerception(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  turnId: string;
  visionTurnDeadlineAt: number | null;
  turnCorrelationBase: CorrelationMetadata;
}): Promise<StagedTurnPerception> {
  const { runtime, message } = input;
  // The reviewer derives its correlation from the ambient request context. The
  // build used to run inside the turn's prompt bridge; staging it earlier would
  // otherwise drop the reviewer to a synthetic `vision-review-<now>` requestId.
  const perceptionCorrelation: CorrelationMetadata = {
    ...input.turnCorrelationBase,
    channelId: message.channelId,
    callType: 'tool',
    originType: 'tool',
    originStage: 'agent.turn.perception_staging',
    purpose: 'images.vision_review',
  };

  try {
    const build = await runWithVisionTurnTimeout({
      channelId: message.channelId,
      deadlineAt: input.visionTurnDeadlineAt,
      stage: 'stage_turn_perception',
      run: () => runWithRequestContext(perceptionCorrelation, () => buildTurnUserContent({
        message,
        llmClient: runtime.llmClient,
        runtimeMode: runtime.runtimeMode,
        logger: log,
        visionReviewer: runtime.imageVisionReviewer,
        visionIntakeScreener: runtime.visionIntakeScreener,
        visionIntakeEnforcing: isIntakeEnforcingMode(runtime.cogSecMode),
        imageRetentionScope: input.turnId,
      })),
    });
    return { cue: buildTurnPerceptionCue(build.perception), outcome: { ok: true, build } };
  } catch (error) {
    const timedOut = error instanceof VisionTurnTimeoutError;
    // AC5: a cold, failed, withheld or timed-out perception path still produces
    // a cue — an honest one that says nothing was seen. It never carries a
    // fabricated description, and the status is what the retrieval lanes and
    // telemetry read.
    const status: TurnPerceptionStatus = timedOut ? 'timed_out' : 'failed';
    log.warn('Current-turn perception staging failed; continuing with an empty perception cue', {
      channelId: message.channelId,
      channelType: message.channelType,
      timedOut,
      error: sanitizeDiagnosticText(toErrorMessage(error)),
    });
    return {
      cue: buildTurnPerceptionCue({
        imageCount: countVisionTurnImageInputs(message),
        withheldCount: 0,
        reviewedImageCount: 0,
        semanticText: '',
        visionSummary: null,
        status,
        embodiment: null,
        // Nothing was delivered, so the firewall interposed on nothing.
        enforcing: false,
      }),
      outcome: { ok: false, error, timedOut },
    };
  }
}

/** Whether this turn is eligible for perception staging at all. */
export function turnRequiresPerceptionStaging(message: SubstrateMessage): boolean {
  return hasVisionTurnInputs(message);
}
