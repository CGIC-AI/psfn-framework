import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
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
import { assertFleetAuthLegacySurfacesUnavailable } from '../../system/config/fleet-auth-legacy-surface-guard.js';
import type { GatewayFleetAuthBroker } from '../../boundary/gateway/fleet-auth-broker.js';
import type { GatewayFleetAuthChildAssertionBroker } from '../../boundary/gateway/fleet-auth-child-assertions.js';
import { GatewayCompanionUiActionBroker } from '../../boundary/gateway/companion-ui-action-broker.js';
import type {
  GatewayRequestCapabilitySigner,
  RequestCapabilityVerifier,
} from '../../boundary/fleet-auth/request-capability.js';
import { CompanionUiWebSocketAdapter } from '../../channels/api/companion-ui-websocket.js';
import { companionUiPromptContent } from '../../boundary/fleet-auth/companion-ui-action.js';
import type { RequestCapabilityReplayPort } from '../../boundary/fleet-auth/request-capability-replay.js';
import { GatewayFleetSsoRouter } from '../../boundary/gateway/fleet-sso-router.js';
import { resolveFleetSsoGardenUpstreams } from '../../boundary/fleet-auth/fleet-sso-transport.js';
import type {
  PrimaryEmbodimentAuthorityPort,
} from '../../boundary/fleet-auth/primary-embodiment.js';
import { dispatchCompanionUiPrimaryEmbodiment } from '../../boundary/gateway/companion-ui-primary-embodiment.js';
import { FleetAuthHttpRoutes } from '../../channels/api/server/fleet-auth-routes.js';
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
import { createGatewayFleetPortalProjection } from './fleet-portal-composition.js';

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
    | 'getFleetConnectionSnapshot'
  >;
  channelsConfig?: RuntimeChannelsConfig;
  satelliteRegistry?: SatelliteRegistryConfig;
  /**
   * htm9.9: intake screening for voice transcripts (sourceClass
   * 'audio_transcript') — a transcript becomes prompt text, so audio is a
   * real injection channel. Null when the firewall mode is 'off'.
   */
  intakeScreening?: IntakeScreeningService | null;
  /** Companion event relay surface (w9hj.1); `/v1/companion/*` 503s without it. */
  companionRelay?: Omit<CompanionRelayHttpDeps, 'stimuli'>;
  /** Present only in gateway fleet-auth mode; owns all browser OAuth/session authority. */
  fleetAuthBroker?: GatewayFleetAuthBroker;
  fleetAuthChildAssertions?: GatewayFleetAuthChildAssertionBroker;
  fleetAuthRequestCapabilities?: GatewayRequestCapabilitySigner;
  fleetAuthRequestCapabilityVerifier?: RequestCapabilityVerifier;
  fleetAuthRequestCapabilityReplay?: RequestCapabilityReplayPort;
  fleetPortalAuthorization?: FleetPortalAuthorizationBatchPort;
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

function resolveGatewayHubDeviceCompanionId(options: StartOptionalGatewayApiServerOptions): string | undefined {
  const channelCompanionId = options.channelsConfig?.api.companionId;
  if (channelCompanionId) return channelCompanionId;
  const fleet = options.config.companionFleet?.companions ?? [];
  if (fleet.length === 1) return fleet[0]!.companionId;
  if (!options.config.companionFleet && options.config.companionId) return options.config.companionId;
  return undefined;
}

function resolveFleetSsoCompanionUi(
  config: SubstrateConfig,
  env: NodeJS.ProcessEnv,
): { companionId: ReturnType<typeof createCompanionId>; origin: URL } | undefined {
  const rawOrigin = env.FLEET_SSO_COMPANION_UI_ORIGIN?.trim();
  if (!rawOrigin) return undefined;
  const fleet = config.companionFleet?.companions
    ?? (config.companionId ? [{ companionId: config.companionId }] : []);
  const rawCompanionId = env.FLEET_SSO_COMPANION_UI_COMPANION_ID?.trim()
    || (fleet.length === 1 ? fleet[0]!.companionId : undefined);
  if (!rawCompanionId || !fleet.some(entry => entry.companionId === rawCompanionId)) {
    throw new Error(
      'Fleet SSO Companion UI requires one exact registered FLEET_SSO_COMPANION_UI_COMPANION_ID',
    );
  }
  const origin = new URL(rawOrigin);
  if (origin.origin !== rawOrigin || origin.protocol !== 'http:' || origin.username
    || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('FLEET_SSO_COMPANION_UI_ORIGIN must be one exact internal HTTP origin');
  }
  return {
    companionId: createCompanionId(rawCompanionId, 'Fleet SSO Companion UI companion binding'),
    origin,
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
  satelliteRegistry?: SatelliteRegistryConfig;
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
      registry: params.satelliteRegistry,
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
  assertFleetAuthLegacySurfacesUnavailable({
    fleetAuthEnabled: options.config.fleetAuth !== undefined,
    processMode: 'gateway',
    env: { ...env, API_PORT: String(options.apiPort) },
    principalAuthenticationWired: false,
    fleetAuthBootstrapRoutesWired: options.fleetAuthBroker !== undefined,
  });
  const allowInsecureWithoutAuth = !fleetAuthBootstrapOnly
    && isExplicitTrue(env.ALLOW_INSECURE_LOCAL_API);
  // Sprint-10 C1/H4: fail-closed parsing — a malformed trusted-proxy token,
  // weak/colliding satellite keys, or partial TLS config abort startup.
  const trustedProxyClientCertToken = parseTrustedProxyClientCertToken(
    env.API_TRUSTED_PROXY_CLIENT_CERT_TOKEN,
  );
  const satelliteApiKeys = parseSatelliteApiKeys(env.API_SATELLITE_KEYS, {
    reservedTokens: [env.API_KEY, env.ADMIN_TOKEN],
  });
  const hubDeviceCompanionId = fleetAuthBootstrapOnly
    ? resolveGatewayHubDeviceCompanionId(options)
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
  const fleetSsoCompanionUi = options.config.fleetAuth
    ? resolveFleetSsoCompanionUi(options.config, env)
    : undefined;
  const fleetPortalProjection = createGatewayFleetPortalProjection({
    fleetAuthEnabled: fleetAuthBootstrapOnly,
    ...(options.fleetPortalAuthorization
      ? { authorization: options.fleetPortalAuthorization }
      : {}),
    ...(options.config.companionFleet
      ? { fleet: options.config.companionFleet.companions }
      : {}),
    source: options.gateway,
  });
  const fleetSsoRouter = options.config.fleetAuth && options.fleetAuthBroker
    && options.fleetAuthRequestCapabilities
    && options.fleetAuthRequestCapabilityVerifier && options.fleetAuthRequestCapabilityReplay
    && fleetPortalProjection
    ? new GatewayFleetSsoRouter({
        canonicalOrigin: options.config.fleetAuth.canonicalOrigin,
        trustProxy: isExplicitTrue(env.FLEET_SSO_TRUST_PROXY),
        broker: options.fleetAuthBroker,
        signer: options.fleetAuthRequestCapabilities,
        verifier: options.fleetAuthRequestCapabilityVerifier,
        replay: options.fleetAuthRequestCapabilityReplay,
        portalProjection: fleetPortalProjection,
        upstreams: resolveFleetSsoGardenUpstreams({
          ...(options.config.companionFleet ? { fleet: options.config.companionFleet } : {}),
          ...(options.config.companionId ? { companionId: options.config.companionId } : {}),
          ...(options.adminPort ? { gardenPort: options.adminPort } : {}),
          env,
        }),
        ...(fleetSsoCompanionUi ? { companionUi: fleetSsoCompanionUi } : {}),
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
  });
  const activeCompanionUiInteractions = new Map<string, AbortController>();
  const companionUiWebSocket = fleetAuthBootstrapOnly
    && options.config.fleetAuth
    && options.fleetAuthBroker
    && options.fleetAuthChildAssertions
    && options.fleetAuthRequestCapabilities
    && hubDeviceIngress
    && options.satelliteRegistry
    ? new CompanionUiWebSocketAdapter({
        canonicalOrigin: options.config.fleetAuth.canonicalOrigin,
        satelliteApiKeys,
        satelliteRegistry: options.satelliteRegistry,
        ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
        hubDeviceIngress,
        actionBroker: new GatewayCompanionUiActionBroker({
          resolveAuthorizationContext: input => options.fleetAuthBroker!.resolveAuthorizationContext(input),
          signer: options.fleetAuthRequestCapabilities,
          childAssertions: options.fleetAuthChildAssertions,
          dispatch: {
            dispatch: async input => {
              const frame = input.compiled.frame;
              const body = frame.body as Record<string, unknown>;
              const embodiment = await dispatchCompanionUiPrimaryEmbodiment({
                compiled: input.compiled,
                attachment: input.attachment,
                ...(options.primaryEmbodiments ? { authority: options.primaryEmbodiments } : {}),
              });
              if (embodiment.handled) return embodiment.result;
              if (frame.resource === 'conversation.status') {
                return await gatewayApiRuntime.handleHealth();
              }
              if (frame.resource === 'confirmations.list') {
                return options.gateway.listOperatorConfirmations();
              }
              if (frame.resource === 'confirmations.resolve') {
                return await options.gateway.resolveOperatorApproval({
                  id: String(body.id),
                  decision: body.decision as 'approve' | 'deny',
                });
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
      })
    : undefined;
  const voiceWebSocketRuntime = fleetAuthBootstrapOnly ? undefined : createApiVoiceWebSocketRuntime({
    config: options.config,
    eligibilityGate: options.eligibilityGate,
    handleAssistantTurn: async ({ request, principal, transportSession, sessionId, transcript, signal, channelPrefix }) => {
      const message = await screenVoiceTranscriptMessage(buildVoiceMessage({
        request,
        principal,
        connectionId: transportSession.connectionId,
        sessionId,
        transcript,
        channelPrefix,
        satelliteRegistry: options.satelliteRegistry,
        ...(trustedProxyClientCertToken ? { trustedProxyClientCertToken } : {}),
      }), options.intakeScreening);
      const result = await options.gateway.requestAgentVoiceStream(message, { signal });
      return result.content;
    },
  });
  const voiceWebSocketPath = voiceWebSocketRuntime
    ? undefined
    : DISABLED_VOICE_WEBSOCKET_PATH;
  const companionRelay: CompanionRelayHttpDeps | undefined = !fleetAuthBootstrapOnly && options.companionRelay
    ? {
        ...options.companionRelay,
        stimuli: new CompanionStimulusIngress({
          cooldownMs: COMPANION_STIMULUS_COOLDOWN_MS,
          deliver: async (message) => {
            const screened = await screenCompanionStimulusMessage(message, options.intakeScreening);
            const result = await options.gateway.requestAgentVoiceStream(screened);
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
    modelName: options.config.companionId
      ?? hubDeviceCompanionId
      ?? options.config.companionFleet?.companions[0]?.companionId,
    companionName: resolveCompanionNameFromConfig(options.config),
    externalChannelProfiles: options.channelsConfig
      ? buildExternalChannelProfiles(options.channelsConfig)
      : {},
    ...(options.satelliteRegistry ? { satelliteRegistry: options.satelliteRegistry } : {}),
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
            trustProxy: isExplicitTrue(env.FLEET_SSO_TRUST_PROXY),
          }),
        }
      : {}),
  });
  await apiServer.start();
  return apiServer;
}
