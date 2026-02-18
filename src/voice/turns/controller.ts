import { createSilenceTurnStrategy } from './strategies.js';
import type {
  TurnActivity,
  TurnSnapshot,
  TurnState,
  TurnStrategy,
  TurnTransition,
  TurnTransitionListener,
  TurnTransitionReason,
} from './types.js';

const DEFAULT_SILENCE_THRESHOLD_MS = 1_200;

export class TurnLifecycleController {
  private readonly listeners = new Set<TurnTransitionListener>();
  private readonly strategy: TurnStrategy;

  private snapshot: TurnSnapshot;

  constructor(
    strategy: TurnStrategy = createSilenceTurnStrategy({ silenceThresholdMs: DEFAULT_SILENCE_THRESHOLD_MS }),
  ) {
    this.strategy = strategy;
    this.snapshot = {
      state: 'idle',
      turnId: 0,
      interruptions: 0,
      silenceMs: 0,
      hasFinalTranscript: false,
      lastTransitionAt: Date.now(),
    };
  }

  getSnapshot(): TurnSnapshot {
    return { ...this.snapshot };
  }

  onTransition(listener: TurnTransitionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onUserSpeechStart(at = Date.now()): boolean {
    if (
      this.snapshot.state === 'assistant_speaking'
      && this.strategy.interruptOnUserSpeechDuringAssistant
    ) {
      this.snapshot.interruptions += 1;
      this.transition('interrupted', 'assistant_interrupted', at);
    }

    if (this.snapshot.state === 'user_speaking') {
      return false;
    }

    this.snapshot.turnId += 1;
    this.snapshot.silenceMs = 0;
    this.snapshot.hasFinalTranscript = false;
    this.transition('user_speaking', 'user_speech_started', at);
    return true;
  }

  onUserSpeechActivity(activity: Partial<TurnActivity>, at = Date.now()): boolean {
    if (this.snapshot.state !== 'user_speaking') {
      return false;
    }

    if (typeof activity.silenceMs === 'number') {
      this.snapshot.silenceMs = Math.max(0, activity.silenceMs);
    }

    if (activity.hasFinalTranscript !== undefined) {
      this.snapshot.hasFinalTranscript = activity.hasFinalTranscript;
    }

    const shouldCloseTurn = this.strategy.shouldCloseUserTurn({
      silenceMs: this.snapshot.silenceMs,
      hasFinalTranscript: this.snapshot.hasFinalTranscript,
    });

    if (!shouldCloseTurn) {
      return false;
    }

    this.transition('user_waiting', 'user_speech_ended', at);
    return true;
  }

  onTranscriptFinal(at = Date.now()): boolean {
    return this.onUserSpeechActivity({ hasFinalTranscript: true }, at);
  }

  onAssistantSpeechStart(at = Date.now()): boolean {
    if (this.snapshot.state === 'assistant_speaking') {
      return true;
    }

    if (this.snapshot.state !== 'idle' && this.snapshot.state !== 'user_waiting') {
      return false;
    }

    this.transition('assistant_speaking', 'assistant_speech_started', at);
    return true;
  }

  onAssistantSpeechEnd(at = Date.now()): boolean {
    if (this.snapshot.state !== 'assistant_speaking') {
      return false;
    }

    this.snapshot.silenceMs = 0;
    this.snapshot.hasFinalTranscript = false;
    this.transition('idle', 'assistant_speech_ended', at);
    return true;
  }

  cancelActiveTurn(at = Date.now()): boolean {
    if (this.snapshot.state === 'idle') {
      return false;
    }

    this.transition('cancelled', 'manual_cancel', at);
    this.snapshot.silenceMs = 0;
    this.snapshot.hasFinalTranscript = false;
    this.transition('idle', 'reset_after_cancel', at);
    return true;
  }

  private transition(nextState: TurnState, reason: TurnTransitionReason, at: number): void {
    const previousState = this.snapshot.state;
    if (previousState === nextState) {
      return;
    }

    this.snapshot = {
      ...this.snapshot,
      state: nextState,
      lastTransitionAt: at,
    };

    const transition: TurnTransition = {
      from: previousState,
      to: nextState,
      reason,
      turnId: this.snapshot.turnId,
      interruptions: this.snapshot.interruptions,
      at,
    };

    const snapshotCopy = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(transition, snapshotCopy);
    }
  }
}
