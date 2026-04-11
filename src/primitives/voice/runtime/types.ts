import type { VoicePipelineDefinition } from '../pipeline/pipeline.js';

export type VoiceOrchestratorState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'cancelled'
  | 'failed';

export interface VoiceOrchestratorSnapshot {
  state: VoiceOrchestratorState;
  runId: number;
  startedAt?: number;
  endedAt?: number;
  reason?: string;
  error?: Error;
}

export interface VoiceOrchestratorTransition {
  from: VoiceOrchestratorState;
  to: VoiceOrchestratorState;
  runId: number;
  at: number;
  reason?: string;
}

export type VoiceOrchestratorListener = (
  transition: VoiceOrchestratorTransition,
  snapshot: VoiceOrchestratorSnapshot,
) => void;

export interface VoiceOrchestratorOptions<TInput, TOutput> {
  pipeline: VoicePipelineDefinition<TInput, TOutput>;
}
