import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { ApiServer } from '../../channels/api/server.js';
import { resolveApiCorsAllowedOrigins } from '../../channels/api/http-policy.js';
import { createApiVoiceWebSocketRuntime } from '../../channels/api/voice-websocket-runtime.js';
import {
  computeGatewayChatRequestTimeoutMs,
  GatewayApiRuntime,
} from '../../channels/api/gateway-runtime.js';
import type { GatewayServer } from '../../boundary/gateway/server.js';
import type { EligibilityGate } from '../../system/capabilities/eligibility.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SessionManager } from '../../core/session/manager.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SensorIngestPort } from '../../shared/telemetry/sensor-ingest-port.js';
import { parseOptionalPositiveIntEnv } from '../../shared/utils/env.js';
import { isExplicitTrue, parseCommaSeparatedEnv } from '../startup/support/env-parsing.js';

const DISABLED_VOICE_WEBSOCKET_PATH = '/v1/voice/ws-disabled';
const GATEWAY_API_REQUEST_TIMEOUT_MS = 120_000;

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
  gateway: Pick<GatewayServer, 'requestAgent' | 'subscribeApiStream' | 'requestAgentVoiceStream'>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function clampHeader(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
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
    const value = clampHeader(url.searchParams.get(name) ?? undefined, 1024);
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
  const headerValue = clampHeader(singleHeader(request.headers[headerName]), maxLength);
  if (headerValue) return headerValue;
  return clampHeader(readQueryParam(request, queryNames), maxLength);
}

function buildVoiceMessage(params: {
  request: IncomingMessage;
  principal: { id: string; mode: 'api_key' | 'insecure_local' };
  connectionId: string;
  transcript: string;
  channelPrefix: string;
}): SubstrateMessage {
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
  const allowInsecureWithoutAuth = isExplicitTrue(env.ALLOW_INSECURE_LOCAL_API);
  const corsAllowedOrigins = resolveApiCorsAllowedOrigins({
    explicitAllowlist: parseCommaSeparatedEnv(env.API_CORS_ALLOWLIST),
    adminHost: options.adminHost,
    adminPort: options.adminPort,
  });
  const voiceWebSocketRuntime = createApiVoiceWebSocketRuntime({
    config: options.config,
    eligibilityGate: options.eligibilityGate,
    handleAssistantTurn: async ({ request, principal, transportSession, transcript, signal, channelPrefix }) => {
      const message = buildVoiceMessage({
        request,
        principal,
        connectionId: transportSession.connectionId,
        transcript,
        channelPrefix,
      });
      const result = await options.gateway.requestAgentVoiceStream(message, { signal });
      return result.content;
    },
  });
  const voiceWebSocketPath = voiceWebSocketRuntime
    ? undefined
    : DISABLED_VOICE_WEBSOCKET_PATH;

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
    adminToken: env.ADMIN_TOKEN || undefined,
    allowInsecureWithoutAuth,
    corsAllowedOrigins,
    voiceWebSocketPath,
    voiceWebSocketRuntime,
    requestTimeoutMs: GATEWAY_API_REQUEST_TIMEOUT_MS,
    runtime: new GatewayApiRuntime(options.gateway, {
      chatRequestTimeoutMs: computeGatewayChatRequestTimeoutMs(GATEWAY_API_REQUEST_TIMEOUT_MS),
    }),
    modelName: options.config.companionId,
  });
  await apiServer.start();
  return apiServer;
}
