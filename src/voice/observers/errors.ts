import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('VoiceErrorsObserver');

export type VoiceErrorStage = 'ingest' | 'transport' | 'stt' | 'llm' | 'tts' | 'orchestrator' | 'unknown';
export type VoiceErrorCategory =
  | 'timeout'
  | 'cancelled'
  | 'silence'
  | 'empty_transcript'
  | 'empty_response'
  | 'playback_error'
  | 'transport'
  | 'stt'
  | 'tts'
  | 'unknown';

type VoiceTurnObservationKind = 'silence' | 'empty-transcript' | 'empty-response' | 'playback-error';

export interface VoiceErrorMetric {
  turnId?: string;
  channelId?: string;
  userId?: string;
  stage: VoiceErrorStage;
  category: VoiceErrorCategory;
  code: string;
  message: string;
  count: number;
}

export interface VoiceErrorsObserverOptions {
  onMetric?: (metric: VoiceErrorMetric) => void;
}

export function inferVoiceErrorStage(message: string): VoiceErrorStage {
  const text = message.toLowerCase();

  if (text.includes('silence') || text.includes('decode') || text.includes('opus')) return 'ingest';
  if (text.includes('deepgram') || text.includes('transcrib') || text.includes('stt')) return 'stt';
  if (text.includes('elevenlabs') || text.includes('synth') || text.includes('tts') || text.includes('playback')) return 'tts';
  if (text.includes('response') || text.includes('llm') || text.includes('assistant')) return 'llm';
  if (text.includes('websocket') || text.includes('socket') || text.includes('connection') || text.includes('transport') || text.includes('frame')) {
    return 'transport';
  }
  if (text.includes('orchestrator') || text.includes('pipeline')) return 'orchestrator';
  return 'unknown';
}

export function classifyVoiceErrorCategory(message: string, stage: VoiceErrorStage): VoiceErrorCategory {
  const text = message.toLowerCase();

  if (text.includes('timeout') || text.includes('timed out') || text.includes('deadline')) return 'timeout';
  if (text.includes('cancel') || text.includes('abort') || text.includes('interrupt')) return 'cancelled';

  if (stage === 'stt') return 'stt';
  if (stage === 'tts') return 'tts';
  if (stage === 'transport') return 'transport';
  return 'unknown';
}

function normalizeErrorCode(input: string): string {
  const normalized = input
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();

  return normalized ? `E_${normalized}` : 'E_UNKNOWN';
}

function classifyVoiceObservationKind(kind: string): {
  stage: VoiceErrorStage;
  category: VoiceErrorCategory;
} {
  const normalizedKind = kind.toLowerCase() as VoiceTurnObservationKind;

  if (normalizedKind === 'silence') {
    return { stage: 'ingest', category: 'silence' };
  }
  if (normalizedKind === 'empty-transcript') {
    return { stage: 'stt', category: 'empty_transcript' };
  }
  if (normalizedKind === 'empty-response') {
    return { stage: 'llm', category: 'empty_response' };
  }
  if (normalizedKind === 'playback-error') {
    return { stage: 'tts', category: 'playback_error' };
  }

  return { stage: 'unknown', category: 'unknown' };
}

export function attachVoiceErrorsObserver(
  eventBus: EventBus,
  options: VoiceErrorsObserverOptions = {},
): () => void {
  const counters = new Map<string, number>();

  const record = (metric: Omit<VoiceErrorMetric, 'count'>): void => {
    const key = `${metric.stage}:${metric.category}:${metric.code}`;
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);

    const withCount: VoiceErrorMetric = { ...metric, count };
    log.error('Voice failure observed', withCount);
    try {
      options.onMetric?.(withCount);
    } catch (error) {
      log.warn('Voice error metric callback failed', { error: String(error) });
    }
  };

  const unsubs = [
    eventBus.on('voice.turn.error', (event) => {
      const stage = event.stage ?? inferVoiceErrorStage(event.error);
      const category = classifyVoiceErrorCategory(event.error, stage);
      const code = normalizeErrorCode(event.code ?? category);

      record({
        turnId: event.turnId,
        channelId: event.channelId,
        userId: event.userId,
        stage,
        category,
        code,
        message: event.error,
      });
    }),
    eventBus.on('voice.turn.observation', (event) => {
      const inferred = classifyVoiceObservationKind(event.kind);
      const stage = event.stage ?? inferred.stage;
      const category = inferred.category;
      const code = normalizeErrorCode(event.code ?? event.kind);
      const detailError = event.detail && typeof event.detail.error === 'string'
        ? event.detail.error
        : undefined;

      record({
        turnId: event.turnId,
        channelId: event.channelId,
        userId: event.userId,
        stage,
        category,
        code,
        message: detailError ?? event.kind,
      });
    }),
    eventBus.on('channel.voice.error', (event) => {
      const stage = inferVoiceErrorStage(event.error);
      const category = classifyVoiceErrorCategory(event.error, stage);
      const code = normalizeErrorCode(category);

      record({
        channelId: event.channelId,
        userId: event.userId,
        stage,
        category,
        code,
        message: event.error,
      });
    }),
  ];

  return () => {
    for (const unsub of unsubs) {
      unsub();
    }
    counters.clear();
  };
}
