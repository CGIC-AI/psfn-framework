import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import type { GatewayServer } from '../../boundary/gateway/server.js';
import type {
  ApiHealthResponse,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiHealthSubsystemStatus,
  ApiRuntimeChatRequest,
  ApiCompanionUiShardActionRpcParams,
  ApiServerRuntime,
  ApiTelemetryIngestRpcResult,
} from './types.js';
import { monotonicEpochNowMs } from '../../shared/telemetry/turn-performance.js';
import type { SatelliteRegistryProvider } from '../../shared/contracts/satellite-registry.js';
import { resolveSharedSatelliteObservationDeliveries } from '../../shared/telemetry/sensor-ingest-port.js';
import {
  hasSatelliteClaimHeaders,
  resolveSatelliteClaim,
} from '../backplane/satellite-registry.js';

const DEFAULT_GATEWAY_CHAT_REQUEST_TIMEOUT_MS = 95_000;
const GATEWAY_CHAT_REQUEST_TIMEOUT_BUFFER_MS = 5_000;
const AGENT_CHAT_TURN_TIMEOUT_HEADROOM_MS = 1_000;

export interface GatewayApiRuntimeOptions {
  chatRequestTimeoutMs?: number;
  satelliteRegistryProvider?: SatelliteRegistryProvider;
  observationAudit?: (event: {
    satelliteId: string;
    companionId: string;
    scope: string;
    eventId: string;
    timestamp: number;
  }) => Promise<void>;
  now?: () => number;
}

export class GatewayApiRuntime implements ApiServerRuntime {
  private requestCounter = 0;
  private readonly chatRequestTimeoutMs: number;
  private readonly options: GatewayApiRuntimeOptions;

  constructor(
    private readonly gateway: Pick<
      GatewayServer,
      'requestAgent' | 'requestCompanionAgent' | 'subscribeApiStream'
    > & Partial<Pick<
      GatewayServer,
      'requestSharedSatelliteChatCompletion' | 'cancelSharedSatelliteChatCompletion'
    >>,
    options: GatewayApiRuntimeOptions = {},
  ) {
    this.options = options;
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
    const registry = this.options.satelliteRegistryProvider?.();
    const deliveries = registry
      ? resolveSharedSatelliteObservationDeliveries({ event, registry })
      : null;
    if (deliveries !== null) {
      if (deliveries.length === 0) {
        return {
          ok: true,
          response: {
            ok: true,
            id: event.id,
            acceptedEventType: event.eventType,
          },
        };
      }
      const results = await Promise.all(deliveries.map(async (delivery) => {
        const result = await this.gateway.requestCompanionAgent<ApiTelemetryIngestRpcResult>(
          delivery.companionId,
          'api.telemetry.ingest',
          { event: delivery.event },
        );
        if (result.ok) {
          await this.options.observationAudit?.({
            satelliteId: String(delivery.event.payload.satelliteId),
            companionId: delivery.companionId,
            scope: delivery.scope,
            eventId: delivery.event.id,
            timestamp: this.options.now?.() ?? Date.now(),
          });
        }
        return result;
      }));
      return results.find(result => !result.ok) ?? results[0]!;
    }
    return await this.gateway.requestAgent<ApiTelemetryIngestRpcResult>('api.telemetry.ingest', { event });
  }

  async handleChatCompletion(input: ApiRuntimeChatRequest): Promise<ApiChatCompletionRpcResult> {
    const receivedMonotonicAtMs = monotonicEpochNowMs();
    const receivedTimestampMs = Date.now();
    const requestId = `api-${Date.now()}-${++this.requestCounter}`;
    const unsubscribe = input.onDelta
      ? this.gateway.subscribeApiStream(requestId, input.onDelta, input.companionId)
      : () => {};

    let cancelled = false;
    const registry = this.options.satelliteRegistryProvider?.();
    const satelliteClaim = hasSatelliteClaimHeaders(input.headers)
      ? resolveSatelliteClaim({
          headers: input.headers,
          principal: input.principal,
          registry,
          ...(input.clientCert ? { clientCert: input.clientCert } : {}),
        })
      : undefined;
    if (satelliteClaim && !satelliteClaim.ok) {
      unsubscribe();
      return {
        ok: false,
        error: {
          status: satelliteClaim.status,
          type: satelliteClaim.type,
          message: satelliteClaim.message,
        },
      };
    }
    const requestAgent = async <T>(
      method: string,
      params: unknown,
    ): Promise<T> => {
      const sharedSatellite = satelliteClaim?.ok
        && satelliteClaim.value.satellite.sharedDevice
        ? {
            ...satelliteClaim.value.satellite,
            sharedDevice: satelliteClaim.value.satellite.sharedDevice,
          }
        : undefined;
      if (sharedSatellite && method === 'api.chat.completion') {
        if (!this.gateway.requestSharedSatelliteChatCompletion) {
          throw new Error('Shared-satellite chat arbitration is not configured');
        }
        return await this.gateway.requestSharedSatelliteChatCompletion({
          satellite: sharedSatellite,
          canonicalContactId: satelliteClaim.value.canonicalContactId,
          channelId: satelliteClaim.value.channelId,
          params: params as Parameters<
            GatewayServer['requestSharedSatelliteChatCompletion']
          >[0]['params'],
          timeoutMs: this.chatRequestTimeoutMs,
        }) as T;
      }
      if (sharedSatellite && method === 'api.chat.cancel') {
        if (!this.gateway.cancelSharedSatelliteChatCompletion) {
          return { cancelled: false } as T;
        }
        return await this.gateway.cancelSharedSatelliteChatCompletion(
          requestId,
          params,
          this.chatRequestTimeoutMs,
        ) as T;
      }
      if (!input.companionId) {
        return await this.gateway.requestAgent<T>(
          method,
          params,
          this.chatRequestTimeoutMs,
        );
      }
      return await this.gateway.requestCompanionAgent<T>(
        input.companionId,
        method,
        params,
        this.chatRequestTimeoutMs,
      );
    };
    const cancel = async (): Promise<ApiChatCompletionCancelRpcResult | undefined> => {
      if (cancelled) return undefined;
      cancelled = true;
      try {
        return await requestAgent<ApiChatCompletionCancelRpcResult>(
          'api.chat.cancel',
          { requestId },
        );
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
      const result = await requestAgent<ApiChatCompletionRpcResult>('api.chat.completion', {
        requestId,
        request: input.request,
        principal: input.principal,
        headers: input.headers,
        ...(input.clientCert ? { clientCert: input.clientCert } : {}),
        ...(input.hubDevicePrincipal ? { hubDevicePrincipal: input.hubDevicePrincipal } : {}),
        ...(input.hubDeviceAttachment ? { hubDeviceAttachment: input.hubDeviceAttachment } : {}),
        ...(input.companionUiCapability ? { companionUiCapability: input.companionUiCapability } : {}),
        timeoutMs: computeAgentChatTurnTimeoutMs(this.chatRequestTimeoutMs),
        performance: { receivedMonotonicAtMs, receivedTimestampMs },
      });
      if (!result.ok || !input.companionId || result.response.companionId) {
        return result;
      }
      return {
        ...result,
        response: {
          ...result.response,
          companionId: input.companionId,
        },
      };
    } finally {
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
      unsubscribe();
    }
  }

  async handleCompanionUiShardAction(
    companionId: string,
    input: Omit<ApiCompanionUiShardActionRpcParams, 'requestId'>,
  ): Promise<ApiCompanionUiShardActionRpcResult> {
    const requestId = `companion-ui-shard-${Date.now()}-${++this.requestCounter}`;
    return await this.gateway.requestCompanionAgent<ApiCompanionUiShardActionRpcResult>(
      companionId,
      'api.companion-ui.shard.action',
      { ...input, requestId },
      this.chatRequestTimeoutMs,
    );
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
