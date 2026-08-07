/**
 * Runtime tuning contract for the durable post-turn work lane.
 *
 * Values are owned by scheduler.json. This module contains types only so the
 * supervisor and executor can consume the validated contract without depending
 * on the system config loader.
 */
export interface BackgroundWorkSupervisorTuning {
  maxConcurrentSessions: number;
  leaseDurationMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  shutdownTimeoutMs: number;
  terminalRetentionMs: number;
  cleanupIntervalMs: number;
}

export interface BackgroundWorkPostTurnTuning {
  maxAttempts: number;
  extractionDrainRequeueDelayMs: number;
  foregroundPreemptionDeferDelayMs: number;
}

/** Disabled lanes never persist or retry work; their transient inputs are single-attempt. */
export const DISABLED_BACKGROUND_WORK_MAX_ATTEMPTS = 1;

export interface BackgroundWorkRuntimeTuning {
  supervisor: BackgroundWorkSupervisorTuning;
  postTurn: BackgroundWorkPostTurnTuning;
}
