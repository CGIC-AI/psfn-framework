import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
  ApiShardOwnerRpcParams,
  ApiShardOwnerRpcResult,
  SatelliteResponseEligibilityRpcParams,
  SatelliteResponseEligibilityRpcResult,
} from '../../channels/api/types.js';
import type {
  VoiceHandleMessageResult,
  VoiceStreamChunkParams,
  VoiceStreamEndParams,
  VoiceStreamCancelParams,
  VoiceStreamAckResult,
  VoiceStreamEndResult,
  VoiceStreamCancelResult,
} from './protocol.js';
import { isRecord } from '../../shared/utils/types.js';
import type {
  ContactAuthoritySnapshotRequest,
  VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';

export interface ReverseGatewayMethodRuntime {
  target: JSONRPCServerAndClient;
  dispatchHandleMessage(message: unknown): Promise<VoiceHandleMessageResult>;
  handleVoiceStreamStart(params: unknown): VoiceStreamAckResult;
  handleVoiceStreamChunk(params: VoiceStreamChunkParams): VoiceStreamAckResult;
  handleVoiceStreamEnd(params: VoiceStreamEndParams): Promise<VoiceStreamEndResult>;
  handleVoiceStreamCancel(params: VoiceStreamCancelParams): Promise<VoiceStreamCancelResult>;
  handleApiChatCompletion(params: ApiChatCompletionRpcParams): Promise<ApiChatCompletionRpcResult>;
  handleApiChatCancel(params: ApiChatCompletionCancelRpcParams): Promise<ApiChatCompletionCancelRpcResult>;
  handleCompanionUiShardAction(
    params: ApiCompanionUiShardActionRpcParams,
  ): Promise<ApiCompanionUiShardActionRpcResult>;
  handleShardOwner(params: ApiShardOwnerRpcParams): Promise<ApiShardOwnerRpcResult>;
  handleApiTelemetryIngest(params: ApiTelemetryIngestRpcParams): Promise<ApiTelemetryIngestRpcResult>;
  handleApiHealth(): Promise<ApiHealthRpcResult>;
  handleSatelliteResponseEligibility(
    params: SatelliteResponseEligibilityRpcParams,
  ): Promise<SatelliteResponseEligibilityRpcResult>;
  handleTurnPerformance(params: unknown): Promise<unknown>;
  handleContactAuthoritySnapshot(
    params: ContactAuthoritySnapshotRequest,
  ): Promise<VerifiedDiscordContactAuthoritySnapshot | null>;
}

interface ReverseGatewayMethodDescriptor<P, R> {
  names: readonly string[];
  handler: (params: P, runtime: ReverseGatewayMethodRuntime) => Promise<R> | R;
}

const reverseDescriptors: Array<ReverseGatewayMethodDescriptor<any, unknown>> = [
  {
    names: ['contact.authority.snapshot'],
    handler: (params: ContactAuthoritySnapshotRequest, runtime) => (
      runtime.handleContactAuthoritySnapshot(params)
    ),
  },
  {
    names: ['voice.handleMessage'],
    handler: (params: unknown, runtime) => {
      if (!isRecord(params) || !Object.hasOwn(params, 'message')) {
        throw new Error('voice.handleMessage requires an object params.message payload');
      }
      return runtime.dispatchHandleMessage(params.message);
    },
  },
  // mmo9.8.6: the inbound transcript-chunking RPC family was renamed
  // voice.stream.* -> voice.transcript.* (reserving the "reply stream" name for
  // the future OUTPUT stream, mmo9.8.4/.5). Each handler is registered under
  // BOTH the legacy and the transcript name so a gateway/agent version skew
  // during rollout keeps dispatching; the legacy names must NOT be removed.
  {
    names: ['voice.stream.start', 'voice.transcript.begin'],
    handler: (params: unknown, runtime) => runtime.handleVoiceStreamStart(params),
  },
  {
    names: ['voice.stream.chunk', 'voice.transcript.chunk'],
    handler: (params: VoiceStreamChunkParams, runtime) => runtime.handleVoiceStreamChunk(params),
  },
  {
    names: ['voice.stream.end', 'voice.transcript.end'],
    handler: (params: VoiceStreamEndParams, runtime) => runtime.handleVoiceStreamEnd(params),
  },
  {
    names: ['voice.stream.cancel', 'voice.transcript.cancel'],
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
    names: ['api.companion-ui.shard.action'],
    handler: (params: ApiCompanionUiShardActionRpcParams, runtime) => (
      runtime.handleCompanionUiShardAction(params)
    ),
  },
  {
    names: ['shard.directory.owner'],
    handler: (params: ApiShardOwnerRpcParams, runtime) => runtime.handleShardOwner(params),
  },
  {
    names: ['api.telemetry.ingest'],
    handler: (params: ApiTelemetryIngestRpcParams, runtime) => runtime.handleApiTelemetryIngest(params),
  },
  {
    names: ['api.health'],
    handler: (_params: Record<string, never>, runtime) => runtime.handleApiHealth(),
  },
  {
    names: ['satellite.response.eligibility'],
    handler: (params: SatelliteResponseEligibilityRpcParams, runtime) => (
      runtime.handleSatelliteResponseEligibility(params)
    ),
  },
  {
    names: ['telemetry.turn.performance'],
    handler: (params: unknown, runtime) => runtime.handleTurnPerformance(params),
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
