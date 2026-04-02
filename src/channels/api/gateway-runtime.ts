import type { ExternalTelemetryEvent } from '../../shared/event-bus.js';
import type { GatewayServer } from '../../boundary/gateway/server.js';
import type {
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiRuntimeChatRequest,
  ApiServerRuntime,
  ApiTelemetryIngestRpcResult,
} from './types.js';

export class GatewayApiRuntime implements ApiServerRuntime {
  private requestCounter = 0;

  constructor(
    private readonly gateway: Pick<GatewayServer, 'requestAgent' | 'subscribeApiStream'>,
  ) {}

  async handleHealth(): Promise<ApiHealthRpcResult> {
    return await this.gateway.requestAgent<ApiHealthRpcResult>('api.health', {});
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
      });
    } finally {
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
      unsubscribe();
    }
  }
}
