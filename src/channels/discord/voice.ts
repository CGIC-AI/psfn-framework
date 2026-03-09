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
import type { EligibilityGate } from '../../capabilities/eligibility.js';
import {
  type StreamingTtsConnector,
  type StreamingTtsProvider,
  type TtsAudioChunk,
  type TtsSynthesisSession,
} from '../../voice/connectors/tts/index.js';
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
import { toErrorMessage } from '../../utils/errors.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  resolveRuntimeVoiceProviderGate,
  type RuntimeVoiceTtsProvider,
  resolveRuntimeVoiceTtsProvider,
  resolveRuntimeVoiceTtsProviderOrder,
} from '../../runtime/bootstrap-helpers.js';
import type { StreamingSttConnector, SttStreamSession } from '../../voice/connectors/stt/index.js';

const log = createComponentLogger('DiscordVoice');
const CAPTURE_SILENCE_MS = 1_200;
const MIN_PCM_BYTES = 32_000;
const STT_STREAM_CHUNK_BYTES = 3_840;
const UNKNOWN_VOICE_ERROR_CODE = 'VOICE_PIPELINE_ERROR';
const DECRYPT_RECOVERY_COOLDOWN_MS = 1_500;
const DECRYPT_RECOVERY_MAX_REJOINS = 3;
const DECRYPT_RECOVERY_WINDOW_MS = 5 * 60_000;

/**
 * Maximum number of consecutive stream errors per user before tearing down
 * that user's receive stream.
 */
const STREAM_ERROR_MAX_FAILURES = 10;

/** Result of checking Opus decoder availability. */
export interface OpusAvailabilityResult {
  available: boolean;
  backend: string | null;
  error: string | null;
}

/**
 * Checks whether an Opus decoder backend is available.
 * Tries prism-media's built-in Opus decoder instantiation.
 * Returns which backend is available (or none with guidance).
 */
export function checkOpusAvailability(): OpusAvailabilityResult {
  try {
    // prism-media tries @discordjs/opus, then node-opus, then opusscript
    const decoder = new prism.opus.Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    // Clean up the test decoder
    decoder.destroy();

    // Determine which backend prism-media resolved to
    let backend: string = 'unknown';
    try {
      // prism-media exposes the resolved package name
      if ('module' in prism.opus && typeof (prism.opus as Record<string, unknown>).module === 'string') {
        backend = (prism.opus as Record<string, unknown>).module as string;
      }
    } catch {
      // Ignore introspection failures
    }

    return { available: true, backend, error: null };
  } catch (error) {
    const message = toErrorMessage(error);
    return {
      available: false,
      backend: null,
      error: message,
    };
  }
}

/**
 * Result of the voice preflight check.
 */
export interface VoicePreflightResult {
  opusAvailable: boolean;
  opusBackend: string | null;
  configComplete: boolean;
  missingConfig: string[];
  canReceive: boolean;
}

/**
 * Runs a preflight check for the voice receive pipeline.
 * Validates Opus decoder availability and configuration completeness.
 * Should be called before enabling voice receive.
 */
export function voicePreflight(config: SubstrateConfig): VoicePreflightResult {
  const opus = checkOpusAvailability();
  const missingConfig: string[] = [];
  const providerGate = resolveRuntimeVoiceProviderGate(config, {
    requireElevenLabsVoiceId: true,
  });

  if (!config.voiceTargetGuildId) missingConfig.push('VOICE_TARGET_GUILD_ID');
  if (!config.voiceTargetUserId) missingConfig.push('VOICE_TARGET_USER_ID');
  if (!providerGate.sttEnabled) missingConfig.push('VOICE_STT_PROVIDER_CONFIG');

  const configComplete = missingConfig.length === 0;
  const canReceive = opus.available && configComplete;

  if (!opus.available) {
    log.error(
      'No Opus decoder found. Voice receive pipeline will be disabled. ' +
      'Install one of: npm install @discordjs/opus (recommended, native), ' +
      'npm install opusscript (JS fallback, slower). ' +
      `Error: ${opus.error}`,
    );
  }

  if (missingConfig.length > 0) {
    log.warn('Voice config incomplete, missing env vars', {
      missing: missingConfig,
    });
  }

  if (canReceive) {
    log.info('Voice preflight passed', {
      opusBackend: opus.backend,
    });
  }

  return {
    opusAvailable: opus.available,
    opusBackend: opus.backend,
    configComplete,
    missingConfig,
    canReceive,
  };
}


type VoiceTurnErrorStage = 'ingest' | 'stt' | 'llm' | 'tts' | 'unknown';
type VoiceTurnObservationKind = 'silence' | 'empty-transcript' | 'empty-response' | 'playback-error';
type VoiceConnectionRecoveryTrigger = 'decrypt-failures' | 'stream-degraded';
type VoiceStreamDegradedPhase = 'degraded-detected' | 'recovery-executed';

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
  eligibilityGate?: EligibilityGate;
}

interface VoiceConnectionStateChange {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  generation: number;
  previousStatus: string;
  status: string;
}

interface ActiveVoiceTurn {
  token: symbol;
  turnId: string;
  channel: VoiceBasedChannel;
  connection: VoiceConnection;
  player: AudioPlayer;
  abortController: AbortController;
  sttSession: SttStreamSession | null;
  ttsSession: TtsSynthesisSession | null;
}

function hasTtsProviderConfig(provider: StreamingTtsProvider, config: SubstrateConfig): boolean {
  try {
    return createRuntimeVoiceTtsConnector(config, {
      provider,
      requireElevenLabsVoiceId: true,
    }) !== null;
  } catch {
    return false;
  }
}

function buildConfiguredTtsConnectors(
  config: SubstrateConfig,
  preferredProviderId: StreamingTtsProvider,
  eligibilityGate?: EligibilityGate,
): StreamingTtsConnector[] {
  const providerOrder = resolveRuntimeVoiceTtsProviderOrder(
    config,
    preferredProviderId,
    { requireElevenLabsVoiceId: true },
  );
  const connectors: StreamingTtsConnector[] = [];

  for (const providerId of providerOrder) {
    try {
      const binding = createRuntimeVoiceTtsConnector(config, {
        provider: providerId,
        requireElevenLabsVoiceId: true,
        eligibilityGate,
      });
      if (binding) {
        connectors.push(binding.connector);
      }
    } catch (error) {
      log.warn('Discord voice TTS connector initialization failed', {
        provider: providerId,
        error: toErrorMessage(error),
      });
    }
  }

  return connectors;
}

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

  constructor({ client, config, eventBus, getHandler, eligibilityGate }: DiscordVoiceRuntimeConfig) {
    this.client = client;
    this.config = config;
    this.eventBus = eventBus;
    this.getHandler = getHandler;
    this.eligibilityGate = eligibilityGate;
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
        if (userId !== this.targetUserId || this.capturing || this.activeTurn) return;
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
    if (this.activeTurn) return;
    if (!this.connection || !this.player || !this.activeChannel || !this.sttConnector || this.ttsConnectors.length === 0) {
      return;
    }

    const turnId = `voice-turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timestampMs = Date.now();
    const turn: ActiveVoiceTurn = {
      token: Symbol(turnId),
      turnId,
      channel: this.activeChannel,
      connection: this.connection,
      player: this.player,
      abortController: new AbortController(),
      sttSession: null,
      ttsSession: null,
    };
    this.activeTurn = turn;
    this.activeTurnId = turnId;
    let turnStatus: 'completed' | 'cancelled' | 'timeout' | 'error' = 'completed';
    let turnReason: string | undefined;

    this.capturing = true;
    try {
      this.assertTurnActive(turn);
      await this.eventBus.emit('voice.turn.start', {
        turnId,
        channelId: turn.channel.id,
        userId: this.targetUserId,
        timestampMs,
      });

      let opusStream: NodeJS.ReadableStream;
      try {
        opusStream = turn.connection.receiver.subscribe(this.targetUserId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: CAPTURE_SILENCE_MS,
          },
        });
      } catch (subscribeError) {
        throw this.createVoiceError({
          error: subscribeError,
          stage: 'ingest',
          code: 'VOICE_SUBSCRIBE_FAILED',
        });
      }

      // Attach a safety error listener immediately to prevent unhandled 'error' event crashes.
      // The actual error handling is in decodeOpusToPcm; this just prevents Node.js from
      // throwing if an error fires before the pipe is set up.
      const safetyErrorHandler = (err: Error): void => {
        log.warn('AudioReceiveStream error caught by safety listener', {
          error: toErrorMessage(err),
          userId: this.targetUserId,
        });
        this.recordStreamError(this.targetUserId);
      };
      opusStream.on('error', safetyErrorHandler);

      const pcm = await runWithVoiceStageBudget({
        stage: 'ingest',
        budgets: this.reliabilityBudgets,
        signal: turn.abortController.signal,
        task: () => this.decodeOpusToPcm(opusStream, turn.abortController.signal),
      });
      this.assertTurnActive(turn);
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
        signal: turn.abortController.signal,
        task: () => this.transcribePcm(pcm, turn),
      });
      this.assertTurnActive(turn);

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
        guildId: turn.channel.guild.id,
        channelId: turn.channel.id,
        userId: this.targetUserId,
        transcript,
      });
      await this.eventBus.emit('voice.stt.final', {
        turnId,
        channelId: turn.channel.id,
        userId: this.targetUserId,
        text: transcript,
        timestampMs: Date.now(),
      });
      this.assertTurnActive(turn);

      const handler = this.getHandler();
      if (!handler) return;

      const member = turn.channel.members.get(this.targetUserId);
      const message: SubstrateMessage = {
        id: `voice-${Date.now()}`,
        channelId: `discord-voice:${turn.channel.id}`,
        channelType: 'discord',
        isDirectMessage: false,
        authorId: this.targetUserId,
        authorName: member?.displayName ?? member?.user.username ?? 'Voice User',
        content: transcript,
        timestamp: new Date(),
      };

      await this.eventBus.emit('message.received', { message });
      const response = await runWithVoiceStageBudget({
        stage: 'llm',
        budgets: this.reliabilityBudgets,
        signal: turn.abortController.signal,
        task: () => handler(message),
      });
      this.assertTurnActive(turn);
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
        channelId: turn.channel.id,
        userId: this.targetUserId,
        text,
        timestampMs: Date.now(),
      });

      await this.speakText(text, turn);
      this.assertTurnActive(turn);
      await this.eventBus.emit('channel.voice.tts.sent', {
        guildId: turn.channel.guild.id,
        channelId: turn.channel.id,
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
      await this.cancelTurnResources(turn, `turn-error:${code}`);
      await this.eventBus.emit('voice.turn.error', {
        turnId,
        channelId: turn.channel.id,
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
        channelId: turn.channel.id,
        userId: this.targetUserId,
        status: turnStatus,
        reason: turnReason,
        timestampMs: Date.now(),
      });
      await this.cancelTurnResources(turn, `turn-${turnStatus}`);
      this.resetTurnStateIfCurrent(turn);
    }
  }

  private async transcribePcm(pcm: Buffer, turn: ActiveVoiceTurn): Promise<string> {
    if (!this.sttConnector) return '';

    const session = await this.sttConnector.startStream({
      sampleRateHz: 48_000,
      channels: 2,
      encoding: 'pcm_s16le',
      model: this.config.deepgramModel,
      interimResults: true,
    }, turn.abortController.signal);
    turn.sttSession = session;

    let finalTranscript = '';
    let latestPartial = '';
    let streamError: unknown;

    const writerPromise = this.writePcmToSttSession(session, pcm, turn.abortController.signal);

    try {
      for await (const chunk of session.transcripts) {
        this.assertTurnActive(turn);

        const transcriptText = chunk.text.trim();
        if (!transcriptText) continue;

        if (chunk.type === 'partial') {
          latestPartial = transcriptText;
          await this.eventBus.emit('channel.voice.transcript.partial', {
            guildId: turn.channel.guild.id,
            channelId: turn.channel.id,
            userId: this.targetUserId,
            transcript: transcriptText,
            confidence: chunk.confidence,
            startMs: chunk.startMs,
            endMs: chunk.endMs,
          });
          await this.eventBus.emit('voice.stt.partial', {
            turnId: turn.turnId,
            channelId: turn.channel.id,
            userId: this.targetUserId,
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
      if (!streamError) {
        streamError = error;
      }
    } finally {
      if (turn.sttSession === session) {
        turn.sttSession = null;
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

  private async writePcmToSttSession(session: SttStreamSession, pcm: Buffer, signal?: AbortSignal): Promise<void> {
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

  private async speakText(text: string, turn?: ActiveVoiceTurn): Promise<void> {
    const player = turn?.player ?? this.player;
    if (!player) return;
    if (turn) {
      this.assertTurnActive(turn);
    }

    const safeText = validateTtsInputText(text, this.securityLimits);
    if (!safeText) return;

    const connectorOrder = buildFallbackOrder(
      this.preferredTtsProviderId,
      this.ttsConnectors.map((connector) => connector.id),
    );
    const firstConnectorId = connectorOrder[0] ?? this.preferredTtsProviderId;
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
      signal: turn?.abortController.signal,
      task: async () => {
        await this.playWithTtsConnector(selected.value, safeText, turn);
      },
    });
  }

  private async playWithTtsConnector(
    connector: StreamingTtsConnector,
    text: string,
    turn?: ActiveVoiceTurn,
  ): Promise<void> {
    try {
      if (turn) {
        this.assertTurnActive(turn);
      }
      const streamSession = await connector.synthesizeStream({
        text,
        encoding: 'mp3',
        allowBufferFallback: false,
      }, turn?.abortController.signal);
      if (turn) {
        turn.ttsSession = streamSession;
      }
      await this.playTtsSession(streamSession, turn);
    } catch (error) {
      if (turn?.abortController.signal.aborted || this.classifyTurnStatus(error) === 'cancelled') {
        throw error;
      }

      const errorText = toErrorMessage(error);
      log.warn('Streaming TTS failed, using buffered fallback', {
        provider: connector.id,
        error: errorText,
      });

      try {
        if (turn) {
          this.assertTurnActive(turn);
        }

        const audio = await connector.synthesizeBuffer({ text, encoding: 'mp3' }, turn?.abortController.signal);
        validateTtsAudioChunk(audio, 0, this.securityLimits);
        if (turn?.turnId) {
          await this.eventBus.emit('voice.tts.first-byte', {
            turnId: turn.turnId,
            channelId: turn.channel.id,
            userId: this.targetUserId,
            timestampMs: Date.now(),
          });
        }
        await this.playReadableAudio(Readable.from(audio), turn);
      } catch (fallbackError) {
        throw this.createVoiceError({
          error: fallbackError,
          stage: 'tts',
          code: 'VOICE_TTS_FALLBACK_FAILED',
        });
      }
    }
  }

  private async playTtsSession(session: TtsSynthesisSession, turn?: ActiveVoiceTurn): Promise<void> {
    try {
      await this.playReadableAudio(Readable.from(this.createPlaybackChunkIterator(session.audio, turn)), turn);
    } finally {
      const reason = turn?.abortController.signal.aborted ? 'playback-aborted' : 'playback-finished';
      await session.cancel(reason).catch(() => undefined);
      if (turn && turn.ttsSession === session) {
        turn.ttsSession = null;
      }
    }
  }

  private async *createPlaybackChunkIterator(
    audio: AsyncIterable<TtsAudioChunk>,
    turn?: ActiveVoiceTurn,
  ): AsyncGenerator<Buffer> {
    let totalAudioBytes = 0;
    let emittedFirstByte = false;

    for await (const chunk of audio) {
      if (turn) {
        this.assertTurnActive(turn);
      }

      totalAudioBytes = validateTtsAudioChunk(chunk.audio, totalAudioBytes, this.securityLimits);
      if (chunk.audio.byteLength === 0) continue;

      if (!emittedFirstByte && turn?.turnId) {
        emittedFirstByte = true;
        await this.eventBus.emit('voice.tts.first-byte', {
          turnId: turn.turnId,
          channelId: turn.channel.id,
          userId: this.targetUserId,
          timestampMs: Date.now(),
        });
      }

      yield Buffer.isBuffer(chunk.audio) ? chunk.audio : Buffer.from(chunk.audio);
    }
  }

  private async playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void> {
    const player = turn?.player ?? this.player;
    if (!player) return;
    if (turn) {
      this.assertTurnActive(turn);
    }

    const resource = createAudioResource(audio);
    player.play(resource);

    try {
      await runWithVoiceStageBudget({
        stage: 'output',
        budgets: this.reliabilityBudgets,
        signal: turn?.abortController.signal,
        task: async () => {
          await entersState(player, AudioPlayerStatus.Playing, 5_000);
          await entersState(player, AudioPlayerStatus.Idle, 120_000);
        },
      });
    } catch (error) {
      if (this.classifyTurnStatus(error) === 'cancelled') {
        throw error;
      }

      const playbackError = this.createVoiceError({
        error,
        stage: 'tts',
        code: 'VOICE_PLAYBACK_FAILED',
      });
      await this.emitTurnObservation({
        turnId: turn?.turnId ?? this.activeTurnId ?? undefined,
        stage: 'tts',
        kind: 'playback-error',
        detail: {
          error: playbackError.message,
        },
      });
      throw playbackError;
    }
  }

  private async decodeOpusToPcm(opusStream: NodeJS.ReadableStream, signal?: AbortSignal): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let decoder: InstanceType<typeof prism.opus.Decoder>;

      try {
        decoder = new prism.opus.Decoder({
          rate: 48_000,
          channels: 2,
          frameSize: 960,
        });
      } catch (error) {
        const msg = toErrorMessage(error);
        log.error('Failed to create Opus decoder. Install @discordjs/opus or opusscript.', {
          error: msg,
        });
        reject(this.createVoiceError({
          error: new Error(`Opus decoder unavailable: ${msg}`),
          stage: 'ingest',
          code: 'VOICE_OPUS_UNAVAILABLE',
        }));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

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
      const onEnd = (): void => {
        succeed();
      };
      const onDecoderError = (error: Error): void => {
        log.warn('Opus decoder error (contained)', {
          error: toErrorMessage(error),
        });
        fail(this.createVoiceError({
          error,
          stage: 'ingest',
          code: 'VOICE_OPUS_DECODE_FAILED',
        }));
      };
      const onOpusError = (error: Error): void => {
        log.warn('AudioReceiveStream error (contained)', {
          error: toErrorMessage(error),
        });
        // Track per-user failures
        this.recordStreamError(this.targetUserId);
        fail(this.createVoiceError({
          error,
          stage: 'ingest',
          code: 'VOICE_RECEIVE_STREAM_ERROR',
        }));
      };
      const onAbort = (): void => {
        fail(new Error('Voice capture aborted'));
      };

      const cleanup = (): void => {
        decoder.off('data', onData);
        decoder.off('end', onEnd);
        decoder.off('error', onDecoderError);
        opusStream.off('error', onOpusError);
        signal?.removeEventListener('abort', onAbort);
        // Ensure decoder is properly destroyed
        try {
          decoder.destroy();
        } catch {
          // Ignore cleanup errors
        }
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

  /**
   * Record a stream error for a given user. If the error count exceeds the
   * threshold, the stream is considered degraded and a warning is emitted.
   */
  private recordStreamError(userId: string): void {
    const count = (this.streamErrorCounts.get(userId) ?? 0) + 1;
    this.streamErrorCounts.set(userId, count);

    if (count < STREAM_ERROR_MAX_FAILURES) {
      return;
    }

    log.error('Stream error threshold exceeded for user; tearing down receive stream', {
      userId,
      errorCount: count,
      threshold: STREAM_ERROR_MAX_FAILURES,
    });
    this.streamErrorCounts.delete(userId);

    const recoveryChannel = this.activeChannel;
    const recoveryGeneration = this.connectionGeneration;
    this.emitStreamDegradedTelemetry({
      phase: 'degraded-detected',
      userId,
      errorCount: count,
      threshold: STREAM_ERROR_MAX_FAILURES,
      channel: recoveryChannel,
      generation: recoveryGeneration,
    });

    if (!recoveryChannel || !this.connection) {
      log.warn('Stream degradation threshold exceeded without active connection; skipping recovery', {
        userId,
        errorCount: count,
        threshold: STREAM_ERROR_MAX_FAILURES,
      });
      return;
    }

    void this.startDecryptRecovery({
      channel: recoveryChannel,
      generation: recoveryGeneration,
      failureCount: count,
      tolerance: STREAM_ERROR_MAX_FAILURES,
      trigger: 'stream-degraded',
      degradedUserId: userId,
      degradedErrorCount: count,
    });
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
    const { phase, userId, errorCount, threshold, generation, recoveryAttempt } = params;
    const channel = params.channel ?? this.activeChannel;
    const payload: Record<string, unknown> = {
      phase,
      userId,
      channelId: channel?.id,
      guildId: channel?.guild.id,
      generation,
      errorCount,
      threshold,
      recoveryAttempt,
      timestampMs: Date.now(),
    };

    // voice.stream.degraded is a telemetry-only channel event not part of EventMap.
    const emitUntyped = this.eventBus.emit.bind(this.eventBus) as unknown as (
      event: string,
      data: Record<string, unknown>,
    ) => Promise<void>;
    emitUntyped('voice.stream.degraded', payload).catch(() => undefined);
  }

  /**
   * Reset stream error tracking, typically called when joining a new channel.
   */
  private resetStreamErrorCounts(): void {
    this.streamErrorCounts.clear();
  }

  private nonBotMemberCount(channel: VoiceBasedChannel): number {
    return channel.members.filter(member => !member.user.bot).size;
  }

  private assertTurnActive(turn: ActiveVoiceTurn): void {
    if (this.activeTurn?.token !== turn.token || turn.abortController.signal.aborted) {
      throw new Error('Voice turn aborted');
    }
  }

  private resetTurnStateIfCurrent(turn: ActiveVoiceTurn): void {
    if (this.activeTurn?.token !== turn.token) return;

    this.activeTurn = null;
    this.activeTurnId = null;
    this.capturing = false;
  }

  private async cancelTurnResources(turn: ActiveVoiceTurn, reason: string): Promise<void> {
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

  private async cancelActiveTurn(reason: string): Promise<void> {
    const turn = this.activeTurn;
    if (!turn) return;

    await this.cancelTurnResources(turn, reason);
    this.resetTurnStateIfCurrent(turn);
  }

  private emitVoiceError(error: unknown): void {
    void this.cancelActiveTurn('voice-error');

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
    }).catch((err) => { log.debug('Failed to emit voice error event', { error: String(err) }); });

    if (!voiceError.voiceTurnErrorEmitted) {
      this.eventBus.emit('voice.turn.error', {
        turnId: this.activeTurnId ?? undefined,
        channelId: this.activeChannel?.id,
        userId: this.targetUserId,
        stage,
        code,
        error: errorText,
        timestampMs: Date.now(),
      }).catch((err) => { log.debug('Failed to emit voice turn error event', { error: String(err) }); });
    }

    this.trackDecryptFailure({
      stage,
      code,
      errorText,
    });
  }

  private resetDecryptFailureTracking(generation: number): void {
    this.decryptFailureGeneration = generation;
    this.decryptFailureCount = 0;
  }

  private trackDecryptFailure(params: {
    stage: VoiceTurnErrorStage;
    code: string;
    errorText: string;
  }): void {
    if (!this.connection || !this.activeChannel || this.decryptRecoveryInFlight) {
      return;
    }

    const { stage, code, errorText } = params;
    if (!this.isRecoverableDecryptFailure(stage, code, errorText)) {
      return;
    }

    const generation = this.connectionGeneration;
    if (this.decryptFailureGeneration !== generation) {
      this.resetDecryptFailureTracking(generation);
    }

    this.decryptFailureCount += 1;

    log.warn('Voice decrypt/ingest failure detected', {
      guildId: this.activeChannel.guild.id,
      channelId: this.activeChannel.id,
      userId: this.targetUserId,
      generation,
      failureCount: this.decryptFailureCount,
      failureTolerance: this.decryptionFailureTolerance,
      code,
      error: errorText,
    });

    if (this.decryptFailureCount <= this.decryptionFailureTolerance) {
      return;
    }

    const recoveryChannel = this.activeChannel;

    void this.startDecryptRecovery({
      channel: recoveryChannel,
      generation,
      failureCount: this.decryptFailureCount,
    });
  }

  private isRecoverableDecryptFailure(stage: VoiceTurnErrorStage, code: string, errorText: string): boolean {
    if (stage !== 'ingest') {
      return false;
    }

    const normalized = `${code} ${errorText}`.toLowerCase();
    if (normalized.includes('abort') || normalized.includes('cancel')) {
      return false;
    }

    return ['decrypt', 'decode', 'opus', 'dave'].some((token) => normalized.includes(token));
  }

  private pruneDecryptRecoveryAttempts(nowMs: number): void {
    this.decryptRecoveryAttempts = this.decryptRecoveryAttempts
      .filter((attemptMs) => nowMs - attemptMs <= DECRYPT_RECOVERY_WINDOW_MS);
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
    const {
      channel,
      generation,
      failureCount,
      tolerance = this.decryptionFailureTolerance,
      trigger = 'decrypt-failures',
      degradedUserId = this.targetUserId,
      degradedErrorCount = failureCount,
    } = params;
    if (this.decryptRecoveryInFlight) {
      return;
    }

    this.decryptRecoveryInFlight = true;

    try {
      const nowMs = Date.now();
      this.pruneDecryptRecoveryAttempts(nowMs);

      if (this.decryptRecoveryAttempts.length >= DECRYPT_RECOVERY_MAX_REJOINS) {
        const exhaustedPayload = {
          guildId: channel.guild.id,
          channelId: channel.id,
          userId: this.targetUserId,
          generation,
          failureCount,
          tolerance,
          maxAttempts: DECRYPT_RECOVERY_MAX_REJOINS,
          windowMs: DECRYPT_RECOVERY_WINDOW_MS,
          timestampMs: nowMs,
        };
        const exhaustedPrefix = trigger === 'stream-degraded'
          ? 'Voice stream recovery exhausted'
          : 'Voice decrypt recovery exhausted';
        const errorText = (
          `${exhaustedPrefix} after ${DECRYPT_RECOVERY_MAX_REJOINS} rejoins ` +
          `in ${Math.floor(DECRYPT_RECOVERY_WINDOW_MS / 1_000)} seconds`
        );

        await this.eventBus.emit('voice.connection.recovery.exhausted', exhaustedPayload);
        await this.eventBus.emit('channel.voice.error', {
          guildId: channel.guild.id,
          channelId: channel.id,
          userId: this.targetUserId,
          error: errorText,
        });

        log.error('Voice connection recovery exhausted; operator intervention required', {
          ...exhaustedPayload,
          trigger,
          error: errorText,
        });
        await this.leaveChannel(trigger === 'stream-degraded' ? 'stream-recovery-exhausted' : 'decrypt-recovery-exhausted');
        return;
      }

      const attempt = this.decryptRecoveryAttempts.length + 1;
      this.decryptRecoveryAttempts.push(nowMs);

      const recoveryPayload = {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: this.targetUserId,
        generation,
        failureCount,
        tolerance,
        attempt,
        maxAttempts: DECRYPT_RECOVERY_MAX_REJOINS,
        windowMs: DECRYPT_RECOVERY_WINDOW_MS,
        cooldownMs: DECRYPT_RECOVERY_COOLDOWN_MS,
        timestampMs: nowMs,
      };

      await this.eventBus.emit('voice.connection.recovery', recoveryPayload);
      if (trigger === 'stream-degraded') {
        this.emitStreamDegradedTelemetry({
          phase: 'recovery-executed',
          userId: degradedUserId,
          errorCount: degradedErrorCount,
          threshold: STREAM_ERROR_MAX_FAILURES,
          channel,
          generation,
          recoveryAttempt: attempt,
        });
      }

      log.warn('Recovering voice connection after repeated failures', {
        ...recoveryPayload,
        trigger,
      });

      await this.leaveChannel(trigger === 'stream-degraded' ? 'stream-recovery' : 'decrypt-recovery');
      await this.wait(DECRYPT_RECOVERY_COOLDOWN_MS);

      if (this.activeChannel) {
        log.info('Skipping recovery rejoin because another channel is already active', {
          ...recoveryPayload,
          trigger,
          activeChannelId: this.activeChannel.id,
        });
        return;
      }

      await this.joinChannel(channel);
      log.info('Voice connection recovered after repeated failures', {
        ...recoveryPayload,
        trigger,
      });
    } catch (error) {
      const errorText = toErrorMessage(error);
      log.error('Voice connection recovery failed', {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: this.targetUserId,
        generation,
        trigger,
        error: errorText,
      });
      const recoveryLabel = trigger === 'stream-degraded' ? 'stream' : 'decrypt';
      await this.eventBus.emit('channel.voice.error', {
        guildId: channel.guild.id,
        channelId: channel.id,
        userId: this.targetUserId,
        error: `Voice ${recoveryLabel} recovery failed: ${errorText}`,
      });
    } finally {
      this.decryptRecoveryInFlight = false;
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private classifyTurnStatus(error: unknown): 'completed' | 'cancelled' | 'timeout' | 'error' {
    const text = (toErrorMessage(error)).toLowerCase();
    if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
    if (text.includes('cancel') || text.includes('abort') || text.includes('interrupt')) return 'cancelled';
    return 'error';
  }

  private resolveVoiceErrorStage(error: unknown): VoiceTurnErrorStage {
    if (error && typeof error === 'object') {
      const stage = (error as StructuredVoiceError).voiceStage;
      if (stage) return stage;
    }

    const text = (toErrorMessage(error)).toLowerCase();
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

    const text = (toErrorMessage(error))
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

    const message = toErrorMessage(error);
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
    const resolvedTurnId = turnId ?? this.activeTurnId ?? `voice-observation-${Date.now()}`;
    const payload = {
      turnId: resolvedTurnId,
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
