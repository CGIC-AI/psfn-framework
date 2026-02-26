import {
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import { Events, type Client, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import { Readable } from 'node:stream';
import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';
import type { SubstrateConfig, SubstrateMessage } from '../../types.js';
import { createStreamingSttConnector, type StreamingSttConnector, type SttStreamSession } from '../../voice/connectors/stt/index.js';
import { createStreamingTtsConnector, type StreamingTtsConnector, type TtsAudioChunk, type TtsSynthesisSession } from '../../voice/connectors/tts/index.js';
import {
  buildFallbackOrder,
  resolveVoiceReliabilityBudgets,
  runWithVoiceStageBudget,
  selectFallbackCandidate,
  type VoiceReliabilityBudgets,
} from '../../voice/policy/reliability.js';
import {
  resolveVoiceSecurityLimits,
  validatePcmAudio,
  validateTranscriptText,
  validateTtsAudioChunk,
  validateTtsInputText,
  type VoiceSecurityLimits,
} from '../../voice/policy/security.js';
import type { MessageHandler } from '../types.js';

const log = createComponentLogger('DiscordVoice');
const CAPTURE_SILENCE_MS = 1_200;
const MIN_PCM_BYTES = 32_000;
const STT_STREAM_CHUNK_BYTES = 3_840;
const UNKNOWN_VOICE_ERROR_CODE = 'VOICE_PIPELINE_ERROR';

type VoiceTurnErrorStage = 'ingest' | 'stt' | 'llm' | 'tts' | 'unknown';
type VoiceTurnObservationKind = 'silence' | 'empty-transcript' | 'empty-response' | 'playback-error';

interface StructuredVoiceError extends Error {
  voiceStage?: VoiceTurnErrorStage;
  voiceCode?: string;
  voiceTurnErrorEmitted?: boolean;
}

interface DiscordVoiceRuntimeConfig {
  client: Client;
  config: SubstrateConfig;
  eventBus: EventBus;
  getHandler: () => MessageHandler | null;
}

export class DiscordVoiceRuntime {
  private readonly client: Client;
  private readonly config: SubstrateConfig;
  private readonly eventBus: EventBus;
  private readonly getHandler: () => MessageHandler | null;

  private readonly enabled: boolean;
  private readonly targetGuildId: string;
  private readonly targetUserId: string;
  private readonly daveEncryption: boolean;
  private readonly decryptionFailureTolerance: number;
  private readonly sttConnector?: StreamingSttConnector;
  private readonly ttsConnectors: StreamingTtsConnector[];
  private readonly reliabilityBudgets: VoiceReliabilityBudgets;
  private readonly securityLimits: VoiceSecurityLimits;

  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private activeChannel: VoiceBasedChannel | null = null;
  private speakingListener: ((userId: string) => void) | null = null;
  private capturing = false;
  private handlingState = false;
  private activeTurnId: string | null = null;

  constructor({ client, config, eventBus, getHandler }: DiscordVoiceRuntimeConfig) {
    this.client = client;
    this.config = config;
    this.eventBus = eventBus;
    this.getHandler = getHandler;
    this.reliabilityBudgets = resolveVoiceReliabilityBudgets();
    this.securityLimits = resolveVoiceSecurityLimits();

    this.targetGuildId = config.voiceTargetGuildId ?? '';
    this.targetUserId = config.voiceTargetUserId ?? '';
    this.daveEncryption = config.voiceDaveEncryption ?? true;
    const configuredDecryptionTolerance = config.voiceDecryptionFailureTolerance;
    this.decryptionFailureTolerance = (
      typeof configuredDecryptionTolerance === 'number'
      && Number.isFinite(configuredDecryptionTolerance)
    )
      ? Math.max(0, Math.floor(configuredDecryptionTolerance))
      : 24;

    const voiceEnabled = config.voiceEnabled === true;
    const deepgramApiKey = config.deepgramApiKey ?? '';
    const elevenLabsApiKey = config.elevenLabsApiKey ?? '';
    const elevenLabsVoiceId = config.elevenLabsVoiceId ?? '';

    if (!voiceEnabled) {
      this.enabled = false;
      this.ttsConnectors = [];
      return;
    }

    if (!this.targetGuildId || !this.targetUserId || !deepgramApiKey || !elevenLabsApiKey || !elevenLabsVoiceId) {
      this.enabled = false;
      this.ttsConnectors = [];
      log.warn('Voice enabled but missing required config, disabling voice runtime', {
        hasGuild: !!this.targetGuildId,
        hasUser: !!this.targetUserId,
        hasDeepgram: !!deepgramApiKey,
        hasElevenLabs: !!elevenLabsApiKey,
        hasVoiceId: !!elevenLabsVoiceId,
      });
      return;
    }

    this.sttConnector = createStreamingSttConnector('deepgram', {
      apiKey: deepgramApiKey,
      model: config.deepgramModel,
    });
    this.ttsConnectors = [
      createStreamingTtsConnector('elevenlabs', {
        apiKey: elevenLabsApiKey,
        voiceId: elevenLabsVoiceId,
        modelId: config.elevenLabsModelId,
      }),
    ];
    this.enabled = true;
  }

  init(): void {
    if (!this.enabled) return;

    this.client.on(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    log.info('Discord voice runtime enabled', {
      guildId: this.targetGuildId,
      userId: this.targetUserId,
    });
  }

  async stop(): Promise<void> {
    if (!this.enabled) return;

    this.client.off(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    await this.leaveChannel('shutdown');
  }

  private onVoiceStateUpdate = async (_oldState: VoiceState, newState: VoiceState): Promise<void> => {
    if (!this.enabled) return;
    if (this.handlingState) return;
    this.handlingState = true;

    try {
      const guildId = newState.guild.id;
      if (guildId !== this.targetGuildId) return;

      if (this.activeChannel && this.nonBotMemberCount(this.activeChannel) === 0) {
        await this.leaveChannel('channel-empty');
      }

      if (newState.id !== this.targetUserId) return;

      const nextChannel = newState.channel;
      if (!nextChannel) {
        await this.leaveChannel('target-left');
        return;
      }

      if (this.activeChannel?.id === nextChannel.id) return;

      await this.joinChannel(nextChannel);
    } catch (error) {
      this.emitVoiceError(error);
    } finally {
      this.handlingState = false;
    }
  };

  private async joinChannel(channel: VoiceBasedChannel): Promise<void> {
    await this.leaveChannel('switch-channel');

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: this.daveEncryption,
      decryptionFailureTolerance: this.decryptionFailureTolerance,
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

    const player = createAudioPlayer();
    connection.subscribe(player);

    this.connection = connection;
    this.player = player;
    this.activeChannel = channel;

    this.speakingListener = (userId: string) => {
      if (userId !== this.targetUserId || this.capturing) return;
      this.handleUtterance().catch((error) => this.emitVoiceError(error));
    };
    connection.receiver.speaking.on('start', this.speakingListener);

    await this.eventBus.emit('channel.voice.start', {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: this.targetUserId,
    });

    const readyCue = this.config.voiceReadyCueText?.trim();
    if (readyCue) {
      await this.speakText(readyCue);
    }
  }

  private async leaveChannel(reason: string): Promise<void> {
    const prevChannel = this.activeChannel;
    if (!prevChannel && !this.connection) return;

    if (this.connection && this.speakingListener) {
      this.connection.receiver.speaking.off('start', this.speakingListener);
    }
    this.speakingListener = null;

    if (this.player) {
      this.player.stop(true);
    }

    if (this.connection) {
      this.connection.destroy();
    }

    this.connection = null;
    this.player = null;
    this.activeChannel = null;
    this.capturing = false;

    if (prevChannel) {
      await this.eventBus.emit('channel.voice.end', {
        guildId: prevChannel.guild.id,
        channelId: prevChannel.id,
        userId: this.targetUserId,
        reason,
      });
    }
  }

  private async handleUtterance(): Promise<void> {
    if (!this.connection || !this.player || !this.activeChannel || !this.sttConnector || this.ttsConnectors.length === 0) {
      return;
    }

    const turnId = `voice-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestampMs = Date.now();
    this.activeTurnId = turnId;
    let turnStatus: 'completed' | 'cancelled' | 'timeout' | 'error' = 'completed';
    let turnReason: string | undefined;

    this.capturing = true;
    try {
      await this.eventBus.emit('voice.turn.start', {
        turnId,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        timestampMs,
      });

      const opusStream = this.connection.receiver.subscribe(this.targetUserId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: CAPTURE_SILENCE_MS,
        },
      });

      const pcm = await runWithVoiceStageBudget({
        stage: 'ingest',
        budgets: this.reliabilityBudgets,
        task: () => this.decodeOpusToPcm(opusStream),
      });
      if (pcm.length < MIN_PCM_BYTES) {
        turnReason = 'silence';
        await this.emitTurnObservation({
          turnId,
          stage: 'ingest',
          kind: 'silence',
          detail: {
            pcmBytes: pcm.length,
            minimumPcmBytes: MIN_PCM_BYTES,
          },
        });
        return;
      }

      validatePcmAudio(pcm, this.securityLimits);

      const rawTranscript = await runWithVoiceStageBudget({
        stage: 'stt',
        budgets: this.reliabilityBudgets,
        task: () => this.transcribePcm(pcm),
      });

      const transcript = validateTranscriptText(rawTranscript, this.securityLimits);
      if (!transcript) {
        turnReason = 'empty-transcript';
        await this.emitTurnObservation({
          turnId,
          stage: 'stt',
          kind: 'empty-transcript',
          detail: {
            rawTranscriptLength: rawTranscript.trim().length,
          },
        });
        return;
      }

      await this.eventBus.emit('channel.voice.transcript', {
        guildId: this.activeChannel.guild.id,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        transcript,
      });
      await this.eventBus.emit('voice.stt.final', {
        turnId,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        text: transcript,
        timestampMs: Date.now(),
      });

      const handler = this.getHandler();
      if (!handler) return;

      const member = this.activeChannel.members.get(this.targetUserId);
      const message: SubstrateMessage = {
        id: `voice-${Date.now()}`,
        channelId: `discord-voice:${this.activeChannel.id}`,
        channelType: 'discord',
        isDirectMessage: false,
        authorId: this.targetUserId,
        authorName: member?.displayName ?? member?.user.username ?? 'Voice User',
        content: transcript,
        timestamp: new Date(),
      };

      await this.eventBus.emit('message.received', { message });
      const response = await handler(message);
      await this.eventBus.emit('message.sent', { response });

      const text = response.content.trim();
      if (!text) {
        turnReason = 'empty-response';
        await this.emitTurnObservation({
          turnId,
          stage: 'llm',
          kind: 'empty-response',
          detail: {
            responseLength: response.content.length,
          },
        });
        log.warn('Voice response was empty; skipping TTS playback');
        return;
      }

      await this.eventBus.emit('voice.tts.requested', {
        turnId,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        text,
        timestampMs: Date.now(),
      });

      await this.speakText(text, turnId);
      await this.eventBus.emit('channel.voice.tts.sent', {
        guildId: this.activeChannel.guild.id,
        channelId: this.activeChannel.id,
        userId: this.targetUserId,
        text,
      });
    } catch (error) {
      const stage = this.resolveVoiceErrorStage(error);
      const code = this.resolveVoiceErrorCode(error);
      const structuredError = this.createVoiceError({
        error,
        stage,
        code,
      });
      turnStatus = this.classifyTurnStatus(structuredError);
      turnReason = structuredError.message;
      await this.eventBus.emit('voice.turn.error', {
        turnId,
        channelId: this.activeChannel?.id,
        userId: this.targetUserId,
        stage,
        code,
        error: structuredError.message,
        timestampMs: Date.now(),
      });
      structuredError.voiceTurnErrorEmitted = true;
      throw structuredError;
    } finally {
      await this.eventBus.emit('voice.turn.end', {
        turnId,
        channelId: this.activeChannel?.id,
        userId: this.targetUserId,
        status: turnStatus,
        reason: turnReason,
        timestampMs: Date.now(),
      });
      this.activeTurnId = null;
      this.capturing = false;
    }
  }

  private async transcribePcm(pcm: Buffer): Promise<string> {
    if (!this.sttConnector || !this.activeChannel) return '';

    const session = await this.sttConnector.startStream({
      sampleRateHz: 48_000,
      channels: 2,
      encoding: 'pcm_s16le',
      model: this.config.deepgramModel,
      interimResults: true,
    });

    let finalTranscript = '';
    let latestPartial = '';
    let streamError: unknown;

    const writerPromise = this.writePcmToSttSession(session, pcm);

    try {
      for await (const chunk of session.transcripts) {
        const transcriptText = chunk.text.trim();
        if (!transcriptText) continue;

        if (chunk.type === 'partial') {
          latestPartial = transcriptText;
          await this.eventBus.emit('channel.voice.transcript.partial', {
            guildId: this.activeChannel.guild.id,
            channelId: this.activeChannel.id,
            userId: this.targetUserId,
            transcript: transcriptText,
            confidence: chunk.confidence,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
          });
          if (this.activeTurnId) {
            await this.eventBus.emit('voice.stt.partial', {
              turnId: this.activeTurnId,
              channelId: this.activeChannel.id,
              userId: this.targetUserId,
              text: transcriptText,
              timestampMs: Date.now(),
            });
          }
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
      if (!streamError) {
        streamError = error;
      }
    }

    if (streamError) {
      throw this.createVoiceError({
        error: streamError,
        stage: 'stt',
        code: 'VOICE_STT_STREAM_FAILED',
      });
    }

    return finalTranscript || latestPartial;
  }

  private async writePcmToSttSession(session: SttStreamSession, pcm: Buffer): Promise<void> {
    for (let offset = 0; offset < pcm.length; offset += STT_STREAM_CHUNK_BYTES) {
      const nextChunk = pcm.subarray(offset, Math.min(offset + STT_STREAM_CHUNK_BYTES, pcm.length));
      await session.writeAudio(nextChunk);
    }

    await session.endInput();
  }

  private async speakText(text: string, turnId?: string): Promise<void> {
    if (!this.player) return;

    const safeText = validateTtsInputText(text, this.securityLimits);
    if (!safeText) return;

    const connectorOrder = buildFallbackOrder('elevenlabs', this.ttsConnectors.map((connector) => connector.id));
    const firstConnectorId = connectorOrder[0] ?? 'elevenlabs';
    const selected = selectFallbackCandidate(
      firstConnectorId,
      this.ttsConnectors.map((connector) => ({ id: connector.id, value: connector })),
    );

    if (!selected) {
      throw new Error('No TTS connector available');
    }

    await runWithVoiceStageBudget({
      stage: 'tts',
      budgets: this.reliabilityBudgets,
      task: async () => {
        await this.playWithTtsConnector(selected.value, safeText, turnId);
      },
    });
  }

  private async playWithTtsConnector(
    connector: StreamingTtsConnector,
    text: string,
    turnId?: string,
  ): Promise<void> {
    try {
      const streamSession = await connector.synthesizeStream({
        text,
        encoding: 'mp3',
        allowBufferFallback: false,
      });
      await this.playTtsSession(streamSession, turnId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      log.warn('Streaming TTS failed, using buffered fallback', {
        provider: connector.id,
        error: errorText,
      });

      try {
        const audio = await connector.synthesizeBuffer({ text, encoding: 'mp3' });
        validateTtsAudioChunk(audio, 0, this.securityLimits);
        if (turnId) {
          await this.eventBus.emit('voice.tts.first-byte', {
            turnId,
            channelId: this.activeChannel?.id,
            userId: this.targetUserId,
            timestampMs: Date.now(),
          });
        }
        await this.playReadableAudio(Readable.from(audio));
      } catch (fallbackError) {
        throw this.createVoiceError({
          error: fallbackError,
          stage: 'tts',
          code: 'VOICE_TTS_FALLBACK_FAILED',
        });
      }
    }
  }

  private async playTtsSession(session: TtsSynthesisSession, turnId?: string): Promise<void> {
    try {
      await this.playReadableAudio(Readable.from(this.createPlaybackChunkIterator(session.audio, turnId)));
    } finally {
      await session.cancel('playback-finished').catch(() => undefined);
    }
  }

  private async *createPlaybackChunkIterator(
    audio: AsyncIterable<TtsAudioChunk>,
    turnId?: string,
  ): AsyncGenerator<Buffer> {
    let totalAudioBytes = 0;
    let emittedFirstByte = false;

    for await (const chunk of audio) {
      totalAudioBytes = validateTtsAudioChunk(chunk.audio, totalAudioBytes, this.securityLimits);
      if (chunk.audio.byteLength === 0) continue;

      if (!emittedFirstByte && turnId) {
        emittedFirstByte = true;
        await this.eventBus.emit('voice.tts.first-byte', {
          turnId,
          channelId: this.activeChannel?.id,
          userId: this.targetUserId,
          timestampMs: Date.now(),
        });
      }

      yield Buffer.isBuffer(chunk.audio) ? chunk.audio : Buffer.from(chunk.audio);
    }
  }

  private async playReadableAudio(audio: Readable): Promise<void> {
    if (!this.player) return;

    const resource = createAudioResource(audio);
    this.player.play(resource);

    try {
      await runWithVoiceStageBudget({
        stage: 'output',
        budgets: this.reliabilityBudgets,
        task: async () => {
          await entersState(this.player!, AudioPlayerStatus.Playing, 5_000);
          await entersState(this.player!, AudioPlayerStatus.Idle, 120_000);
        },
      });
    } catch (error) {
      const playbackError = this.createVoiceError({
        error,
        stage: 'tts',
        code: 'VOICE_PLAYBACK_FAILED',
      });
      await this.emitTurnObservation({
        turnId: this.activeTurnId ?? undefined,
        stage: 'tts',
        kind: 'playback-error',
        detail: {
          error: playbackError.message,
        },
      });
      throw playbackError;
    }
  }

  private async decodeOpusToPcm(opusStream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const decoder = new prism.opus.Decoder({
        rate: 48_000,
        channels: 2,
        frameSize: 960,
      });
      const chunks: Buffer[] = [];
      let total = 0;

      decoder.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
      });
      decoder.once('end', () => {
        resolve(Buffer.concat(chunks, total));
      });
      decoder.once('error', (error: Error) => reject(error));
      opusStream.once('error', (error: Error) => reject(error));

      opusStream.pipe(decoder);
    });
  }

  private nonBotMemberCount(channel: VoiceBasedChannel): number {
    return channel.members.filter(member => !member.user.bot).size;
  }

  private emitVoiceError(error: unknown): void {
    const stage = this.resolveVoiceErrorStage(error);
    const code = this.resolveVoiceErrorCode(error);
    const voiceError = this.createVoiceError({
      error,
      stage,
      code,
    });
    const errorText = voiceError.message;
    log.error('Voice pipeline error', {
      stage,
      code,
      error: errorText,
    });

    this.eventBus.emit('channel.voice.error', {
      guildId: this.activeChannel?.guild.id,
      channelId: this.activeChannel?.id,
      userId: this.targetUserId,
      error: errorText,
    }).catch(() => undefined);

    if (!voiceError.voiceTurnErrorEmitted) {
      this.eventBus.emit('voice.turn.error', {
        turnId: this.activeTurnId ?? undefined,
        channelId: this.activeChannel?.id,
        userId: this.targetUserId,
        stage,
        code,
        error: errorText,
        timestampMs: Date.now(),
      }).catch(() => undefined);
    }
  }

  private classifyTurnStatus(error: unknown): 'completed' | 'cancelled' | 'timeout' | 'error' {
    const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
    if (text.includes('cancel') || text.includes('abort') || text.includes('interrupt')) return 'cancelled';
    return 'error';
  }

  private resolveVoiceErrorStage(error: unknown): VoiceTurnErrorStage {
    if (error && typeof error === 'object') {
      const stage = (error as StructuredVoiceError).voiceStage;
      if (stage) return stage;
    }

    const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
    if (text.includes('deepgram') || text.includes('transcrib') || text.includes('stt')) return 'stt';
    if (text.includes('elevenlabs') || text.includes('synth') || text.includes('tts') || text.includes('playback')) {
      return 'tts';
    }
    if (text.includes('silence') || text.includes('decode') || text.includes('opus')) return 'ingest';
    if (text.includes('response')) return 'llm';
    return 'unknown';
  }

  private resolveVoiceErrorCode(error: unknown): string {
    if (error && typeof error === 'object') {
      const code = (error as StructuredVoiceError).voiceCode;
      if (code) return code;
    }

    const text = (error instanceof Error ? error.message : String(error))
      .trim()
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase();

    return text ? `VOICE_${text}` : UNKNOWN_VOICE_ERROR_CODE;
  }

  private createVoiceError(params: {
    error: unknown;
    stage: VoiceTurnErrorStage;
    code: string;
  }): StructuredVoiceError {
    const { error, stage, code } = params;
    if (error && typeof error === 'object') {
      const existing = error as StructuredVoiceError;
      if (existing.voiceStage && existing.voiceCode) {
        return existing;
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(message) as StructuredVoiceError;
    wrapped.voiceStage = stage;
    wrapped.voiceCode = code;
    if (error instanceof Error && error.stack) {
      wrapped.stack = error.stack;
    }
    return wrapped;
  }

  private async emitTurnObservation(params: {
    turnId?: string;
    stage: VoiceTurnErrorStage;
    kind: VoiceTurnObservationKind;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    const { turnId, stage, kind, detail } = params;
    const payload = {
      turnId,
      channelId: this.activeChannel?.id,
      userId: this.targetUserId,
      stage,
      kind,
      detail: detail ?? {},
      timestampMs: Date.now(),
    };

    log.warn('Voice turn observation', payload);
    await this.eventBus.emit('voice.turn.observation', payload);
  }
}
