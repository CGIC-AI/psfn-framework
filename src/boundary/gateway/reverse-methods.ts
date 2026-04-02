import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiHealthRpcResult,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
} from '../../channels/api/types.js';
import type {
  RpcSubstrateMessage,
  VoiceHandleMessageResult,
  VoiceStreamStartParams,
  VoiceStreamChunkParams,
  VoiceStreamEndParams,
  VoiceStreamCancelParams,
  VoiceStreamAckResult,
  VoiceStreamEndResult,
  VoiceStreamCancelResult,
} from './protocol.js';

export interface ReverseGatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  dispatchHandleMessage(message: RpcSubstrateMessage): Promise<VoiceHandleMessageResult>;
  handleVoiceStreamStart(params: VoiceStreamStartParams): VoiceStreamAckResult;
  handleVoiceStreamChunk(params: VoiceStreamChunkParams): VoiceStreamAckResult;
  handleVoiceStreamEnd(params: VoiceStreamEndParams): Promise<VoiceStreamEndResult>;
  handleVoiceStreamCancel(params: VoiceStreamCancelParams): Promise<VoiceStreamCancelResult>;
  handleApiChatCompletion(params: ApiChatCompletionRpcParams): Promise<ApiChatCompletionRpcResult>;
  handleApiChatCancel(params: ApiChatCompletionCancelRpcParams): Promise<ApiChatCompletionCancelRpcResult>;
  handleApiTelemetryIngest(params: ApiTelemetryIngestRpcParams): Promise<ApiTelemetryIngestRpcResult>;
  handleApiHealth(): Promise<ApiHealthRpcResult>;
}

interface ReverseGatewayMethodDescriptor<P, R> {
  names: readonly string[];
  handler: (params: P, runtime: ReverseGatewayMethodRuntime) => Promise<R> | R;
}

const reverseDescriptors: Array<ReverseGatewayMethodDescriptor<any, unknown>> = [
  {
    names: ['voice.handleMessage'],
    handler: (params: { message: RpcSubstrateMessage }, runtime) => runtime.dispatchHandleMessage(params.message),
  },
  {
    names: ['voice.stream.start'],
    handler: (params: VoiceStreamStartParams, runtime) => runtime.handleVoiceStreamStart(params),
  },
  {
    names: ['voice.stream.chunk'],
    handler: (params: VoiceStreamChunkParams, runtime) => runtime.handleVoiceStreamChunk(params),
  },
  {
    names: ['voice.stream.end'],
    handler: (params: VoiceStreamEndParams, runtime) => runtime.handleVoiceStreamEnd(params),
  },
  {
    names: ['voice.stream.cancel'],
    handler: (params: VoiceStreamCancelParams, runtime) => runtime.handleVoiceStreamCancel(params),
  },
  {
    names: ['api.chat.completion'],
    handler: (params: ApiChatCompletionRpcParams, runtime) => runtime.handleApiChatCompletion(params),
  },
  {
    names: ['api.chat.cancel'],
    handler: (params: ApiChatCompletionCancelRpcParams, runtime) => runtime.handleApiChatCancel(params),
  },
  {
    names: ['api.telemetry.ingest'],
    handler: (params: ApiTelemetryIngestRpcParams, runtime) => runtime.handleApiTelemetryIngest(params),
  },
  {
    names: ['api.health'],
    handler: (_params: Record<string, never>, runtime) => runtime.handleApiHealth(),
  },
];

export function registerReverseGatewayMethods(runtime: ReverseGatewayMethodRuntime): void {
  for (const descriptor of reverseDescriptors) {
    for (const name of descriptor.names) {
      runtime.target.addMethod(
        name,
        (params: unknown) => descriptor.handler(params as never, runtime),
      );
    }
  }
}
