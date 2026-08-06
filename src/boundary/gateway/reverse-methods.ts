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
  MemoryDeletionPartnerAlertedParams,
  MemoryDeletionPartnerAlertedResult,
  MemoryDeletionProposalSnapshotParams,
  MemoryDeletionProposalSnapshotResult,
  MemoryDeletionResolveParams,
  MemoryDeletionResolveResult,
} from './protocol.js';
import type {
  ContactAuthoritySnapshotRequest,
  VerifiedDiscordContactAuthoritySnapshot,
} from '../../shared/contracts/contact-authority-snapshot.js';
import type {
  IcpLocalPolicyAcquireParams,
  IcpLocalPolicyAcquireResult,
  IcpLocalPolicyInspectParams,
  IcpLocalPolicyInspectResult,
  IcpLocalPolicyReleaseParams,
  IcpLocalPolicyReleaseResult,
} from '../../core/icp/local-policy-contract.js';
import {
  parseIcpLocalPolicyAcquireParams,
  parseIcpLocalPolicyInspectParams,
  parseIcpLocalPolicyReleaseParams,
} from '../../core/icp/local-policy-contract.js';
import { parseContactAuthoritySnapshotRequest } from '../../shared/contracts/contact-authority-snapshot.js';
import { agentMethodParamDecoders } from './methods/params.js';
import type { RpcParamsDecoder } from './rpc-param-decoder.js';

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
  handleMemoryDeletionPartnerAlerted(
    params: MemoryDeletionPartnerAlertedParams,
  ): Promise<MemoryDeletionPartnerAlertedResult>;
  handleMemoryDeletionProposalSnapshot(
    params: MemoryDeletionProposalSnapshotParams,
  ): Promise<MemoryDeletionProposalSnapshotResult>;
  handleMemoryDeletionResolve(
    params: MemoryDeletionResolveParams,
  ): Promise<MemoryDeletionResolveResult>;
  handleIcpLocalPolicyInspect(
    params: IcpLocalPolicyInspectParams,
  ): Promise<IcpLocalPolicyInspectResult>;
  handleIcpLocalPolicyAcquire(
    params: IcpLocalPolicyAcquireParams,
  ): Promise<IcpLocalPolicyAcquireResult>;
  handleIcpLocalPolicyRelease(
    params: IcpLocalPolicyReleaseParams,
  ): Promise<IcpLocalPolicyReleaseResult>;
}

interface ReverseGatewayMethodDescriptor {
  names: readonly string[];
  handle: (params: unknown, runtime: ReverseGatewayMethodRuntime) => Promise<unknown> | unknown;
}

function defineReverseMethod<P, R>(definition: {
  names: readonly string[];
  decode: RpcParamsDecoder<P>;
  handler: (params: P, runtime: ReverseGatewayMethodRuntime) => Promise<R> | R;
}): ReverseGatewayMethodDescriptor {
  return {
    names: definition.names,
    handle: (params, runtime) => definition.handler(definition.decode(params), runtime),
  };
}

const reverseDescriptors = [
  defineReverseMethod({
    names: ['icp.policy.inspect'],
    decode: parseIcpLocalPolicyInspectParams,
    handler: (params: IcpLocalPolicyInspectParams, runtime) => (
      runtime.handleIcpLocalPolicyInspect(params)
    ),
  }),
  defineReverseMethod({
    names: ['icp.policy.acquire'],
    decode: parseIcpLocalPolicyAcquireParams,
    handler: (params: IcpLocalPolicyAcquireParams, runtime) => (
      runtime.handleIcpLocalPolicyAcquire(params)
    ),
  }),
  defineReverseMethod({
    names: ['icp.policy.release'],
    decode: parseIcpLocalPolicyReleaseParams,
    handler: (params: IcpLocalPolicyReleaseParams, runtime) => (
      runtime.handleIcpLocalPolicyRelease(params)
    ),
  }),
  defineReverseMethod({
    names: ['memory.deletion.snapshot'],
    decode: agentMethodParamDecoders['memory.deletion.snapshot'],
    handler: (params: MemoryDeletionProposalSnapshotParams, runtime) => (
      runtime.handleMemoryDeletionProposalSnapshot(params)
    ),
  }),
  defineReverseMethod({
    names: ['memory.deletion.partner_alerted'],
    decode: agentMethodParamDecoders['memory.deletion.partner_alerted'],
    handler: (params: MemoryDeletionPartnerAlertedParams, runtime) => (
      runtime.handleMemoryDeletionPartnerAlerted(params)
    ),
  }),
  defineReverseMethod({
    names: ['memory.deletion.resolve'],
    decode: agentMethodParamDecoders['memory.deletion.resolve'],
    handler: (params: MemoryDeletionResolveParams, runtime) => (
      runtime.handleMemoryDeletionResolve(params)
    ),
  }),
  defineReverseMethod({
    names: ['contact.authority.snapshot'],
    decode: parseContactAuthoritySnapshotRequest,
    handler: (params: ContactAuthoritySnapshotRequest, runtime) => (
      runtime.handleContactAuthoritySnapshot(params)
    ),
  }),
  defineReverseMethod({
    names: ['voice.handleMessage'],
    decode: agentMethodParamDecoders['voice.handleMessage'],
    handler: (params, runtime) => {
      return runtime.dispatchHandleMessage(params.message);
    },
  }),
  // mmo9.8.6: the inbound transcript-chunking RPC family was renamed
  // voice.stream.* -> voice.transcript.* (reserving the "reply stream" name for
  // the future OUTPUT stream, mmo9.8.4/.5). Each handler is registered under
  // BOTH the legacy and the transcript name so a gateway/agent version skew
  // during rollout keeps dispatching; the legacy names must NOT be removed.
  defineReverseMethod({
    names: ['voice.stream.start', 'voice.transcript.begin'],
    decode: agentMethodParamDecoders['voice.stream.start'],
    handler: (params, runtime) => runtime.handleVoiceStreamStart(params),
  }),
  defineReverseMethod({
    names: ['voice.stream.chunk', 'voice.transcript.chunk'],
    decode: agentMethodParamDecoders['voice.stream.chunk'],
    handler: (params: VoiceStreamChunkParams, runtime) => runtime.handleVoiceStreamChunk(params),
  }),
  defineReverseMethod({
    names: ['voice.stream.end', 'voice.transcript.end'],
    decode: agentMethodParamDecoders['voice.stream.end'],
    handler: (params: VoiceStreamEndParams, runtime) => runtime.handleVoiceStreamEnd(params),
  }),
  defineReverseMethod({
    names: ['voice.stream.cancel', 'voice.transcript.cancel'],
    decode: agentMethodParamDecoders['voice.stream.cancel'],
    handler: (params: VoiceStreamCancelParams, runtime) => runtime.handleVoiceStreamCancel(params),
  }),
  defineReverseMethod({
    names: ['api.chat.completion'],
    decode: agentMethodParamDecoders['api.chat.completion'],
    handler: (params: ApiChatCompletionRpcParams, runtime) => runtime.handleApiChatCompletion(params),
  }),
  defineReverseMethod({
    names: ['api.chat.cancel'],
    decode: agentMethodParamDecoders['api.chat.cancel'],
    handler: (params: ApiChatCompletionCancelRpcParams, runtime) => runtime.handleApiChatCancel(params),
  }),
  defineReverseMethod({
    names: ['api.companion-ui.shard.action'],
    decode: agentMethodParamDecoders['api.companion-ui.shard.action'],
    handler: (params: ApiCompanionUiShardActionRpcParams, runtime) => (
      runtime.handleCompanionUiShardAction(params)
    ),
  }),
  defineReverseMethod({
    names: ['shard.directory.owner'],
    decode: agentMethodParamDecoders['shard.directory.owner'],
    handler: (params: ApiShardOwnerRpcParams, runtime) => runtime.handleShardOwner(params),
  }),
  defineReverseMethod({
    names: ['api.telemetry.ingest'],
    decode: agentMethodParamDecoders['api.telemetry.ingest'],
    handler: (params: ApiTelemetryIngestRpcParams, runtime) => runtime.handleApiTelemetryIngest(params),
  }),
  defineReverseMethod({
    names: ['api.health'],
    decode: agentMethodParamDecoders['api.health'],
    handler: (_params: Record<string, never>, runtime) => runtime.handleApiHealth(),
  }),
  defineReverseMethod({
    names: ['satellite.response.eligibility'],
    decode: agentMethodParamDecoders['satellite.response.eligibility'],
    handler: (params: SatelliteResponseEligibilityRpcParams, runtime) => (
      runtime.handleSatelliteResponseEligibility(params)
    ),
  }),
  defineReverseMethod({
    names: ['telemetry.turn.performance'],
    decode: agentMethodParamDecoders['telemetry.turn.performance'],
    handler: (params, runtime) => runtime.handleTurnPerformance(params),
  }),
];

export function registerReverseGatewayMethods(runtime: ReverseGatewayMethodRuntime): void {
  for (const descriptor of reverseDescriptors) {
    for (const name of descriptor.names) {
      runtime.target.addMethod(
        name,
        (params: unknown) => descriptor.handle(params, runtime),
      );
    }
  }
}
