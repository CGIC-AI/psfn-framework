import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { attachVoiceTurnsObserver, type VoiceTurnMetrics } from './turns.js';

describe('attachVoiceTurnsObserver', () => {
  it('tracks interruption_count and drop_count for each turn', async () => {
    const eventBus = new EventBus();
    const seen: VoiceTurnMetrics[] = [];
    attachVoiceTurnsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.start', { turnId: 'turn-1', channelId: 'voice-c', userId: 'u1' });
    await eventBus.emit('voice.turn.interrupted', { turnId: 'turn-1' });
    await eventBus.emit('voice.frame.dropped', { turnId: 'turn-1', stage: 'transport' });
    await eventBus.emit('voice.frame.dropped', { turnId: 'turn-1', stage: 'stt', count: 2 });
    await eventBus.emit('voice.turn.end', { turnId: 'turn-1' });

    expect(seen).toEqual([
      {
        turnId: 'turn-1',
        channelId: 'voice-c',
        userId: 'u1',
        interruption_count: 1,
        drop_count: 3,
      },
    ]);
  });

  it('emits zeroed counters when a turn ends without interruption/drop events', async () => {
    const eventBus = new EventBus();
    const seen: VoiceTurnMetrics[] = [];
    attachVoiceTurnsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.start', { turnId: 'turn-2' });
    await eventBus.emit('voice.turn.end', { turnId: 'turn-2' });

    expect(seen[0]).toMatchObject({
      turnId: 'turn-2',
      interruption_count: 0,
      drop_count: 0,
    });
  });
});
