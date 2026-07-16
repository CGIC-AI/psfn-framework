import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import dotenv from "dotenv";
import {
  loadHubDeviceRegistryAuthority,
  type HubDeviceRegistryAuthority,
} from "../hub/device-registry.js";
import {
  createHubDeviceAssertionIssuer,
  type HubDeviceAssertionIssuer,
} from "../hub/device-assertion.js";

import {
  CAPABILITY_PROFILE_DEFAULTS,
  DEFAULT_ENDPOINT_DISPLAY_NAME,
  DEFAULT_ENDPOINT_ID,
  DEFAULT_PSFN_CHANNEL_TYPE,
  DEFAULT_SATELLITE_ID,
  DEFAULT_CAPABILITY_PROFILE,
  SATELLITE_CLAIM_NAMESPACE,
  normalizeSatelliteClaimConfig,
  type PsfnClientCertificateConfig,
  type PsfnSatelliteClaimConfig,
  type SatelliteCapabilityProfile,
  type SatelliteEndpointClass,
  type SatelliteLocationMode,
  type SatelliteTelemetryCategory,
  type SatelliteTelemetryMode,
} from "../hub/satellite-claim.js";

const MAX_NODE_TIMER_MS = 2_147_483_647;

export interface PsfnRuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey?: string;
  channelType: string;
  satelliteClaim: PsfnSatelliteClaimConfig;
  deviceAssertionIssuer?: HubDeviceAssertionIssuer;
  /**
   * Total wall-clock budget for producing a voice-turn reply, across all
   * attempts. When an attempt returns an empty completion the adapter may
   * retry within this budget; once it elapses the turn fails closed so the
   * voice client is never left waiting on an unbounded fallback.
   */
  voiceReplyDeadlineMs: number;
  /** Per-attempt timeout, clamped to the remaining reply deadline. */
  voiceAttemptTimeoutMs: number;
  /**
   * Total wall-clock budget for authenticated typed turns. The 80 second
   * default leaves 10 seconds for Hub error delivery before the framework's
   * current 90 second API request timeout.
   */
  textReplyDeadlineMs: number;
  /** Per-attempt timeout for typed turns, clamped to their remaining deadline. */
  textAttemptTimeoutMs: number;
}

export interface CompanionBridgeIdentity {
  satelliteId: string;
  endpointId: string;
  claimType: string;
}

export interface CompanionBridgeConfig {
  baseUrl: string;
  apiKey?: string;
  identity: CompanionBridgeIdentity;
  previewMaxBytes: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
}

export interface HomeAssistantConfig {
  baseUrl: string;
  token: string;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  requestTimeoutMs: number;
}

export interface HubControlConfig {
  bindHost: string;
  port: number;
  token: string;
  maxBodyBytes: number;
}

export interface HubConfig {
  textOnlyMode: boolean;
  bindHost: string;
  port: number;
  deepgramApiKey: string | null;
  elevenlabsApiKey: string | null;
  elevenlabsVoiceId: string | null;
  elevenlabsModelId: string;
  artifactsRoot: string;
  psfn: PsfnRuntimeConfig;
  companion: CompanionBridgeConfig | null;
  homeAssistant: HomeAssistantConfig | null;
  control: HubControlConfig | null;
  deviceRegistry: HubDeviceRegistryAuthority | null;
  voxta: VoxtaFacadeConfig;
  sessionTtlSeconds: number;
}

export interface VoxtaFacadeConfig {
  enabled: boolean;
  satelliteId: string;
  satelliteName: string;
  sessionId: string | null;
  chatId: string | null;
  assistantId: string;
  assistantName: string;
  userId: string;
  userName: string;
  appLabel: string;
  clientVersion: string;
  publicBaseUrl: string | null;
  audioFolder: string | null;
  sttStreamEnabled: boolean;
  visionCaptureTimeoutMs: number;
  actionAllowlist: string[];
}

export interface PiClientConfig {
  hubUrl: string;
  deviceCredential?: string;
  relayDeviceCredential?: string;
  deviceId: string;
  deviceName: string;
  conversationId?: string;
  realtimeAudioEnabled: boolean;
  relayRequestTimeoutMs: number;
  amicaBridge: AmicaBridgeConfig | null;
  control: PiClientControlConfig | null;
  inputCommand: string[];
  outputCommand: string[];
  sampleRate: number;
  startThreshold: number;
  continueThreshold: number;
  ambientStartRatio: number;
  interruptRatio: number;
  startChunks: number;
  releaseMs: number;
  initialSilenceMs: number;
  endSilenceMs: number;
  maxTurnMs: number;
  prerollChunks: number;
  prerollLeadChunks: number;
  micGain: number;
  ducking: {
    mixerCard: string;
    mixerControl: string;
    duckPercent: number;
  } | null;
}

export interface AmicaBridgeConfig {
  endpointUrl: string;
  token: string;
  ownerMode: boolean;
  requestTimeoutMs: number;
}

export interface PiClientControlConfig {
  bindHost: string;
  port: number;
}

export function resolveProjectRoot(): string {
  return process.cwd();
}

export function loadProjectEnv(projectRoot: string): void {
  const projectEnv = path.join(projectRoot, ".env");
  if (fs.existsSync(projectEnv)) {
    dotenv.config({ path: projectEnv, override: false });
  }
}

export function loadPsfnRuntime(projectRoot: string): PsfnRuntimeConfig {
  const baseUrl = required("PSFN_API_BASE_URL");
  const model = process.env.PSFN_MODEL?.trim() || "psfn";
  const apiKey = process.env.PSFN_API_KEY?.trim() || undefined;
  const capabilityProfile = parseCapabilityProfile(process.env.PSFN_CAPABILITY_PROFILE) ?? DEFAULT_CAPABILITY_PROFILE;
  const profileDefaults = CAPABILITY_PROFILE_DEFAULTS[capabilityProfile];
  const claimNamespace = process.env.PSFN_CLAIM_NAMESPACE?.trim() || SATELLITE_CLAIM_NAMESPACE;
  const satelliteClaim = normalizeSatelliteClaimConfig({
    namespace: claimNamespace,
    type: process.env.PSFN_CLAIM_TYPE?.trim() || capabilityProfile,
    channelType: process.env.PSFN_CHANNEL_TYPE?.trim() || claimNamespace || DEFAULT_PSFN_CHANNEL_TYPE,
    satelliteId: process.env.PSFN_SATELLITE_ID?.trim() || DEFAULT_SATELLITE_ID,
    endpointId: process.env.PSFN_ENDPOINT_ID?.trim() || process.env.PSFN_SATELLITE_ID?.trim() || DEFAULT_ENDPOINT_ID,
    displayName: process.env.PSFN_ENDPOINT_NAME?.trim() || DEFAULT_ENDPOINT_DISPLAY_NAME,
    endpointClass: parseEndpointClass(process.env.PSFN_ENDPOINT_CLASS) ?? profileDefaults.endpointClass,
    locationMode: parseLocationMode(process.env.PSFN_LOCATION_MODE) ?? profileDefaults.locationMode,
    capabilityProfile,
    telemetry: {
      mode: parseTelemetryMode(process.env.PSFN_TELEMETRY_MODE) ?? profileDefaults.telemetry.mode,
      categories: process.env.PSFN_TELEMETRY_CATEGORIES
        ? parseTelemetryCategories(process.env.PSFN_TELEMETRY_CATEGORIES)
        : profileDefaults.telemetry.categories,
    },
    tls: loadPsfnClientCertificateConfig(projectRoot),
  });
  const voiceBudget = loadReplyBudget(
    "PSFN_VOICE_REPLY_DEADLINE_MS",
    "PSFN_VOICE_ATTEMPT_TIMEOUT_MS",
    8_000,
    6_000,
  );
  const textBudget = loadReplyBudget(
    "PSFN_TEXT_REPLY_DEADLINE_MS",
    "PSFN_TEXT_ATTEMPT_TIMEOUT_MS",
    80_000,
    75_000,
    80_000,
  );
  validateReplyBudget(
    "PSFN_VOICE_ATTEMPT_TIMEOUT_MS",
    voiceBudget.attemptTimeoutMs,
    "PSFN_VOICE_REPLY_DEADLINE_MS",
    voiceBudget.replyDeadlineMs,
  );
  validateReplyBudget(
    "PSFN_TEXT_ATTEMPT_TIMEOUT_MS",
    textBudget.attemptTimeoutMs,
    "PSFN_TEXT_REPLY_DEADLINE_MS",
    textBudget.replyDeadlineMs,
  );
  return {
    model,
    baseUrl,
    apiKey,
    channelType: satelliteClaim.channelType,
    satelliteClaim,
    voiceReplyDeadlineMs: voiceBudget.replyDeadlineMs,
    voiceAttemptTimeoutMs: voiceBudget.attemptTimeoutMs,
    textReplyDeadlineMs: textBudget.replyDeadlineMs,
    textAttemptTimeoutMs: textBudget.attemptTimeoutMs,
  };
}

export function loadCompanionBridgeConfig(
  satelliteClaim: PsfnSatelliteClaimConfig,
): CompanionBridgeConfig | null {
  const baseUrl = optional("PSFN_COMPANION_BASE_URL");
  if (!baseUrl) {
    return null;
  }
  const identity: CompanionBridgeIdentity = {
    satelliteId: satelliteClaim.satelliteId?.trim() || "",
    endpointId: satelliteClaim.endpointId?.trim() || "",
    claimType: satelliteClaim.type?.trim() || "",
  };
  if (!identity.satelliteId || !identity.endpointId || !identity.claimType) {
    throw new Error(
      "PSFN_COMPANION_BASE_URL requires a complete satellite registry identity "
      + "(PSFN_SATELLITE_ID, PSFN_ENDPOINT_ID, and PSFN_CLAIM_TYPE or PSFN_CAPABILITY_PROFILE)",
    );
  }
  const normalizedBaseUrl = new URL(baseUrl).toString().replace(/\/+$/, "");
  const previewMaxBytes = Number.parseInt(process.env.PSFN_COMPANION_PREVIEW_MAX_BYTES || "1048576", 10);
  if (!Number.isInteger(previewMaxBytes) || previewMaxBytes <= 0) {
    throw new Error("PSFN_COMPANION_PREVIEW_MAX_BYTES must be a positive integer");
  }
  const reconnectBaseMs = Number.parseInt(process.env.PSFN_COMPANION_RECONNECT_BASE_MS || "1000", 10);
  if (!Number.isInteger(reconnectBaseMs) || reconnectBaseMs <= 0) {
    throw new Error("PSFN_COMPANION_RECONNECT_BASE_MS must be a positive integer");
  }
  const reconnectMaxMs = Number.parseInt(process.env.PSFN_COMPANION_RECONNECT_MAX_MS || "30000", 10);
  if (!Number.isInteger(reconnectMaxMs) || reconnectMaxMs < reconnectBaseMs) {
    throw new Error("PSFN_COMPANION_RECONNECT_MAX_MS must be an integer >= PSFN_COMPANION_RECONNECT_BASE_MS");
  }
  return {
    baseUrl: normalizedBaseUrl,
    apiKey: optional("PSFN_COMPANION_API_KEY") ?? optional("PSFN_API_KEY"),
    identity,
    previewMaxBytes,
    reconnectBaseMs,
    reconnectMaxMs,
  };
}

export function loadHubConfig(projectRoot: string): HubConfig {
  loadProjectEnv(projectRoot);
  const psfn = loadPsfnRuntime(projectRoot);
  const companion = loadCompanionBridgeConfig(psfn.satelliteClaim);
  const homeAssistant = loadHomeAssistantConfig();
  const control = loadHubControlConfig(homeAssistant !== null);
  const deviceRegistry = loadHubDeviceRegistryAuthority(
    optional("HUB_DEVICE_REGISTRY_PATH")
      ? resolveExistingFile(projectRoot, required("HUB_DEVICE_REGISTRY_PATH"), "HUB_DEVICE_REGISTRY_PATH")
      : undefined,
    control
      ? { reservedCredentials: [{ label: "HUB_CONTROL_TOKEN", credential: control.token }] }
      : undefined,
  );
  const deviceAssertionIssuer = loadHubDeviceAssertionIssuer(projectRoot, deviceRegistry !== null);
  if (homeAssistant && !deviceRegistry) {
    throw new Error("HOME_ASSISTANT_ENABLED=true requires HUB_DEVICE_REGISTRY_PATH for trusted room identity");
  }
  const textOnlyMode = process.env.HUB_TEXT_ONLY?.trim() === "true";

  return {
    textOnlyMode,
    bindHost: process.env.REALTIME_VOICE_BIND_HOST || "0.0.0.0",
    port: Number.parseInt(process.env.REALTIME_VOICE_PORT || "8787", 10),
    deepgramApiKey: textOnlyMode ? optional("DEEPGRAM_API_KEY") ?? null : required("DEEPGRAM_API_KEY"),
    elevenlabsApiKey: textOnlyMode ? optional("ELEVENLABS_API_KEY") ?? null : required("ELEVENLABS_API_KEY"),
    elevenlabsVoiceId: textOnlyMode ? optional("ELEVENLABS_VOICE_ID") ?? null : required("ELEVENLABS_VOICE_ID"),
    elevenlabsModelId: process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2_5",
    artifactsRoot: resolvePath(projectRoot, process.env.ARTIFACT_ROOT || ".artifacts/runtime-ts"),
    psfn: {
      ...psfn,
      ...(deviceAssertionIssuer ? { deviceAssertionIssuer } : {}),
    },
    companion,
    homeAssistant,
    control,
    deviceRegistry,
    voxta: loadVoxtaFacadeConfig(projectRoot),
    sessionTtlSeconds: Number.parseInt(process.env.SESSION_TTL_SECONDS || "300", 10),
  };
}

function loadHubDeviceAssertionIssuer(
  projectRoot: string,
  deviceRegistryConfigured: boolean,
): HubDeviceAssertionIssuer | undefined {
  const names = [
    "HUB_DEVICE_ASSERTION_ISSUER",
    "HUB_DEVICE_ASSERTION_KID",
    "HUB_DEVICE_ASSERTION_AUDIENCE",
    "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
    "HUB_DEVICE_ASSERTION_TTL_SECONDS",
  ] as const;
  const configured = names.filter(name => optional(name) !== undefined);
  if (!deviceRegistryConfigured) {
    if (configured.length > 0) {
      throw new Error("Hub device assertion signing authority requires HUB_DEVICE_REGISTRY_PATH");
    }
    return undefined;
  }
  if (configured.length !== names.length) {
    throw new Error("HUB_DEVICE_REGISTRY_PATH requires complete Hub device assertion signing authority configuration");
  }
  const privateKeyPath = resolveExistingFile(
    projectRoot,
    required("HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH"),
    "HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH",
  );
  if ((fs.statSync(privateKeyPath).mode & 0o077) !== 0) {
    throw new Error("HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH must not be group/world accessible");
  }
  return createHubDeviceAssertionIssuer({
    issuer: required("HUB_DEVICE_ASSERTION_ISSUER"),
    kid: required("HUB_DEVICE_ASSERTION_KID"),
    audience: required("HUB_DEVICE_ASSERTION_AUDIENCE"),
    privateKeyPem: fs.readFileSync(privateKeyPath, "utf8"),
    ttlSeconds: parsePositiveIntegerEnv("HUB_DEVICE_ASSERTION_TTL_SECONDS", 0),
  });
}

export function loadHomeAssistantConfig(): HomeAssistantConfig | null {
  const enabled = optional("HOME_ASSISTANT_ENABLED");
  if (enabled !== undefined && enabled !== "true" && enabled !== "false") {
    throw new Error("HOME_ASSISTANT_ENABLED must be 'true' or 'false'");
  }
  if (enabled !== "true") {
    return null;
  }

  const baseUrl = new URL(required("HOME_ASSISTANT_BASE_URL"));
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("HOME_ASSISTANT_BASE_URL must use http or https");
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error("HOME_ASSISTANT_BASE_URL must not include credentials, query, or fragment");
  }
  const reconnectBaseMs = parsePositiveIntegerEnv("HOME_ASSISTANT_RECONNECT_BASE_MS", 1_000);
  const reconnectMaxMs = parsePositiveIntegerEnv("HOME_ASSISTANT_RECONNECT_MAX_MS", 30_000);
  if (reconnectMaxMs < reconnectBaseMs) {
    throw new Error("HOME_ASSISTANT_RECONNECT_MAX_MS must be greater than or equal to HOME_ASSISTANT_RECONNECT_BASE_MS");
  }

  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ""),
    token: required("HOME_ASSISTANT_TOKEN"),
    reconnectBaseMs,
    reconnectMaxMs,
    requestTimeoutMs: parsePositiveIntegerEnv("HOME_ASSISTANT_REQUEST_TIMEOUT_MS", 10_000),
  };
}

export function loadHubControlConfig(requiredForHomeAssistant: boolean): HubControlConfig | null {
  const bindHost = optional("HUB_CONTROL_BIND_HOST");
  const portValue = optional("HUB_CONTROL_PORT");
  const token = optional("HUB_CONTROL_TOKEN");
  const configured = Boolean(bindHost || portValue || token);
  if (configured && !requiredForHomeAssistant) {
    throw new Error("HUB_CONTROL_* configuration requires HOME_ASSISTANT_ENABLED=true");
  }
  if (!configured && !requiredForHomeAssistant) {
    return null;
  }
  if (!bindHost || !portValue || !token) {
    throw new Error(
      "HUB_CONTROL_BIND_HOST, HUB_CONTROL_PORT, and HUB_CONTROL_TOKEN must all be set when Home Assistant is enabled",
    );
  }
  if (token.length < 16) {
    throw new Error("HUB_CONTROL_TOKEN must be at least 16 characters");
  }
  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("HUB_CONTROL_PORT must be a valid TCP port");
  }
  return {
    bindHost,
    port,
    token,
    maxBodyBytes: parsePositiveIntegerEnv("HUB_CONTROL_MAX_BODY_BYTES", 64 * 1024),
  };
}

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseStrictPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = optional(name);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (parsed > MAX_NODE_TIMER_MS) {
    throw new Error(`${name} must not exceed ${MAX_NODE_TIMER_MS} ms`);
  }
  return parsed;
}

function loadReplyBudget(
  deadlineName: string,
  attemptName: string,
  defaultDeadlineMs: number,
  defaultAttemptTimeoutMs: number,
  maxDeadlineMs?: number,
): { replyDeadlineMs: number; attemptTimeoutMs: number } {
  const deadlineConfigured = optional(deadlineName) !== undefined;
  const attemptConfigured = optional(attemptName) !== undefined;
  if (deadlineConfigured !== attemptConfigured) {
    throw new Error(`${deadlineName} and ${attemptName} must be configured together`);
  }
  const replyDeadlineMs = parseStrictPositiveIntegerEnv(deadlineName, defaultDeadlineMs);
  const attemptTimeoutMs = parseStrictPositiveIntegerEnv(attemptName, defaultAttemptTimeoutMs);
  if (maxDeadlineMs !== undefined && replyDeadlineMs > maxDeadlineMs) {
    throw new Error(`${deadlineName} must not exceed ${maxDeadlineMs} ms`);
  }
  return { replyDeadlineMs, attemptTimeoutMs };
}

function validateReplyBudget(
  attemptName: string,
  attemptTimeoutMs: number,
  deadlineName: string,
  replyDeadlineMs: number,
): void {
  if (attemptTimeoutMs > replyDeadlineMs) {
    throw new Error(`${attemptName} must be less than or equal to ${deadlineName}`);
  }
}

function loadVoxtaFacadeConfig(projectRoot: string): VoxtaFacadeConfig {
  return {
    enabled: process.env.VOXTA_FACADE_ENABLED?.trim() !== "false",
    satelliteId: process.env.VOXTA_SATELLITE_ID?.trim() || "voxta-vam",
    satelliteName: process.env.VOXTA_SATELLITE_NAME?.trim() || "Voxta VaM",
    sessionId: process.env.VOXTA_SESSION_ID?.trim() || null,
    chatId: process.env.VOXTA_CHAT_ID?.trim() || null,
    assistantId: process.env.VOXTA_ASSISTANT_ID?.trim() || "psfn-assistant",
    assistantName: process.env.VOXTA_ASSISTANT_NAME?.trim() || "PSFN",
    userId: process.env.VOXTA_USER_ID?.trim() || "voxta-user",
    userName: process.env.VOXTA_USER_NAME?.trim() || "User",
    appLabel: process.env.VOXTA_APP_LABEL?.trim() || "PSFN Satellite Hub",
    clientVersion: process.env.VOXTA_CLIENT_VERSION?.trim() || "1.2.1",
    publicBaseUrl: loadVoxtaPublicBaseUrl(),
    audioFolder: process.env.VOXTA_AUDIO_FOLDER?.trim()
      ? resolvePath(projectRoot, process.env.VOXTA_AUDIO_FOLDER.trim())
      : null,
    sttStreamEnabled: process.env.VOXTA_STT_STREAM_ENABLED?.trim() === "true",
    visionCaptureTimeoutMs: Number.parseInt(process.env.VOXTA_VISION_CAPTURE_TIMEOUT_MS || "1500", 10),
    actionAllowlist: splitCsv(process.env.VOXTA_APP_TRIGGER_ALLOWLIST || ""),
  };
}

function loadVoxtaPublicBaseUrl(): string | null {
  const explicit = process.env.VOXTA_PUBLIC_BASE_URL?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, "");
  }
  const host = (
    process.env.AUDIO_PUBLIC_HOST?.trim() ||
    process.env.REALTIME_VOICE_PUBLIC_HOST?.trim()
  );
  if (!host) {
    return null;
  }
  if (/^https?:\/\//i.test(host)) {
    return host.replace(/\/+$/, "");
  }
  const port = process.env.REALTIME_VOICE_PORT?.trim() || "8787";
  const hasPort = /:\d+$/.test(host);
  return `http://${host}${hasPort ? "" : `:${port}`}`;
}

export function loadPiClientConfig(projectRoot: string): PiClientConfig {
  loadProjectEnv(projectRoot);
  const sampleRate = Number.parseInt(process.env.MIC_SAMPLE_RATE || "16000", 10);
  const audioCard = process.env.AUDIO_DEVICE_CARD?.trim() || "";
  const inputDevice =
    process.env.AUDIO_INPUT_DEVICE?.trim() ||
    (audioCard ? `plughw:CARD=${audioCard},DEV=0` : "default");
  const outputDevice =
    process.env.AUDIO_OUTPUT_DEVICE?.trim() ||
    (audioCard ? `default:CARD=${audioCard}` : "default");
  const duckCard = process.env.ALSA_DUCK_CARD?.trim() || audioCard;
  const duckControl = process.env.ALSA_DUCK_CONTROL?.trim() || "PCM";
  const amicaBridge = loadAmicaBridgeConfig();
  const relayRequestTimeoutMs = Number.parseInt(
    process.env.PI_CLIENT_RELAY_REQUEST_TIMEOUT_MS || "20000",
    10,
  );
  if (!Number.isInteger(relayRequestTimeoutMs) || relayRequestTimeoutMs <= 0) {
    throw new Error("PI_CLIENT_RELAY_REQUEST_TIMEOUT_MS must be a positive integer");
  }

  return {
    hubUrl: required("HUB_WS_URL"),
    deviceCredential: optional("HUB_DEVICE_TOKEN"),
    relayDeviceCredential: optional("HUB_RELAY_DEVICE_TOKEN"),
    deviceId: required("DEVICE_ID"),
    deviceName: required("DEVICE_NAME"),
    conversationId: optional("CONVERSATION_ID"),
    realtimeAudioEnabled: process.env.PI_CLIENT_REALTIME_AUDIO_ENABLED?.trim() !== "false",
    relayRequestTimeoutMs,
    amicaBridge,
    control: loadPiClientControlConfig(),
    inputCommand: splitCommand(
      process.env.AUDIO_INPUT_COMMAND ||
        `arecord -q -f S16_LE -r ${sampleRate} -c 1 -D ${inputDevice} -t raw`,
    ),
    outputCommand: splitCommand(
      process.env.AUDIO_OUTPUT_COMMAND ||
        `bash -lc "ffmpeg -hide_banner -loglevel error -fflags nobuffer -flags low_delay -probesize 32 -analyzeduration 0 -i pipe:0 -f s16le -acodec pcm_s16le -ar 44100 -ac 2 pipe:1 | aplay -q -D ${outputDevice} -f S16_LE -r 44100 -c 2"`,
    ),
    sampleRate,
    startThreshold: Number.parseFloat(process.env.VOICE_START_THRESHOLD || "0.008"),
    continueThreshold: Number.parseFloat(process.env.VOICE_CONTINUE_THRESHOLD || "0.004"),
    ambientStartRatio: Number.parseFloat(process.env.VOICE_AMBIENT_START_RATIO || "1.5"),
    interruptRatio: Number.parseFloat(process.env.VOICE_INTERRUPT_RATIO || "1.0"),
    startChunks: Number.parseInt(process.env.VOICE_START_CHUNKS || "1", 10),
    releaseMs: Number.parseInt(process.env.VOICE_SPEECH_RELEASE_MS || "180", 10),
    initialSilenceMs: Number.parseInt(process.env.VOICE_INITIAL_SILENCE_MS || "1800", 10),
    endSilenceMs: Number.parseInt(process.env.VOICE_END_SILENCE_MS || "420", 10),
    maxTurnMs: Number.parseInt(process.env.VOICE_MAX_TURN_MS || "20000", 10),
    prerollChunks: Number.parseInt(process.env.VOICE_PREROLL_CHUNKS || "24", 10),
    prerollLeadChunks: Number.parseInt(process.env.VOICE_PREROLL_LEAD_CHUNKS || "4", 10),
    micGain: Number.parseFloat(process.env.MIC_GAIN || "1.0"),
    ducking: duckCard
      ? {
          mixerCard: duckCard,
          mixerControl: duckControl,
          duckPercent: Number.parseInt(process.env.ALSA_DUCK_PERCENT || "8", 10),
        }
      : null,
  };
}

function loadAmicaBridgeConfig(): AmicaBridgeConfig | null {
  const endpointUrl = optional("AMICA_BRIDGE_URL");
  const token = optional("AMICA_BRIDGE_TOKEN");

  if (!endpointUrl && !token) {
    return null;
  }
  if (!endpointUrl) {
    throw new Error("Missing required environment variable: AMICA_BRIDGE_URL");
  }
  if (!token) {
    throw new Error("Missing required environment variable: AMICA_BRIDGE_TOKEN");
  }

  const ownerMode = process.env.AMICA_BRIDGE_OWNER_MODE?.trim() === "true";
  const requestTimeoutMs = Number.parseInt(
    process.env.AMICA_BRIDGE_TIMEOUT_MS || "5000",
    10,
  );
  const normalizedUrl = new URL(endpointUrl).toString();
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 0) {
    throw new Error("AMICA_BRIDGE_TIMEOUT_MS must be a non-negative integer");
  }

  return {
    endpointUrl: normalizedUrl,
    token,
    ownerMode,
    requestTimeoutMs,
  };
}

function loadPiClientControlConfig(): PiClientControlConfig | null {
  const bindHost = optional("PI_CLIENT_CONTROL_BIND_HOST");
  const portValue = optional("PI_CLIENT_CONTROL_PORT");

  if (!bindHost && !portValue) {
    return null;
  }
  if (!bindHost || !portValue) {
    throw new Error(
      "PI_CLIENT_CONTROL_BIND_HOST and PI_CLIENT_CONTROL_PORT must both be set",
    );
  }
  if (!isLoopbackHost(bindHost)) {
    throw new Error("PI_CLIENT_CONTROL_BIND_HOST must be a loopback address");
  }

  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PI_CLIENT_CONTROL_PORT must be a valid TCP port");
  }

  return {
    bindHost,
    port,
  };
}

function resolvePath(projectRoot: string, value: string): string {
  const expanded = value.startsWith("~")
    ? path.join(os.homedir(), value.slice(1))
    : value;
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.join(projectRoot, expanded);
}

function loadPsfnClientCertificateConfig(projectRoot: string): PsfnClientCertificateConfig | undefined {
  const certPath = optional("PSFN_CLIENT_CERT_PATH");
  const keyPath = optional("PSFN_CLIENT_KEY_PATH");
  const caPath = optional("PSFN_CA_CERT_PATH");
  if (!certPath && !keyPath && !caPath) {
    return undefined;
  }
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("PSFN_CLIENT_CERT_PATH and PSFN_CLIENT_KEY_PATH must both be set when either is configured");
  }
  const config: PsfnClientCertificateConfig = {
    certPath: certPath ? resolveExistingFile(projectRoot, certPath, "PSFN_CLIENT_CERT_PATH") : undefined,
    keyPath: keyPath ? resolveExistingFile(projectRoot, keyPath, "PSFN_CLIENT_KEY_PATH") : undefined,
    caPath: caPath ? resolveExistingFile(projectRoot, caPath, "PSFN_CA_CERT_PATH") : undefined,
  };
  return config;
}

function resolveExistingFile(projectRoot: string, value: string, name: string): string {
  const resolved = resolvePath(projectRoot, value);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`${name} must point to a readable file`);
  }
  if (!stats.isFile()) {
    throw new Error(`${name} must point to a readable file`);
  }
  fs.accessSync(resolved, fs.constants.R_OK);
  return resolved;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function splitCommand(command: string): string[] {
  const matches = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  return matches.map((part) => part.replace(/^"(.*)"$/, "$1"));
}

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseCapabilityProfile(value: string | undefined): SatelliteCapabilityProfile | undefined {
  return parseEnum(value, [
    "voice-only",
    "text-only",
    "voxta-avatar",
    "vision-capable",
    "telemetry-only",
    "mobile-location",
  ], "PSFN_CAPABILITY_PROFILE");
}

function parseEndpointClass(value: string | undefined): SatelliteEndpointClass | undefined {
  return parseEnum(value, ["voice", "text", "avatar", "vision", "telemetry", "mobile"], "PSFN_ENDPOINT_CLASS");
}

function parseLocationMode(value: string | undefined): SatelliteLocationMode | undefined {
  return parseEnum(value, ["static", "mobile", "unavailable"], "PSFN_LOCATION_MODE");
}

function parseTelemetryMode(value: string | undefined): SatelliteTelemetryMode | undefined {
  return parseEnum(value, ["disabled", "static", "periodic", "event"], "PSFN_TELEMETRY_MODE");
}

function parseTelemetryCategories(value: string): SatelliteTelemetryCategory[] {
  return splitCsv(value).map((category) => {
    const parsed = parseEnum(category, [
      "location",
      "timezone",
      "room",
      "presence",
      "battery",
      "health",
      "device_status",
      "avatar_state",
    ], "PSFN_TELEMETRY_CATEGORIES");
    if (!parsed) {
      throw new Error("PSFN_TELEMETRY_CATEGORIES contains an empty category");
    }
    return parsed;
  });
}

function parseEnum<T extends string>(value: string | undefined, allowed: readonly T[], name: string): T | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(normalized)) {
    return normalized as T;
  }
  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "localhost";
}
