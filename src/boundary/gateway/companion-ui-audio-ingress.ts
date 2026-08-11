import type {
  StreamingSttConnector,
  SttTranscriptChunk,
} from '../../primitives/voice/connectors/stt/types.js';
import { assertBoundedText } from '../../primitives/voice/policy/security.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';

export interface CompanionUiAudioIngressCallbacks {
  readonly companionId: CompanionId;
  readonly onPartial: (text: string) => void;
  readonly onUtterance: (text: string) => Promise<void>;
  readonly onError: (error: Error) => void;
}

export interface CompanionUiAudioIngressSession {
  writePcm(pcm: Uint8Array): Promise<void>;
  stop(reason: string): Promise<void>;
  cancel(reason: string): Promise<void>;
}

export interface CompanionUiAudioIngressPort {
  start(callbacks: CompanionUiAudioIngressCallbacks): Promise<CompanionUiAudioIngressSession>;
}

export interface GatewayCompanionUiAudioIngressOptions {
  readonly createConnector: (companionId: CompanionId) => StreamingSttConnector;
  readonly maxFrameBytes: number;
  readonly maxPendingUtterances: number;
  readonly maxTranscriptBytes: number;
}

/**
 * Gateway-owned continuous PCM-to-utterance bridge. Browser audio is fixed to
 * PCM16 mono 16 kHz; provider endpointing marks utterance boundaries and only
 * bounded transcript text leaves this module.
 */
export class GatewayCompanionUiAudioIngress implements CompanionUiAudioIngressPort {
  constructor(private readonly options: GatewayCompanionUiAudioIngressOptions) {
    for (const value of [
      options.maxFrameBytes,
      options.maxPendingUtterances,
      options.maxTranscriptBytes,
    ]) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('Companion UI audio ingress limits must be positive integers');
      }
    }
  }

  async start(callbacks: CompanionUiAudioIngressCallbacks): Promise<CompanionUiAudioIngressSession> {
    const connector = this.options.createConnector(callbacks.companionId);
    const controller = new AbortController();
    const stream = await connector.startStream({
      sampleRateHz: 16_000,
      channels: 1,
      encoding: 'pcm_s16le',
      interimResults: true,
    }, controller.signal);
    const state: { stopped: boolean; failure: Error | null } = {
      stopped: false,
      failure: null,
    };
    let pendingUtterances = 0;
    let delivery = Promise.resolve();
    const finalSegments: string[] = [];

    const fail = (error: unknown): Error => {
      const resolved = error instanceof Error ? error : new Error(String(error));
      if (!state.failure) {
        state.failure = resolved;
        callbacks.onError(resolved);
        controller.abort(resolved);
        void stream.cancel('companion audio ingress failed').catch(() => undefined);
      }
      return resolved;
    };
    const bounded = (text: string): string => assertBoundedText(
      'companion.audio.transcript',
      text,
      this.options.maxTranscriptBytes,
    );
    const combinedText = (tail = ''): string => bounded(
      [...finalSegments, tail].filter(Boolean).join(' '),
    );
    const queueUtterance = (text: string): void => {
      if (!text) return;
      if (pendingUtterances >= this.options.maxPendingUtterances) {
        fail(new Error(
          `Companion audio utterance backlog exceeded ${this.options.maxPendingUtterances}`,
        ));
        return;
      }
      pendingUtterances += 1;
      delivery = delivery
        .then(() => callbacks.onUtterance(text))
        .catch(error => { fail(error); })
        .finally(() => { pendingUtterances -= 1; });
    };
    const flushFinalSegments = (): void => {
      const text = combinedText();
      finalSegments.length = 0;
      queueUtterance(text);
    };
    const consumeTranscript = (chunk: SttTranscriptChunk): void => {
      const text = bounded(chunk.text);
      if (!text || state.failure) return;
      if (chunk.type === 'partial') {
        callbacks.onPartial(combinedText(text));
        return;
      }
      if (finalSegments.at(-1) !== text) finalSegments.push(text);
      if (chunk.utteranceFinal) {
        flushFinalSegments();
      } else {
        callbacks.onPartial(combinedText());
      }
    };
    const pump = (async () => {
      try {
        for await (const chunk of stream.transcripts) consumeTranscript(chunk);
        if (!state.failure && finalSegments.length > 0) flushFinalSegments();
      } catch (error) {
        if (!state.stopped && !controller.signal.aborted) fail(error);
      }
    })();

    const ensureWritable = (): void => {
      if (state.failure) throw state.failure;
      if (state.stopped) throw new Error('Companion audio ingress is closed');
    };
    const finish = async (reason: string, cancel: boolean): Promise<void> => {
      if (state.stopped) return;
      state.stopped = true;
      if (cancel) {
        controller.abort(reason);
        await stream.cancel(reason);
      } else {
        await stream.endInput();
      }
      await pump;
      await delivery;
    };

    return Object.freeze({
      writePcm: async (pcm: Uint8Array): Promise<void> => {
        ensureWritable();
        if (!(pcm instanceof Uint8Array) || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
          throw new Error('Companion audio requires non-empty PCM16 frames');
        }
        if (pcm.byteLength > this.options.maxFrameBytes) {
          throw new Error(`Companion audio frame limit exceeded (${pcm.byteLength})`);
        }
        await stream.writeAudio(pcm);
      },
      stop: async (reason: string): Promise<void> => finish(reason, false),
      cancel: async (reason: string): Promise<void> => finish(reason, true),
    });
  }
}
