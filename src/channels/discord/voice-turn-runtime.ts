import {
  AudioPlayerStatus,
  createAudioResource,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { PassThrough, Readable } from 'node:stream';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import {
  buildFallbackOrder,
  runWithVoiceStageBudget,
  selectFallbackCandidate,
} from '../../primitives/voice/policy/reliability.js';
import {
  validatePcmAudioChunk,
  validateTranscriptText,
  validateTtsAudioChunk,
  validateTtsInputText,
} from '../../primitives/voice/policy/security.js';
import { classifyVoiceControlIntent } from '../../primitives/voice/control-intent.js';
import type { SttStreamSession } from '../../primitives/voice/connectors/stt/index.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  emitTurnPerformance,
  type TurnPerformanceEventInput,
  type TurnPerformanceStage,
} from '../../shared/telemetry/turn-performance.js';
import {
  CAPTURE_SILENCE_MS,
  MIN_PCM_BYTES,
  type ActiveVoiceTurn,
  type VoiceStreamTranscription,
  type VoiceTurnErrorStage,
  type VoiceTurnObservationKind,
  type VoiceTurnRuntimeContext,
  type VoiceTurnStateContext,
} from './voice-types.js';
import {
  classifyVoiceTurnStatus,
  createStructuredVoiceError,
  resolveVoiceErrorCode,
  resolveVoiceErrorStage,
} from './voice-errors.js';

const log = createComponentLogger('DiscordVoice');

function emitVoicePerformance(
  runtime: VoiceTurnStateContext,
  turn: ActiveVoiceTurn,
  stage: TurnPerformanceStage,
  details: Omit<TurnPerformanceEventInput, 'traceId' | 'stage' | 'turnId' | 'requestId' | 'channelId' | 'channelType'> = {},
): void {
  void emitTurnPerformance(runtime.eventBus, {
    traceId: turn.turnId,
    turnId: turn.turnId,
    requestId: turn.turnId,
    channelId: turn.channel.id,
    channelType: 'discord-voice',
    ...(runtime.config.companionId ? { companionId: runtime.config.companionId } : {}),
    stage,
    ...details,
  }).catch(error => {
    log.debug('Voice performance telemetry emit failed', {
      turnId: turn.turnId,
      stage,
      error: toErrorMessage(error),
    });
  });
}

export function assertActiveVoiceTurn(runtime: VoiceTurnRuntimeContext, turn: ActiveVoiceTurn): void {
  if (runtime.activeTurn?.token !== turn.token || turn.abortController.signal.aborted) {
    throw new Error('Voice turn aborted');
  }
}

export function resetActiveVoiceTurnState(runtime: VoiceTurnStateContext, turn: ActiveVoiceTurn): void {
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
    cancelTasks.push(session.cancel(reason));
  }
  if (turn.ttsSession) {
    const session = turn.ttsSession;
    turn.ttsSession = null;
    cancelTasks.push(session.cancel(reason));
  }

  if (cancelTasks.length > 0) {
    const results = await Promise.allSettled(cancelTasks);
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Voice cancellation failed for ${failures.length} connector(s)`);
    }
  }
}

export async function cancelActiveVoiceTurn(runtime: VoiceTurnStateContext, reason: string): Promise<void> {
  const turn = runtime.activeTurn;
  if (!turn) return;
  try {
    await cancelVoiceTurnResources(turn, reason);
    emitVoicePerformance(runtime, turn, 'cancellation_ack', {
      cancellationOutcome: 'acknowledged',
    });
  } catch (error) {
    emitVoicePerformance(runtime, turn, 'cancellation_ack', {
      cancellationOutcome: 'failed',
    });
    log.error('Voice turn cancellation failed', {
      turnId: turn.turnId,
      reason,
      error: toErrorMessage(error),
    });
    throw error;
  } finally {
    resetActiveVoiceTurnState(runtime, turn);
  }
}

function hasReadySubscribedPlayback(connection: VoiceConnection, player: AudioPlayer): boolean {
  const state = connection.state;
  return state.status === VoiceConnectionStatus.Ready
    && 'subscription' in state
    && state.subscription?.player === player;
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
  runtime: VoiceTurnRuntimeContext,
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

    // mmo9.6.3: stream decoded PCM to STT AS IT ARRIVES during speech rather
    // than buffering the whole utterance until AfterSilence fires. The intake
    // firewall is positional and unchanged: partials emit only as telemetry
    // inside transcribeOpusStream, and the FINAL assembled transcript below is
    // still the sole input to validateTranscriptText + intake screening.
    const { transcript: rawTranscript, pcmBytes } = await runWithVoiceStageBudget({
      stage: 'stt',
      budgets: runtime.reliabilityBudgets,
      signal: turn.abortController.signal,
      task: () => runtime.transcribeOpusStream(opusStream, turn),
    });
    assertActiveVoiceTurn(runtime, turn);
    emitVoicePerformance(runtime, turn, 'speech_end');

    // MIN_PCM_BYTES silence gate, applied on the total decoded PCM. With lazy
    // STT start the session is only opened once this threshold is crossed, so a
    // sub-threshold capture never reaches STT and never reaches the handler.
    if (pcmBytes < MIN_PCM_BYTES) {
      turnReason = 'silence';
      await runtime.emitTurnObservation({
        turnId,
        stage: 'ingest',
        kind: 'silence',
        detail: { pcmBytes, minimumPcmBytes: MIN_PCM_BYTES },
      });
      return;
    }

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
    emitVoicePerformance(runtime, turn, 'stt_final');
    assertActiveVoiceTurn(runtime, turn);

    // mmo9.7.5: deterministic transport-control guard. If the finalized
    // transcript is exactly a stop/interrupt/repeat command, handle it locally
    // with ZERO model invocations — it must never reach the message handler.
    // Detection is exact/local (no classifier, no model call). `repeat` replays
    // the last spoken utterance; `stop`/`interrupt` produce no reply (the turn
    // `finally` cancels the in-flight resources).
    const controlIntent = classifyVoiceControlIntent(transcript);
    if (controlIntent) {
      turnReason = `control:${controlIntent}`;
      log.debug('Voice transport control handled locally', {
        turnId,
        userId: runtime.targetUserId,
        intent: controlIntent,
      });
      if (controlIntent === 'repeat') {
        const lastText = runtime.lastAssistantUtterance?.trim();
        if (lastText) {
          await runtime.speakText(lastText, turn);
          assertActiveVoiceTurn(runtime, turn);
        }
      }
      return;
    }

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
    // mmo9.6.1: the per-turn AbortController is the barge-in/timeout signal;
    // give the turn a transport-agnostic cancellation identity (the turnId) and
    // thread both into the handler so aborting the controller cancels the
    // in-flight model turn — not just the local stage-budget wrapper.
    const cancellationId = turnId;
    const message: SubstrateMessage = {
      id: turnId,
      channelId: `discord-voice:${turn.channel.id}`,
      channelType: 'discord',
      isDirectMessage: false,
      authorId: runtime.targetUserId,
      authorName: member?.displayName ?? member?.user.username ?? 'Voice User',
      content: effectiveTranscript,
      timestamp: new Date(),
      routing: {
        ...(intakeEnvelopes ? { intakeEnvelopes } : {}),
        cancellationId,
      },
    };

    await runtime.eventBus.emit('message.received', { message });
    const response = await runWithVoiceStageBudget({
      stage: 'llm',
      budgets: runtime.reliabilityBudgets,
      signal: turn.abortController.signal,
      task: () => handler(message, {
        signal: turn.abortController.signal,
        cancellationId,
      }),
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
    emitVoicePerformance(runtime, turn, 'tts_request');

    await runtime.speakText(text, turn);
    assertActiveVoiceTurn(runtime, turn);
    // mmo9.7.5: remember the spoken reply so a later "repeat" control can replay
    // it locally without a model turn.
    runtime.lastAssistantUtterance = text;
    await runtime.eventBus.emit('channel.voice.tts.sent', {
      guildId: turn.channel.guild.id,
      channelId: turn.channel.id,
      userId: runtime.targetUserId,
      text,
    });
    emitVoicePerformance(runtime, turn, 'turn_complete');
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

/**
 * Stream a captured opus utterance through STT while the speaker is still
 * talking. Decoded PCM frames are piped to the connector session AS THEY
 * ARRIVE (`writeAudio` per frame), and `endInput` fires when decode ends —
 * rather than buffering the whole utterance until AfterSilence and only then
 * feeding STT.
 *
 * COGSEC INVARIANT (positional intake firewall, unchanged): interim/partial
 * transcripts emit ONLY as `voice.stt.partial` / `channel.voice.transcript.partial`
 * telemetry here and NEVER become handler/message input. The single FINAL
 * assembled transcript is returned to the caller, which remains the sole input
 * to `validateTranscriptText` and `intakeScreening.screen(...)`.
 *
 * The MIN_PCM_BYTES silence gate is preserved exactly via lazy session start:
 * decoded PCM is buffered until the threshold is crossed; only then is the STT
 * session opened, the buffered lead-in flushed, and every later frame streamed
 * live. A sub-threshold capture never opens a session (no STT, nothing reaches
 * the handler). The security byte-cap is enforced incrementally on the running
 * total via `validatePcmAudioChunk`, failing closed the instant it is exceeded.
 */
export async function transcribeOpusStream(
  runtime: VoiceTurnRuntimeContext,
  opusStream: NodeJS.ReadableStream,
  turn: ActiveVoiceTurn,
): Promise<VoiceStreamTranscription> {
  const connector = runtime.sttConnector;
  if (!connector) return { transcript: '', pcmBytes: 0 };

  const signal = turn.abortController.signal;
  const pcmStream = runtime.decodeOpusToPcmStream(opusStream, signal);

  let pcmBytes = 0;
  // Holder (not a bare `let`) so the session assigned inside the async pump
  // closure below is visible to the outer cleanup — a bare `let` is
  // control-flow-narrowed to `null` at the outer `finally`.
  const sessionRef: { current: SttStreamSession | null } = { current: null };

  const preBuffer: Buffer[] = [];
  let preBufferBytes = 0;

  let settleSession!: (value: SttStreamSession | null) => void;
  const sessionReady = new Promise<SttStreamSession | null>((resolve) => {
    settleSession = resolve;
  });
  let sessionSettled = false;
  const resolveSessionReady = (value: SttStreamSession | null): void => {
    if (sessionSettled) return;
    sessionSettled = true;
    settleSession(value);
  };

  const throwIfAborted = (): void => {
    if (signal.aborted) {
      throw new Error('STT session aborted');
    }
  };

  // Incremental pump: decode -> writeAudio per frame AS THEY ARRIVE -> endInput
  // on decode end. Runs concurrently with the transcript consumer below.
  const pumpPromise = (async (): Promise<number> => {
    try {
      for await (const frame of pcmStream as AsyncIterable<Buffer | Uint8Array | string>) {
        throwIfAborted();
        const chunk = Buffer.isBuffer(frame) ? frame : Buffer.from(frame as Uint8Array);
        // Fail-closed byte cap bounding the TOTAL streamed PCM.
        pcmBytes = validatePcmAudioChunk(chunk, pcmBytes, runtime.securityLimits);
        if (chunk.byteLength === 0) continue;

        if (sessionRef.current) {
          await sessionRef.current.writeAudio(chunk);
          continue;
        }

        preBuffer.push(chunk);
        preBufferBytes += chunk.byteLength;
        if (preBufferBytes < MIN_PCM_BYTES) continue;

        const started = await connector.startStream({
          sampleRateHz: 48_000,
          channels: 2,
          encoding: 'pcm_s16le',
          model: runtime.config.deepgramModel,
          interimResults: true,
        }, signal);
        sessionRef.current = started;
        turn.sttSession = started;
        resolveSessionReady(started);
        for (const buffered of preBuffer) {
          throwIfAborted();
          await started.writeAudio(buffered);
        }
        preBuffer.length = 0;
      }

      throwIfAborted();
      if (sessionRef.current) {
        await sessionRef.current.endInput();
      }
      return pcmBytes;
    } catch (error) {
      // Unblock the transcript consumer so it cannot hang awaiting a final that
      // will never arrive, then propagate. No swallowed errors.
      if (sessionRef.current) {
        await sessionRef.current.cancel('stt-ingest-error').catch(() => undefined);
      }
      throw error;
    } finally {
      resolveSessionReady(sessionRef.current);
    }
  })();

  let finalTranscript = '';
  let latestPartial = '';
  let streamError: unknown;

  const activeSession = await sessionReady;
  if (activeSession) {
    try {
      for await (const chunk of activeSession.transcripts) {
        assertActiveVoiceTurn(runtime, turn);
        const transcriptText = chunk.text.trim();
        if (!transcriptText) continue;

        if (chunk.type === 'partial') {
          latestPartial = transcriptText;
          // Partials are telemetry ONLY — never handler/message.received input.
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
      await activeSession.cancel('stt-stream-error').catch(() => undefined);
    }
  }

  try {
    await pumpPromise;
  } catch (error) {
    if (!streamError) streamError = error;
  } finally {
    if (sessionRef.current && turn.sttSession === sessionRef.current) {
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

  return { transcript: finalTranscript || latestPartial, pcmBytes };
}

type TtsStreamSession = { audio: AsyncIterable<{ audio: Uint8Array }>; cancel(reason: string): Promise<void> };

/**
 * A streaming TTS session whose first audible chunk has already been read under
 * the short `tts_first_byte` budget. Playback resumes from `firstChunk` and
 * continues draining `iterator`, all under the long, non-retryable `output`
 * budget so playback duration can never trip a first-byte retry (double-speak).
 */
interface AcquiredTtsAudio {
  session: TtsStreamSession;
  iterator: AsyncIterator<{ audio: Uint8Array }>;
  firstChunk: { audio: Uint8Array } | null;
  totalAudioBytes: number;
}

export async function speakVoiceText(
  runtime: VoiceTurnRuntimeContext,
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

  // No stage wraps the whole synth+playback: request-to-first-byte is budgeted
  // under `tts_first_byte` (inside playWithTtsConnector) and playback under
  // `output`. A long reply's playback therefore never trips a synth retry.
  await runtime.playWithTtsConnector(selected.value, safeText, turn);
}

/**
 * Read the streaming session up to and including its first audible chunk under
 * the short, retry-safe `tts_first_byte` budget. On a first-byte retry the prior
 * attempt's session is cancelled BEFORE re-synthesizing, so a stalled first byte
 * can never leave two live TTS streams playing at once (double-speak).
 */
export async function acquireTtsFirstByte(
  runtime: VoiceTurnRuntimeContext,
  connector: NonNullable<VoiceTurnRuntimeContext['ttsConnectors'][number]>,
  text: string,
  turn?: ActiveVoiceTurn,
): Promise<AcquiredTtsAudio> {
  let attempt = 0;

  return await runWithVoiceStageBudget({
    stage: 'tts_first_byte',
    budgets: runtime.reliabilityBudgets,
    signal: turn?.abortController.signal,
    task: async (signal) => {
      attempt += 1;

      // Retry: the previous attempt may have opened a session before stalling.
      // Cancel it before re-synth so we never run two overlapping streams.
      if (attempt > 1 && turn?.ttsSession) {
        const prior = turn.ttsSession;
        turn.ttsSession = null;
        await prior.cancel('tts-first-byte-retry').catch(() => undefined);
      }

      if (turn) {
        assertActiveVoiceTurn(runtime, turn);
      }

      const session = await connector.synthesizeStream({
        text,
        encoding: 'mp3',
        allowBufferFallback: false,
      }, signal);
      if (turn) {
        turn.ttsSession = session;
      }

      const iterator = session.audio[Symbol.asyncIterator]();
      let totalAudioBytes = 0;

      for (;;) {
        if (turn) {
          assertActiveVoiceTurn(runtime, turn);
        }

        const next = await iterator.next();
        if (next.done) {
          return { session, iterator, firstChunk: null, totalAudioBytes };
        }

        totalAudioBytes = validateTtsAudioChunk(next.value.audio, totalAudioBytes, runtime.securityLimits);
        if (next.value.audio.byteLength === 0) continue;

        if (turn?.turnId) {
          await runtime.eventBus.emit('voice.tts.first-byte', {
            turnId: turn.turnId,
            channelId: turn.channel.id,
            userId: runtime.targetUserId,
            timestampMs: Date.now(),
          });
          emitVoicePerformance(runtime, turn, 'tts_first_byte');
        }

        return { session, iterator, firstChunk: next.value, totalAudioBytes };
      }
    },
  });
}

export async function playWithTtsConnector(
  runtime: VoiceTurnRuntimeContext,
  connector: NonNullable<VoiceTurnRuntimeContext['ttsConnectors'][number]>,
  text: string,
  turn?: ActiveVoiceTurn,
): Promise<void> {
  try {
    if (turn) {
      assertActiveVoiceTurn(runtime, turn);
    }
    const acquired = await acquireTtsFirstByte(runtime, connector, text, turn);
    await playAcquiredTtsAudio(runtime, acquired, turn);
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
      const audio = await runWithVoiceStageBudget({
        stage: 'tts_first_byte',
        budgets: runtime.reliabilityBudgets,
        signal: turn?.abortController.signal,
        task: async (signal) => connector.synthesizeBuffer({ text, encoding: 'mp3' }, signal),
      });
      validateTtsAudioChunk(audio, 0, runtime.securityLimits);
      if (turn?.turnId) {
        await runtime.eventBus.emit('voice.tts.first-byte', {
          turnId: turn.turnId,
          channelId: turn.channel.id,
          userId: runtime.targetUserId,
          timestampMs: Date.now(),
        });
        emitVoicePerformance(runtime, turn, 'tts_first_byte');
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

/**
 * Play an acquired streaming session under the long, non-retryable `output`
 * budget (inside playReadableAudio). The first audible chunk was already read
 * during first-byte acquisition; playback resumes from it.
 */
export async function playAcquiredTtsAudio(
  runtime: VoiceTurnRuntimeContext,
  acquired: AcquiredTtsAudio,
  turn?: ActiveVoiceTurn,
): Promise<void> {
  const { session } = acquired;
  try {
    // Empty synthesis (no audible bytes) has nothing to play; do not spin up a
    // player on silence.
    if (!acquired.firstChunk) {
      return;
    }
    await runtime.playReadableAudio(
      Readable.from(resumeTtsPlayback(runtime, acquired, turn)),
      turn,
    );
  } finally {
    const reason = turn?.abortController.signal.aborted ? 'playback-aborted' : 'playback-finished';
    await session.cancel(reason).catch(() => undefined);
    if (turn && turn.ttsSession === session) {
      turn.ttsSession = null;
    }
  }
}

export async function* resumeTtsPlayback(
  runtime: VoiceTurnRuntimeContext,
  acquired: AcquiredTtsAudio,
  turn?: ActiveVoiceTurn,
): AsyncGenerator<Buffer> {
  const { iterator, firstChunk } = acquired;
  let totalAudioBytes = acquired.totalAudioBytes;

  if (firstChunk) {
    yield Buffer.isBuffer(firstChunk.audio) ? firstChunk.audio : Buffer.from(firstChunk.audio);
  }

  for (;;) {
    if (turn) {
      assertActiveVoiceTurn(runtime, turn);
    }

    const next = await iterator.next();
    if (next.done) break;

    totalAudioBytes = validateTtsAudioChunk(next.value.audio, totalAudioBytes, runtime.securityLimits);
    if (next.value.audio.byteLength === 0) continue;

    yield Buffer.isBuffer(next.value.audio) ? next.value.audio : Buffer.from(next.value.audio);
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
        // Discord exposes no remote-listener acknowledgement. The strongest
        // observable playback proxy is local Playing while the live voice
        // connection is Ready and still subscribed to this exact player.
        // Disconnected/unsubscribed local playback emits no TTFA endpoint.
        if (turn && hasReadySubscribedPlayback(turn.connection, player)) {
          emitVoicePerformance(runtime, turn, 'first_audible_playback');
        }
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

/**
 * Decode a captured opus stream into a live Readable of PCM frames. Unlike the
 * previous buffered decoder, this returns immediately and emits decoded PCM as
 * it arrives so the STT pump can stream during speech. Natural stream
 * backpressure (the consumer awaits each `writeAudio`) paces decoding, so
 * memory stays bounded to roughly one frame in flight. Errors from the opus
 * receive stream and the decoder are re-wrapped as structured ingest errors and
 * surfaced to the consumer by destroying the output stream — never swallowed.
 */
export function decodeOpusToPcmStream(
  runtime: VoiceTurnRuntimeContext,
  opusStream: NodeJS.ReadableStream,
  signal?: AbortSignal,
): NodeJS.ReadableStream {
  let decoder: InstanceType<typeof prism.opus.Decoder>;

  try {
    decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
  } catch (error) {
    log.error('Failed to create Opus decoder. Install @discordjs/opus or opusscript.', {
      error: toErrorMessage(error),
    });
    throw createStructuredVoiceError({
      error: new Error(`Opus decoder unavailable: ${toErrorMessage(error)}`),
      stage: 'ingest',
      code: 'VOICE_OPUS_UNAVAILABLE',
    });
  }

  const output = new PassThrough();
  let settled = false;

  const cleanup = (): void => {
    opusStream.off('error', onOpusError);
    decoder.off('error', onDecoderError);
    signal?.removeEventListener('abort', onAbort);
  };

  const destroyOutput = (error?: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      decoder.destroy();
    } catch {
      // Ignore decoder teardown errors.
    }
    output.destroy(error);
  };

  function onOpusError(error: Error): void {
    log.warn('AudioReceiveStream error (contained)', { error: toErrorMessage(error) });
    runtime.recordStreamError(runtime.targetUserId);
    destroyOutput(createStructuredVoiceError({
      error,
      stage: 'ingest',
      code: 'VOICE_RECEIVE_STREAM_ERROR',
    }));
  }

  function onDecoderError(error: Error): void {
    log.warn('Opus decoder error (contained)', { error: toErrorMessage(error) });
    destroyOutput(createStructuredVoiceError({
      error,
      stage: 'ingest',
      code: 'VOICE_OPUS_DECODE_FAILED',
    }));
  }

  function onAbort(): void {
    // The STT pump and transcript consumer raise the canonical abort error;
    // here we only end decode so the consumer's async iterator completes.
    destroyOutput();
  }

  opusStream.once('error', onOpusError);
  decoder.once('error', onDecoderError);
  if (signal) {
    if (signal.aborted) {
      queueMicrotask(onAbort);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  decoder.once('end', () => {
    // Normal completion: the decoder has flushed all PCM (piped to `output`,
    // which pipe ends for us). Drop listeners and release the decoder's native
    // handles; buffered PCM already queued in `output` still drains to the
    // consumer.
    cleanup();
    try {
      decoder.destroy();
    } catch {
      // Ignore decoder teardown errors.
    }
  });
  opusStream.pipe(decoder);
  decoder.pipe(output);
  return output;
}
