import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
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
import { createApiVoiceWebSocketRuntime } from '../../channels/api/voice-websocket-runtime.js';
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
import {
  assertFleetAuthLegacySurfacesUnavailable,
  warnIfInsecureLocalApiIgnoredUnderFleetAuth,
} from '../../system/config/fleet-auth-legacy-surface-guard.js';
import type { GatewayFleetAuthBroker } from '../../boundary/gateway/fleet-auth-broker.js';
import type { GatewayFleetAuthChildAssertionBroker } from '../../boundary/gateway/fleet-auth-child-assertions.js';
import { GatewayCompanionUiActionBroker } from '../../boundary/gateway/companion-ui-action-broker.js';
import type {
  GatewayRequestCapabilitySigner,
  RequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import { CompanionUiWebSocketAdapter } from '../../channels/api/companion-ui-websocket.js';
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
  HubDevicePrincipal,
} from '../../shared/contracts/hub-device-ingress.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import type { FleetPortalAuthorizationBatchPort } from '../../boundary/gateway/fleet-portal-authorization.js';
import type { FleetPortalChannelHealthSource } from '../../boundary/gateway/fleet-portal-projection.js';
import { createGatewayFleetPortalProjection } from './fleet-portal-composition.js';
import type { FleetModelUsageSummaryQueryPort } from '../../shared/telemetry/model-usage.js';
import { createGatewayFleetModelUsageProjection } from './fleet-model-usage-composition.js';
import { createBearerCompanionRoutingConfig } from '../../channels/api/server/bearer-companion-selector.js';

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
  /** Explicit owner-file posture; required so omission cannot disable screening. */
  intakeScreeningMode: 'off' | 'shadow' | 'enforce';
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
  if (
    configuredMode !== 'off'
    && configuredMode !== 'shadow'
    && configuredMode !== 'enforce'
  ) {
    throw new Error('Gateway API intake screening requires an explicit valid mode');
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
      if (mode === 'off') {
        if (screening !== null) {
          throw new Error(
            `Fleet gateway API intake screening mode=off resolved a service for ${companion.companionId}`,
          );
        }
      } else if (!screening || screening.mode !== mode) {
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
  if (mode === 'off') {
    if (options.intakeScreening) {
      throw new Error('Single-companion gateway API intake screening mode=off resolved a service');
    }
  } else if (!options.intakeScreening || options.intakeScreening.mode !== mode) {
    throw new Error(
      `Single-companion gateway API intake screening mode=${mode} has no matching service`,
    );
  }
}

function resolveGatewayHubDeviceCompanionId(
  options: StartOptionalGatewayApiServerOptions,
  fleet: NonNullable<SubstrateConfig['companionFleet']>,
): string | undefined {
  const channelCompanionId = options.channelsConfig?.api.companionId;
  if (channelCompanionId) return channelCompanionId;
  if (fleet.companions.length === 1) return fleet.companions[0]!.companionId;
  return undefined;
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
  const fleetAuthBootstrapOnly = options.config.fleetAuth !== undefined;
  const fleetAuthFleet = fleetAuthBootstrapOnly
    ? requireFleetSsoFleetManifest(options.config.companionFleet)
    : undefined;
  const principalAuthenticationWired = options.fleetAuthBroker !== undefined
    && options.fleetAuthEscalation !== undefined
    && options.fleetAuthTrustedHostRecovery !== undefined
    && options.fleetAuthLifecycleCeremonies !== undefined
    && options.fleetAuthChildAssertions !== undefined
    && options.fleetAuthRequestCapabilities !== undefined
    && options.fleetAuthRequestCapabilityVerifier !== undefined
    && options.fleetAuthRequestCapabilityReplay !== undefined
    && options.fleetPortalAuthorization !== undefined
    && options.primaryEmbodiments !== undefined
    && options.hubDeviceAssertionVerifier !== undefined;
  if (fleetAuthBootstrapOnly && !principalAuthenticationWired) {
    throw new Error(
      'Fleet-auth principal composition is incomplete; refusing to expose the gateway API',
    );
  }
  assertFleetAuthLegacySurfacesUnavailable({
    fleetAuthEnabled: options.config.fleetAuth !== undefined,
    processMode: 'gateway',
    env: { ...env, API_PORT: String(options.apiPort) },
    principalAuthenticationWired,
    fleetAuthBootstrapRoutesWired: options.fleetAuthBroker !== undefined,
  });
  assertGatewayApiIntakeScreeningOwnership(options);
  const allowInsecureWithoutAuth = !fleetAuthBootstrapOnly
    && isExplicitTrue(env.ALLOW_INSECURE_LOCAL_API);
  // Fleet auth overrode any ALLOW_INSECURE_LOCAL_API=true above; warn loudly so
  // the ineffective, dangerous flag is removed rather than left to mislead.
  warnIfInsecureLocalApiIgnoredUnderFleetAuth({ fleetAuthEnabled: fleetAuthBootstrapOnly, env });
  // Sprint-10 C1/H4: fail-closed parsing — a malformed trusted-proxy token,
  // weak/colliding satellite keys, or partial TLS config abort startup.
  const trustedProxyClientCertToken = parseTrustedProxyClientCertToken(
    env.API_TRUSTED_PROXY_CLIENT_CERT_TOKEN,
  );
  const satelliteApiKeys = parseSatelliteApiKeys(env.API_SATELLITE_KEYS, {
    reservedTokens: [env.API_KEY, env.ADMIN_TOKEN],
  });
  const hubDeviceCompanionId = fleetAuthBootstrapOnly && fleetAuthFleet
    ? resolveGatewayHubDeviceCompanionId(options, fleetAuthFleet)
    : undefined;
  const hubDeviceIngress = fleetAuthBootstrapOnly && options.hubDeviceAssertionVerifier
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
    fleetAuthEnabled: fleetAuthBootstrapOnly,
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
    fleetAuthEnabled: fleetAuthBootstrapOnly,
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
  if (fleetAuthBootstrapOnly && !fleetSsoRouter) {
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
  const companionUiWebSocket = fleetAuthBootstrapOnly
    && options.config.fleetAuth
    && options.fleetAuthBroker
    && options.fleetAuthChildAssertions
    && options.fleetAuthRequestCapabilities
    && hubDeviceIngress
    && options.satelliteRegistry
    && options.companionRelay
    ? new CompanionUiWebSocketAdapter({
        canonicalOrigin: options.config.fleetAuth.canonicalOrigin,
        satelliteApiKeys,
        satelliteRegistry: options.satelliteRegistry,
        guestMode: fleetSsoCompanionUi?.guestMode ?? 'disabled',
        ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
        hubDeviceIngress,
        eventRelay: options.companionRelay.relay,
        actionBroker: new GatewayCompanionUiActionBroker({
          resolveAuthorizationContext: input => options.fleetAuthBroker!.resolveAuthorizationContext(input),
          signer: options.fleetAuthRequestCapabilities,
          childAssertions: options.fleetAuthChildAssertions,
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
              const controller = new AbortController();
              activeCompanionUiInteractions.set(frame.requestId, controller);
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
                  signal: controller.signal,
                });
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              } finally {
                if (activeCompanionUiInteractions.get(frame.requestId) === controller) {
                  activeCompanionUiInteractions.delete(frame.requestId);
                }
              }
            },
          },
        }),
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
              const controller = new AbortController();
              activeCompanionUiInteractions.set(frame.requestId, controller);
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
                  signal: controller.signal,
                });
                if (!result.ok) throw new Error(result.error.type);
                return result.response;
              } finally {
                if (activeCompanionUiInteractions.get(frame.requestId) === controller) {
                  activeCompanionUiInteractions.delete(frame.requestId);
                }
              }
            },
          },
        } : {}),
      })
    : undefined;
  const voiceWebSocketRuntime = fleetAuthBootstrapOnly ? undefined : createApiVoiceWebSocketRuntime({
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
    apiKey: fleetAuthBootstrapOnly ? undefined : env.API_KEY || undefined,
    testingHarnessPrincipal: options.channelsConfig?.api.testingHarness,
    adminToken: fleetAuthBootstrapOnly ? undefined : env.ADMIN_TOKEN || undefined,
    ...(satelliteApiKeys.length > 0 ? { satelliteApiKeys } : {}),
    ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
    ...(apiTlsConfig ? { tls: apiTlsConfig } : {}),
    allowInsecureWithoutAuth,
    fleetAuthBootstrapOnly,
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
      resolve: async params => await options.gateway.resolveOperatorApproval(params),
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
