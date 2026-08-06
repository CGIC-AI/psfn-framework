import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import type { Readable } from 'node:stream';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { RuntimeVoiceTtsProvider } from '../../app/startup/support/bootstrap-helpers.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { StreamingSttConnector, SttStreamSession } from '../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsConnector, TtsSynthesisSession } from '../../primitives/voice/connectors/tts/index.js';
import type { VoiceReliabilityBudgets } from '../../primitives/voice/policy/reliability.js';
import type { VoiceSecurityLimits } from '../../primitives/voice/policy/security.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import type { MessageHandler } from '../backplane/types.js';

export const CAPTURE_SILENCE_MS = 1_200;
export const MIN_PCM_BYTES = 32_000;
export const UNKNOWN_VOICE_ERROR_CODE = 'VOICE_PIPELINE_ERROR';
export const DECRYPT_RECOVERY_COOLDOWN_MS = 1_500;
export const DECRYPT_RECOVERY_MAX_REJOINS = 3;
export const DECRYPT_RECOVERY_WINDOW_MS = 5 * 60_000;
export const STREAM_ERROR_MAX_FAILURES = 10;

export interface OpusAvailabilityResult {
  available: boolean;
  backend: string | null;
  error: string | null;
}

export interface VoicePreflightResult {
  opusAvailable: boolean;
  opusBackend: string | null;
  configComplete: boolean;
  missingConfig: string[];
  canReceive: boolean;
}

export type VoiceTurnErrorStage = 'ingest' | 'stt' | 'llm' | 'tts' | 'unknown';
export type VoiceTurnObservationKind = 'silence' | 'empty-transcript' | 'empty-response' | 'playback-error';
export type VoiceConnectionRecoveryTrigger = 'decrypt-failures' | 'stream-degraded';
export type VoiceStreamDegradedPhase = 'degraded-detected' | 'recovery-executed';

export interface StructuredVoiceError extends Error {
  voiceStage?: VoiceTurnErrorStage;
  voiceCode?: string;
  voiceTurnErrorEmitted?: boolean;
}

export interface DiscordVoiceRuntimeConfig {
  client: Client;
  config: SubstrateConfig;
  eventBus: EventBus;
  getHandler: () => MessageHandler | null;
  eligibilityGate?: EligibilityGate;
  /**
   * htm9.9: intake screening for voice transcripts (sourceClass
   * 'audio_transcript') — a transcript becomes prompt text, so audio is a
   * real injection channel. Null when the firewall mode is 'off'.
   */
  intakeScreening?: IntakeScreeningService | null;
}

export interface VoiceConnectionStateChange {
  connection: VoiceConnection;
  channel: VoiceBasedChannel;
  generation: number;
  previousStatus: string;
  status: string;
}

export interface ActiveVoiceTurn {
  token: symbol;
  turnId: string;
  channel: VoiceBasedChannel;
  connection: VoiceConnection;
  player: AudioPlayer;
  abortController: AbortController;
  sttSession: SttStreamSession | null;
  ttsSession: TtsSynthesisSession | null;
}

/**
 * Result of streaming an opus capture through STT. `transcript` is the final
 * assembled transcript (the sole downstream firewall/model input); `pcmBytes`
 * is the total decoded PCM streamed, used for the MIN_PCM_BYTES silence gate
 * applied on the total after capture ends.
 */
export interface VoiceStreamTranscription {
  transcript: string;
  pcmBytes: number;
}

export interface VoiceRuntimeBaseContext {
  readonly eventBus: EventBus;
  readonly targetUserId: string;
  readonly activeChannel: VoiceBasedChannel | null;
  activeTurnId: string | null;
}

export interface VoiceTurnStateContext extends VoiceRuntimeBaseContext {
  readonly config: SubstrateConfig;
  activeTurn: ActiveVoiceTurn | null;
  capturing: boolean;
}

export interface VoiceTurnRuntimeContext extends VoiceTurnStateContext {
  readonly connection: VoiceConnection | null;
  readonly player: AudioPlayer | null;
  readonly sttConnector?: StreamingSttConnector;
  readonly ttsConnectors: StreamingTtsConnector[];
  readonly reliabilityBudgets: VoiceReliabilityBudgets;
  readonly securityLimits: VoiceSecurityLimits;
  /**
   * mmo9.7.5: last spoken assistant utterance, replayed locally
   * on a deterministic "repeat" control intent without a model turn.
   */
  lastAssistantUtterance: string | null;
  readonly preferredTtsProviderId: RuntimeVoiceTtsProvider;
  /** htm9.9: screens transcripts as 'audio_transcript' intake before prompt use. */
  readonly intakeScreening: IntakeScreeningService | null;
  readonly getHandler: () => MessageHandler | null;
  recordStreamError(userId: string): void;
  transcribeOpusStream(
    opusStream: NodeJS.ReadableStream,
    turn: ActiveVoiceTurn,
  ): Promise<VoiceStreamTranscription>;
  speakText(text: string, turn?: ActiveVoiceTurn): Promise<void>;
  playWithTtsConnector(
    connector: StreamingTtsConnector,
    text: string,
    turn?: ActiveVoiceTurn,
  ): Promise<void>;
  playReadableAudio(audio: Readable, turn?: ActiveVoiceTurn): Promise<void>;
  decodeOpusToPcmStream(
    opusStream: NodeJS.ReadableStream,
    signal?: AbortSignal,
  ): NodeJS.ReadableStream;
  cancelTurnResources(turn: ActiveVoiceTurn, reason: string): Promise<void>;
  emitTurnObservation(params: {
    turnId?: string;
    stage: VoiceTurnErrorStage;
    kind: VoiceTurnObservationKind;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

export interface VoiceRecoveryRuntimeContext extends VoiceTurnStateContext {
  readonly connection: VoiceConnection | null;
  readonly connectionGeneration: number;
  decryptFailureGeneration: number;
  decryptFailureCount: number;
  decryptRecoveryAttempts: number[];
  decryptRecoveryInFlight: boolean;
  readonly decryptionFailureTolerance: number;
  readonly streamErrorCounts: Map<string, number>;
  leaveChannel(reason: string): Promise<void>;
  joinChannel(channel: VoiceBasedChannel): Promise<void>;
}

/**
 * Compiler-checked structural view of DiscordVoiceRuntime used by the split
 * turn and recovery helpers. The class keeps its state private; a typed adapter
 * binds that state to this contract without weakening it through casts.
 */
export interface DiscordVoiceRuntimeContext
  extends VoiceTurnRuntimeContext, VoiceRecoveryRuntimeContext {}
