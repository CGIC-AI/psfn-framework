import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('VoiceTurnsObserver');

interface TurnCounters {
  channelId?: string;
  userId?: string;
  interruptionCount: number;
  dropCount: number;
}

export interface VoiceTurnMetrics {
  turnId: string;
  channelId?: string;
  userId?: string;
  interruption_count: number;
  drop_count: number;
}

export interface VoiceTurnsObserverOptions {
  onMetric?: (metrics: VoiceTurnMetrics) => void;
}

export function attachVoiceTurnsObserver(
  eventBus: EventBus,
  options: VoiceTurnsObserverOptions = {},
): () => void {
  const turns = new Map<string, TurnCounters>();

  const getOrCreate = (turnId: string, channelId?: string, userId?: string): TurnCounters => {
    const existing = turns.get(turnId);
    if (existing) {
      if (!existing.channelId && channelId) existing.channelId = channelId;
      if (!existing.userId && userId) existing.userId = userId;
      return existing;
    }

    const state: TurnCounters = {
      channelId,
      userId,
      interruptionCount: 0,
      dropCount: 0,
    };
    turns.set(turnId, state);
    return state;
  };

  const emit = (metrics: VoiceTurnMetrics): void => {
    log.info('Voice turn counters', metrics);
    try {
      options.onMetric?.(metrics);
    } catch (error) {
      log.warn('Voice turn metric callback failed', { error: String(error) });
    }
  };

  const unsubs = [
    eventBus.on('voice.turn.start', (event) => {
      turns.set(event.turnId, {
        channelId: event.channelId,
        userId: event.userId,
        interruptionCount: 0,
        dropCount: 0,
      });
    }),
    eventBus.on('voice.turn.interrupted', (event) => {
      const state = getOrCreate(event.turnId, event.channelId, event.userId);
      state.interruptionCount += 1;
    }),
    eventBus.on('voice.frame.dropped', (event) => {
      if (!event.turnId) return;
      const state = getOrCreate(event.turnId, event.channelId, event.userId);
      const count = event.count;
      const increment = typeof count === 'number' && Number.isFinite(count) && count > 0
        ? Math.trunc(count)
        : 1;
      state.dropCount += increment;
    }),
    eventBus.on('voice.turn.end', (event) => {
      const state = turns.get(event.turnId);
      const metrics: VoiceTurnMetrics = {
        turnId: event.turnId,
        channelId: state?.channelId ?? event.channelId,
        userId: state?.userId ?? event.userId,
        interruption_count: state?.interruptionCount ?? 0,
        drop_count: state?.dropCount ?? 0,
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
