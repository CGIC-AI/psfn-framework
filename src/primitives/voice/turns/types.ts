export type TurnState =
  | 'idle'
  | 'user_speaking'
  | 'user_waiting'
  | 'assistant_speaking'
  | 'interrupted'
  | 'cancelled';

export type TurnTransitionReason =
  | 'user_speech_started'
  | 'user_speech_ended'
  | 'assistant_speech_started'
  | 'assistant_speech_ended'
  | 'assistant_interrupted'
  | 'manual_cancel'
  | 'reset_after_cancel';

export interface TurnActivity {
  silenceMs: number;
  hasFinalTranscript: boolean;
}

export interface TurnStrategy {
  name: string;
  interruptOnUserSpeechDuringAssistant: boolean;
  shouldCloseUserTurn(activity: TurnActivity): boolean;
}

export interface TurnSnapshot {
  state: TurnState;
  turnId: number;
  interruptions: number;
  silenceMs: number;
  hasFinalTranscript: boolean;
  lastTransitionAt: number;
}

export interface TurnTransition {
  from: TurnState;
  to: TurnState;
  reason: TurnTransitionReason;
  turnId: number;
  interruptions: number;
  at: number;
}

export type TurnTransitionListener = (
  transition: TurnTransition,
  snapshot: TurnSnapshot,
) => void;
