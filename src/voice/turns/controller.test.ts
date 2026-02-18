import { describe, expect, it } from 'vitest';
import { TurnLifecycleController } from './controller.js';
import {
  createSilenceTurnStrategy,
  createTranscriptConfirmedTurnStrategy,
} from './strategies.js';

describe('TurnLifecycleController', () => {
  it('handles the baseline user->assistant->idle lifecycle', () => {
    const controller = new TurnLifecycleController(
      createSilenceTurnStrategy({ silenceThresholdMs: 300 }),
    );

    const transitions: Array<{ from: string; to: string; reason: string }> = [];
    controller.onTransition((transition) => {
      transitions.push({
        from: transition.from,
        to: transition.to,
        reason: transition.reason,
      });
    });

    expect(controller.onUserSpeechStart()).toBe(true);
    expect(controller.onUserSpeechActivity({ silenceMs: 100 })).toBe(false);
    expect(controller.onUserSpeechActivity({ silenceMs: 300 })).toBe(true);
    expect(controller.onAssistantSpeechStart()).toBe(true);
    expect(controller.onAssistantSpeechEnd()).toBe(true);

    expect(controller.getSnapshot().state).toBe('idle');
    expect(transitions).toEqual([
      { from: 'idle', to: 'user_speaking', reason: 'user_speech_started' },
      { from: 'user_speaking', to: 'user_waiting', reason: 'user_speech_ended' },
      { from: 'user_waiting', to: 'assistant_speaking', reason: 'assistant_speech_started' },
      { from: 'assistant_speaking', to: 'idle', reason: 'assistant_speech_ended' },
    ]);
  });

  it('interrupts assistant speech when user barges in', () => {
    const controller = new TurnLifecycleController(
      createSilenceTurnStrategy({ silenceThresholdMs: 200 }),
    );

    controller.onUserSpeechStart();
    controller.onUserSpeechActivity({ silenceMs: 200 });
    controller.onAssistantSpeechStart();

    const started = controller.onUserSpeechStart();
    const snapshot = controller.getSnapshot();

    expect(started).toBe(true);
    expect(snapshot.state).toBe('user_speaking');
    expect(snapshot.interruptions).toBe(1);
    expect(snapshot.turnId).toBe(2);
  });

  it('keeps false starts open when transcript confirmation is required', () => {
    const controller = new TurnLifecycleController(
      createTranscriptConfirmedTurnStrategy({
        silenceThresholdMs: 200,
        requireFinalTranscript: true,
      }),
    );

    controller.onUserSpeechStart();

    expect(controller.onUserSpeechActivity({ silenceMs: 220 })).toBe(false);
    expect(controller.getSnapshot().state).toBe('user_speaking');

    expect(controller.onTranscriptFinal()).toBe(true);
    expect(controller.getSnapshot().state).toBe('user_waiting');
  });

  it('supports explicit cancellation and reset', () => {
    const controller = new TurnLifecycleController(
      createSilenceTurnStrategy({ silenceThresholdMs: 250 }),
    );

    controller.onUserSpeechStart();

    expect(controller.cancelActiveTurn()).toBe(true);
    expect(controller.getSnapshot().state).toBe('idle');
  });
});
