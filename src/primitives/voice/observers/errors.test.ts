import { describe, expect, it } from 'vitest';
import { EventBus } from '../../../shared/event-bus.js';
import {
  attachVoiceErrorsObserver,
  classifyVoiceErrorCategory,
  inferVoiceErrorStage,
  type VoiceErrorMetric,
} from './errors.js';

describe('voice error taxonomy helpers', () => {
  it('infers stage from common provider/transport wording', () => {
    expect(inferVoiceErrorStage('Deepgram timed out')).toBe('stt');
    expect(inferVoiceErrorStage('ElevenLabs synthesis failed')).toBe('tts');
    expect(inferVoiceErrorStage('websocket connection reset')).toBe('transport');
    expect(inferVoiceErrorStage('captured silence frame')).toBe('ingest');
    expect(inferVoiceErrorStage('assistant response was empty')).toBe('llm');
  });

  it('classifies timeout/cancelled before stage defaults', () => {
    expect(classifyVoiceErrorCategory('request timed out', 'stt')).toBe('timeout');
    expect(classifyVoiceErrorCategory('stream cancelled by user', 'tts')).toBe('cancelled');
    expect(classifyVoiceErrorCategory('provider rejected request', 'stt')).toBe('stt');
  });
});

describe('attachVoiceErrorsObserver', () => {
  it('records typed turn errors and increments repeated counts', async () => {
    const eventBus = new EventBus();
    const seen: VoiceErrorMetric[] = [];
    attachVoiceErrorsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.error', {
      turnId: 'turn-1',
      channelId: 'voice-c',
      userId: 'u1',
      stage: 'stt',
      error: 'request timed out',
    });
    await eventBus.emit('voice.turn.error', {
      turnId: 'turn-2',
      channelId: 'voice-c',
      userId: 'u1',
      stage: 'stt',
      error: 'request timed out',
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      stage: 'stt',
      category: 'timeout',
      code: 'E_TIMEOUT',
      count: 1,
    });
    expect(seen[1]).toMatchObject({
      stage: 'stt',
      category: 'timeout',
      code: 'E_TIMEOUT',
      count: 2,
    });
  });

  it('ingests channel voice errors and infers taxonomy', async () => {
    const eventBus = new EventBus();
    const seen: VoiceErrorMetric[] = [];
    attachVoiceErrorsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('channel.voice.error', {
      channelId: 'voice-c',
      userId: 'u2',
      error: 'ElevenLabs synthesis failed',
    });

    expect(seen[0]).toMatchObject({
      channelId: 'voice-c',
      userId: 'u2',
      stage: 'tts',
      category: 'tts',
      code: 'E_TTS',
      count: 1,
    });
  });

  it('captures turn observation metrics for silence, empty responses, and playback failures', async () => {
    const eventBus = new EventBus();
    const seen: VoiceErrorMetric[] = [];
    attachVoiceErrorsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('voice.turn.observation', {
      turnId: 'turn-silence',
      channelId: 'voice-c',
      userId: 'u2',
      stage: 'ingest',
      kind: 'silence',
      detail: { pcmBytes: 2048 },
    });
    await eventBus.emit('voice.turn.observation', {
      turnId: 'turn-empty',
      channelId: 'voice-c',
      userId: 'u2',
      stage: 'llm',
      kind: 'empty-response',
      detail: { responseLength: 0 },
    });
    await eventBus.emit('voice.turn.observation', {
      turnId: 'turn-playback',
      channelId: 'voice-c',
      userId: 'u2',
      stage: 'tts',
      kind: 'playback-error',
      detail: { error: 'player timed out' },
    });

    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({
      stage: 'ingest',
      category: 'silence',
      code: 'E_SILENCE',
      count: 1,
    });
    expect(seen[1]).toMatchObject({
      stage: 'llm',
      category: 'empty_response',
      code: 'E_EMPTY_RESPONSE',
      count: 1,
    });
    expect(seen[2]).toMatchObject({
      stage: 'tts',
      category: 'playback_error',
      code: 'E_PLAYBACK_ERROR',
      count: 1,
    });
  });

  it('ingests Wyoming policy/connection failures as transport metrics', async () => {
    const eventBus = new EventBus();
    const seen: VoiceErrorMetric[] = [];
    attachVoiceErrorsObserver(eventBus, {
      onMetric: (metric) => seen.push(metric),
    });

    await eventBus.emit('wyoming.policy.violation', {
      connectionId: 'wyoming-conn-1',
      scope: 'transport',
      code: 'READ_RATE_LIMIT_EXCEEDED',
      message: 'read rate exceeded',
      sessionId: 'session-1',
      eventType: 'audio.chunk',
      limit: 120,
      observed: 121,
      action: 'close_connection',
      timestampMs: 1,
    });
    await eventBus.emit('wyoming.connection.error', {
      connectionId: 'wyoming-conn-1',
      code: 'WRITE_QUEUE_OVERFLOW',
      error: 'Write queue exceeded',
      timestampMs: 2,
    });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      channelId: 'wyoming-conn-1',
      stage: 'transport',
      category: 'transport',
      code: 'E_READ_RATE_LIMIT_EXCEEDED',
      count: 1,
    });
    expect(seen[1]).toMatchObject({
      channelId: 'wyoming-conn-1',
      stage: 'transport',
      category: 'transport',
      code: 'E_WRITE_QUEUE_OVERFLOW',
      count: 1,
    });
  });
});
