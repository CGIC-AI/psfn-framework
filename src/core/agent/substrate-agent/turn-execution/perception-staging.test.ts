import { describe, expect, it, vi } from 'vitest';
import type { CorrelationMetadata, SubstrateMessage } from '../../../../shared/contracts/runtime.js';
import { getRequestContext } from '../../../../primitives/llm/request-context.js';
import { stageCurrentTurnPerception, turnRequiresPerceptionStaging } from './perception-staging.js';
import { VISION_TURN_TIMEOUT_MS } from './vision-turn-deadline.js';
import type { TurnExecutionRuntime } from './contracts.js';

const IMAGE_URL = 'https://cdn.example.test/attachments/1/2/current-image.png';

function makeMessage(overrides: Partial<SubstrateMessage> = {}): SubstrateMessage {
  return {
    id: 'msg-1',
    channelId: 'ch1',
    channelType: 'discord',
    authorId: 'contact:morgan',
    authorName: 'Morgan',
    content: 'is this the same pier we walked on?',
    timestamp: new Date(),
    attachments: [{ url: IMAGE_URL, contentType: 'image/png', name: 'current-image.png' }],
    ...overrides,
  } as SubstrateMessage;
}

function makeRuntime(overrides: {
  analyze?: ReturnType<typeof vi.fn>;
  cogSecMode?: TurnExecutionRuntime['cogSecMode'];
  visionIntakeScreener?: TurnExecutionRuntime['visionIntakeScreener'];
} = {}): TurnExecutionRuntime {
  return {
    llmClient: { stream: vi.fn(), complete: vi.fn() },
    runtimeMode: 'enforce',
    imageVisionReviewer: overrides.analyze ? { analyze: overrides.analyze } : null,
    visionIntakeScreener: overrides.visionIntakeScreener ?? null,
    cogSecMode: overrides.cogSecMode ?? 'shadow',
  } as unknown as TurnExecutionRuntime;
}

/** A wired intake screener that admits the image under the given mode. */
function admittingScreener(mode: 'shadow' | 'enforce'): TurnExecutionRuntime['visionIntakeScreener'] {
  return {
    screenImageIntake: vi.fn(async () => ({
      kind: 'screened' as const,
      mode,
      flagged: false,
      withheld: false,
      ...(mode === 'enforce'
        ? { promptBlock: '<untrusted_image_screening>benign</untrusted_image_screening>' }
        : {}),
    })),
  };
}

const CORRELATION: CorrelationMetadata = {
  requestId: 'req-1',
  turnId: 'turn-1',
  channelId: 'ch1',
  callType: 'chat',
  purpose: 'agent.turn.prompt',
};

function stage(input: {
  runtime: TurnExecutionRuntime;
  message?: SubstrateMessage;
  visionTurnDeadlineAt?: number | null;
}) {
  return stageCurrentTurnPerception({
    runtime: input.runtime,
    message: input.message ?? makeMessage(),
    turnId: 'turn-1',
    visionTurnDeadlineAt: input.visionTurnDeadlineAt ?? Date.now() + VISION_TURN_TIMEOUT_MS,
    turnCorrelationBase: CORRELATION,
  });
}

describe('stageCurrentTurnPerception (lpxg3.1)', () => {
  it('stages only turns that actually carry image inputs', () => {
    expect(turnRequiresPerceptionStaging(makeMessage())).toBe(true);
    expect(turnRequiresPerceptionStaging(makeMessage({ attachments: [] }))).toBe(false);
    expect(turnRequiresPerceptionStaging(makeMessage({
      attachments: [{ url: 'https://example.test/notes.pdf', contentType: 'application/pdf', name: 'notes.pdf' }],
    }))).toBe(false);
  });

  it('produces a reviewed cue and the build result the invocation reuses', async () => {
    const analyze = vi.fn(async () => ({
      question: 'q',
      summary: 'A wooden pier at sunset with two people at the far end.',
      model: 'vision-model',
      imageCount: 1,
    }));
    const staged = await stage({ runtime: makeRuntime({ analyze }) });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(staged.outcome.ok).toBe(true);
    expect(staged.cue).toMatchObject({
      imageCount: 1,
      reviewedImageCount: 1,
      status: 'reviewed',
      visionSummary: 'A wooden pier at sunset with two people at the far end.',
      participantText: 'is this the same pier we walked on?',
      trustLabel: 'untrusted_image_derived',
    });
    // AC4: an inbound Participant image is never compared to her identity
    // reference — no forced self-recognition, and the reason says so.
    expect(analyze.mock.calls[0]?.[0]).not.toHaveProperty('compareToReference');
    expect(staged.cue.embodiment).toEqual({
      verdict: 'unknown',
      reason: 'reference_comparison_not_requested',
    });
  });

  it('resolves the reviewer correlation from the turn instead of a synthetic request id', async () => {
    let observedPurpose: string | undefined;
    let observedRequestId: string | undefined;
    const analyze = vi.fn(async () => {
      const context = getRequestContext();
      observedPurpose = context?.purpose;
      observedRequestId = context?.requestId;
      return { question: 'q', summary: 'a pier', model: 'vision-model', imageCount: 1 };
    });

    await stage({ runtime: makeRuntime({ analyze }) });

    expect(observedRequestId).toBe('req-1');
    expect(observedPurpose).toBe('images.vision_review');
  });

  it('merges a multi-image review into one cue', async () => {
    const analyze = vi.fn(async () => ({
      question: 'q',
      summary: 'Two shots of the same pier, taken minutes apart.',
      model: 'vision-model',
      imageCount: 2,
    }));
    const staged = await stage({
      runtime: makeRuntime({ analyze }),
      message: makeMessage({
        attachments: [
          { url: `${IMAGE_URL}?a=1`, contentType: 'image/png', name: 'a.png' },
          { url: `${IMAGE_URL}?a=2`, contentType: 'image/png', name: 'b.png' },
        ],
      }),
    });

    expect(analyze).toHaveBeenCalledTimes(1);
    expect(analyze.mock.calls[0]?.[0]?.imageUrls).toHaveLength(2);
    expect(staged.cue.imageCount).toBe(2);
    expect(staged.cue.reviewedImageCount).toBe(2);
    expect(staged.cue.visionSummary).toContain('Two shots of the same pier');
  });

  it('keeps a sparse-text image turn cueable from the review alone', async () => {
    const analyze = vi.fn(async () => ({
      question: 'q',
      summary: 'A wooden pier at sunset.',
      model: 'vision-model',
      imageCount: 1,
    }));
    const staged = await stage({
      runtime: makeRuntime({ analyze }),
      message: makeMessage({ content: '(image attachment)' }),
    });

    // The transport placeholder is not the Participant's words...
    expect(staged.cue.participantText).toBe('');
    // ...but the review still gives retrieval something to work with.
    expect(staged.cue.visionSummary).toBe('A wooden pier at sunset.');
  });

  it('reports an honest failed cue with no fabricated description when review fails', async () => {
    const analyze = vi.fn(async () => {
      throw new Error('vision provider unavailable');
    });
    const staged = await stage({ runtime: makeRuntime({ analyze }) });

    // The build itself succeeded (it renders a review-failure notice), so the
    // invocation still gets usable content — but the cue says nothing was seen.
    expect(staged.outcome.ok).toBe(true);
    expect(staged.cue.status).toBe('failed');
    expect(staged.cue.visionSummary).toBeNull();
    expect(staged.cue.reviewedImageCount).toBe(0);
  });

  it('fails closed with a timed_out cue when the vision budget is already spent (AC5)', async () => {
    const analyze = vi.fn(async () => ({
      question: 'q',
      summary: 'this must never reach the cue',
      model: 'vision-model',
      imageCount: 1,
    }));
    const staged = await stage({
      runtime: makeRuntime({ analyze }),
      // A deadline in the past: the stage refuses before it starts, with no
      // timers to wait on.
      visionTurnDeadlineAt: Date.now() - 1,
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(staged.outcome.ok).toBe(false);
    if (staged.outcome.ok) throw new Error('expected a failed staging outcome');
    expect(staged.outcome.timedOut).toBe(true);
    expect(staged.cue).toMatchObject({
      status: 'timed_out',
      visionSummary: null,
      reviewedImageCount: 0,
      participantText: '',
      trustLabel: 'untrusted_image_derived',
    });
    expect(staged.cue.imageCount).toBe(1);
  });

  it('records whether the intake firewall actually interposed (shadow vs enforce)', async () => {
    const analyze = () => vi.fn(async () => ({
      question: 'q', summary: 'a pier', model: 'vision-model', imageCount: 1,
    }));
    const shadow = await stage({
      runtime: makeRuntime({
        analyze: analyze(),
        cogSecMode: 'shadow',
        visionIntakeScreener: admittingScreener('shadow'),
      }),
    });
    const enforce = await stage({
      runtime: makeRuntime({
        analyze: analyze(),
        cogSecMode: 'enforce',
        visionIntakeScreener: admittingScreener('enforce'),
      }),
    });

    // Shadow mode audits gateway-side and changes nothing about delivery, so
    // the cue reports no interposition; enforce mode does.
    expect(shadow.cue.enforcing).toBe(false);
    expect(enforce.cue.enforcing).toBe(true);
    // Either way the companion's own review is what cues retrieval — the
    // screener is a boundary audit, never the description source.
    expect(shadow.cue.visionSummary).toBe('a pier');
    expect(enforce.cue.visionSummary).toBe('a pier');
  });

  it('produces a withheld cue with no description when intake withholds every image', async () => {
    const analyze = vi.fn();
    const staged = await stage({
      runtime: makeRuntime({
        analyze,
        cogSecMode: 'enforce',
        visionIntakeScreener: {
          screenImageIntake: vi.fn(async () => ({
            kind: 'screened' as const,
            mode: 'enforce' as const,
            flagged: true,
            withheld: true,
          })),
        },
      }),
    });

    expect(analyze).not.toHaveBeenCalled();
    expect(staged.cue).toMatchObject({
      status: 'withheld',
      visionSummary: null,
      withheldCount: 1,
      imageCount: 1,
    });
  });
});
