import { createComponentLogger } from '../../shared/logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type {
  VoiceConnectionRecoveryTrigger,
  VoiceRecoveryRuntimeContext,
  VoiceStreamDegradedPhase,
  VoiceTurnErrorStage,
} from './voice-types.js';
import {
  DECRYPT_RECOVERY_COOLDOWN_MS,
  DECRYPT_RECOVERY_MAX_REJOINS,
  DECRYPT_RECOVERY_WINDOW_MS,
  STREAM_ERROR_MAX_FAILURES,
} from './voice-types.js';
import {
  createStructuredVoiceError,
  resolveVoiceErrorCode,
  resolveVoiceErrorStage,
} from './voice-errors.js';
import { cancelActiveVoiceTurn } from './voice-turn-runtime.js';

const log = createComponentLogger('DiscordVoice');

export function emitVoiceStreamDegradedTelemetry(
  runtime: VoiceRecoveryRuntimeContext,
  params: {
    phase: VoiceStreamDegradedPhase;
    userId: string;
    errorCount: number;
    threshold: number;
    channel?: VoiceRecoveryRuntimeContext['activeChannel'];
    generation?: number;
    recoveryAttempt?: number;
  },
): void {
  const { phase, userId, errorCount, threshold, generation, recoveryAttempt } = params;
  const channel = params.channel ?? runtime.activeChannel;
  const payload: Record<string, unknown> = {
    phase,
    userId,
    channelId: channel?.id,
    guildId: channel?.guild.id,
    generation,
    errorCount,
    threshold,
    recoveryAttempt,
    timestampMs: Date.now(),
  };

  const emitUntyped = runtime.eventBus.emit.bind(runtime.eventBus) as unknown as (
    event: string,
    data: Record<string, unknown>,
  ) => Promise<void>;
  emitUntyped('voice.stream.degraded', payload).catch(() => undefined);
}

export function resetVoiceStreamErrorCounts(runtime: VoiceRecoveryRuntimeContext): void {
  runtime.streamErrorCounts.clear();
}

export function recordVoiceStreamError(runtime: VoiceRecoveryRuntimeContext, userId: string): void {
  const count = (runtime.streamErrorCounts.get(userId) ?? 0) + 1;
  runtime.streamErrorCounts.set(userId, count);

  if (count < STREAM_ERROR_MAX_FAILURES) {
    return;
  }

  log.error('Stream error threshold exceeded for user; tearing down receive stream', {
    userId,
    errorCount: count,
    threshold: STREAM_ERROR_MAX_FAILURES,
  });
  runtime.streamErrorCounts.delete(userId);

  const recoveryChannel = runtime.activeChannel;
  const recoveryGeneration = runtime.connectionGeneration;
  emitVoiceStreamDegradedTelemetry(runtime, {
    phase: 'degraded-detected',
    userId,
    errorCount: count,
    threshold: STREAM_ERROR_MAX_FAILURES,
    channel: recoveryChannel,
    generation: recoveryGeneration,
  });

  if (!recoveryChannel || !runtime.connection) {
    log.warn('Stream degradation threshold exceeded without active connection; skipping recovery', {
      userId,
      errorCount: count,
      threshold: STREAM_ERROR_MAX_FAILURES,
    });
    return;
  }

  void startVoiceDecryptRecovery(runtime, {
    channel: recoveryChannel,
    generation: recoveryGeneration,
    failureCount: count,
    tolerance: STREAM_ERROR_MAX_FAILURES,
    trigger: 'stream-degraded',
    degradedUserId: userId,
    degradedErrorCount: count,
  });
}

export function emitRuntimeVoiceError(runtime: VoiceRecoveryRuntimeContext, error: unknown): void {
  void cancelActiveVoiceTurn(runtime as never, 'voice-error');

  const stage = resolveVoiceErrorStage(error);
  const code = resolveVoiceErrorCode(error);
  const voiceError = createStructuredVoiceError({ error, stage, code });
  const errorText = voiceError.message;

  log.error('Voice pipeline error', {
    stage,
    code,
    error: errorText,
  });

  runtime.eventBus.emit('channel.voice.error', {
    guildId: runtime.activeChannel?.guild.id,
    channelId: runtime.activeChannel?.id,
    userId: runtime.targetUserId,
    error: errorText,
  }).catch((err) => {
    log.debug('Failed to emit voice error event', { error: String(err) });
  });

  if (!voiceError.voiceTurnErrorEmitted) {
    runtime.eventBus.emit('voice.turn.error', {
      turnId: runtime.activeTurnId ?? undefined,
      channelId: runtime.activeChannel?.id,
      userId: runtime.targetUserId,
      stage,
      code,
      error: errorText,
      timestampMs: Date.now(),
    }).catch((err) => {
      log.debug('Failed to emit voice turn error event', { error: String(err) });
    });
  }

  trackVoiceDecryptFailure(runtime, {
    stage,
    code,
    errorText,
  });
}

export function resetVoiceDecryptFailureTracking(runtime: VoiceRecoveryRuntimeContext, generation: number): void {
  runtime.decryptFailureGeneration = generation;
  runtime.decryptFailureCount = 0;
}

export function isRecoverableDecryptFailure(
  stage: VoiceTurnErrorStage,
  code: string,
  errorText: string,
): boolean {
  if (stage !== 'ingest') {
    return false;
  }

  const normalized = `${code} ${errorText}`.toLowerCase();
  if (normalized.includes('abort') || normalized.includes('cancel')) {
    return false;
  }

  return ['decrypt', 'decode', 'opus', 'dave'].some((token) => normalized.includes(token));
}

export function pruneVoiceDecryptRecoveryAttempts(runtime: VoiceRecoveryRuntimeContext, nowMs: number): void {
  runtime.decryptRecoveryAttempts = runtime.decryptRecoveryAttempts
    .filter((attemptMs) => nowMs - attemptMs <= DECRYPT_RECOVERY_WINDOW_MS);
}

export function trackVoiceDecryptFailure(
  runtime: VoiceRecoveryRuntimeContext,
  params: {
    stage: VoiceTurnErrorStage;
    code: string;
    errorText: string;
  },
): void {
  if (!runtime.connection || !runtime.activeChannel || runtime.decryptRecoveryInFlight) {
    return;
  }

  const { stage, code, errorText } = params;
  if (!isRecoverableDecryptFailure(stage, code, errorText)) {
    return;
  }

  const generation = runtime.connectionGeneration;
  if (runtime.decryptFailureGeneration !== generation) {
    resetVoiceDecryptFailureTracking(runtime, generation);
  }

  runtime.decryptFailureCount += 1;

  log.warn('Voice decrypt/ingest failure detected', {
    guildId: runtime.activeChannel.guild.id,
    channelId: runtime.activeChannel.id,
    userId: runtime.targetUserId,
    generation,
    failureCount: runtime.decryptFailureCount,
    failureTolerance: runtime.decryptionFailureTolerance,
    code,
    error: errorText,
  });

  if (runtime.decryptFailureCount <= runtime.decryptionFailureTolerance) {
    return;
  }

  const recoveryChannel = runtime.activeChannel;

  void startVoiceDecryptRecovery(runtime, {
    channel: recoveryChannel,
    generation,
    failureCount: runtime.decryptFailureCount,
  });
}

export async function startVoiceDecryptRecovery(
  runtime: VoiceRecoveryRuntimeContext,
  params: {
    channel: NonNullable<VoiceRecoveryRuntimeContext['activeChannel']>;
    generation: number;
    failureCount: number;
    tolerance?: number;
    trigger?: VoiceConnectionRecoveryTrigger;
    degradedUserId?: string;
    degradedErrorCount?: number;
  },
): Promise<void> {
  const {
    channel,
    generation,
    failureCount,
    tolerance = runtime.decryptionFailureTolerance,
    trigger = 'decrypt-failures',
    degradedUserId = runtime.targetUserId,
    degradedErrorCount = failureCount,
  } = params;
  if (runtime.decryptRecoveryInFlight) {
    return;
  }

  runtime.decryptRecoveryInFlight = true;

  try {
    const nowMs = Date.now();
    pruneVoiceDecryptRecoveryAttempts(runtime, nowMs);

    if (runtime.decryptRecoveryAttempts.length >= DECRYPT_RECOVERY_MAX_REJOINS) {
      const exhaustedPayload = {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: runtime.targetUserId,
        generation,
        failureCount,
        tolerance,
        maxAttempts: DECRYPT_RECOVERY_MAX_REJOINS,
        windowMs: DECRYPT_RECOVERY_WINDOW_MS,
        timestampMs: nowMs,
      };
      const exhaustedPrefix = trigger === 'stream-degraded'
        ? 'Voice stream recovery exhausted'
        : 'Voice decrypt recovery exhausted';
      const errorText = `${exhaustedPrefix} after ${DECRYPT_RECOVERY_MAX_REJOINS} rejoins in ${Math.floor(DECRYPT_RECOVERY_WINDOW_MS / 1_000)} seconds`;

      await runtime.eventBus.emit('voice.connection.recovery.exhausted', exhaustedPayload);
      await runtime.eventBus.emit('channel.voice.error', {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: runtime.targetUserId,
        error: errorText,
      });

      log.error('Voice connection recovery exhausted; operator intervention required', {
        ...exhaustedPayload,
        trigger,
        error: errorText,
      });
      await runtime.leaveChannel(trigger === 'stream-degraded' ? 'stream-recovery-exhausted' : 'decrypt-recovery-exhausted');
      return;
    }

    const attempt = runtime.decryptRecoveryAttempts.length + 1;
    runtime.decryptRecoveryAttempts.push(nowMs);

    const recoveryPayload = {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: runtime.targetUserId,
      generation,
      failureCount,
      tolerance,
      attempt,
      maxAttempts: DECRYPT_RECOVERY_MAX_REJOINS,
      windowMs: DECRYPT_RECOVERY_WINDOW_MS,
      cooldownMs: DECRYPT_RECOVERY_COOLDOWN_MS,
      timestampMs: nowMs,
    };

    await runtime.eventBus.emit('voice.connection.recovery', recoveryPayload);
    if (trigger === 'stream-degraded') {
      emitVoiceStreamDegradedTelemetry(runtime, {
        phase: 'recovery-executed',
        userId: degradedUserId,
        errorCount: degradedErrorCount,
        threshold: STREAM_ERROR_MAX_FAILURES,
        channel,
        generation,
        recoveryAttempt: attempt,
      });
    }

    log.warn('Recovering voice connection after repeated failures', {
      ...recoveryPayload,
      trigger,
    });

    await runtime.leaveChannel(trigger === 'stream-degraded' ? 'stream-recovery' : 'decrypt-recovery');
    await new Promise<void>((resolve) => {
      setTimeout(resolve, DECRYPT_RECOVERY_COOLDOWN_MS);
    });

    if (runtime.activeChannel) {
      log.info('Skipping recovery rejoin because another channel is already active', {
        ...recoveryPayload,
        trigger,
        activeChannelId: runtime.activeChannel.id,
      });
      return;
    }

    await runtime.joinChannel(channel);
    log.info('Voice connection recovered after repeated failures', {
      ...recoveryPayload,
      trigger,
    });
  } catch (error) {
    const errorText = toErrorMessage(error);
    log.error('Voice connection recovery failed', {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: runtime.targetUserId,
      generation,
      trigger,
      error: errorText,
    });
    const recoveryLabel = trigger === 'stream-degraded' ? 'stream' : 'decrypt';
    await runtime.eventBus.emit('channel.voice.error', {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: runtime.targetUserId,
      error: `Voice ${recoveryLabel} recovery failed: ${errorText}`,
    });
  } finally {
    runtime.decryptRecoveryInFlight = false;
  }
}
