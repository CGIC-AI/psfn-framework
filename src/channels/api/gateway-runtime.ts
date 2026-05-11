import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import type { GatewayServer } from '../../boundary/gateway/server.js';
import type {
  ApiHealthResponse,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiHealthSubsystemStatus,
  ApiRuntimeChatRequest,
  ApiServerRuntime,
  ApiTelemetryIngestRpcResult,
} from './types.js';

const DEFAULT_GATEWAY_CHAT_REQUEST_TIMEOUT_MS = 95_000;
const GATEWAY_CHAT_REQUEST_TIMEOUT_BUFFER_MS = 5_000;
const AGENT_CHAT_TURN_TIMEOUT_HEADROOM_MS = 1_000;

export interface GatewayApiRuntimeOptions {
  chatRequestTimeoutMs?: number;
}

export class GatewayApiRuntime implements ApiServerRuntime {
  private requestCounter = 0;
  private readonly chatRequestTimeoutMs: number;

  constructor(
    private readonly gateway: Pick<GatewayServer, 'requestAgent' | 'subscribeApiStream'>,
    options: GatewayApiRuntimeOptions = {},
  ) {
    this.chatRequestTimeoutMs = normalizeGatewayChatRequestTimeoutMs(
      options.chatRequestTimeoutMs,
      DEFAULT_GATEWAY_CHAT_REQUEST_TIMEOUT_MS,
    );
  }

  async handleHealth(): Promise<ApiHealthRpcResult> {
    try {
      return await this.gateway.requestAgent<ApiHealthRpcResult>('api.health', {});
    } catch (error) {
      return buildGatewayDisconnectedHealth(error);
    }
  }

  async handleTelemetryIngest(event: ExternalTelemetryEvent): Promise<ApiTelemetryIngestRpcResult> {
    return await this.gateway.requestAgent<ApiTelemetryIngestRpcResult>('api.telemetry.ingest', { event });
  }

  async handleChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult> {
    const requestId = `api-${Date.now()}-${++this.requestCounter}`;
    const unsubscribe = input.onDelta
      ? this.gateway.subscribeApiStream(requestId, input.onDelta)
      : () => {};

    let cancelled = false;
    const cancel = async (): Promise<ApiChatCompletionCancelRpcResult | undefined> => {
      if (cancelled) return undefined;
      cancelled = true;
      try {
        return await this.gateway.requestAgent<ApiChatCompletionCancelRpcResult>('api.chat.cancel', { requestId });
      } catch {
        return undefined;
      }
    };

    const onAbort = () => {
      void cancel();
    };

    if (input.signal) {
      if (input.signal.aborted) {
        await cancel();
        return {
          ok: false,
          error: {
            status: 499,
            type: 'request_cancelled',
            message: 'Request cancelled',
          },
        };
      } else {
        input.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    try {
      return await this.gateway.requestAgent<ApiChatCompletionRpcResult>('api.chat.completion', {
        requestId,
        request: input.request,
        principal: input.principal,
        headers: input.headers,
        timeoutMs: computeAgentChatTurnTimeoutMs(this.chatRequestTimeoutMs),
      }, this.chatRequestTimeoutMs);
    } finally {
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
      unsubscribe();
    }
  }
}

function computeAgentChatTurnTimeoutMs(gatewayTimeoutMs: number): number {
  return Math.max(
    1,
    Math.floor(gatewayTimeoutMs) - GATEWAY_CHAT_REQUEST_TIMEOUT_BUFFER_MS - AGENT_CHAT_TURN_TIMEOUT_HEADROOM_MS,
  );
}

function buildGatewayDisconnectedHealth(error: unknown): ApiHealthResponse {
  const detail = error instanceof Error ? error.message : String(error);
  const checkedAt = new Date().toISOString();
  const pendingAgentStatus = buildPendingAgentStatus(detail);

  return {
    status: 'degraded',
    checkedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    subsystems: {
      memory: pendingAgentStatus,
      llm: pendingAgentStatus,
      discord: pendingAgentStatus,
      embeddings: pendingAgentStatus,
      scheduler: pendingAgentStatus,
    },
    continuity: {
      status: 'degraded',
      checks: {
        database: pendingAgentStatus,
        gatewayLink: {
          status: 'degraded',
          detail,
          meta: {
            agentConnected: false,
          },
        },
        schedulerHealthcheck: pendingAgentStatus,
      },
    },
  };
}

function buildPendingAgentStatus(detail: string): ApiHealthSubsystemStatus {
  return {
    status: 'degraded',
    detail: `Waiting for agent health: ${detail}`,
    meta: {
      agentConnected: false,
    },
  };
}

function normalizeGatewayChatRequestTimeoutMs(
  value: number | undefined,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function computeGatewayChatRequestTimeoutMs(apiRequestTimeoutMs: number | undefined): number {
  if (typeof apiRequestTimeoutMs !== 'number' || !Number.isFinite(apiRequestTimeoutMs) || apiRequestTimeoutMs <= 0) {
    return DEFAULT_GATEWAY_CHAT_REQUEST_TIMEOUT_MS;
  }
  return Math.max(
    1,
    Math.floor(apiRequestTimeoutMs) + GATEWAY_CHAT_REQUEST_TIMEOUT_BUFFER_MS,
  );
}
