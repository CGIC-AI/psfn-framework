import { createComponentLogger } from '../../../shared/logger.js';
import type { SttStreamSession } from '../../connectors/stt/types.js';
import type { TtsSynthesisSession } from '../../connectors/tts/types.js';
import type { VoiceRuntimeStage } from '../../policy/reliability.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceAckFrame,
  type VoiceWireInboundFrame,
  type VoiceWireOutboundFrame,
  type VoiceWireErrorFrame,
  type VoicePlaybackFrame,
  type VoicePongFrame,
  type VoiceTranscriptFrame,
  type WebSocketVoiceRuntimeOptions,
  type WebSocketVoiceSession,
} from './types.js';

const log = createComponentLogger('VoiceWebSocketRuntime');

const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_FINAL_TRANSCRIPTS = 128;
const FINAL_TRANSCRIPT_OVERFLOW_POLICY = 'drop_oldest' as const;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

type RuntimeErrorCode =
  | 'SESSION_NOT_FOUND'
  | 'SESSION_END_IN_PROGRESS'
  | 'INVALID_AUDIO_BASE64'
  | 'AUDIO_CHUNK_TOO_LARGE'
  | 'STT_TRANSCRIPT_STREAM_FAILED'
  | 'SECURITY_VIOLATION'
  | 'INTERRUPTED'
  | 'INTERNAL_RUNTIME_ERROR';

interface RuntimeSessionState {
  key: string;
  transportSession: WebSocketVoiceSession;
  frameSessionId: string;
  sttSession: SttStreamSession;
  transcriptPump: Promise<void>;
  transcriptPumpError: Error | null;
  finalTranscripts: string[];
  droppedFinalTranscriptCount: number;
  lastPartialTranscript: string;
  abortController: AbortController;
  ttsSession: TtsSynthesisSession | null;
  ending: boolean;
  interrupted: boolean;
}

interface SessionStartInFlight {
  key: string;
  transportSession: WebSocketVoiceSession;
  abortController: AbortController;
  promise: Promise<RuntimeSessionState>;
}

type VoiceWireOutboundPayload =
  | Omit<VoiceAckFrame, 'wire' | 'sessionId' | 'timestampMs'>
  | Omit<VoiceTranscriptFrame, 'wire' | 'sessionId' | 'timestampMs'>
  | Omit<VoicePlaybackFrame, 'wire' | 'sessionId' | 'timestampMs'>
  | Omit<VoicePongFrame, 'wire' | 'sessionId' | 'timestampMs'>
  | Omit<VoiceWireErrorFrame, 'wire' | 'sessionId' | 'timestampMs'>;

class WebSocketVoiceRuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'WebSocketVoiceRuntimeError';
    this.code = code;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof WebSocketVoiceRuntimeError && error.code === 'INTERRUPTED') return true;
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError') return true;
  return /abort/i.test(error.message);
}

function toSessionKey(transportSession: WebSocketVoiceSession, frameSessionId: string): string {
  return `${transportSession.connectionId}:${frameSessionId}`;
}

function canonicalBase64(input: string): string {
  return input.replace(/\s+/g, '').replace(/=+$/g, '');
}

export class WebSocketVoiceRuntime {
  private readonly sessions = new Map<string, RuntimeSessionState>();
  private readonly startsInFlight = new Map<string, SessionStartInFlight>();
  private readonly maxAudioChunkBytes: number;
  private readonly now: () => number;
  private readonly stt: WebSocketVoiceRuntimeOptions['stt'];
  private readonly tts: WebSocketVoiceRuntimeOptions['tts'];
  private readonly security: WebSocketVoiceRuntimeOptions['security'];
  private readonly onAssistantTurn: WebSocketVoiceRuntimeOptions['onAssistantTurn'];
  private readonly emitFrame: WebSocketVoiceRuntimeOptions['emitFrame'];
  private readonly sttConfig: WebSocketVoiceRuntimeOptions['sttConfig'];
  private readonly ttsRequest: WebSocketVoiceRuntimeOptions['ttsRequest'];
  private readonly reliability: WebSocketVoiceRuntimeOptions['reliability'];

  constructor(options: WebSocketVoiceRuntimeOptions) {
    this.stt = options.stt;
    this.tts = options.tts;
    this.security = options.security;
    this.onAssistantTurn = options.onAssistantTurn;
    this.emitFrame = options.emitFrame;
    this.sttConfig = options.sttConfig;
    this.ttsRequest = options.ttsRequest;
    this.reliability = options.reliability;
    this.now = options.now ?? (() => Date.now());
    this.maxAudioChunkBytes = Math.max(1, Math.floor(options.maxAudioChunkBytes ?? DEFAULT_MAX_AUDIO_CHUNK_BYTES));
  }

  async handleFrame(session: WebSocketVoiceSession, frame: VoiceWireInboundFrame): Promise<void> {
    try {
      switch (frame.type) {
        case 'session.start':
          await this.handleSessionStart(session, frame.sessionId);
          return;
        case 'audio.chunk':
          await this.handleAudioChunk(session, frame.sessionId, frame.audioBase64);
          return;
        case 'session.end':
          await this.handleSessionEnd(session, frame.sessionId);
          return;
        case 'interrupt':
          await this.handleInterrupt(session, frame.sessionId, frame.reason);
          return;
        case 'ping':
          await this.emitOutbound(session, frame.sessionId, { type: 'pong' });
          return;
      }
    } catch (error) {
      const runtimeError = this.asRuntimeError(error);
      if (runtimeError.code === 'INTERRUPTED') {
        return;
      }

      await this.safeEmitError(session, frame.sessionId, runtimeError.code, runtimeError.message);
    }
  }

  async stop(): Promise<void> {
    await this.abortPendingStarts(() => true, 'runtime.stop');

    const states = [...this.sessions.values()];
    await Promise.all(states.map(async (state) => {
      await this.cancelInFlight(state, 'runtime.stop');
      this.releaseState(state);
    }));
  }

  async closeConnection(connectionId: string, reason = 'transport.closed'): Promise<void> {
    await this.abortPendingStarts(
      (pending) => pending.transportSession.connectionId === connectionId,
      reason,
    );

    const states = [...this.sessions.values()].filter(
      (state) => state.transportSession.connectionId === connectionId,
    );

    await Promise.all(states.map(async (state) => {
      state.interrupted = true;
      await this.cancelInFlight(state, reason);
      this.releaseState(state);
    }));
  }

  private async handleSessionStart(transportSession: WebSocketVoiceSession, frameSessionId: string): Promise<void> {
    const key = toSessionKey(transportSession, frameSessionId);
    const existing = this.sessions.get(key);
    if (existing) {
      await this.emitOutbound(transportSession, frameSessionId, {
        type: 'ack',
        ackType: 'session.start',
      });
      return;
    }

    const pendingStart = this.startsInFlight.get(key);
    if (pendingStart) {
      await pendingStart.promise;
      await this.emitOutbound(transportSession, frameSessionId, {
        type: 'ack',
        ackType: 'session.start',
      });
      return;
    }

    const abortController = new AbortController();
    const pending: SessionStartInFlight = {
      key,
      transportSession,
      abortController,
      promise: this.startSessionState(key, transportSession, frameSessionId, abortController),
    };
    this.startsInFlight.set(key, pending);

    try {
      await pending.promise;
      await this.emitOutbound(transportSession, frameSessionId, {
        type: 'ack',
        ackType: 'session.start',
      });
    } finally {
      const current = this.startsInFlight.get(key);
      if (current === pending) {
        this.startsInFlight.delete(key);
      }
    }
  }

  private async startSessionState(
    key: string,
    transportSession: WebSocketVoiceSession,
    frameSessionId: string,
    abortController: AbortController,
  ): Promise<RuntimeSessionState> {
    const sttSession = await this.runStage(
      'stt',
      (stageSignal) => this.stt.startStream(this.sttConfig, stageSignal),
      abortController.signal,
    );

    const state: RuntimeSessionState = {
      key,
      transportSession,
      frameSessionId,
      sttSession,
      transcriptPump: Promise.resolve(),
      transcriptPumpError: null,
      finalTranscripts: [],
      droppedFinalTranscriptCount: 0,
      lastPartialTranscript: '',
      abortController,
      ttsSession: null,
      ending: false,
      interrupted: false,
    };

    const existing = this.sessions.get(key);
    if (existing) {
      await Promise.allSettled([sttSession.cancel('session.start.idempotent')]);
      return existing;
    }

    this.sessions.set(key, state);
    state.transcriptPump = this.pumpTranscripts(state);

    return state;
  }

  private async handleAudioChunk(
    transportSession: WebSocketVoiceSession,
    frameSessionId: string,
    audioBase64: string,
  ): Promise<void> {
    const state = this.requireState(transportSession, frameSessionId);
    this.throwIfInterrupted(state);

    const chunk = await this.runStage(
      'ingest',
      async () => this.decodeAudioChunk(audioBase64),
      state.abortController.signal,
    );

    await this.runStage(
      'stt',
      () => state.sttSession.writeAudio(chunk),
      state.abortController.signal,
    );

    await this.emitOutbound(transportSession, frameSessionId, {
      type: 'ack',
      ackType: 'audio.chunk',
    });
  }

  private async handleSessionEnd(transportSession: WebSocketVoiceSession, frameSessionId: string): Promise<void> {
    const state = this.requireState(transportSession, frameSessionId);
    if (state.ending) {
      throw new WebSocketVoiceRuntimeError('SESSION_END_IN_PROGRESS', 'session.end is already processing');
    }
    state.ending = true;

    try {
      this.throwIfInterrupted(state);

      await this.runStage(
        'stt',
        () => state.sttSession.endInput(),
        state.abortController.signal,
      );
      await state.transcriptPump;

      if (state.transcriptPumpError) {
        throw new WebSocketVoiceRuntimeError(
          'STT_TRANSCRIPT_STREAM_FAILED',
          state.transcriptPumpError.message,
        );
      }

      const transcript = this.security.validateTranscriptText(this.collectTranscript(state));
      this.throwIfInterrupted(state);

      const assistantText = this.security.validateTtsInputText(
        await this.runStage(
          'llm',
          (stageSignal) => this.onAssistantTurn({
            transportSession,
            sessionId: frameSessionId,
            transcript,
            signal: stageSignal,
          }),
          state.abortController.signal,
        ),
      );

      this.throwIfInterrupted(state);

      if (assistantText.length > 0) {
        await this.streamPlayback(state, assistantText);
      }

      this.throwIfInterrupted(state);

      await this.emitOutbound(transportSession, frameSessionId, {
        type: 'ack',
        ackType: 'session.end',
      });
    } catch (error) {
      if (state.interrupted && isAbortLikeError(error)) {
        return;
      }

      throw error;
    } finally {
      await this.cancelInFlight(state, state.interrupted ? 'session.interrupted' : 'session.complete');
      this.releaseState(state);
    }
  }

  private async handleInterrupt(
    transportSession: WebSocketVoiceSession,
    frameSessionId: string,
    reason?: string,
  ): Promise<void> {
    const state = this.requireState(transportSession, frameSessionId);
    state.interrupted = true;

    await this.cancelInFlight(state, reason ?? 'interrupt');
    this.releaseState(state);

    await this.emitOutbound(transportSession, frameSessionId, {
      type: 'ack',
      ackType: 'interrupt',
    });
  }

  private requireState(transportSession: WebSocketVoiceSession, frameSessionId: string): RuntimeSessionState {
    const key = toSessionKey(transportSession, frameSessionId);
    const state = this.sessions.get(key);
    if (!state) {
      throw new WebSocketVoiceRuntimeError(
        'SESSION_NOT_FOUND',
        `No active session for ${transportSession.connectionId}/${frameSessionId}`,
      );
    }

    return state;
  }

  private releaseState(state: RuntimeSessionState): void {
    const current = this.sessions.get(state.key);
    if (current === state) {
      this.sessions.delete(state.key);
    }

    if (state.droppedFinalTranscriptCount > 0) {
      log.warn('Voice runtime transcript queue applied overflow policy', {
        connectionId: state.transportSession.connectionId,
        sessionId: state.frameSessionId,
        droppedFinalTranscripts: state.droppedFinalTranscriptCount,
        maxFinalTranscripts: DEFAULT_MAX_FINAL_TRANSCRIPTS,
        overflowPolicy: FINAL_TRANSCRIPT_OVERFLOW_POLICY,
      });
    }
  }

  private async pumpTranscripts(state: RuntimeSessionState): Promise<void> {
    try {
      for await (const chunk of state.sttSession.transcripts) {
        if (state.abortController.signal.aborted) {
          return;
        }

        const text = this.security.validateTranscriptText(chunk.text);
        if (text.length === 0) {
          continue;
        }

        if (chunk.type === 'final') {
          this.pushFinalTranscript(state, text);
        } else {
          state.lastPartialTranscript = text;
        }

        await this.emitOutbound(state.transportSession, state.frameSessionId, {
          type: chunk.type === 'final' ? 'transcript.final' : 'transcript.partial',
          text,
        });
      }
    } catch (error) {
      if (state.abortController.signal.aborted || isAbortLikeError(error)) {
        return;
      }

      state.transcriptPumpError = toError(error);
      log.warn('STT transcript pump failed', {
        sessionId: state.frameSessionId,
        connectionId: state.transportSession.connectionId,
        error: state.transcriptPumpError.message,
      });
    }
  }

  private pushFinalTranscript(state: RuntimeSessionState, text: string): void {
    if (state.finalTranscripts.length < DEFAULT_MAX_FINAL_TRANSCRIPTS) {
      state.finalTranscripts.push(text);
      return;
    }

    state.droppedFinalTranscriptCount += 1;
    state.finalTranscripts.shift();
    state.finalTranscripts.push(text);
  }

  private collectTranscript(state: RuntimeSessionState): string {
    const finalText = state.finalTranscripts.join(' ').trim();
    const partialText = state.lastPartialTranscript.trim();

    if (!finalText) return partialText;
    if (!partialText) return finalText;

    if (finalText.includes(partialText)) return finalText;
    if (partialText.includes(finalText)) return partialText;

    return `${finalText} ${partialText}`.trim();
  }

  private async streamPlayback(state: RuntimeSessionState, assistantText: string): Promise<void> {
    const ttsSession = await this.runStage(
      'tts',
      (stageSignal) => this.tts.synthesizeStream({ ...this.ttsRequest, text: assistantText }, stageSignal),
      state.abortController.signal,
    );
    state.ttsSession = ttsSession;

    let totalBytes = 0;
    let fallbackSeq = 0;
    for await (const chunk of ttsSession.audio) {
      this.throwIfInterrupted(state);

      totalBytes = this.security.validateTtsAudioChunk(chunk.audio, totalBytes);
      const encoded = Buffer.from(chunk.audio).toString('base64');

      await this.runStage(
        'output',
        () => this.emitOutbound(state.transportSession, state.frameSessionId, {
          type: 'playback.chunk',
          seq: Number.isFinite(chunk.sequence) ? chunk.sequence : fallbackSeq,
          audioBase64: encoded,
        }),
        state.abortController.signal,
      );

      fallbackSeq += 1;
    }

    state.ttsSession = null;
  }

  private decodeAudioChunk(audioBase64: string): Uint8Array {
    const trimmed = audioBase64.trim();
    if (trimmed.length === 0) {
      throw new WebSocketVoiceRuntimeError('INVALID_AUDIO_BASE64', 'audioBase64 payload is required');
    }

    const normalized = canonicalBase64(trimmed);
    const decodedBuffer = Buffer.from(trimmed, 'base64');

    if (decodedBuffer.byteLength === 0 || canonicalBase64(decodedBuffer.toString('base64')) !== normalized) {
      throw new WebSocketVoiceRuntimeError('INVALID_AUDIO_BASE64', 'audioBase64 payload is invalid');
    }

    if (decodedBuffer.byteLength > this.maxAudioChunkBytes) {
      throw new WebSocketVoiceRuntimeError(
        'AUDIO_CHUNK_TOO_LARGE',
        `Audio chunk exceeds runtime limit (${decodedBuffer.byteLength} > ${this.maxAudioChunkBytes})`,
      );
    }

    const chunk = new Uint8Array(decodedBuffer);
    try {
      this.security.validatePcmAudio(chunk);
    } catch (error) {
      throw this.asRuntimeError(error);
    }
    return chunk;
  }

  private async cancelInFlight(state: RuntimeSessionState, reason: string): Promise<void> {
    if (!state.abortController.signal.aborted) {
      state.abortController.abort(reason);
    }

    const cancelTasks: Array<Promise<unknown>> = [state.sttSession.cancel(reason)];
    if (state.ttsSession) {
      cancelTasks.push(state.ttsSession.cancel(reason));
    }

    await Promise.allSettled(cancelTasks);
    await state.transcriptPump.catch(() => undefined);
  }

  private async abortPendingStarts(
    matcher: (pending: SessionStartInFlight) => boolean,
    reason: string,
  ): Promise<void> {
    const pendingStarts = [...this.startsInFlight.values()].filter(matcher);
    if (pendingStarts.length === 0) {
      return;
    }

    for (const pending of pendingStarts) {
      if (!pending.abortController.signal.aborted) {
        pending.abortController.abort(reason);
      }
    }

    await Promise.allSettled(pendingStarts.map((pending) => pending.promise));
  }

  private throwIfInterrupted(state: RuntimeSessionState): void {
    if (state.abortController.signal.aborted) {
      throw new WebSocketVoiceRuntimeError('INTERRUPTED', 'Voice session was interrupted');
    }
  }

  private async runStage<T>(
    stage: VoiceRuntimeStage,
    task: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new WebSocketVoiceRuntimeError('INTERRUPTED', 'Voice session was interrupted');
    }

    const stageSignal = signal ?? NEVER_ABORT_SIGNAL;

    if (!this.reliability) {
      return task(stageSignal);
    }

    return this.reliability.runStage(stage, task, stageSignal);
  }

  private async emitOutbound(
    transportSession: WebSocketVoiceSession,
    frameSessionId: string,
    frame: VoiceWireOutboundPayload,
  ): Promise<void> {
    const timestampMs = this.now();
    let outbound: VoiceWireOutboundFrame;
    switch (frame.type) {
      case 'ack':
        outbound = {
          wire: VOICE_WIRE_PROTOCOL,
          sessionId: frameSessionId,
          timestampMs,
          type: 'ack',
          ackType: frame.ackType,
        };
        break;
      case 'transcript.partial':
      case 'transcript.final':
        outbound = {
          wire: VOICE_WIRE_PROTOCOL,
          sessionId: frameSessionId,
          timestampMs,
          type: frame.type,
          text: frame.text,
        };
        break;
      case 'playback.chunk':
        outbound = {
          wire: VOICE_WIRE_PROTOCOL,
          sessionId: frameSessionId,
          timestampMs,
          type: 'playback.chunk',
          seq: frame.seq,
          audioBase64: frame.audioBase64,
        };
        break;
      case 'pong':
        outbound = {
          wire: VOICE_WIRE_PROTOCOL,
          sessionId: frameSessionId,
          timestampMs,
          type: 'pong',
        };
        break;
      case 'error':
        outbound = {
          wire: VOICE_WIRE_PROTOCOL,
          sessionId: frameSessionId,
          timestampMs,
          type: 'error',
          code: frame.code,
          message: frame.message,
        };
        break;
    }

    await Promise.resolve(this.emitFrame(transportSession, outbound));
  }

  private async safeEmitError(
    transportSession: WebSocketVoiceSession,
    frameSessionId: string,
    code: RuntimeErrorCode,
    message: string,
  ): Promise<void> {
    try {
      await this.emitOutbound(transportSession, frameSessionId, {
        type: 'error',
        code,
        message,
      });
    } catch (error) {
      log.warn('Failed to emit voice runtime error frame', {
        sessionId: frameSessionId,
        connectionId: transportSession.connectionId,
        code,
        error: String(error),
      });
    }
  }

  private asRuntimeError(error: unknown): WebSocketVoiceRuntimeError {
    if (error instanceof WebSocketVoiceRuntimeError) {
      return error;
    }

    if (isAbortLikeError(error)) {
      return new WebSocketVoiceRuntimeError('INTERRUPTED', 'Voice session was interrupted');
    }

    const normalized = toError(error);
    if (normalized.name === 'VoiceSecurityError') {
      return new WebSocketVoiceRuntimeError('SECURITY_VIOLATION', normalized.message);
    }

    return new WebSocketVoiceRuntimeError('INTERNAL_RUNTIME_ERROR', normalized.message);
  }
}
