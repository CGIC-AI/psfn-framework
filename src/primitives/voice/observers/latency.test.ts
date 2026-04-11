import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import { attachVoiceLatencyObserver, type VoiceLatencyMetrics } from './latency.js';

describe('attachVoiceLatencyObserver', () => {
  it('records stt and tts latency fields for a completed turn', async () => {
    const eventBus = new EventBus();
    const seen: VoiceLatencyMetrics[] = [];
    attachVoiceLatencyObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.start', { turnId: 'turn-1', channelId: 'c1', userId: 'u1', timestampMs: 100 });
    await eventBus.emit('voice.stt.partial', { turnId: 'turn-1', timestampMs: 180 });
    await eventBus.emit('voice.stt.final', { turnId: 'turn-1', text: 'hello', timestampMs: 260 });
    await eventBus.emit('voice.tts.requested', { turnId: 'turn-1', timestampMs: 300 });
    await eventBus.emit('voice.tts.first-byte', { turnId: 'turn-1', timestampMs: 360 });
    await eventBus.emit('voice.turn.end', { turnId: 'turn-1', timestampMs: 500 });

    expect(seen).toEqual([
      {
        turnId: 'turn-1',
        channelId: 'c1',
        userId: 'u1',
        stt_first_partial_ms: 80,
        stt_final_ms: 160,
        tts_ttfb_ms: 60,
      },
    ]);
  });

  it('keeps the first partial latency sample and supports unsubscribe', async () => {
    const eventBus = new EventBus();
    const seen: VoiceLatencyMetrics[] = [];
    const unsubscribe = attachVoiceLatencyObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.start', { turnId: 'turn-2', timestampMs: 1_000 });
    await eventBus.emit('voice.stt.partial', { turnId: 'turn-2', timestampMs: 1_050 });
    await eventBus.emit('voice.stt.partial', { turnId: 'turn-2', timestampMs: 1_200 });
    await eventBus.emit('voice.turn.end', { turnId: 'turn-2', timestampMs: 1_400 });

    unsubscribe();
    await eventBus.emit('voice.turn.start', { turnId: 'turn-3', timestampMs: 2_000 });
    await eventBus.emit('voice.turn.end', { turnId: 'turn-3', timestampMs: 2_100 });

    expect(seen).toEqual([
      {
        turnId: 'turn-2',
        channelId: undefined,
        userId: undefined,
        stt_first_partial_ms: 50,
        stt_final_ms: undefined,
        tts_ttfb_ms: undefined,
      },
    ]);
  });
});
