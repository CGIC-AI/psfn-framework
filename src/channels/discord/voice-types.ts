import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { Client, VoiceBasedChannel } from 'discord.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { RuntimeVoiceTtsProvider } from '../../app/startup/support/bootstrap-helpers.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { StreamingSttConnector, SttStreamSession } from '../../primitives/voice/connectors/stt/index.js';
import type { StreamingTtsConnector, TtsSynthesisSession } from '../../primitives/voice/connectors/tts/index.js';
import type { VoiceReliabilityBudgets } from '../../primitives/voice/policy/reliability.js';
import type { VoiceSecurityLimits } from '../../primitives/voice/policy/security.js';
import type { MessageHandler } from '../backplane/types.js';

export const CAPTURE_SILENCE_MS = 1_200;
export const MIN_PCM_BYTES = 32_000;
export const STT_STREAM_CHUNK_BYTES = 3_840;
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

export interface VoiceRuntimeBaseContext {
  eventBus: EventBus;
  targetUserId: string;
  activeChannel: VoiceBasedChannel | null;
  activeTurnId: string | null;
}

export interface VoiceTurnRuntimeContext extends VoiceRuntimeBaseContext {
  config: SubstrateConfig;
  connection: VoiceConnection | null;
  player: AudioPlayer | null;
  sttConnector?: StreamingSttConnector;
  ttsConnectors: StreamingTtsConnector[];
  reliabilityBudgets: VoiceReliabilityBudgets;
  securityLimits: VoiceSecurityLimits;
  activeTurn: ActiveVoiceTurn | null;
  capturing: boolean;
  preferredTtsProviderId: RuntimeVoiceTtsProvider;
  getHandler: () => MessageHandler | null;
  emitTurnObservation(params: {
    turnId?: string;
    stage: VoiceTurnErrorStage;
    kind: VoiceTurnObservationKind;
    detail?: Record<string, unknown>;
  }): Promise<void>;
}

export interface VoiceRecoveryRuntimeContext extends VoiceRuntimeBaseContext {
  connection: VoiceConnection | null;
  connectionGeneration: number;
  decryptFailureGeneration: number;
  decryptFailureCount: number;
  decryptRecoveryAttempts: number[];
  decryptRecoveryInFlight: boolean;
  decryptionFailureTolerance: number;
  streamErrorCounts: Map<string, number>;
  leaveChannel(reason: string): Promise<void>;
  joinChannel(channel: VoiceBasedChannel): Promise<void>;
}
