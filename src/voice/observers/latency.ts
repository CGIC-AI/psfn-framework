import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('VoiceLatencyObserver');

interface TurnLatencyState {
  startedAtMs: number;
  channelId?: string;
  userId?: string;
  sttFirstPartialMs?: number;
  sttFinalMs?: number;
  ttsRequestedAtMs?: number;
  ttsTtfbMs?: number;
}

export interface VoiceLatencyMetrics {
  turnId: string;
  channelId?: string;
  userId?: string;
  stt_first_partial_ms?: number;
  stt_final_ms?: number;
  tts_ttfb_ms?: number;
}

export interface VoiceLatencyObserverOptions {
  now?: () => number;
  onMetric?: (metrics: VoiceLatencyMetrics) => void;
}

export function attachVoiceLatencyObserver(
  eventBus: EventBus,
  options: VoiceLatencyObserverOptions = {},
): () => void {
  const now = options.now ?? (() => Date.now());
  const turns = new Map<string, TurnLatencyState>();

  const getTimestamp = (timestampMs?: number): number => {
    return typeof timestampMs === 'number' ? timestampMs : now();
  };

  const getOrCreate = (
    turnId: string,
    timestampMs?: number,
    channelId?: string,
    userId?: string,
  ): TurnLatencyState => {
    const existing = turns.get(turnId);
    if (existing) {
      if (!existing.channelId && channelId) existing.channelId = channelId;
      if (!existing.userId && userId) existing.userId = userId;
      return existing;
    }

    const state: TurnLatencyState = {
      startedAtMs: getTimestamp(timestampMs),
      channelId,
      userId,
    };
    turns.set(turnId, state);
    return state;
  };

  const emit = (metrics: VoiceLatencyMetrics): void => {
    log.info('Voice turn latency metrics', metrics);
    try {
      options.onMetric?.(metrics);
    } catch (error) {
      log.warn('Voice latency metric callback failed', { error: String(error) });
    }
  };

  const unsubs = [
    eventBus.on('voice.turn.start', (event) => {
      turns.set(event.turnId, {
        startedAtMs: getTimestamp(event.timestampMs),
        channelId: event.channelId,
        userId: event.userId,
      });
    }),
    eventBus.on('voice.stt.partial', (event) => {
      const state = getOrCreate(event.turnId, event.timestampMs, event.channelId, event.userId);
      if (state.sttFirstPartialMs !== undefined) return;
      state.sttFirstPartialMs = Math.max(0, getTimestamp(event.timestampMs) - state.startedAtMs);
    }),
    eventBus.on('voice.stt.final', (event) => {
      const state = getOrCreate(event.turnId, event.timestampMs, event.channelId, event.userId);
      state.sttFinalMs = Math.max(0, getTimestamp(event.timestampMs) - state.startedAtMs);
    }),
    eventBus.on('voice.tts.requested', (event) => {
      const state = getOrCreate(event.turnId, event.timestampMs, event.channelId, event.userId);
      state.ttsRequestedAtMs = getTimestamp(event.timestampMs);
    }),
    eventBus.on('voice.tts.first-byte', (event) => {
      const state = getOrCreate(event.turnId, event.timestampMs, event.channelId, event.userId);
      if (state.ttsRequestedAtMs === undefined) return;
      state.ttsTtfbMs = Math.max(0, getTimestamp(event.timestampMs) - state.ttsRequestedAtMs);
    }),
    eventBus.on('voice.turn.end', (event) => {
      const state = turns.get(event.turnId);
      const metrics: VoiceLatencyMetrics = {
        turnId: event.turnId,
        channelId: state?.channelId ?? event.channelId,
        userId: state?.userId ?? event.userId,
        stt_first_partial_ms: state?.sttFirstPartialMs,
        stt_final_ms: state?.sttFinalMs,
        tts_ttfb_ms: state?.ttsTtfbMs,
      };

      emit(metrics);
      turns.delete(event.turnId);
    }),
  ];

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
    turns.clear();
  };
}
