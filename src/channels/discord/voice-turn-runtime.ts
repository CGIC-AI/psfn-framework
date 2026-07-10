import { AudioPlayerStatus, createAudioResource, EndBehaviorType, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import {
  buildFallbackOrder,
  runWithVoiceStageBudget,
  selectFallbackCandidate,
} from '../../primitives/voice/policy/reliability.js';
import {
  validatePcmAudio,
  validateTranscriptText,
  validateTtsAudioChunk,
  validateTtsInputText,
} from '../../primitives/voice/policy/security.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  CAPTURE_SILENCE_MS,
  MIN_PCM_BYTES,
  STT_STREAM_CHUNK_BYTES,
  type ActiveVoiceTurn,
  type VoiceTurnErrorStage,
  type VoiceTurnObservationKind,
  type VoiceTurnRuntimeContext,
} from './voice-types.js';
import {
  classifyVoiceTurnStatus,
  createStructuredVoiceError,
  resolveVoiceErrorCode,
  resolveVoiceErrorStage,
} from './voice-errors.js';

const log = createComponentLogger('DiscordVoice');

export function assertActiveVoiceTurn(runtime: VoiceTurnRuntimeContext, turn: ActiveVoiceTurn): void {
  if (runtime.activeTurn?.token !== turn.token || turn.abortController.signal.aborted) {
    throw new Error('Voice turn aborted');
  }
}

export function resetActiveVoiceTurnState(runtime: VoiceTurnRuntimeContext, turn: ActiveVoiceTurn): void {
  if (runtime.activeTurn?.token !== turn.token) return;
  runtime.activeTurn = null;
  runtime.activeTurnId = null;
  runtime.capturing = false;
}

export async function cancelVoiceTurnResources(turn: ActiveVoiceTurn, reason: string): Promise<void> {
  if (!turn.abortController.signal.aborted) {
    turn.abortController.abort(reason);
  }

  const cancelTasks: Array<Promise<unknown>> = [];
  if (turn.sttSession) {
    const session = turn.sttSession;
    turn.sttSession = null;
    cancelTasks.push(session.cancel(reason).catch(() => undefined));
  }
  if (turn.ttsSession) {
    const session = turn.ttsSession;
    turn.ttsSession = null;
    cancelTasks.push(session.cancel(reason).catch(() => undefined));
  }

  if (cancelTasks.length > 0) {
    await Promise.allSettled(cancelTasks);
  }
}

export async function cancelActiveVoiceTurn(runtime: VoiceTurnRuntimeContext, reason: string): Promise<void> {
  const turn = runtime.activeTurn;
  if (!turn) return;
  await cancelVoiceTurnResources(turn, reason);
  resetActiveVoiceTurnState(runtime, turn);
}

export async function emitVoiceTurnObservation(runtime: VoiceTurnRuntimeContext, params: {
  turnId?: string;
  stage: VoiceTurnErrorStage;
  kind: VoiceTurnObservationKind;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const { turnId, stage, kind, detail } = params;
  const resolvedTurnId = turnId ?? runtime.activeTurnId ?? `voice-observation-${Date.now()}`;
  const payload = {
    turnId: resolvedTurnId,
    channelId: runtime.activeChannel?.id,
    userId: runtime.targetUserId,
    stage,
    kind,
    detail: detail ?? {},
    timestampMs: Date.now(),
  };

  log.warn('Voice turn observation', payload);
  await runtime.eventBus.emit('voice.turn.observation', payload);
}

export async function handleVoiceUtterance(
  runtime: VoiceTurnRuntimeContext & {
    recordStreamError(userId: string): void;
    decodeOpusToPcm(opusStream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer>;
    transcribePcm(pcm: Buffer, turn: ActiveVoiceTurn): Promise<string>;
    speakText(text: string, turn?: ActiveVoiceTurn): Promise<void>;
    emitTurnObservation(params: {
      turnId?: string;
      stage: VoiceTurnErrorStage;
      kind: VoiceTurnObservationKind;
      detail?: Record<string, unknown>;
    }): Promise<void>;
    cancelTurnResources(turn: ActiveVoiceTurn, reason: string): Promise<void>;
  },
): Promise<void> {
  if (runtime.activeTurn) return;
  if (!runtime.connection || !runtime.player || !runtime.activeChannel || !runtime.sttConnector || runtime.ttsConnectors.length === 0) {
    return;
  }

  const turnId = `voice-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestampMs = Date.now();
  const turn: ActiveVoiceTurn = {
    token: Symbol(turnId),
    turnId,
    channel: runtime.activeChannel,
    connection: runtime.connection,
    player: runtime.player,
    abortController: new AbortController(),
    sttSession: null,
    ttsSession: null,
  };
  runtime.activeTurn = turn;
  runtime.activeTurnId = turnId;
  runtime.capturing = true;
  let turnStatus: 'completed' | 'cancelled' | 'timeout' | 'error' = 'completed';
  let turnReason: string | undefined;

  try {
    assertActiveVoiceTurn(runtime, turn);
    await runtime.eventBus.emit('voice.turn.start', {
      turnId,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      timestampMs,
    });

    let opusStream: NodeJS.ReadableStream;
    try {
      opusStream = turn.connection.receiver.subscribe(runtime.targetUserId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: CAPTURE_SILENCE_MS },
      });
    } catch (subscribeError) {
      throw createStructuredVoiceError({
        error: subscribeError,
        stage: 'ingest',
        code: 'VOICE_SUBSCRIBE_FAILED',
      });
    }

    const safetyErrorHandler = (err: Error): void => {
      log.warn('AudioReceiveStream error caught by safety listener', {
        error: toErrorMessage(err),
        userId: runtime.targetUserId,
      });
      runtime.recordStreamError(runtime.targetUserId);
    };
    opusStream.on('error', safetyErrorHandler);

    const pcm = await runWithVoiceStageBudget({
      stage: 'ingest',
      budgets: runtime.reliabilityBudgets,
      signal: turn.abortController.signal,
      task: () => runtime.decodeOpusToPcm(opusStream, turn.abortController.signal),
    });
    assertActiveVoiceTurn(runtime, turn);
    if (pcm.length < MIN_PCM_BYTES) {
      turnReason = 'silence';
      await runtime.emitTurnObservation({
        turnId,
        stage: 'ingest',
        kind: 'silence',
        detail: { pcmBytes: pcm.length, minimumPcmBytes: MIN_PCM_BYTES },
      });
      return;
    }

    validatePcmAudio(pcm, runtime.securityLimits);

    const rawTranscript = await runWithVoiceStageBudget({
      stage: 'stt',
      budgets: runtime.reliabilityBudgets,
      signal: turn.abortController.signal,
      task: () => runtime.transcribePcm(pcm, turn),
    });
    assertActiveVoiceTurn(runtime, turn);

    const transcript = validateTranscriptText(rawTranscript, runtime.securityLimits);
    if (!transcript) {
      turnReason = 'empty-transcript';
      await runtime.emitTurnObservation({
        turnId,
        stage: 'stt',
        kind: 'empty-transcript',
        detail: { rawTranscriptLength: rawTranscript.trim().length },
      });
      return;
    }

    await runtime.eventBus.emit('channel.voice.transcript', {
      guildId: turn.channel.guild.id,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      transcript,
    });
    await runtime.eventBus.emit('voice.stt.final', {
      turnId,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      text: transcript,
      timestampMs: Date.now(),
    });
    assertActiveVoiceTurn(runtime, turn);

    const handler = runtime.getHandler();
    if (!handler) return;

    // htm9.9: a transcript becomes prompt text, so audio is a real injection
    // channel — screen it through the intake firewall (sourceClass
    // 'audio_transcript'). Shadow mode records the envelope without altering
    // the transcript; enforce-mode quarantine substitutes the fixed
    // withheld-content placeholder.
    let effectiveTranscript = transcript;
    let intakeEnvelopes: IntakeEnvelopeSnapshot[] | null = null;
    if (runtime.intakeScreening) {
      const screened = await runtime.intakeScreening.screen(transcript, {
        sourceClass: 'audio_transcript',
        origin: {
          ref: `discord-voice:${turn.channel.id}:${turnId}`.slice(0, 2048),
          detail: `speaker:${runtime.targetUserId}`.slice(0, 512),
        },
        scope: 'context',
      });
      effectiveTranscript = screened.effectiveText;
      intakeEnvelopes = [screened.snapshot];
    }
    assertActiveVoiceTurn(runtime, turn);

    const member = turn.channel.members.get(runtime.targetUserId);
    const message: SubstrateMessage = {
      id: `voice-${Date.now()}`,
      channelId: `discord-voice:${turn.channel.id}`,
      channelType: 'discord',
      isDirectMessage: false,
      authorId: runtime.targetUserId,
      authorName: member?.displayName ?? member?.user.username ?? 'Voice User',
      content: effectiveTranscript,
      timestamp: new Date(),
      ...(intakeEnvelopes ? { routing: { intakeEnvelopes } } : {}),
    };

    await runtime.eventBus.emit('message.received', { message });
    const response = await runWithVoiceStageBudget({
      stage: 'llm',
      budgets: runtime.reliabilityBudgets,
      signal: turn.abortController.signal,
      task: () => handler(message),
    });
    assertActiveVoiceTurn(runtime, turn);
    await runtime.eventBus.emit('message.sent', { response });

    const text = response.content.trim();
    if (!text) {
      turnReason = 'empty-response';
      await runtime.emitTurnObservation({
        turnId,
        stage: 'llm',
        kind: 'empty-response',
        detail: { responseLength: response.content.length },
      });
      log.warn('Voice response was empty; skipping TTS playback');
      return;
    }

    await runtime.eventBus.emit('voice.tts.requested', {
      turnId,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      text,
      timestampMs: Date.now(),
    });

    await runtime.speakText(text, turn);
    assertActiveVoiceTurn(runtime, turn);
    await runtime.eventBus.emit('channel.voice.tts.sent', {
      guildId: turn.channel.guild.id,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      text,
    });
  } catch (error) {
    const structuredError = createStructuredVoiceError({
      error,
      stage: resolveVoiceErrorStage(error),
      code: resolveVoiceErrorCode(error),
    });
    turnStatus = classifyVoiceTurnStatus(structuredError);
    turnReason = structuredError.message;
    await runtime.cancelTurnResources(turn, `turn-error:${structuredError.voiceCode ?? 'unknown'}`);
    await runtime.eventBus.emit('voice.turn.error', {
      turnId,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      stage: structuredError.voiceStage,
      code: structuredError.voiceCode,
      error: structuredError.message,
      timestampMs: Date.now(),
    });
    structuredError.voiceTurnErrorEmitted = true;
    throw structuredError;
  } finally {
    await runtime.eventBus.emit('voice.turn.end', {
      turnId,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      status: turnStatus,
      reason: turnReason,
      timestampMs: Date.now(),
    });
    await runtime.cancelTurnResources(turn, `turn-${turnStatus}`);
    resetActiveVoiceTurnState(runtime, turn);
  }
}

export async function transcribeVoicePcm(
  runtime: VoiceTurnRuntimeContext,
  pcm: Buffer,
  turn: ActiveVoiceTurn,
): Promise<string> {
  if (!runtime.sttConnector) return '';

  const session = await runtime.sttConnector.startStream({
    sampleRateHz: 48_000,
    channels: 2,
    encoding: 'pcm_s16le',
    model: runtime.config.deepgramModel,
    interimResults: true,
  }, turn.abortController.signal);
  turn.sttSession = session;

  let finalTranscript = '';
  let latestPartial = '';
  let streamError: unknown;
  const writerPromise = writePcmToSttSession(session, pcm, turn.abortController.signal);

  try {
    for await (const chunk of session.transcripts) {
      assertActiveVoiceTurn(runtime, turn);
      const transcriptText = chunk.text.trim();
      if (!transcriptText) continue;

      if (chunk.type === 'partial') {
        latestPartial = transcriptText;
        await runtime.eventBus.emit('channel.voice.transcript.partial', {
          guildId: turn.channel.guild.id,
          channelId: turn.channel.id,
          userId: runtime.targetUserId,
          transcript: transcriptText,
          confidence: chunk.confidence,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
        });
        await runtime.eventBus.emit('voice.stt.partial', {
          turnId: turn.turnId,
          channelId: turn.channel.id,
          userId: runtime.targetUserId,
          text: transcriptText,
          timestampMs: Date.now(),
        });
        continue;
      }

      if (transcriptText.length >= finalTranscript.length) {
        finalTranscript = transcriptText;
      }
    }
  } catch (error) {
    streamError = error;
    await session.cancel('stt-stream-error').catch(() => undefined);
  }

  try {
    await writerPromise;
  } catch (error) {
    if (!streamError) streamError = error;
  } finally {
    if (turn.sttSession === session) {
      turn.sttSession = null;
    }
  }

  if (streamError) {
    throw createStructuredVoiceError({
      error: streamError,
      stage: 'stt',
      code: 'VOICE_STT_STREAM_FAILED',
    });
  }

  return finalTranscript || latestPartial;
}

export async function writePcmToSttSession(
  session: { writeAudio(chunk: Uint8Array): Promise<void>; endInput(): Promise<void> },
  pcm: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < pcm.length; offset += STT_STREAM_CHUNK_BYTES) {
    if (signal?.aborted) {
      throw new Error('STT session aborted');
    }

    const nextChunk = pcm.subarray(offset, Math.min(offset + STT_STREAM_CHUNK_BYTES, pcm.length));
    await session.writeAudio(nextChunk);
  }

  if (signal?.aborted) {
    throw new Error('STT session aborted');
  }

  await session.endInput();
}

export async function speakVoiceText(
  runtime: VoiceTurnRuntimeContext & {
    playWithTtsConnector(connector: NonNullable<VoiceTurnRuntimeContext['ttsConnectors'][number]>, text: string, turn?: ActiveVoiceTurn): Promise<void>;
  },
  text: string,
  turn?: ActiveVoiceTurn,
): Promise<void> {
  const player = turn?.player ?? runtime.player;
  if (!player) return;
  if (turn) {
    assertActiveVoiceTurn(runtime, turn);
  }

  const safeText = validateTtsInputText(text, runtime.securityLimits);
  if (!safeText) return;

  const connectorOrder = buildFallbackOrder(
    runtime.preferredTtsProviderId,
    runtime.ttsConnectors.map((connector) => connector.id),
  );
  const firstConnectorId = connectorOrder[0] ?? runtime.preferredTtsProviderId;
  const selected = selectFallbackCandidate(
    firstConnectorId,
    runtime.ttsConnectors.map((connector) => ({ id: connector.id, value: connector })),
  );

  if (!selected) {
    throw new Error('No TTS connector available');
  }

  await runWithVoiceStageBudget({
    stage: 'tts',
    budgets: runtime.reliabilityBudgets,
    signal: turn?.abortController.signal,
    task: async () => {
      await runtime.playWithTtsConnector(selected.value, safeText, turn);
    },
  });
}

export async function playWithTtsConnector(
  runtime: VoiceTurnRuntimeContext & {
    playTtsSession(session: { audio: AsyncIterable<{ audio: Uint8Array }>; cancel(reason: string): Promise<void> }, turn?: ActiveVoiceTurn): Promise<void>;
    playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void>;
  },
  connector: NonNullable<VoiceTurnRuntimeContext['ttsConnectors'][number]>,
  text: string,
  turn?: ActiveVoiceTurn,
): Promise<void> {
  try {
    if (turn) {
      assertActiveVoiceTurn(runtime, turn);
    }
    const streamSession = await connector.synthesizeStream({
      text,
      encoding: 'mp3',
      allowBufferFallback: false,
    }, turn?.abortController.signal);
    if (turn) {
      turn.ttsSession = streamSession;
    }
    await runtime.playTtsSession(streamSession, turn);
  } catch (error) {
    if (turn?.abortController.signal.aborted || classifyVoiceTurnStatus(error) === 'cancelled') {
      throw error;
    }

    log.warn('Streaming TTS failed, using buffered fallback', {
      provider: connector.id,
      error: toErrorMessage(error),
    });

    try {
      if (turn) {
        assertActiveVoiceTurn(runtime, turn);
      }
      const audio = await connector.synthesizeBuffer({ text, encoding: 'mp3' }, turn?.abortController.signal);
      validateTtsAudioChunk(audio, 0, runtime.securityLimits);
      if (turn?.turnId) {
        await runtime.eventBus.emit('voice.tts.first-byte', {
          turnId: turn.turnId,
          channelId: turn.channel.id,
          userId: runtime.targetUserId,
          timestampMs: Date.now(),
        });
      }
      await runtime.playReadableAudio(Readable.from(audio), turn);
    } catch (fallbackError) {
      throw createStructuredVoiceError({
        error: fallbackError,
        stage: 'tts',
        code: 'VOICE_TTS_FALLBACK_FAILED',
      });
    }
  }
}

export async function playTtsSession(
  runtime: VoiceTurnRuntimeContext & {
    playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void>;
  },
  session: { audio: AsyncIterable<{ audio: Uint8Array }>; cancel(reason: string): Promise<void> },
  turn?: ActiveVoiceTurn,
): Promise<void> {
  try {
    await runtime.playReadableAudio(Readable.from(createPlaybackChunkIterator(runtime, session.audio, turn)), turn);
  } finally {
    const reason = turn?.abortController.signal.aborted ? 'playback-aborted' : 'playback-finished';
    await session.cancel(reason).catch(() => undefined);
    if (turn && turn.ttsSession === session) {
      turn.ttsSession = null;
    }
  }
}

export async function* createPlaybackChunkIterator(
  runtime: VoiceTurnRuntimeContext,
  audio: AsyncIterable<{ audio: Uint8Array }>,
  turn?: ActiveVoiceTurn,
): AsyncGenerator<Buffer> {
  let totalAudioBytes = 0;
  let emittedFirstByte = false;

  for await (const chunk of audio) {
    if (turn) {
      assertActiveVoiceTurn(runtime, turn);
    }
    totalAudioBytes = validateTtsAudioChunk(chunk.audio, totalAudioBytes, runtime.securityLimits);
    if (chunk.audio.byteLength === 0) continue;

    if (!emittedFirstByte && turn?.turnId) {
      emittedFirstByte = true;
      await runtime.eventBus.emit('voice.tts.first-byte', {
        turnId: turn.turnId,
        channelId: turn.channel.id,
        userId: runtime.targetUserId,
        timestampMs: Date.now(),
      });
    }

    yield Buffer.isBuffer(chunk.audio) ? chunk.audio : Buffer.from(chunk.audio);
  }
}

export async function playReadableAudio(
  runtime: VoiceTurnRuntimeContext,
  audio: Readable,
  turn?: ActiveVoiceTurn,
): Promise<void> {
  const player = turn?.player ?? runtime.player;
  if (!player) return;
  if (turn) {
    assertActiveVoiceTurn(runtime, turn);
  }

  player.play(createAudioResource(audio));

  try {
    await runWithVoiceStageBudget({
      stage: 'output',
      budgets: runtime.reliabilityBudgets,
      signal: turn?.abortController.signal,
      task: async () => {
        await entersState(player, AudioPlayerStatus.Playing, 5_000);
        await entersState(player, AudioPlayerStatus.Idle, 120_000);
      },
    });
  } catch (error) {
    if (classifyVoiceTurnStatus(error) === 'cancelled') {
      throw error;
    }

    const playbackError = createStructuredVoiceError({
      error,
      stage: 'tts',
      code: 'VOICE_PLAYBACK_FAILED',
    });
    await runtime.emitTurnObservation({
      turnId: turn?.turnId ?? runtime.activeTurnId ?? undefined,
      stage: 'tts',
      kind: 'playback-error',
      detail: { error: playbackError.message },
    });
    throw playbackError;
  }
}

export async function decodeOpusStreamToPcm(
  runtime: VoiceTurnRuntimeContext & { recordStreamError(userId: string): void },
  opusStream: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let decoder: InstanceType<typeof prism.opus.Decoder>;

    try {
      decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    } catch (error) {
      log.error('Failed to create Opus decoder. Install @discordjs/opus or opusscript.', {
        error: toErrorMessage(error),
      });
      reject(createStructuredVoiceError({
        error: new Error(`Opus decoder unavailable: ${toErrorMessage(error)}`),
        stage: 'ingest',
        code: 'VOICE_OPUS_UNAVAILABLE',
      }));
      return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      decoder.off('data', onData);
      decoder.off('end', onEnd);
      decoder.off('error', onDecoderError);
      opusStream.off('error', onOpusError);
      signal?.removeEventListener('abort', onAbort);
      try {
        decoder.destroy();
      } catch {
        // Ignore cleanup errors.
      }
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      total += chunk.length;
    };
    const onEnd = (): void => succeed();
    const onDecoderError = (error: Error): void => {
      log.warn('Opus decoder error (contained)', { error: toErrorMessage(error) });
      fail(createStructuredVoiceError({
        error,
        stage: 'ingest',
        code: 'VOICE_OPUS_DECODE_FAILED',
      }));
    };
    const onOpusError = (error: Error): void => {
      log.warn('AudioReceiveStream error (contained)', { error: toErrorMessage(error) });
      runtime.recordStreamError(runtime.targetUserId);
      fail(createStructuredVoiceError({
        error,
        stage: 'ingest',
        code: 'VOICE_RECEIVE_STREAM_ERROR',
      }));
    };
    const onAbort = (): void => {
      fail(new Error('Voice capture aborted'));
    };

    if (signal?.aborted) {
      fail(new Error('Voice capture aborted'));
      return;
    }

    decoder.on('data', onData);
    decoder.once('end', onEnd);
    decoder.once('error', onDecoderError);
    opusStream.once('error', onOpusError);
    signal?.addEventListener('abort', onAbort, { once: true });
    opusStream.pipe(decoder);
  });
}
