import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
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
}

interface ReverseGatewayMethodDescriptor<P, R> {
  names: readonly string[];
  handler: (params: P, runtime: ReverseGatewayMethodRuntime) => Promise<R> | R;
}

const reverseDescriptors: Array<ReverseGatewayMethodDescriptor<any, unknown>> = [
  {
    names: ['voice.handleMessage', 'discord.handleMessage'],
    handler: (params: { message: RpcSubstrateMessage }, runtime) => runtime.dispatchHandleMessage(params.message),
  },
  {
    names: ['voice.stream.start', 'discord.voice.start'],
    handler: (params: VoiceStreamStartParams, runtime) => runtime.handleVoiceStreamStart(params),
  },
  {
    names: ['voice.stream.chunk', 'discord.voice.chunk'],
    handler: (params: VoiceStreamChunkParams, runtime) => runtime.handleVoiceStreamChunk(params),
  },
  {
    names: ['voice.stream.end', 'discord.voice.end'],
    handler: (params: VoiceStreamEndParams, runtime) => runtime.handleVoiceStreamEnd(params),
  },
  {
    names: ['voice.stream.cancel', 'discord.voice.cancel'],
    handler: (params: VoiceStreamCancelParams, runtime) => runtime.handleVoiceStreamCancel(params),
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
