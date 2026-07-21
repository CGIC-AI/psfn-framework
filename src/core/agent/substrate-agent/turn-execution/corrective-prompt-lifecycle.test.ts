import { describe, expect, it, vi } from 'vitest';
import { runCorrectivePromptLifecycle } from './corrective-prompt-lifecycle.js';
import type {
  CorrectivePromptLifecycleParams,
  VisionTurnTimeoutRunner,
} from './corrective-prompt-lifecycle.js';
import { getVisionToolRequestContext } from '../../../../primitives/images/request-context.js';
import { getRequestContext } from '../../../../primitives/llm/request-context.js';
import type { VisionToolRequestContext } from '../../../../primitives/images/request-context.js';
import type { ObservabilityCallType, TurnID } from '../../../../shared/contracts/runtime.js';

const BRIDGE_TOKEN = 7;
const VISION_CONTEXT: VisionToolRequestContext = {
  userMessageText: 'hi',
  imageAttachmentUrls: ['u1'],
};

function makeHarness(overrides: Partial<CorrectivePromptLifecycleParams> = {}): {
  params: CorrectivePromptLifecycleParams;
  setChannel: ReturnType<typeof vi.fn>;
  clearChannel: ReturnType<typeof vi.fn>;
  enterActiveTurn: ReturnType<typeof vi.fn>;
  exitActiveTurn: ReturnType<typeof vi.fn>;
} {
  const setChannel = vi.fn(() => BRIDGE_TOKEN);
  const clearChannel = vi.fn();
  const enterActiveTurn = vi.fn();
  const exitActiveTurn = vi.fn();
  const passthroughTimeout: VisionTurnTimeoutRunner = (options) => options.run();
  const params: CorrectivePromptLifecycleParams = {
    bridge: { setChannel, clearChannel },
    channelId: 'c1',
    turnId: 'turn-1' as TurnID,
    requestId: 'req-1:corrective',
    callType: 'chat' as ObservabilityCallType,
    originStage: 'agent.turn.vision_recovery',
    timeoutStage: 'agent.turn.vision_recovery',
    deadlineAt: null,
    onTimeout: vi.fn(),
    requestContext: { requestId: 'req-1:corrective', purpose: 'agent.turn.vision_recovery' },
    visionToolRequestContext: VISION_CONTEXT,
    enterActiveTurn,
    exitActiveTurn,
    invokePrompt: vi.fn(async () => undefined),
    runWithVisionTurnTimeout: passthroughTimeout,
    ...overrides,
  };
  return { params, setChannel, clearChannel, enterActiveTurn, exitActiveTurn };
}

describe('runCorrectivePromptLifecycle (fvl9)', () => {
  it('registers the bridge + active-turn context, threads request/vision contexts, and clears on success', async () => {
    let seenVision: VisionToolRequestContext | undefined;
    let seenRequestPurpose: string | undefined;
    const invokePrompt = vi.fn(async () => {
      seenVision = getVisionToolRequestContext();
      seenRequestPurpose = getRequestContext()?.purpose;
    });
    const { params, setChannel, clearChannel, enterActiveTurn, exitActiveTurn } = makeHarness({ invokePrompt });

    await runCorrectivePromptLifecycle(params);

    expect(setChannel).toHaveBeenCalledWith('c1', {
      turnId: 'turn-1',
      requestId: 'req-1:corrective',
      callType: 'chat',
      originType: 'chat',
      originStage: 'agent.turn.vision_recovery',
      purpose: 'agent.turn.vision_recovery',
    });
    expect(enterActiveTurn).toHaveBeenCalledTimes(1);
    expect(invokePrompt).toHaveBeenCalledTimes(1);
    expect(seenVision).toEqual(VISION_CONTEXT);
    expect(seenRequestPurpose).toBe('agent.turn.vision_recovery');
    // Cleanup happens exactly once with the returned token.
    expect(clearChannel).toHaveBeenCalledWith(BRIDGE_TOKEN);
    expect(exitActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('clears the bridge token and active-turn context when the prompt throws', async () => {
    const failure = new Error('prompt failed');
    const { params, clearChannel, exitActiveTurn } = makeHarness({
      invokePrompt: vi.fn(async () => { throw failure; }),
    });

    await expect(runCorrectivePromptLifecycle(params)).rejects.toThrow('prompt failed');
    expect(clearChannel).toHaveBeenCalledWith(BRIDGE_TOKEN);
    expect(exitActiveTurn).toHaveBeenCalledTimes(1);
  });

  it('clears the bridge token and active-turn context on timeout/abort', async () => {
    const onTimeout = vi.fn();
    const timeoutError = new Error('Vision turn timed out');
    const timeoutRunner: VisionTurnTimeoutRunner = (options) => {
      options.onTimeout?.();
      return Promise.reject(timeoutError);
    };
    const invokePrompt = vi.fn(async () => undefined);
    const { params, clearChannel, exitActiveTurn } = makeHarness({
      onTimeout,
      runWithVisionTurnTimeout: timeoutRunner,
      invokePrompt,
    });

    await expect(runCorrectivePromptLifecycle(params)).rejects.toThrow('Vision turn timed out');
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(clearChannel).toHaveBeenCalledWith(BRIDGE_TOKEN);
    expect(exitActiveTurn).toHaveBeenCalledTimes(1);
  });
});
