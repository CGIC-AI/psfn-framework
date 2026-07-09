import {
  createAudioPlayer,
  entersState,
  joinVoiceChannel,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import { Events, type Client, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import type { Readable } from 'node:stream';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import {
  type StreamingTtsConnector,
  type TtsAudioChunk,
  type TtsSynthesisSession,
} from '../../primitives/voice/connectors/tts/index.js';
import {
  resolveVoiceReliabilityBudgets,
  type VoiceReliabilityBudgets,
} from '../../primitives/voice/policy/reliability.js';
import {
  resolveVoiceSecurityLimits,
  type VoiceSecurityLimits,
} from '../../primitives/voice/policy/security.js';
import type { MessageHandler } from '../backplane/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  createRuntimeVoiceSttConnector,
  type RuntimeVoiceTtsProvider,
  resolveRuntimeVoiceTtsProvider,
} from '../../app/startup/support/bootstrap-helpers.js';
import type { StreamingSttConnector, SttStreamSession } from '../../primitives/voice/connectors/stt/index.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type {
  ActiveVoiceTurn,
  DiscordVoiceRuntimeConfig,
  StructuredVoiceError,
  VoiceConnectionRecoveryTrigger,
  VoiceConnectionStateChange,
  VoiceRecoveryRuntimeContext,
  VoiceStreamDegradedPhase,
  VoiceTurnErrorStage,
  VoiceTurnObservationKind,
  VoiceTurnRuntimeContext,
} from './voice-types.js';
import {
  buildConfiguredTtsConnectors,
  hasTtsProviderConfig,
  voicePreflight,
} from './voice-preflight.js';
import {
  classifyVoiceTurnStatus,
  createStructuredVoiceError,
  resolveVoiceErrorCode,
  resolveVoiceErrorStage,
} from './voice-errors.js';
import {
  emitRuntimeVoiceError,
  emitVoiceStreamDegradedTelemetry,
  isRecoverableDecryptFailure as isRecoverableVoiceDecryptFailure,
  pruneVoiceDecryptRecoveryAttempts,
  recordVoiceStreamError,
  resetVoiceDecryptFailureTracking,
  resetVoiceStreamErrorCounts,
  startVoiceDecryptRecovery,
  trackVoiceDecryptFailure,
} from './voice-recovery-runtime.js';
import {
  assertActiveVoiceTurn,
  cancelActiveVoiceTurn,
  cancelVoiceTurnResources,
  createPlaybackChunkIterator as createVoicePlaybackChunkIterator,
  decodeOpusStreamToPcm,
  emitVoiceTurnObservation,
  handleVoiceUtterance,
  playReadableAudio as playVoiceReadableAudio,
  playTtsSession as playVoiceTtsSession,
  playWithTtsConnector as playVoiceWithTtsConnector,
  resetActiveVoiceTurnState,
  speakVoiceText,
  transcribeVoicePcm,
  writePcmToSttSession as writeVoicePcmToSttSession,
} from './voice-turn-runtime.js';

export type { OpusAvailabilityResult, VoicePreflightResult } from './voice-types.js';
export { checkOpusAvailability, voicePreflight } from './voice-preflight.js';

const log = createComponentLogger('DiscordVoice');

export class DiscordVoiceRuntime {
  private readonly client: Client;
  private readonly config: SubstrateConfig;
  private readonly eventBus: EventBus;
  private readonly getHandler: () => MessageHandler | null;
  private readonly eligibilityGate?: EligibilityGate;

  private readonly enabled: boolean;
  private readonly targetGuildId: string;
  private readonly targetUserId: string;
  private readonly daveEncryption: boolean;
  private readonly decryptionFailureTolerance: number;
  private readonly preferredTtsProviderId: RuntimeVoiceTtsProvider;
  private readonly sttConnector?: StreamingSttConnector;
  readonly intakeScreening: IntakeScreeningService | null;
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
  private connectionGeneration = 0;
  private connectionStateListener: ((oldState: VoiceConnection['state'], newState: VoiceConnection['state']) => void) | null = null;
  private activeTurn: ActiveVoiceTurn | null = null;
  private decryptFailureGeneration = 0;
  private decryptFailureCount = 0;
  private decryptRecoveryAttempts: number[] = [];
  private decryptRecoveryInFlight = false;
  private opusAvailable = true;
  private receiveEnabled = true;

  /** Per-user stream error counters for isolation and graceful teardown. */
  private streamErrorCounts = new Map<string, number>();

  constructor({ client, config, eventBus, getHandler, eligibilityGate, intakeScreening }: DiscordVoiceRuntimeConfig) {
    this.client = client;
    this.config = config;
    this.eventBus = eventBus;
    this.getHandler = getHandler;
    this.eligibilityGate = eligibilityGate;
    this.intakeScreening = intakeScreening ?? null;
    this.reliabilityBudgets = resolveVoiceReliabilityBudgets();
    this.securityLimits = resolveVoiceSecurityLimits();

    this.targetGuildId = config.voiceTargetGuildId ?? '';
    this.targetUserId = config.voiceTargetUserId ?? '';
    this.daveEncryption = config.voiceDaveEncryption ?? true;
    const configuredTtsProvider = resolveRuntimeVoiceTtsProvider(config);
    this.preferredTtsProviderId = configuredTtsProvider;
    const configuredDecryptionTolerance = config.voiceDecryptionFailureTolerance;
    this.decryptionFailureTolerance = (
      typeof configuredDecryptionTolerance === 'number'
      && Number.isFinite(configuredDecryptionTolerance)
    )
      ? Math.max(0, Math.floor(configuredDecryptionTolerance))
      : 24;

    const voiceEnabled = config.voiceEnabled === true;

    if (!voiceEnabled) {
      this.enabled = false;
      this.ttsConnectors = [];
      return;
    }

    // Run preflight to check Opus availability and config completeness
    const preflight = voicePreflight(config);
    this.opusAvailable = preflight.opusAvailable;
    this.receiveEnabled = preflight.opusAvailable;

    let sttBinding: ReturnType<typeof createRuntimeVoiceSttConnector> = null;
    try {
      sttBinding = createRuntimeVoiceSttConnector(config, {
        eligibilityGate: this.eligibilityGate,
      });
    } catch (error) {
      log.warn('Discord voice STT connector initialization failed', {
        error: toErrorMessage(error),
      });
    }

    if (!this.targetGuildId || !this.targetUserId || !sttBinding) {
      this.enabled = false;
      this.ttsConnectors = [];
      const hasSelectedTtsConfig = this.preferredTtsProviderId !== 'disabled'
        ? hasTtsProviderConfig(this.preferredTtsProviderId, config)
        : false;
      log.warn('Voice enabled but missing required config, disabling voice runtime', {
        hasGuild: !!this.targetGuildId,
        hasUser: !!this.targetUserId,
        hasSttConfig: Boolean(sttBinding),
        ttsProvider: this.preferredTtsProviderId,
        hasSelectedTtsConfig,
        hasElevenLabsConfig: hasTtsProviderConfig('elevenlabs', config),
        hasEchoConfig: hasTtsProviderConfig('echo', config),
      });
      return;
    }

    if (!preflight.opusAvailable) {
      log.error(
        'Voice enabled but no Opus decoder available. ' +
        'Voice receive pipeline disabled to prevent crashes; voice join/output remains enabled. ' +
        'Install one of: npm install @discordjs/opus (recommended), npm install opusscript (JS fallback)',
      );
    }

    const ttsConnectors = this.preferredTtsProviderId === 'disabled'
      ? []
      : buildConfiguredTtsConnectors(config, this.preferredTtsProviderId, this.eligibilityGate);
    if (ttsConnectors.length === 0) {
      this.enabled = false;
      this.ttsConnectors = [];
      log.warn('Voice enabled but no TTS connectors could be created, disabling voice runtime', {
        ttsProvider: this.preferredTtsProviderId,
        hasSelectedTtsConfig: hasTtsProviderConfig(this.preferredTtsProviderId, config),
        hasElevenLabsConfig: hasTtsProviderConfig('elevenlabs', config),
        hasEchoConfig: hasTtsProviderConfig('echo', config),
      });
      return;
    }

    this.sttConnector = sttBinding.connector;
    this.ttsConnectors = ttsConnectors;
    this.enabled = true;
  }

  init(): void {
    if (!this.enabled) return;

    this.client.on(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    this.client.on(Events.ClientReady, this.onClientReady);
    log.info('Discord voice runtime enabled', {
      guildId: this.targetGuildId,
      userId: this.targetUserId,
      receiveEnabled: this.receiveEnabled,
    });

    const isReady = typeof (this.client as { isReady?: () => boolean }).isReady === 'function'
      ? (this.client as { isReady: () => boolean }).isReady()
      : false;
    if (isReady) {
      void this.reconcileTargetVoiceChannel('init');
    }
  }

  async stop(): Promise<void> {
    if (!this.enabled) return;

    this.client.off(Events.VoiceStateUpdate, this.onVoiceStateUpdate);
    this.client.off(Events.ClientReady, this.onClientReady);
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
      try {
        this.emitVoiceError(error);
      } catch (emitError) {
        log.error('Failed to emit voice state error (double fault)', {
          originalError: toErrorMessage(error),
          emitError: toErrorMessage(emitError),
        });
      }
    } finally {
      this.handlingState = false;
    }
  };

  private onClientReady = (): void => {
    void this.reconcileTargetVoiceChannel('client-ready');
  };

  private async reconcileTargetVoiceChannel(trigger: 'init' | 'client-ready'): Promise<void> {
    const guildFetcher = (this.client as unknown as {
      guilds?: {
        fetch?: (guildId: string) => Promise<{
          members?: {
            fetch?: (userId: string) => Promise<{ voice?: { channel?: VoiceBasedChannel | null } }>;
          };
        }>;
      };
    }).guilds?.fetch;
    if (!guildFetcher) return;

    try {
      const guild = await guildFetcher(this.targetGuildId);
      const member = await guild.members?.fetch?.(this.targetUserId);
      const targetChannel = member?.voice?.channel ?? null;

      if (!targetChannel) {
        log.debug('Discord voice target user is not in a voice channel during reconciliation', {
          trigger,
          guildId: this.targetGuildId,
          userId: this.targetUserId,
        });
        return;
      }

      if (this.activeChannel?.id === targetChannel.id) {
        return;
      }

      await this.joinChannel(targetChannel);
    } catch (error) {
      log.warn('Discord voice startup reconciliation failed', {
        trigger,
        guildId: this.targetGuildId,
        userId: this.targetUserId,
        error: toErrorMessage(error),
      });
    }
  }

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

    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.connection = connection;
    this.bindConnectionStateListener(connection, channel, generation);

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      if (this.isCurrentConnection(connection, generation)) {
        await this.leaveChannel('connection-ready-timeout');
      }
      throw error;
    }

    if (!this.isCurrentConnection(connection, generation)) {
      return;
    }

    const player = createAudioPlayer();
    connection.subscribe(player);

    this.player = player;
    this.activeChannel = channel;
    this.resetDecryptFailureTracking(generation);
    this.resetStreamErrorCounts();

    if (this.receiveEnabled) {
      this.speakingListener = (userId: string) => {
        if (userId !== this.targetUserId || this.capturing || this.activeTurn || this.isPlaybackActive()) return;
        this.handleUtterance().catch((error) => {
          try {
            this.emitVoiceError(error);
          } catch (emitError) {
            // Last-resort containment: never let errors escape to process level
            log.error('Failed to emit voice error (double fault)', {
              originalError: toErrorMessage(error),
              emitError: toErrorMessage(emitError),
            });
          }
        });
      };
      connection.receiver.speaking.on('start', this.speakingListener);
    } else {
      this.speakingListener = null;
    }

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
    await this.cancelActiveTurn(`leave:${reason}`);

    const prevChannel = this.activeChannel;
    const prevConnection = this.connection;
    if (!prevChannel && !prevConnection) return;

    if (prevConnection && this.connectionStateListener) {
      prevConnection.off('stateChange', this.connectionStateListener);
    }
    this.connectionStateListener = null;

    if (prevConnection && this.speakingListener) {
      prevConnection.receiver.speaking.off('start', this.speakingListener);
    }
    this.speakingListener = null;

    if (this.player) {
      this.player.stop(true);
    }

    if (prevConnection) {
      this.connectionGeneration += 1;
      prevConnection.destroy();
    }

    this.connection = null;
    this.player = null;
    this.activeChannel = null;
    this.activeTurn = null;
    this.activeTurnId = null;
    this.capturing = false;
    this.decryptFailureGeneration = 0;
    this.decryptFailureCount = 0;
    this.resetStreamErrorCounts();

    if (prevChannel) {
      await this.eventBus.emit('channel.voice.end', {
        guildId: prevChannel.guild.id,
        channelId: prevChannel.id,
        userId: this.targetUserId,
        reason,
      });
    }
  }

  private bindConnectionStateListener(connection: VoiceConnection, channel: VoiceBasedChannel, generation: number): void {
    const stateListener = (oldState: VoiceConnection['state'], newState: VoiceConnection['state']) => {
      this.handleConnectionStateChange({
        connection,
        channel,
        generation,
        previousStatus: oldState.status,
        status: newState.status,
      }).catch((error) => {
        try {
          this.emitVoiceError(error);
        } catch (emitError) {
          log.error('Failed to emit connection state error (double fault)', {
            originalError: toErrorMessage(error),
            emitError: toErrorMessage(emitError),
          });
        }
      });
    };

    this.connectionStateListener = stateListener;
    connection.on('stateChange', stateListener);
  }

  private isCurrentConnection(connection: VoiceConnection, generation: number): boolean {
    return this.connection === connection && this.connectionGeneration === generation;
  }

  private isPlaybackActive(): boolean {
    return this.player?.state.status === AudioPlayerStatus.Playing;
  }

  private async handleConnectionStateChange(params: VoiceConnectionStateChange): Promise<void> {
    const { connection, channel, generation, previousStatus, status } = params;
    if (!this.isCurrentConnection(connection, generation)) {
      log.debug('Ignoring stale voice connection state change', {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: this.targetUserId,
        generation,
        activeGeneration: this.connectionGeneration,
        previousStatus,
        status,
      });
      return;
    }

    const payload = {
      guildId: channel.guild.id,
      channelId: channel.id,
      userId: this.targetUserId,
      generation,
      previousStatus,
      status,
      timestampMs: Date.now(),
    };

    await this.eventBus.emit('voice.connection.state', payload);
    log.info('Voice connection state changed', payload);

    if (status === VoiceConnectionStatus.Signalling) {
      log.info('Voice connection entering signalling state', payload);
      return;
    }

    if (status === VoiceConnectionStatus.Disconnected) {
      const rejoinAttempt = connection.rejoinAttempts + 1;
      const didRejoin = connection.rejoin();
      if (didRejoin) {
        log.warn('Voice connection disconnected; attempting rejoin', {
          ...payload,
          rejoinAttempt,
        });
        return;
      }

      log.warn('Voice connection disconnected and rejoin failed; tearing down channel', {
        ...payload,
        rejoinAttempt,
      });
      await this.leaveChannel('connection-disconnected');
      return;
    }

    if (status === VoiceConnectionStatus.Destroyed) {
      log.warn('Voice connection destroyed unexpectedly; tearing down channel', payload);
      await this.leaveChannel('connection-destroyed');
    }
  }

  private async handleUtterance(): Promise<void> {
    await handleVoiceUtterance(this as unknown as VoiceTurnRuntimeContext & {
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
    });
  }

  private async transcribePcm(pcm: Buffer, turn: ActiveVoiceTurn): Promise<string> {
    return await transcribeVoicePcm(this as unknown as VoiceTurnRuntimeContext, pcm, turn);
  }

  private async writePcmToSttSession(session: SttStreamSession, pcm: Buffer, signal?: AbortSignal): Promise<void> {
    await writeVoicePcmToSttSession(session, pcm, signal);
  }

  private async speakText(text: string, turn?: ActiveVoiceTurn): Promise<void> {
    await speakVoiceText(this as unknown as VoiceTurnRuntimeContext & {
      playWithTtsConnector(connector: StreamingTtsConnector, text: string, turn?: ActiveVoiceTurn): Promise<void>;
    }, text, turn);
  }

  private async playWithTtsConnector(
    connector: StreamingTtsConnector,
    text: string,
    turn?: ActiveVoiceTurn,
  ): Promise<void> {
    await playVoiceWithTtsConnector(this as unknown as VoiceTurnRuntimeContext & {
      playTtsSession(session: TtsSynthesisSession, turn?: ActiveVoiceTurn): Promise<void>;
      playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void>;
    }, connector, text, turn);
  }

  private async playTtsSession(session: TtsSynthesisSession, turn?: ActiveVoiceTurn): Promise<void> {
    await playVoiceTtsSession(this as unknown as VoiceTurnRuntimeContext & {
      playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void>;
    }, session, turn);
  }

  private async *createPlaybackChunkIterator(
    audio: AsyncIterable<TtsAudioChunk>,
    turn?: ActiveVoiceTurn,
  ): AsyncGenerator<Buffer> {
    yield* createVoicePlaybackChunkIterator(this as unknown as VoiceTurnRuntimeContext, audio, turn);
  }

  private async playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void> {
    await playVoiceReadableAudio(this as unknown as VoiceTurnRuntimeContext, audio, turn);
  }

  private async decodeOpusToPcm(opusStream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
    return await decodeOpusStreamToPcm(this as unknown as VoiceTurnRuntimeContext & {
      recordStreamError(userId: string): void;
    }, opusStream, signal);
  }

  /**
   * Record a stream error for a given user. If the error count exceeds the
   * threshold, the stream is considered degraded and a warning is emitted.
   */
  private recordStreamError(userId: string): void {
    recordVoiceStreamError(this as unknown as VoiceRecoveryRuntimeContext, userId);
  }

  private emitStreamDegradedTelemetry(params: {
    phase: VoiceStreamDegradedPhase;
    userId: string;
    errorCount: number;
    threshold: number;
    channel?: VoiceBasedChannel | null;
    generation?: number;
    recoveryAttempt?: number;
  }): void {
    emitVoiceStreamDegradedTelemetry(this as unknown as VoiceRecoveryRuntimeContext, params);
  }

  /**
   * Reset stream error tracking, typically called when joining a new channel.
   */
  private resetStreamErrorCounts(): void {
    resetVoiceStreamErrorCounts(this as unknown as VoiceRecoveryRuntimeContext);
  }

  private nonBotMemberCount(channel: VoiceBasedChannel): number {
    return channel.members.filter(member => !member.user.bot).size;
  }

  private assertTurnActive(turn: ActiveVoiceTurn): void {
    assertActiveVoiceTurn(this as unknown as VoiceTurnRuntimeContext, turn);
  }

  private resetTurnStateIfCurrent(turn: ActiveVoiceTurn): void {
    resetActiveVoiceTurnState(this as unknown as VoiceTurnRuntimeContext, turn);
  }

  private async cancelTurnResources(turn: ActiveVoiceTurn, reason: string): Promise<void> {
    await cancelVoiceTurnResources(turn, reason);
  }

  private async cancelActiveTurn(reason: string): Promise<void> {
    await cancelActiveVoiceTurn(this as unknown as VoiceTurnRuntimeContext, reason);
  }

  private emitVoiceError(error: unknown): void {
    emitRuntimeVoiceError(this as unknown as VoiceRecoveryRuntimeContext, error);
  }

  private resetDecryptFailureTracking(generation: number): void {
    resetVoiceDecryptFailureTracking(this as unknown as VoiceRecoveryRuntimeContext, generation);
  }

  private trackDecryptFailure(params: {
    stage: VoiceTurnErrorStage;
    code: string;
    errorText: string;
  }): void {
    trackVoiceDecryptFailure(this as unknown as VoiceRecoveryRuntimeContext, params);
  }

  private isRecoverableDecryptFailure(stage: VoiceTurnErrorStage, code: string, errorText: string): boolean {
    return isRecoverableVoiceDecryptFailure(stage, code, errorText);
  }

  private pruneDecryptRecoveryAttempts(nowMs: number): void {
    pruneVoiceDecryptRecoveryAttempts(this as unknown as VoiceRecoveryRuntimeContext, nowMs);
  }

  private async startDecryptRecovery(params: {
    channel: VoiceBasedChannel;
    generation: number;
    failureCount: number;
    tolerance?: number;
    trigger?: VoiceConnectionRecoveryTrigger;
    degradedUserId?: string;
    degradedErrorCount?: number;
  }): Promise<void> {
    await startVoiceDecryptRecovery(this as unknown as VoiceRecoveryRuntimeContext, params);
  }

  private classifyTurnStatus(error: unknown): 'completed' | 'cancelled' | 'timeout' | 'error' {
    return classifyVoiceTurnStatus(error);
  }

  private resolveVoiceErrorStage(error: unknown): VoiceTurnErrorStage {
    return resolveVoiceErrorStage(error);
  }

  private resolveVoiceErrorCode(error: unknown): string {
    return resolveVoiceErrorCode(error);
  }

  private createVoiceError(params: {
    error: unknown;
    stage: VoiceTurnErrorStage;
    code: string;
  }): StructuredVoiceError {
    return createStructuredVoiceError(params);
  }

  private async emitTurnObservation(params: {
    turnId?: string;
    stage: VoiceTurnErrorStage;
    kind: VoiceTurnObservationKind;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await emitVoiceTurnObservation(this as unknown as VoiceTurnRuntimeContext, params);
  }
}
