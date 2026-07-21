import { runWithVisionToolRequestContext } from '../../../../primitives/images/request-context.js';
import type { VisionToolRequestContext } from '../../../../primitives/images/request-context.js';
import { runWithRequestContext } from '../../../../primitives/llm/request-context.js';
import type {
  CorrelationMetadata,
  ObservabilityCallType,
  TurnID,
} from '../../../../shared/contracts/runtime.js';

/**
 * Shared corrective-prompt lifecycle (bead fvl9).
 *
 * The runtime-datetime contradiction retry and the vision empty-response
 * recovery replay independently registered an event-bridge channel, entered
 * active-turn context, wrapped the prompt in the vision timeout / request /
 * vision-tool contexts, invoked the current prompt, and cleared the bridge and
 * context state in a `finally`. That duplication meant cleanup and correlation
 * behavior could drift between the two paths. This helper owns that one
 * lifecycle so both corrective prompts share identical setup and teardown.
 *
 * Only lifecycle orchestration is centralized here: retry counts, model
 * selection, attachment policy, prompt contents, deadlines, and the active-turn
 * strategy stay owned by each caller and are passed in.
 */

/** Minimal event-bridge surface the lifecycle needs (satisfied by EventBridge). */
export interface CorrectivePromptBridge {
  setChannel(
    channelId: string,
    correlation: {
      turnId: TurnID;
      requestId: string;
      callType: ObservabilityCallType;
      originType: ObservabilityCallType;
      originStage: string;
      purpose: string;
    },
  ): number;
  clearChannel(token?: number): void;
}

/** The vision turn-timeout wrapper, injected so callers keep ownership of it. */
export type VisionTurnTimeoutRunner = <T>(options: {
  channelId: string;
  deadlineAt: number | null;
  stage: string;
  onTimeout?: (() => void) | undefined;
  run: () => Promise<T>;
}) => Promise<T>;

export interface CorrectivePromptLifecycleParams {
  bridge: CorrectivePromptBridge;
  channelId: string;
  turnId: TurnID;
  requestId: string;
  callType: ObservabilityCallType;
  /** Bridge origin stage / purpose and request-context purpose for this prompt. */
  originStage: string;
  /** Timeout stage label (may differ from originStage, e.g. underscore variant). */
  timeoutStage: string;
  deadlineAt: number | null;
  onTimeout?: (() => void) | undefined;
  /** Already-merged correlation + viewer request context for this prompt. */
  requestContext: Partial<CorrelationMetadata>;
  visionToolRequestContext: VisionToolRequestContext;
  /** Enter this path's active-turn context (strategy differs per caller). */
  enterActiveTurn: () => void;
  /** Clear this path's active-turn context; runs in `finally`. */
  exitActiveTurn: () => void;
  /** Invoke the corrective prompt (each caller supplies its own message). */
  invokePrompt: () => Promise<unknown>;
  runWithVisionTurnTimeout: VisionTurnTimeoutRunner;
}

/**
 * Register the bridge channel and active-turn context, run the prompt inside
 * the vision timeout / request / vision-tool context stack, and always clear
 * the bridge token and active-turn context afterward — including on prompt
 * failure and on timeout/abort.
 */
export async function runCorrectivePromptLifecycle(
  params: CorrectivePromptLifecycleParams,
): Promise<void> {
  const bridgeToken = params.bridge.setChannel(params.channelId, {
    turnId: params.turnId,
    requestId: params.requestId,
    callType: params.callType,
    originType: params.callType,
    originStage: params.originStage,
    purpose: params.originStage,
  });
  params.enterActiveTurn();
  try {
    await params.runWithVisionTurnTimeout({
      channelId: params.channelId,
      deadlineAt: params.deadlineAt,
      stage: params.timeoutStage,
      onTimeout: params.onTimeout,
      run: () => runWithRequestContext(
        params.requestContext,
        async () => runWithVisionToolRequestContext(
          params.visionToolRequestContext,
          async () => {
            await params.invokePrompt();
          },
        ),
      ),
    });
  } finally {
    params.bridge.clearChannel(bridgeToken);
    params.exitActiveTurn();
  }
}
