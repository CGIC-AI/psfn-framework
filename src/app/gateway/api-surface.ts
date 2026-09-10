import { resolveTestingHarnessDevicesConfig } from '../../channels/backplane/testing-harness-devices.js';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ExternalMemoryMcpRoute } from '../../channels/api/server/external-memory-mcp.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
  SatelliteRegistryProvider,
} from '../../shared/contracts/satellite-registry.js';
import { ApiServer } from '../../channels/api/server.js';
import { clampHttpHeader, resolveApiCorsAllowedOrigins } from '../../channels/api/http-policy.js';
import { parseSatelliteApiKeys } from '../../channels/backplane/http/auth.js';
import {
  deriveClientCertIdentity,
  parseTrustedProxyClientCertToken,
  stripClientCertHeaders,
} from '../../channels/backplane/http/client-cert.js';
import { resolveApiHttpServerTlsConfig } from '../../channels/api/server/http.js';
import {
  hasSatelliteClaimHeaders,
  resolveSatelliteClaim,
  SATELLITE_CLAIM_HEADERS,
} from '../../channels/backplane/satellite-registry.js';
import {
  buildVoiceWebSocketServerOptions,
  createApiVoiceWebSocketRuntime,
} from '../../channels/api/voice-websocket-runtime.js';
import { createRuntimeVoiceSttConnector } from '../../channels/backplane/voice-provider-runtime.js';
import {
  computeGatewayChatRequestTimeoutMs,
  GatewayApiRuntime,
} from '../../channels/api/gateway-runtime.js';
import type { GatewayServer } from '../../boundary/gateway/server.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { buildExternalChannelProfiles, type RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import { resolveCompanionNameFromConfig } from '../../core/identity/companion-runtime.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { CompanionRelayHttpDeps } from '../../channels/api/server/companion-relay-routes.js';
import { CompanionStimulusIngress } from '../../channels/api/server/companion-stimuli.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SensorIngestPort } from '../../shared/telemetry/sensor-ingest-port.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import { isExplicitTrue, parseCommaSeparatedEnv } from '../startup/support/env-parsing.js';
import type { IntakeScreeningService } from '../../core/cogsec/intake/screening.js';
import { isCogSecMode, type CogSecMode } from '../../shared/contracts/cogsec-mode.js';
import {
  assertFleetAuthStandaloneSurfacesUnavailable,
  warnIfInsecureLocalApiUnderFleetAuth,
} from '../../system/config/fleet-auth-standalone-surface-guard.js';
import type { GatewayFleetAuthBroker } from '../../boundary/gateway/fleet-auth-broker.js';
import type { GatewayFleetAuthChildAssertionBroker } from '../../boundary/gateway/fleet-auth-child-assertions.js';
import { GatewayCompanionUiActionBroker } from '../../boundary/gateway/companion-ui-action-broker.js';
import { GatewayCompanionUiAudioIngress } from '../../boundary/gateway/companion-ui-audio-ingress.js';
import type {
  GatewayRequestCapabilitySigner,
  RequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import { CompanionUiWebSocketAdapter } from '../../channels/api/companion-ui-websocket.js';
import { CompanionUiAudioOutputRelay } from '../../channels/backplane/companion-ui-audio-output-relay.js';
import {
  companionUiPromptContent,
  compileCompanionUiAction,
} from '../../boundary/fleet-auth/companion-ui-action.js';
import type { RequestCapabilityReplayPort } from '../../boundary/fleet-auth/request-capability-replay.js';
import {
  GatewayFleetSsoRouter,
} from '../../boundary/gateway/fleet-sso-router.js';
import type { TestingHarnessGardenAuthorizationAuditPort } from '../../boundary/gateway/testing-harness-garden-door.js';
import {
  requireFleetSsoFleetManifest,
  resolveFleetSsoGardenUpstreams,
} from '../../boundary/fleet-auth/fleet-sso-transport.js';
import type {
  PrimaryEmbodimentAuthorityPort,
} from '../../boundary/fleet-auth/primary-embodiment.js';
import { dispatchCompanionUiPrimaryEmbodiment } from '../../boundary/gateway/companion-ui-primary-embodiment.js';
import { dispatchCompanionUiApproval } from '../../boundary/gateway/companion-ui-approvals.js';
import { FleetAuthHttpRoutes } from '../../channels/api/server/fleet-auth-routes.js';
import type { FleetEscalationCoordinator } from '../../boundary/fleet-auth/escalation.js';
import type { GatewayTrustedHostGardenRecoveryService } from '../../boundary/gateway/trusted-host-garden-recovery.js';
import type { GatewayFleetAuthLifecycleCeremonyService } from '../../boundary/fleet-auth/lifecycle-ceremony.js';
import {
  GatewayHubDeviceIngressService,
  type HubDeviceHumanAttachmentPort,
} from '../../boundary/fleet-auth/hub-device-ingress.js';
import type {
  HubDeviceAssertionExpectedBinding,
  HubDeviceAttachmentSnapshot,
  HubDevicePrincipal,
} from '../../shared/contracts/hub-device-ingress.js';
import { createCompanionId, type CompanionId } from '../../shared/routing/companion-id.js';
import { isLoopbackHost } from '../../shared/net/hosts.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { FleetPortalAuthorizationBatchPort } from '../../boundary/gateway/fleet-portal-authorization.js';
import type { FleetPortalChannelHealthSource } from '../../boundary/gateway/fleet-portal-projection.js';
import { createGatewayFleetPortalProjection } from './fleet-portal-composition.js';
import type { FleetModelUsageSummaryQueryPort } from '../../shared/telemetry/model-usage.js';
import { createGatewayFleetModelUsageProjection } from './fleet-model-usage-composition.js';
import { createBearerCompanionRoutingConfig } from '../../channels/api/server/bearer-companion-selector.js';
import { resolveVoiceSecurityLimits } from '../../primitives/voice/policy/security.js';

const log = createComponentLogger('GatewayApiSurface');

const DISABLED_VOICE_WEBSOCKET_PATH = '/v1/voice/ws-disabled';
const GATEWAY_API_REQUEST_TIMEOUT_MS = 240_000;
const COMPANION_STIMULUS_COOLDOWN_MS = 3_000;

export interface GatewayApiSurfaceBindings {
  apiHost?: string;
  apiPort?: number;
  adminHost?: string;
  adminPort?: number;
}

export interface StartOptionalGatewayApiServerOptions extends GatewayApiSurfaceBindings {
  config: SubstrateConfig;
  env?: NodeJS.ProcessEnv;
  eligibilityGate: EligibilityGate;
  gateway: Pick<
    GatewayServer,
    | 'requestAgent'
    | 'subscribeApiStream'
    | 'requestAgentVoiceStream'
    | 'invalidateIcpAutonomyForCompanion'
    | 'isIcpAutonomyConfigured'
    | 'resolveOperatorApproval'
    | 'resolveOperatorApprovalForOwner'
    | 'listOperatorConfirmations'
    | 'ownerOfConfirmation'
    | 'listCompanionUiConfirmations'
    | 'resolveCompanionUiApproval'
    | 'getFleetConnectionSnapshot'
    | 'requestCompanionAgent'
    | 'recordSharedSatelliteObservationAudit'
  >;
  /** Exact gateway topology posture after fleet/single configuration resolution. */
  multiCompanion: boolean;
  channelsConfig?: RuntimeChannelsConfig;
  satelliteRegistryProvider: SatelliteRegistryProvider;
  satelliteRegistry?: SatelliteRegistryConfig;
  /**
   * htm9.9: intake screening for voice transcripts (sourceClass
   * 'audio_transcript') — a transcript becomes prompt text, so audio is a
   * real injection channel. Null when the firewall mode is 'off'.
   */
  intakeScreening?: IntakeScreeningService | null;
  /** Canonical global CogSec mode (shadow/boundary/strict); required so omission cannot disable screening. */
  intakeScreeningMode: CogSecMode;
  /** Fleet-only exact resolver for the companion owning an API/satellite ingress. */
  intakeScreeningForCompanion?: (
    companionId: string,
  ) => IntakeScreeningService | null;
  /** Companion event relay surface (w9hj.1); `/v1/companion/*` 503s without it. */
  companionRelay?: Omit<CompanionRelayHttpDeps, 'stimuli'>;
  /** Present only in gateway fleet-auth mode; owns all browser OAuth/session authority. */
  fleetAuthBroker?: GatewayFleetAuthBroker;
  fleetAuthEscalation?: FleetEscalationCoordinator;
  fleetAuthTrustedHostRecovery?: GatewayTrustedHostGardenRecoveryService;
  fleetAuthLifecycleCeremonies?: GatewayFleetAuthLifecycleCeremonyService;
  fleetAuthChildAssertions?: GatewayFleetAuthChildAssertionBroker;
  fleetAuthRequestCapabilities?: GatewayRequestCapabilitySigner;
  fleetAuthRequestCapabilityVerifier?: RequestCapabilityVerifier;
  fleetAuthRequestCapabilityReplay?: RequestCapabilityReplayPort;
  fleetAuthTestingHarnessGardenAuthorizationAudit?: TestingHarnessGardenAuthorizationAuditPort;
  fleetPortalAuthorization?: FleetPortalAuthorizationBatchPort;
  fleetPortalChannelHealth?: FleetPortalChannelHealthSource;
  /** Canonical fleet-scoped model-attempt ledger used by the authenticated budget projection. */
  fleetModelUsage?: FleetModelUsageSummaryQueryPort;
  primaryEmbodiments?: PrimaryEmbodimentAuthorityPort;
  /** Persistence-backed verifier/consumer required by authenticated Hub device ingress. */
  hubDeviceAssertionVerifier?: {
    verifyAndConsumeHubDeviceAssertion(
      token: string,
      expected: HubDeviceAssertionExpectedBinding,
    ): Promise<HubDevicePrincipal>;
    attachHubDeviceHuman(
      input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0],
    ): ReturnType<HubDeviceHumanAttachmentPort['attach']>;
    fenceHubDeviceAttachment(
      input: Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0],
    ): ReturnType<HubDeviceHumanAttachmentPort['fenceDevice']>;
  };
}

function resolveOwnedIntakeScreening(
  options: StartOptionalGatewayApiServerOptions,
  companionId: string,
): IntakeScreeningService | null | undefined {
  if (options.multiCompanion) {
    if (!options.intakeScreeningForCompanion) {
      throw new Error('Fleet API intake screening has no companion-owned resolver');
    }
    return options.intakeScreeningForCompanion(companionId);
  }
  return options.intakeScreening;
}

export function assertGatewayApiIntakeScreeningOwnership(
  options: StartOptionalGatewayApiServerOptions,
): void {
  const configuredMode: unknown = options.intakeScreeningMode;
  if (!isCogSecMode(configuredMode)) {
    throw new Error('Gateway API intake screening requires an explicit valid CogSec mode (shadow/boundary/strict)');
  }
  const mode = configuredMode;
  if (options.multiCompanion) {
    if (options.intakeScreening) {
      throw new Error(
        'Fleet gateway API intake screening must use a companion-owned resolver, not a singleton service',
      );
    }
    if (!options.intakeScreeningForCompanion) {
      throw new Error(
        'Fleet gateway API intake screening requires a companion-owned resolver',
      );
    }
    const fleet = options.config.companionFleet;
    if (!fleet || fleet.companions.length === 0) {
      throw new Error(
        'Fleet gateway API intake screening requires the resolved companion manifest',
      );
    }
    for (const companion of fleet.companions) {
      const screening = options.intakeScreeningForCompanion(companion.companionId);
      if (!screening || screening.globalMode !== mode) {
        throw new Error(
          `Fleet gateway API intake screening mode=${mode} has no matching service for ${companion.companionId}`,
        );
      }
    }
    return;
  }
  if (options.intakeScreeningForCompanion) {
    throw new Error(
      'Single-companion gateway API intake screening must use its singleton service',
    );
  }
  if (!options.intakeScreening || options.intakeScreening.globalMode !== mode) {
    throw new Error(
      `Single-companion gateway API intake screening mode=${mode} has no matching service`,
    );
  }
}

/**
 * The companion a Hub device binds to. Independent of fleet auth: the pinned
 * API companion wins, then a one-entry fleet manifest, then the single
 * configured companion. Multi-companion fleets without a pinned API companion
 * have no unambiguous device binding and leave it undefined.
 */
function resolveGatewayHubDeviceCompanionId(
  options: StartOptionalGatewayApiServerOptions,
): string | undefined {
  const channelCompanionId = options.channelsConfig?.api.companionId;
  if (channelCompanionId) return channelCompanionId;
  const fleet = options.config.companionFleet;
  if (fleet && fleet.companions.length === 1) return fleet.companions[0]!.companionId;
  if (fleet && fleet.companions.length > 1) return undefined;
  return options.config.companionId;
}

function resolveFleetSsoCompanionUi(
  fleet: NonNullable<SubstrateConfig['companionFleet']>,
  env: NodeJS.ProcessEnv,
): {
  companionId: ReturnType<typeof createCompanionId>;
  origin: URL;
  guestMode: 'disabled' | 'explicit';
} | undefined {
  const rawOrigin = env.FLEET_SSO_COMPANION_UI_ORIGIN?.trim();
  if (!rawOrigin) return undefined;
  const rawCompanionId = env.FLEET_SSO_COMPANION_UI_COMPANION_ID?.trim()
    || (fleet.companions.length === 1 ? fleet.companions[0]!.companionId : undefined);
  if (!rawCompanionId
    || !fleet.companions.some(entry => entry.companionId === rawCompanionId)) {
    throw new Error(
      'Fleet SSO Companion UI requires one exact registered FLEET_SSO_COMPANION_UI_COMPANION_ID',
    );
  }
  const origin = new URL(rawOrigin);
  if (origin.origin !== rawOrigin || origin.protocol !== 'http:' || origin.username
    || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('FLEET_SSO_COMPANION_UI_ORIGIN must be one exact internal HTTP origin');
  }
  const rawGuestMode = env.FLEET_SSO_COMPANION_UI_GUEST_MODE?.trim() || 'disabled';
  if (rawGuestMode !== 'disabled' && rawGuestMode !== 'explicit') {
    throw new Error('FLEET_SSO_COMPANION_UI_GUEST_MODE must be disabled or explicit');
  }
  return {
    companionId: createCompanionId(rawCompanionId, 'Fleet SSO Companion UI companion binding'),
    origin,
    guestMode: rawGuestMode,
  };
}

/**
 * Pins the Companion UI WebSocket origin without fleet auth (psfn-framework-7oh9y).
 * One exact origin: HTTPS, or HTTP on a loopback host, matching the transport
 * policy of the key-authenticated REST API on the same listener.
 */
function resolveStandaloneCompanionUiOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.COMPANION_UI_ORIGIN?.trim();
  if (!raw) return undefined;
  let origin: URL;
  try {
    origin = new URL(raw);
  } catch {
    throw new Error('COMPANION_UI_ORIGIN must be one exact origin');
  }
  if (origin.origin !== raw || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopbackHost(origin.hostname)))) {
    throw new Error('COMPANION_UI_ORIGIN must be one exact HTTPS origin (or HTTP on loopback)');
  }
  return raw;
}

/**
 * Screens a voice transcript through the intake firewall before it becomes a
 * prompt-bearing message. Shadow mode records the envelope without altering
 * the transcript; enforce-mode quarantine substitutes the fixed withheld-
 * content placeholder. The envelope snapshot rides routing.intakeEnvelopes.
 */
async function screenVoiceTranscriptMessage(
  message: SubstrateMessage,
  intakeScreening: IntakeScreeningService | null | undefined,
): Promise<SubstrateMessage> {
  if (!intakeScreening || !message.content.trim()) return message;
  const screened = await intakeScreening.screen(message.content, {
    sourceClass: 'audio_transcript',
    origin: { ref: `api-voice:${message.channelId}:${message.id}`.slice(0, 2048) },
    scope: 'context',
    timing: {
      traceId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      channelType: message.channelType,
    },
  });
  return {
    ...message,
    content: screened.effectiveText,
    routing: {
      ...(message.routing ?? {}),
      intakeEnvelopes: [screened.snapshot],
    },
  };
}

async function screenCompanionStimulusMessage(
  message: SubstrateMessage,
  intakeScreening: IntakeScreeningService | null | undefined,
): Promise<SubstrateMessage> {
  if (!intakeScreening) return message;
  const screened = await intakeScreening.screen(message.content, {
    sourceClass: 'primary_user',
    origin: { ref: `companion-stimulus:${message.channelId}:${message.id}`.slice(0, 2048) },
    scope: 'context',
    ...(message.routing?.canonicalContactId
      ? { canonicalContactId: message.routing.canonicalContactId }
      : {}),
    sourceChannelId: message.channelId,
    timing: {
      traceId: message.id,
      requestId: message.id,
      channelId: message.channelId,
      channelType: message.channelType,
    },
  });
  return {
    ...message,
    content: screened.effectiveText,
    routing: {
      ...(message.routing ?? {}),
      intakeEnvelopes: [screened.snapshot],
    },
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function parseRequestUrl(request: IncomingMessage): URL | null {
  try {
    return new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  } catch {
    return null;
  }
}

function readQueryParam(request: IncomingMessage, names: string[]): string | undefined {
  const url = parseRequestUrl(request);
  if (!url) return undefined;

  for (const name of names) {
    const value = clampHttpHeader(url.searchParams.get(name) ?? undefined, 1024);
    if (value) return value;
  }

  return undefined;
}

function readHeaderOrQuery(
  request: IncomingMessage,
  headerName: string,
  queryNames: string[],
  maxLength: number,
): string | undefined {
  const headerValue = clampHttpHeader(singleHeader(request.headers[headerName]), maxLength);
  if (headerValue) return headerValue;
  return clampHttpHeader(readQueryParam(request, queryNames), maxLength);
}

function buildSatelliteClaimHeaders(
  request: IncomingMessage,
  sessionId: string,
): IncomingMessage['headers'] {
  const headers: IncomingMessage['headers'] = { ...request.headers };
  // Sprint-10 C1: certificate identity is derived from the TLS socket or an
  // authenticated trusted proxy BEFORE this map is built; caller-supplied
  // Client-certificate forwarding headers (and the proxy token) must never flow into
  // claim resolution, and are never accepted via query parameters.
  stripClientCertHeaders(headers);
  const copy = (headerName: string, queryNames: string[], maxLength: number) => {
    if (clampHttpHeader(singleHeader(headers[headerName]), maxLength)) return;
    const value = readQueryParam(request, queryNames);
    if (value) {
      headers[headerName] = clampHttpHeader(value, maxLength);
    }
  };

  copy(SATELLITE_CLAIM_HEADERS.claimType, ['satellite_claim_type', 'claim_type'], 64);
  copy(SATELLITE_CLAIM_HEADERS.satelliteId, ['satellite_id'], 128);
  copy(SATELLITE_CLAIM_HEADERS.endpointId, ['satellite_endpoint_id', 'endpoint_id'], 128);
  copy(SATELLITE_CLAIM_HEADERS.sessionId, ['satellite_session_id', 'satellite_thread_id'], 128);
  copy(SATELLITE_CLAIM_HEADERS.capabilities, ['satellite_capabilities'], 1024);
  copy(SATELLITE_CLAIM_HEADERS.telemetryScopes, ['satellite_telemetry_scopes'], 1024);

  const hasSatelliteEnvelope = Boolean(
    clampHttpHeader(singleHeader(headers[SATELLITE_CLAIM_HEADERS.claimType]), 64)
    || clampHttpHeader(singleHeader(headers[SATELLITE_CLAIM_HEADERS.satelliteId]), 128)
    || clampHttpHeader(singleHeader(headers[SATELLITE_CLAIM_HEADERS.endpointId]), 128),
  );
  if (hasSatelliteEnvelope && !clampHttpHeader(singleHeader(headers[SATELLITE_CLAIM_HEADERS.sessionId]), 128)) {
    headers[SATELLITE_CLAIM_HEADERS.sessionId] = sessionId;
  }
  return headers;
}

function buildVoiceMessage(params: {
  request: IncomingMessage;
  principal: { id: string; mode: 'api_key' | 'insecure_local'; scope?: 'satellite' };
  connectionId: string;
  sessionId: string;
  transcript: string;
  channelPrefix: string;
  satelliteRegistryProvider: SatelliteRegistryProvider;
  trustedProxyClientCertToken?: string;
}): SubstrateMessage {
  // Derive the authenticated client-cert identity from the original request
  // (TLS peer cert or token-authenticated trusted proxy) before the claim
  // header map is built with cert headers stripped.
  const clientCert: SatelliteClientCertIdentity | undefined = deriveClientCertIdentity(params.request, {
    ...(params.trustedProxyClientCertToken
      ? { trustedProxyToken: params.trustedProxyClientCertToken }
      : {}),
  });
  const satelliteHeaders = buildSatelliteClaimHeaders(params.request, params.sessionId);
  if (hasSatelliteClaimHeaders(satelliteHeaders)) {
    const satelliteClaim = resolveSatelliteClaim({
      headers: satelliteHeaders,
      principal: params.principal,
      registry: params.satelliteRegistryProvider(),
      ...(clientCert ? { clientCert } : {}),
    });
    if (!satelliteClaim.ok) {
      throw new Error(`${satelliteClaim.type}: ${satelliteClaim.message}`);
    }
    return {
      id: `api-voice-msg-${randomUUID()}`,
      channelId: satelliteClaim.value.channelId,
      channelType: 'api',
      authorId: satelliteClaim.value.authorId,
      authorName: satelliteClaim.value.authorName,
      content: params.transcript,
      isDirectMessage: true,
      routing: {
        source: 'satellite',
        responseStyle: 'concise',
        channelPrivacy: satelliteClaim.value.channelPrivacy,
        canonicalContactId: satelliteClaim.value.canonicalContactId,
        satellite: satelliteClaim.value.satellite,
      },
      timestamp: new Date(),
    };
  }

  const sessionId = readHeaderOrQuery(
    params.request,
    'x-session-id',
    ['session_id', 'x_session_id', 'x-session-id'],
    128,
  );
  const channelId = sessionId
    ? `api:${params.principal.id}:${sessionId}`
    : `${params.channelPrefix}:${params.principal.id}:${params.connectionId}`;
  const authorName = params.principal.mode === 'api_key'
    ? 'API Voice Principal'
    : 'Local Voice Principal';

  return {
    id: `api-voice-msg-${randomUUID()}`,
    channelId,
    channelType: 'api',
    authorId: params.principal.id,
    authorName,
    content: params.transcript,
    isDirectMessage: true,
    routing: {
      source: 'api',
      responseStyle: 'concise',
    },
    timestamp: new Date(),
  };
}

export function resolveGatewayApiSurfaceBindings(
  env: NodeJS.ProcessEnv = process.env,
): GatewayApiSurfaceBindings {
  return {
    apiHost: env.API_HOST || undefined,
    apiPort: parseOptionalPositiveIntEnv(env.API_PORT),
    adminHost: env.ADMIN_HOST || undefined,
    adminPort: parseOptionalPositiveIntEnv(env.ADMIN_PORT),
  };
}

export async function startOptionalGatewayApiServer(
  options: StartOptionalGatewayApiServerOptions,
): Promise<ApiServer | undefined> {
  if (!options.apiPort) {
    return undefined;
  }

  const env = options.env ?? process.env;
  // Fleet auth is an OPTIONAL sign-in method. Its presence ADDS the SSO router,
  // lifecycle routes and SSO principals below; nothing else keys off it. Key
  // authentication (API_KEY, ADMIN_TOKEN, API_SATELLITE_KEYS, testing harness),
  // the voice WebSocket, companion relays and Hub device ingress are wired the
  // same way with or without fleet-auth.json (operator rule, S13).
  const fleetAuthEnabled = options.config.fleetAuth !== undefined;
  const fleetAuthFleet = fleetAuthEnabled
    ? requireFleetSsoFleetManifest(options.config.companionFleet)
    : undefined;
  // SSO-only composition: when fleet auth is configured every SSO principal
  // conjunct must be present so the SSO door itself is never half-wired. The
  // Hub device assertion verifier is deliberately NOT part of this set — device
  // ingress is a key-auth feature that exists without fleet auth.
  const fleetSsoCompositionWired = options.fleetAuthBroker !== undefined
    && options.fleetAuthEscalation !== undefined
    && options.fleetAuthTrustedHostRecovery !== undefined
    && options.fleetAuthLifecycleCeremonies !== undefined
    && options.fleetAuthChildAssertions !== undefined
    && options.fleetAuthRequestCapabilities !== undefined
    && options.fleetAuthRequestCapabilityVerifier !== undefined
    && options.fleetAuthRequestCapabilityReplay !== undefined
    && options.fleetPortalAuthorization !== undefined
    && options.primaryEmbodiments !== undefined;
  if (fleetAuthEnabled && !fleetSsoCompositionWired) {
    throw new Error(
      'Fleet-auth principal composition is incomplete; refusing to expose the gateway API',
    );
  }
  assertFleetAuthStandaloneSurfacesUnavailable({
    fleetAuthEnabled,
    processMode: 'gateway',
    env: { ...env, API_PORT: String(options.apiPort) },
    principalAuthenticationWired: fleetSsoCompositionWired,
    fleetAuthBootstrapRoutesWired: options.fleetAuthBroker !== undefined,
  });
  assertGatewayApiIntakeScreeningOwnership(options);
  const allowInsecureWithoutAuth = isExplicitTrue(env.ALLOW_INSECURE_LOCAL_API);
  // The bypass stays in effect under fleet auth (fleet auth never removes a
  // key/no-key path); warn loudly because it is almost never intended there.
  warnIfInsecureLocalApiUnderFleetAuth({ fleetAuthEnabled, env });
  // Sprint-10 C1/H4: fail-closed parsing — a malformed trusted-proxy token,
  // weak/colliding satellite keys, or partial TLS config abort startup.
  const trustedProxyClientCertToken = parseTrustedProxyClientCertToken(
    env.API_TRUSTED_PROXY_CLIENT_CERT_TOKEN,
  );
  const satelliteApiKeys = parseSatelliteApiKeys(env.API_SATELLITE_KEYS, {
    reservedTokens: [env.API_KEY, env.ADMIN_TOKEN],
  });
  const hubDeviceCompanionId = resolveGatewayHubDeviceCompanionId(options);
  // Testing-harness devices (psfn-framework-ajgo2): env flag plus the harness
  // principal, failing closed when either is missing.
  const testingHarnessDevices = resolveTestingHarnessDevicesConfig(
    options.channelsConfig?.api.testingHarness !== undefined,
    env,
  );
  const hubDeviceIngress = options.hubDeviceAssertionVerifier
    ? new GatewayHubDeviceIngressService({
        verifyAndConsume: (assertion, expected) => options.hubDeviceAssertionVerifier!
          .verifyAndConsumeHubDeviceAssertion(assertion, expected),
        enrollmentAuthority: {
          resolve: async ({ connectionId, authenticatedConnection }) => {
            if (connectionId !== authenticatedConnection.connectionId) {
              throw new Error('Authenticated Hub enrollment authority connection changed');
            }
            return Object.freeze({ ...authenticatedConnection });
          },
        },
        attachments: {
          attach: input => options.hubDeviceAssertionVerifier!.attachHubDeviceHuman(input),
          fenceDevice: input => options.hubDeviceAssertionVerifier!.fenceHubDeviceAttachment(input),
        },
      })
    : undefined;
  const apiTlsConfig = resolveApiHttpServerTlsConfig(env);
  const fleetSsoCompanionUi = options.config.fleetAuth && fleetAuthFleet
    ? resolveFleetSsoCompanionUi(fleetAuthFleet, env)
    : undefined;
  const fleetPortalProjection = createGatewayFleetPortalProjection({
    fleetAuthEnabled,
    ...(options.fleetPortalAuthorization
      ? { authorization: options.fleetPortalAuthorization }
      : {}),
    ...(fleetAuthFleet
      ? { fleet: fleetAuthFleet.companions }
      : {}),
    source: options.gateway,
    ...(options.fleetPortalChannelHealth
      ? { channelHealth: options.fleetPortalChannelHealth }
      : {}),
  });
  const fleetModelUsageProjection = createGatewayFleetModelUsageProjection({
    fleetAuthEnabled,
    ...(options.fleetPortalAuthorization
      ? { portalAuthorization: options.fleetPortalAuthorization }
      : {}),
    ...(options.fleetAuthBroker
      ? { modelAuthorization: options.fleetAuthBroker }
      : {}),
    ...(options.fleetModelUsage ? { usage: options.fleetModelUsage } : {}),
  });
  const testingHarnessGardenAdmin = options.channelsConfig?.api.testingHarness?.gardenAdmin;
  if (options.config.fleetAuth
    && testingHarnessGardenAdmin
    && !options.fleetAuthTestingHarnessGardenAuthorizationAudit) {
    throw new Error(
      'Testing-harness Garden admin requires durable fleet authorization audit wiring',
    );
  }
  const fleetSsoRouter = options.config.fleetAuth && options.fleetAuthBroker
    && options.fleetAuthRequestCapabilities
    && options.fleetAuthRequestCapabilityVerifier && options.fleetAuthRequestCapabilityReplay
    && fleetPortalProjection && fleetModelUsageProjection && fleetAuthFleet
    ? new GatewayFleetSsoRouter({
        canonicalOrigin: options.config.fleetAuth.canonicalOrigin,
        trustProxy: isExplicitTrue(env.FLEET_SSO_TRUST_PROXY),
        ...(env.ADMIN_TOKEN ? { adminToken: env.ADMIN_TOKEN } : {}),
        broker: options.fleetAuthBroker,
        signer: options.fleetAuthRequestCapabilities,
        verifier: options.fleetAuthRequestCapabilityVerifier,
        replay: options.fleetAuthRequestCapabilityReplay,
        portalProjection: fleetPortalProjection,
        modelUsageProjection: fleetModelUsageProjection,
        ...(testingHarnessGardenAdmin
          && options.channelsConfig?.api.testingHarness
          && options.fleetAuthTestingHarnessGardenAuthorizationAudit
          ? {
              testingHarness: {
                apiKey: options.channelsConfig.api.testingHarness.apiKey,
                policy: testingHarnessGardenAdmin,
                audit: options.fleetAuthTestingHarnessGardenAuthorizationAudit,
              },
            }
          : {}),
        ...(options.fleetAuthEscalation ? { escalation: options.fleetAuthEscalation } : {}),
        ...(options.config.fleetAuth.accountRoster
          ? { accountRoster: options.config.fleetAuth.accountRoster }
          : {}),
        upstreams: resolveFleetSsoGardenUpstreams({
          fleet: fleetAuthFleet,
          ...(options.adminPort ? { fleetGardenPort: options.adminPort } : {}),
          env,
        }),
        ...(fleetSsoCompanionUi ? {
          companionUi: {
            companionId: fleetSsoCompanionUi.companionId,
            origin: fleetSsoCompanionUi.origin,
          },
        } : {}),
      })
    : undefined;
  if (fleetAuthEnabled && !fleetSsoRouter) {
    throw new Error('Fleet authentication requires the complete unified-origin router wiring');
  }
  const corsAllowedOrigins = resolveApiCorsAllowedOrigins({
    explicitAllowlist: parseCommaSeparatedEnv(env.API_CORS_ALLOWLIST),
    adminHost: options.adminHost,
    adminPort: options.adminPort,
  });
  const gatewayApiRuntime = new GatewayApiRuntime(options.gateway, {
    chatRequestTimeoutMs: computeGatewayChatRequestTimeoutMs(GATEWAY_API_REQUEST_TIMEOUT_MS),
    satelliteRegistryProvider: options.satelliteRegistryProvider,
    observationAudit: async observation => {
      await options.gateway.recordSharedSatelliteObservationAudit(observation);
    },
  });
  const bearerCompanionRouting = createBearerCompanionRoutingConfig({
    pinnedCompanionId: options.channelsConfig?.api.companionId,
    knownCompanionIds: options.config.companionFleet?.companions
      .map(companion => companion.companionId)
      ?? (options.config.companionId ? [options.config.companionId] : []),
    selectableCompanionIds: options.channelsConfig?.api.selectableCompanionIds,
  });
  const activeCompanionUiInteractions = new Map<string, AbortController>();
  const beginCompanionUiInteraction = (
    interactionId: string,
    upstream?: AbortSignal,
  ): Readonly<{ signal: AbortSignal; release: () => void }> => {
    const controller = new AbortController();
    const mirrorAbort = () => controller.abort(upstream?.reason);
    if (upstream?.aborted) mirrorAbort();
    else upstream?.addEventListener('abort', mirrorAbort, { once: true });
    activeCompanionUiInteractions.set(interactionId, controller);
    return Object.freeze({
      signal: controller.signal,
      release: () => {
        upstream?.removeEventListener('abort', mirrorAbort);
        if (activeCompanionUiInteractions.get(interactionId) === controller) {
          activeCompanionUiInteractions.delete(interactionId);
        }
      },
    });
  };
  const companionUiVoiceLimits = buildVoiceWebSocketServerOptions(options.config);
  // The audio output relay feeds the key-authenticated companion relay routes
  // (`/v1/companion/*` audio) as well as the SSO Companion UI socket, so it is
  // wired whenever the relay exists — never keyed on fleet auth.
  const companionUiAudioOutputRelay = options.companionRelay
    ? new CompanionUiAudioOutputRelay(companionUiVoiceLimits.maxFrameBytes!)
    : undefined;
  // The Companion UI WebSocket has two admission paths (psfn-framework-7oh9y):
  // the Hub path (satellite key + Hub device assertion relaying a fleet SSO
  // cookie or an explicit guest) and the key path (ADMIN_TOKEN / API_KEY bearer
  // on the upgrade). Fleet SSO adds the cookie path; it is never a
  // precondition. The socket is pinned to the fleet canonical origin when
  // fleet auth exists, otherwise to COMPANION_UI_ORIGIN. Its STT ingress is
  // built whenever the socket can exist.
  const companionUiOrigin = options.config.fleetAuth?.canonicalOrigin
    ?? resolveStandaloneCompanionUiOrigin(env);
  const companionUiOperatorKeys = [env.ADMIN_TOKEN, env.API_KEY]
    .filter((key): key is string => Boolean(key?.trim()));
  const companionUiHubPathComposable = hubDeviceIngress !== undefined
    && options.satelliteRegistry !== undefined
    && satelliteApiKeys.length > 0;
  const companionUiSsoComposable = options.config.fleetAuth !== undefined
    && options.fleetAuthBroker !== undefined
    && options.fleetAuthChildAssertions !== undefined
    && options.fleetAuthRequestCapabilities !== undefined;
  const companionUiWebSocketComposable = companionUiOrigin !== undefined
    && options.companionRelay !== undefined
    && (companionUiHubPathComposable || companionUiOperatorKeys.length > 0);
  if (!companionUiWebSocketComposable && companionUiOrigin === undefined && options.companionRelay) {
    log.info(
      'Companion UI WebSocket not composed: set COMPANION_UI_ORIGIN (or fleet auth) to pin its origin; '
      + 'ADMIN_TOKEN / API_KEY then admit key sessions and a Hub device verifier admits Hub sessions',
    );
  }
  const companionUiStt = companionUiWebSocketComposable
    ? createRuntimeVoiceSttConnector(options.config, {
        eligibilityGate: options.eligibilityGate,
      })
    : null;
  const companionUiAudioIngress = companionUiStt
    ? new GatewayCompanionUiAudioIngress({
        createConnector: (companionId) => {
          const owned = createRuntimeVoiceSttConnector(options.config, {
            eligibilityGate: options.eligibilityGate,
            companionId,
          });
          if (!owned) throw new Error('Companion audio transcription is unavailable');
          return owned.connector;
        },
        maxFrameBytes: companionUiVoiceLimits.maxFrameBytes!,
        maxPendingUtterances: companionUiVoiceLimits.maxPendingFrames!,
        maxTranscriptBytes: resolveVoiceSecurityLimits().maxTranscriptChars,
      })
    : undefined;
  const companionUiScreenTranscript = async (input: Readonly<{
    companionId: CompanionId;
    attachment?: HubDeviceAttachmentSnapshot;
    requestId: string;
    transcript: string;
  }>): Promise<string> => {
    const screening = resolveOwnedIntakeScreening(options, input.companionId);
    if (!screening || !input.transcript.trim()) return input.transcript;
    // Key-path sessions have no Hub attachment; their channel is the operator's
    // own companion-ui lane (the same channel the REST key turn would land in).
    const channelId = input.attachment?.channel.id ?? `companion-ui:operator:${input.companionId}`;
    const screened = await screening.screen(input.transcript, {
      sourceClass: 'audio_transcript',
      origin: {
        ref: `companion-ui-audio:${channelId}:${input.requestId}`,
      },
      scope: 'context',
      subject: { kind: 'body' },
      sourceChannelId: channelId,
      timing: {
        traceId: input.requestId,
        requestId: input.requestId,
        channelId,
        channelType: 'api',
      },
    });
    return screened.effectiveText;
  };
  const companionUiCancelAudioInteraction = async ({ interactionId }: Readonly<{
    interactionId: string;
  }>): Promise<void> => {
    activeCompanionUiInteractions.get(interactionId)?.abort();
  };
  const companionUiWebSocket = companionUiWebSocketComposable && companionUiOrigin && options.companionRelay
    ? new CompanionUiWebSocketAdapter({
        ...(companionUiHubPathComposable && env.FLEET_SSO_COMPANION_UI_HUB_ORIGIN?.trim()
          ? { browserHubOrigin: env.FLEET_SSO_COMPANION_UI_HUB_ORIGIN.trim(),
              browserHubTimeoutMs: GATEWAY_API_REQUEST_TIMEOUT_MS }
          : {}),
        canonicalOrigin: companionUiOrigin,
        ...(hubDeviceIngress && options.satelliteRegistry && satelliteApiKeys.length > 0 ? {
          satelliteApiKeys,
          satelliteRegistry: options.satelliteRegistry,
          hubDeviceIngress,
        } : {}),
        guestMode: fleetSsoCompanionUi?.guestMode ?? 'disabled',
        ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
        eventRelay: options.companionRelay.relay,
        ...(companionUiAudioOutputRelay ? { audioOutputRelay: companionUiAudioOutputRelay } : {}),
        ...(companionUiAudioIngress ? {
          audioIngress: companionUiAudioIngress,
          maxPendingAudioFrames: companionUiVoiceLimits.maxPendingFrames,
          screenAudioTranscript: companionUiScreenTranscript,
          cancelAudioInteraction: companionUiCancelAudioInteraction,
        } : {}),
        ...(companionUiOperatorKeys.length > 0 ? {
          operatorKeys: companionUiOperatorKeys,
          operatorActionBroker: {
            // Key path (psfn-framework-7oh9y): the bearer is the human authority,
            // so frames dispatch with the key principal exactly as the REST API
            // does. No Hub attachment, no fleet child assertion: shard and
            // embodiment frames are denied here (they exist only as fleet
            // child-capability / Hub-attachment routes), everything else maps
            // onto the key routes.
            execute: async input => {
              const compiled = compileCompanionUiAction(
                input.rawBody,
                input.companionId,
                input.physicalCeiling,
              );
              const frame = compiled.frame;
              const body = frame.body as Record<string, unknown>;
              if (frame.resource === 'conversation.status') return await gatewayApiRuntime.handleHealth();
              if (frame.resource === 'conversation.interrupt') {
                const interactionId = String(body.interactionId);
                const active = activeCompanionUiInteractions.get(interactionId);
                active?.abort();
                return { interrupted: active !== undefined, interactionId };
              }
              if (frame.resource === 'tool_activity.subscribe') return { subscribed: true };
              if (frame.resource === 'artifact.preview') {
                const preview = options.companionRelay?.relay.getPreviewSource(
                  String(body.id),
                  input.companionId,
                );
                if (!preview?.previewable || !preview.bytes) throw new Error('Artifact preview unavailable');
                return {
                  artifactId: preview.artifactId,
                  mediaType: preview.mediaType,
                  sizeBytes: preview.sizeBytes,
                  dataBase64: preview.bytes.toString('base64'),
                };
              }
              const approval = await dispatchCompanionUiApproval({
                compiled,
                gateway: options.gateway,
              });
              if (approval.handled) return approval.result;
              const content = companionUiPromptContent(frame);
              if (!content || frame.resource === 'shards.interact') {
                throw new Error('Companion UI operator action has no key dispatcher');
              }
              const interaction = beginCompanionUiInteraction(frame.requestId, input.signal);
              try {
                const result = await gatewayApiRuntime.handleChatCompletion({
                  request: {
                    model: input.companionId,
                    messages: [{ role: 'user', content }],
                    system_prompt_mode: 'default',
                  },
                  principal: input.principal,
                  headers: {},
                  signal: interaction.signal,
                });
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              } finally {
                interaction.release();
              }
            },
          },
        } : {}),
        ...(companionUiSsoComposable ? { actionBroker: new GatewayCompanionUiActionBroker({
          resolveAuthorizationContext: input => options.fleetAuthBroker!.resolveAuthorizationContext(input),
          signer: options.fleetAuthRequestCapabilities!,
          childAssertions: options.fleetAuthChildAssertions!,
          approvalOwner: {
            ownerOf: (id) => options.gateway.ownerOfConfirmation(id),
          },
          shardDeployment: {
            ownerOfLiveShard: async (shardId, parentCompanionId) => {
              const result = await options.gateway.requestCompanionAgent<{
                parentCompanionId?: string;
              }>(
                parentCompanionId,
                'shard.directory.owner',
                { shardId },
              );
              return result.parentCompanionId;
            },
          },
          dispatch: {
            dispatch: async input => {
              const frame = input.compiled.frame;
              const body = frame.body as Record<string, unknown>;
              if (frame.resource === 'shards.list'
                || frame.resource === 'shards.history'
                || frame.resource === 'shards.interact'
                || frame.resource === 'shards.interrupt') {
                const result = await gatewayApiRuntime.handleCompanionUiShardAction(
                  input.compiled.target.companionId,
                  {
                    principal: input.deviceTransport.principal,
                    headers: { ...input.deviceTransport.headers },
                    ...(input.deviceTransport.clientCert
                      ? { clientCert: input.deviceTransport.clientCert }
                      : {}),
                    hubDevicePrincipal: input.attachment.deviceActor.principal,
                    hubDeviceAttachment: input.attachment,
                    companionUiCapability: {
                      token: input.childAssertion.token,
                      requestId: input.childAssertion.requestId,
                      decisionId: input.childAssertion.decisionId,
                      versions: input.childAssertion.versions,
                      parent: input.childAssertion.parent,
                      rawBodyBase64Url: Buffer.from(input.compiled.target.body).toString('base64url'),
                    },
                  },
                );
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              }
              const embodiment = await dispatchCompanionUiPrimaryEmbodiment({
                compiled: input.compiled,
                attachment: input.attachment,
                ...(options.primaryEmbodiments ? { authority: options.primaryEmbodiments } : {}),
              });
              if (embodiment.handled) return embodiment.result;
              const approval = await dispatchCompanionUiApproval({
                compiled: input.compiled,
                gateway: options.gateway,
              });
              if (approval.handled) return approval.result;
              if (frame.resource === 'conversation.status') {
                return await gatewayApiRuntime.handleHealth();
              }
              if (frame.resource === 'artifact.preview') {
                const preview = options.companionRelay?.relay.getPreviewSource(
                  String(body.id),
                  input.compiled.target.companionId,
                );
                if (!preview?.previewable || !preview.bytes) throw new Error('Artifact preview unavailable');
                return {
                  artifactId: preview.artifactId,
                  mediaType: preview.mediaType,
                  sizeBytes: preview.sizeBytes,
                  dataBase64: preview.bytes.toString('base64'),
                };
              }
              if (frame.resource === 'tool_activity.subscribe') return { subscribed: true };
              if (frame.resource === 'conversation.interrupt') {
                const interactionId = String(body.interactionId);
                const active = activeCompanionUiInteractions.get(interactionId);
                active?.abort();
                return { interrupted: active !== undefined, interactionId };
              }
              const content = companionUiPromptContent(frame);
              if (!content) throw new Error('Companion UI action has no dispatcher');
              const interaction = beginCompanionUiInteraction(frame.requestId, input.signal);
              try {
                const result = await gatewayApiRuntime.handleChatCompletion({
                  request: {
                    model: input.compiled.target.companionId,
                    messages: [{ role: 'user', content }],
                    system_prompt_mode: 'default',
                  },
                  principal: input.deviceTransport.principal,
                  headers: { ...input.deviceTransport.headers },
                  ...(input.deviceTransport.clientCert ? { clientCert: input.deviceTransport.clientCert } : {}),
                  hubDevicePrincipal: input.attachment.deviceActor.principal,
                  hubDeviceAttachment: input.attachment,
                  companionUiCapability: {
                    token: input.childAssertion.token,
                    requestId: input.childAssertion.requestId,
                    decisionId: input.childAssertion.decisionId,
                    versions: input.childAssertion.versions,
                    parent: input.childAssertion.parent,
                    rawBodyBase64Url: Buffer.from(input.compiled.target.body).toString('base64url'),
                  },
                  signal: interaction.signal,
                });
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              } finally {
                interaction.release();
              }
            },
          },
        }) } : {}),
        ...(fleetSsoCompanionUi?.guestMode === 'explicit' ? {
          guestActionBroker: {
            execute: async input => {
              if (input.attachment.actor.kind !== 'guest') throw new Error('guest attachment required');
              const compiled = compileCompanionUiAction(
                input.rawBody,
                input.companionId,
                input.physicalCeiling,
              );
              const frame = compiled.frame;
              const body = frame.body as Record<string, unknown>;
              if (frame.resource === 'conversation.status') return await gatewayApiRuntime.handleHealth();
              if (frame.resource === 'conversation.interrupt') {
                const interactionId = String(body.interactionId);
                const active = activeCompanionUiInteractions.get(interactionId);
                active?.abort();
                return { interrupted: active !== undefined, interactionId };
              }
              if (frame.resource !== 'conversation.interact'
                && frame.resource !== 'conversation.audio'
                && frame.resource !== 'conversation.touch') {
                throw new Error('guest action denied');
              }
              const content = companionUiPromptContent(frame);
              if (!content) throw new Error('Companion UI guest action has no dispatcher');
              const interaction = beginCompanionUiInteraction(frame.requestId, input.signal);
              try {
                const result = await gatewayApiRuntime.handleChatCompletion({
                  request: {
                    model: input.companionId,
                    messages: [{ role: 'user', content }],
                    system_prompt_mode: 'default',
                  },
                  principal: input.deviceTransport.principal,
                  headers: { ...input.deviceTransport.headers },
                  ...(input.deviceTransport.clientCert ? { clientCert: input.deviceTransport.clientCert } : {}),
                  hubDevicePrincipal: input.attachment.deviceActor.principal,
                  hubDeviceAttachment: input.attachment,
                  signal: interaction.signal,
                });
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              } finally {
                interaction.release();
              }
            },
          },
        } : {}),
      })
    : undefined;
  const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
    config: options.config,
    eligibilityGate: options.eligibilityGate,
    handleAssistantTurn: async ({ request, principal, transportSession, sessionId, transcript, signal, channelPrefix }) => {
      const inboundMessage = buildVoiceMessage({
        request,
        principal,
        connectionId: transportSession.connectionId,
        sessionId,
        transcript,
        channelPrefix,
        satelliteRegistryProvider: options.satelliteRegistryProvider,
        ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
      });
      if (!options.multiCompanion) {
        const message = await screenVoiceTranscriptMessage(
          inboundMessage,
          options.intakeScreening,
        );
        const result = await options.gateway.requestAgentVoiceStream(message, { signal });
        return result.content;
      }
      const result = await options.gateway.requestAgentVoiceStream(inboundMessage, {
        signal,
        screenMessageForCompanion: (message, companionId) =>
          screenVoiceTranscriptMessage(
            message,
            resolveOwnedIntakeScreening(options, companionId),
          ),
      });
      return result.content;
    },
  });
  const voiceWebSocketPath = voiceWebSocketRuntime
    ? undefined
    : DISABLED_VOICE_WEBSOCKET_PATH;
  const companionRelay: CompanionRelayHttpDeps | undefined = options.companionRelay
    ? {
        ...options.companionRelay,
        ...(companionUiAudioOutputRelay ? { audioOutput: companionUiAudioOutputRelay } : {}),
        stimuli: new CompanionStimulusIngress({
          cooldownMs: COMPANION_STIMULUS_COOLDOWN_MS,
          deliver: async (message) => {
            if (!options.multiCompanion) {
              const screened = await screenCompanionStimulusMessage(
                message,
                options.intakeScreening,
              );
              const result = await options.gateway.requestAgentVoiceStream(screened);
              const response = result.content.trim();
              return response ? { response } : {};
            }
            const result = await options.gateway.requestAgentVoiceStream(message, {
              screenMessageForCompanion: (ownedMessage, companionId) =>
                screenCompanionStimulusMessage(
                  ownedMessage,
                  resolveOwnedIntakeScreening(options, companionId),
                ),
            });
            const response = result.content.trim();
            return response ? { response } : {};
          },
        }),
      }
    : undefined;

  const inertEventBus = {
    on: () => () => {},
    emit: async () => undefined,
  } as unknown as EventBus;
  const inertSessionManager = {
    recordAssistantMessage: () => undefined,
  } as unknown as SessionManager;
  const inertAgentLoop = {
    handleMessage: async () => {
      throw new Error('Gateway-hosted API server must not invoke local agent turns');
    },
  } as unknown as SubstrateAgent;
  const inertSensorIngest = {
    ingestTelemetry: async () => {
      throw new Error('Gateway-hosted API server must not ingest telemetry locally');
    },
  } as unknown as SensorIngestPort;

  const apiServer = new ApiServer({
    port: options.apiPort,
    host: options.apiHost,
    agentLoop: inertAgentLoop,
    eventBus: inertEventBus,
    sessionManager: inertSessionManager,
    sensorIngest: inertSensorIngest,
    apiKey: env.API_KEY || undefined,
    testingHarnessPrincipal: options.channelsConfig?.api.testingHarness,
    ...(testingHarnessDevices ? { testingHarnessDevices } : {}),
    ...(options.channelsConfig?.api.externalMemory ? {
      externalMemoryMcp: new ExternalMemoryMcpRoute(
        options.channelsConfig.api.externalMemory,
        params => options.gateway.requestCompanionAgent(
          params.binding.companionId,
          'memory.external.execute',
          params,
          GATEWAY_API_REQUEST_TIMEOUT_MS,
        ),
        [env.API_KEY, env.ADMIN_TOKEN, options.channelsConfig.api.testingHarness?.apiKey, ...satelliteApiKeys],
      ),
    } : {}),
    // ADMIN_TOKEN remains available to the private Garden -> Gateway operator
    // confirmation endpoint and to the fleet router's alternative admin door.
    adminToken: env.ADMIN_TOKEN || undefined,
    ...(satelliteApiKeys.length > 0 ? { satelliteApiKeys } : {}),
    ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
    ...(apiTlsConfig ? { tls: apiTlsConfig } : {}),
    allowInsecureWithoutAuth,
    // Owner-scoped confirmation resolution is a multi-companion concern, not a
    // fleet-auth one.
    confirmationOperatorRequiresCompanionId: options.multiCompanion === true,
    ...(fleetSsoRouter ? { fleetSsoRouter } : {}),
    ...(options.fleetAuthChildAssertions
      ? { fleetAuthChildAssertions: options.fleetAuthChildAssertions }
      : {}),
    ...(hubDeviceIngress ? { hubDeviceIngress } : {}),
    ...(hubDeviceCompanionId ? { hubDeviceCompanionId } : {}),
    ...(companionUiWebSocket ? { companionUiWebSocket } : {}),
    corsAllowedOrigins,
    voiceWebSocketPath,
    voiceWebSocketRuntime,
    requestTimeoutMs: GATEWAY_API_REQUEST_TIMEOUT_MS,
    runtime: gatewayApiRuntime,
    ...(bearerCompanionRouting ? { bearerCompanionRouting } : {}),
    modelName: options.config.companionId
      ?? hubDeviceCompanionId
      ?? options.config.companionFleet?.companions[0]?.companionId,
    companionName: resolveCompanionNameFromConfig(options.config),
    externalChannelProfiles: options.channelsConfig
      ? buildExternalChannelProfiles(options.channelsConfig)
      : {},
    satelliteRegistryProvider: options.satelliteRegistryProvider,
    ...(companionRelay ? { companionRelay } : {}),
    ...(options.gateway.isIcpAutonomyConfigured()
      ? {
          icpAutonomyOperator: {
            cancelForCompanion: async companionId => await options.gateway
              .invalidateIcpAutonomyForCompanion(companionId, 'operator_cancelled'),
          },
        }
      : {}),
    confirmationOperator: {
      resolve: async (params, authority) => {
        if (authority.kind === 'fleet_companion') {
          return await options.gateway.resolveOperatorApprovalForOwner(
            authority.companionId,
            params,
          );
        }
        if (options.multiCompanion) {
          throw new Error('Multi-companion operator confirmation resolution requires companion authority');
        }
        return await options.gateway.resolveOperatorApproval(params);
      },
    },
    ...(options.fleetAuthBroker && options.config.fleetAuth
      ? {
          fleetAuthHttpRoutes: new FleetAuthHttpRoutes({
            broker: options.fleetAuthBroker,
            canonicalOrigin: options.config.fleetAuth.canonicalOrigin,
            callbackPath: options.config.fleetAuth.callbackPath,
            ...(options.fleetAuthEscalation ? { escalation: options.fleetAuthEscalation } : {}),
            ...(options.fleetAuthTrustedHostRecovery
              ? { trustedHostRecovery: options.fleetAuthTrustedHostRecovery }
              : {}),
            ...(options.fleetAuthLifecycleCeremonies
              ? { lifecycleCeremonies: options.fleetAuthLifecycleCeremonies }
              : {}),
            trustProxy: isExplicitTrue(env.FLEET_SSO_TRUST_PROXY),
            ...(fleetSsoCompanionUi ? {
              companionUi: {
                companionId: fleetSsoCompanionUi.companionId,
                guestMode: fleetSsoCompanionUi.guestMode,
              },
            } : {}),
            // Companion roster wire: the authenticated fleet portal projection
            // is the single least-authority, non-enumerating roster source, and
            // it also attributes/filters the fleet-wide approvals view. The raw
            // fleet manifest is never enumerated to the browser.
            ...(fleetPortalProjection ? {
              rosterSource: fleetPortalProjection,
              approvalsSource: {
                listPending: () => options.gateway.listOperatorConfirmations().pending,
                ownerOfConfirmation: (id: string) => options.gateway.ownerOfConfirmation(id),
              },
            } : {}),
          }),
        }
      : {}),
  });
  await apiServer.start();
  return apiServer;
}
