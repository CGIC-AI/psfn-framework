import type { JSONRPCServerAndClient } from 'json-rpc-2.0';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { MessageHandler, MessageHandlerOptions } from '../../../channels/backplane/types.js';
import type {
  ApiChatCompletionCancelRpcParams,
  ApiChatCompletionCancelRpcResult,
  ApiChatCompletionRpcParams,
  ApiChatCompletionRpcResult,
  ApiCompanionUiShardActionRpcParams,
  ApiCompanionUiShardActionRpcResult,
  ApiHealthRpcResult,
  ApiShardOwnerRpcParams,
  ApiShardOwnerRpcResult,
  ApiTelemetryIngestRpcParams,
  ApiTelemetryIngestRpcResult,
  SatelliteResponseEligibilityRpcParams,
  SatelliteResponseEligibilityRpcResult,
} from '../../../channels/api/types.js';
import type { CompanionRelayPublishParams } from '../../../channels/backplane/companion-relay/relay.js';
import {
  parseIcpLocalPolicyAcquireResult,
  parseIcpLocalPolicyInspectResult,
  parseIcpLocalPolicyReleaseResult,
  type IcpLocalPolicyAcquireParams,
  type IcpLocalPolicyAcquireResult,
  type IcpLocalPolicyInspectParams,
  type IcpLocalPolicyInspectResult,
  type IcpLocalPolicyReleaseParams,
  type IcpLocalPolicyReleaseResult,
} from '../../../core/icp/local-policy-contract.js';
import { captureReplyCanary, getReplyCanaryCaptureToken } from '../../../core/cogsec/canary/reply-canary.js';
import { CANARY_CARRIER_PARAM_KEY, getActiveCanaryToken } from '../../../core/cogsec/canary/canary-token.js';
import { CHANNEL_TYPES, type SubstrateMessage } from '../../../shared/contracts/runtime.js';
import {
  parseVerifiedDiscordContactAuthoritySnapshot,
  type ContactAuthoritySnapshotRequest,
  type VerifiedDiscordContactAuthoritySnapshot,
} from '../../../shared/contracts/contact-authority-snapshot.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { CompanionId } from '../../../shared/routing/companion-id.js';
import { parseGatewayRoutingEnvelope } from '../../../shared/routing/envelope.js';
import type { TurnPerformanceEvent } from '../../../shared/telemetry/turn-performance.js';
import { isRecord } from '../../../shared/utils/types.js';
import { BoundedQueue, QueueOverflowError, type QueueOverflowPolicy } from '../backpressure.js';
import {
  GatewayErrors,
  type MemoryDeletionPartnerAlertedParams,
  type MemoryDeletionPartnerAlertedResult,
  type MemoryDeletionProposalSnapshotParams,
  type MemoryDeletionProposalSnapshotResult,
  type MemoryDeletionResolveParams,
  type MemoryDeletionResolveResult,
  type RpcSubstrateMessage,
  type TurnPerformanceIngestParams,
  type TurnPerformanceIngestResult,
  type VoiceHandleMessageResult,
  type VoiceStreamAckResult,
  type VoiceStreamCancelParams,
  type VoiceStreamCancelResult,
  type VoiceStreamChunkParams,
  type VoiceStreamEndParams,
  type VoiceStreamEndResult,
  type VoiceStreamStartParams,
} from '../protocol.js';
import { registerReverseGatewayMethods } from '../reverse-methods.js';

const log = createComponentLogger('GatewayClient');

function assertRpcSubstrateMessage(
  value: unknown,
  options: { fieldName: string; allowEmptyContent?: boolean },
): asserts value is RpcSubstrateMessage {
  const { fieldName, allowEmptyContent = false } = options;
  if (!isRecord(value)) throw new Error(`${fieldName} must be an object`);
  for (const field of ['id', 'channelId', 'authorId', 'authorName'] as const) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      throw new Error(`${fieldName}.${field} must be a non-empty string`);
    }
  }
  if (typeof value.content !== 'string' || (!allowEmptyContent && !value.content.trim())) {
    throw new Error(`${fieldName}.content must be ${allowEmptyContent ? 'a string' : 'a non-empty string'}`);
  }
  if (typeof value.channelType !== 'string'
    || !CHANNEL_TYPES.some(channelType => channelType === value.channelType)) {
    throw new Error(`${fieldName}.channelType is not supported`);
  }
  const timestamp = value.timestamp;
  if (!(timestamp instanceof Date) && typeof timestamp !== 'string') {
    throw new Error(`${fieldName}.timestamp must be a Date or ISO string`);
  }
  const timestampMs = timestamp instanceof Date ? timestamp.getTime() : Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) throw new Error(`${fieldName}.timestamp must be valid`);
  if (!isRecord(value.routing)) throw new Error(`${fieldName}.routing must be an object`);
}

export interface IcpLocalPolicyAuthorityPort {
  inspect(input: IcpLocalPolicyInspectParams): Promise<IcpLocalPolicyInspectResult>;
  acquire(input: IcpLocalPolicyAcquireParams): Promise<IcpLocalPolicyAcquireResult>;
  release(input: IcpLocalPolicyReleaseParams): Promise<IcpLocalPolicyReleaseResult>;
  releaseAll(): Promise<void>;
}

interface VoiceStreamState {
  correlationId: string;
  streamId: string;
  baseMessage: SubstrateMessage;
  expectedSequence: number;
  chunkQueue: BoundedQueue<string>;
  chunks: string[];
  droppedChunks: number;
  cancelled: boolean;
  cancellationId?: string;
  abortController: AbortController;
}

interface ReverseRpcRuntimeOptions {
  target: JSONRPCServerAndClient;
  send: (message: unknown) => void;
  companionId?: CompanionId;
  voiceStreamQueueSize: number;
  voiceStreamOverflowPolicy: QueueOverflowPolicy;
  isClosed: () => boolean;
}

/** Owns reverse-RPC registration, handler readiness, ICP holds, and voice streams. */
export class GatewayClientReverseRpcRuntime {
  private registered = false;
  private handleMessageHandler: MessageHandler | null = null;
  private apiChatCompletionHandler: ((params: ApiChatCompletionRpcParams) => Promise<ApiChatCompletionRpcResult>) | null = null;
  private apiChatCancelHandler: ((params: ApiChatCompletionCancelRpcParams) => Promise<ApiChatCompletionCancelRpcResult>) | null = null;
  private companionUiShardActionHandler: ((params: ApiCompanionUiShardActionRpcParams) => Promise<ApiCompanionUiShardActionRpcResult>) | null = null;
  private shardOwnerHandler: ((params: ApiShardOwnerRpcParams) => Promise<ApiShardOwnerRpcResult>) | null = null;
  private apiTelemetryIngestHandler: ((params: ApiTelemetryIngestRpcParams) => Promise<ApiTelemetryIngestRpcResult>) | null = null;
  private apiHealthHandler: (() => Promise<ApiHealthRpcResult>) | null = null;
  private satelliteResponseEligibilityHandler: ((params: SatelliteResponseEligibilityRpcParams) => Promise<SatelliteResponseEligibilityRpcResult>) | null = null;
  private turnPerformanceHandler: ((event: TurnPerformanceEvent) => Promise<void>) | null = null;
  private contactAuthoritySnapshotHandler: ((params: ContactAuthoritySnapshotRequest) => Promise<VerifiedDiscordContactAuthoritySnapshot | undefined>) | null = null;
  private memoryDeletionPartnerAlertedHandler: ((params: MemoryDeletionPartnerAlertedParams) => Promise<MemoryDeletionPartnerAlertedResult>) | null = null;
  private memoryDeletionProposalSnapshotHandler: ((params: MemoryDeletionProposalSnapshotParams) => Promise<MemoryDeletionProposalSnapshotResult>) | null = null;
  private memoryDeletionResolveHandler: ((params: MemoryDeletionResolveParams) => Promise<MemoryDeletionResolveResult>) | null = null;
  private icpAuthority: IcpLocalPolicyAuthorityPort | null = null;
  private icpReady = false;
  private icpCleanupStarted = false;
  private readonly voiceStreams = new Map<string, VoiceStreamState>();

  constructor(private readonly options: ReverseRpcRuntimeOptions) {}

  onHandleMessage(handler: MessageHandler): void { this.handleMessageHandler = handler; this.register(); }
  onApiChatCompletion(handler: (params: ApiChatCompletionRpcParams) => Promise<ApiChatCompletionRpcResult>): void { this.apiChatCompletionHandler = handler; this.register(); }
  onApiChatCancel(handler: (params: ApiChatCompletionCancelRpcParams) => Promise<ApiChatCompletionCancelRpcResult>): void { this.apiChatCancelHandler = handler; this.register(); }
  onCompanionUiShardAction(handler: (params: ApiCompanionUiShardActionRpcParams) => Promise<ApiCompanionUiShardActionRpcResult>): void { this.companionUiShardActionHandler = handler; this.register(); }
  onShardOwner(handler: (params: ApiShardOwnerRpcParams) => Promise<ApiShardOwnerRpcResult>): void { this.shardOwnerHandler = handler; this.register(); }
  onApiTelemetryIngest(handler: (params: ApiTelemetryIngestRpcParams) => Promise<ApiTelemetryIngestRpcResult>): void { this.apiTelemetryIngestHandler = handler; this.register(); }
  onApiHealth(handler: () => Promise<ApiHealthRpcResult>): void { this.apiHealthHandler = handler; this.register(); }
  onSatelliteResponseEligibility(handler: (params: SatelliteResponseEligibilityRpcParams) => Promise<SatelliteResponseEligibilityRpcResult>): void { this.satelliteResponseEligibilityHandler = handler; this.register(); }
  onTurnPerformance(handler: (event: TurnPerformanceEvent) => Promise<void>): void { this.turnPerformanceHandler = handler; this.register(); }
  onContactAuthoritySnapshot(handler: (params: ContactAuthoritySnapshotRequest) => Promise<VerifiedDiscordContactAuthoritySnapshot | undefined>): void { this.contactAuthoritySnapshotHandler = handler; this.register(); }
  onMemoryDeletionPartnerAlerted(handler: (params: MemoryDeletionPartnerAlertedParams) => Promise<MemoryDeletionPartnerAlertedResult>): void { this.memoryDeletionPartnerAlertedHandler = handler; this.register(); }
  onMemoryDeletionProposalSnapshot(handler: (params: MemoryDeletionProposalSnapshotParams) => Promise<MemoryDeletionProposalSnapshotResult>): void { this.memoryDeletionProposalSnapshotHandler = handler; this.register(); }
  onMemoryDeletionResolve(handler: (params: MemoryDeletionResolveParams) => Promise<MemoryDeletionResolveResult>): void { this.memoryDeletionResolveHandler = handler; this.register(); }

  onIcpLocalPolicyAuthority(authority: IcpLocalPolicyAuthorityPort): void {
    if (this.icpAuthority) throw new Error('ICP local policy authority is already registered');
    this.icpAuthority = authority;
    this.icpReady = false;
    this.icpCleanupStarted = false;
    this.register();
  }

  markIcpLocalPolicyAuthorityReady(): void {
    if (!this.icpAuthority) throw new Error('Cannot mark an unregistered ICP local policy authority ready');
    if (this.options.isClosed()) throw new Error('Cannot mark ICP local policy ready on a closed gateway connection');
    this.icpReady = true;
  }

  notifyApiStreamDelta(requestId: string, text: string): void {
    const canaryToken = getActiveCanaryToken() ?? getReplyCanaryCaptureToken();
    this.options.send({
      jsonrpc: '2.0', method: 'api.stream.delta',
      params: { requestId, text, ...(canaryToken ? { [CANARY_CARRIER_PARAM_KEY]: canaryToken } : {}) },
    });
  }

  publishCompanionEvent(params: CompanionRelayPublishParams): void {
    this.options.send({ jsonrpc: '2.0', method: 'companion.event.publish', params });
  }

  cleanupIcpLocalPolicyHolds(): void {
    if (this.icpCleanupStarted || !this.icpAuthority) return;
    this.icpCleanupStarted = true;
    this.icpReady = false;
    void this.icpAuthority.releaseAll().catch((error: unknown) => {
      log.error('Failed to release ICP local policy holds after connection shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  clearVoiceStreams(): void {
    this.voiceStreams.clear();
  }

  private register(): void {
    if (this.registered) return;
    this.registered = true;
    registerReverseGatewayMethods({
      target: this.options.target,
      dispatchHandleMessage: (message) => this.dispatchHandleMessage(message),
      handleVoiceStreamStart: (params) => this.handleVoiceStreamStart(params),
      handleVoiceStreamChunk: (params) => this.handleVoiceStreamChunk(params),
      handleVoiceStreamEnd: (params) => this.handleVoiceStreamEnd(params),
      handleVoiceStreamCancel: (params) => this.handleVoiceStreamCancel(params),
      handleApiChatCompletion: (params) => this.handleApiChatCompletion(params),
      handleApiChatCancel: (params) => this.requireHandler(this.apiChatCancelHandler, 'api.chat.cancel')(params),
      handleCompanionUiShardAction: (params) => this.handleCompanionUiShardAction(params),
      handleShardOwner: (params) => this.requireHandler(this.shardOwnerHandler, 'shard.directory.owner')(params),
      handleApiTelemetryIngest: (params) => this.requireHandler(this.apiTelemetryIngestHandler, 'api.telemetry.ingest')(params),
      handleApiHealth: () => this.requireHandler(this.apiHealthHandler, 'api.health')(),
      handleSatelliteResponseEligibility: (params) => this.requireHandler(this.satelliteResponseEligibilityHandler, 'satellite.response.eligibility')(params),
      handleTurnPerformance: (params) => this.handleTurnPerformance(params),
      handleContactAuthoritySnapshot: (params) => this.handleContactAuthoritySnapshot(params),
      handleMemoryDeletionPartnerAlerted: (params) => this.handleMemoryDeletionPartnerAlerted(params),
      handleMemoryDeletionProposalSnapshot: (params) => this.handleMemoryDeletionProposalSnapshot(params),
      handleMemoryDeletionResolve: (params) => this.handleMemoryDeletionResolve(params),
      handleIcpLocalPolicyInspect: (params) => this.handleIcpLocalPolicyInspect(params),
      handleIcpLocalPolicyAcquire: (params) => this.handleIcpLocalPolicyAcquire(params),
      handleIcpLocalPolicyRelease: (params) => this.handleIcpLocalPolicyRelease(params),
    });
  }

  private requireHandler<T>(handler: T | null, method: string): T {
    if (!handler) throw new Error(`No ${method} handler registered`);
    return handler;
  }

  private requireIcpAuthority(requireReady: boolean): IcpLocalPolicyAuthorityPort {
    if (!this.icpAuthority) throw new Error('No ICP local policy authority registered');
    if (requireReady && !this.icpReady) throw new Error('ICP local policy authority is not ready');
    return this.icpAuthority;
  }

  private async handleIcpLocalPolicyInspect(params: IcpLocalPolicyInspectParams): Promise<IcpLocalPolicyInspectResult> {
    const authority = this.requireIcpAuthority(false);
    if (!this.icpReady) return { role: params.role, ready: false };
    return parseIcpLocalPolicyInspectResult(await authority.inspect(params));
  }

  private async handleIcpLocalPolicyAcquire(params: IcpLocalPolicyAcquireParams): Promise<IcpLocalPolicyAcquireResult> {
    return parseIcpLocalPolicyAcquireResult(await this.requireIcpAuthority(true).acquire(params));
  }

  private async handleIcpLocalPolicyRelease(params: IcpLocalPolicyReleaseParams): Promise<IcpLocalPolicyReleaseResult> {
    return parseIcpLocalPolicyReleaseResult(await this.requireIcpAuthority(true).release(params));
  }

  private async handleMemoryDeletionPartnerAlerted(params: MemoryDeletionPartnerAlertedParams): Promise<MemoryDeletionPartnerAlertedResult> {
    const handler = this.requireHandler(this.memoryDeletionPartnerAlertedHandler, 'memory.deletion.partner_alerted');
    return handler(params);
  }

  private async handleMemoryDeletionProposalSnapshot(params: MemoryDeletionProposalSnapshotParams): Promise<MemoryDeletionProposalSnapshotResult> {
    const handler = this.requireHandler(this.memoryDeletionProposalSnapshotHandler, 'memory.deletion.snapshot');
    return handler(params);
  }

  private async handleMemoryDeletionResolve(params: MemoryDeletionResolveParams): Promise<MemoryDeletionResolveResult> {
    const handler = this.requireHandler(this.memoryDeletionResolveHandler, 'memory.deletion.resolve');
    return handler(params);
  }

  private async handleContactAuthoritySnapshot(params: ContactAuthoritySnapshotRequest): Promise<VerifiedDiscordContactAuthoritySnapshot | null> {
    const handler = this.requireHandler(this.contactAuthoritySnapshotHandler, 'contact.authority.snapshot');
    const snapshot = await handler(params);
    return snapshot ? parseVerifiedDiscordContactAuthoritySnapshot(snapshot) : null;
  }

  private async dispatchHandleMessage(message: unknown, options?: MessageHandlerOptions): Promise<VoiceHandleMessageResult> {
    const handler = this.requireHandler(this.handleMessageHandler, 'voice.handleMessage');
    return captureReplyCanary(async () => {
      const substrateMessage = this.deserializeMessage(message);
      const response = await handler(substrateMessage, options);
      return {
        content: response.content,
        channelId: response.channelId,
        ...(response.attachments ? { attachments: response.attachments } : {}),
        model: response.metadata.model,
        durationMs: response.metadata.durationMs,
        ...(response.metadata.noReply ? { disposition: 'decline' as const } : {}),
      } satisfies VoiceHandleMessageResult;
    });
  }

  private handleApiChatCompletion(params: ApiChatCompletionRpcParams): Promise<ApiChatCompletionRpcResult> {
    const handler = this.requireHandler(this.apiChatCompletionHandler, 'api.chat.completion');
    return captureReplyCanary(() => handler(params));
  }

  private handleCompanionUiShardAction(params: ApiCompanionUiShardActionRpcParams): Promise<ApiCompanionUiShardActionRpcResult> {
    const handler = this.requireHandler(this.companionUiShardActionHandler, 'api.companion-ui.shard.action');
    return captureReplyCanary(() => handler(params));
  }

  private async handleTurnPerformance(params: TurnPerformanceIngestParams): Promise<TurnPerformanceIngestResult> {
    const handler = this.requireHandler(this.turnPerformanceHandler, 'telemetry.turn.performance');
    await handler(params.event);
    return { accepted: true };
  }

  private handleVoiceStreamStart(params: VoiceStreamStartParams): VoiceStreamAckResult {
    const message = this.deserializeMessage(params.message, { fieldName: 'voice.stream.start params.message', allowEmptyContent: true });
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    if (this.voiceStreams.has(key)) throw this.rpcError('Voice stream already exists', GatewayErrors.VOICE_STREAM_SEQUENCE);
    const cancellationId = typeof message.routing?.cancellationId === 'string' && message.routing.cancellationId.trim() ? message.routing.cancellationId : undefined;
    const state: VoiceStreamState = {
      correlationId: params.correlationId,
      streamId: params.streamId,
      baseMessage: message,
      expectedSequence: params.sequence + 1,
      chunkQueue: new BoundedQueue<string>({ maxSize: this.options.voiceStreamQueueSize, overflowPolicy: this.options.voiceStreamOverflowPolicy }),
      chunks: [], droppedChunks: 0, cancelled: false,
      ...(cancellationId ? { cancellationId } : {}), abortController: new AbortController(),
    };
    this.voiceStreams.set(key, state);
    return this.streamAck(state, params.sequence, true);
  }

  private handleVoiceStreamChunk(params: VoiceStreamChunkParams): VoiceStreamAckResult {
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    this.assertSequence(state, params.sequence);
    if (state.cancelled) throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED);
    let accepted = true;
    try {
      const result = state.chunkQueue.enqueue(params.text);
      accepted = result.accepted;
      if (result.droppedReason) state.droppedChunks += 1;
    } catch (error) {
      if (error instanceof QueueOverflowError) throw this.rpcError(error.message, GatewayErrors.VOICE_STREAM_OVERFLOW);
      throw error;
    }
    state.expectedSequence = params.sequence + 1;
    return this.streamAck(state, params.sequence, accepted);
  }

  private async handleVoiceStreamEnd(params: VoiceStreamEndParams): Promise<VoiceStreamEndResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.requireVoiceStream(params.correlationId, params.streamId);
    if (state.cancelled) { this.voiceStreams.delete(key); throw this.rpcError('Voice stream cancelled', GatewayErrors.VOICE_STREAM_CANCELLED); }
    this.assertSequence(state, params.sequence);
    state.expectedSequence = params.sequence + 1;
    this.drainQueuedChunks(state);
    try {
      const result = await this.dispatchHandleMessage(
        { ...state.baseMessage, content: state.baseMessage.content + state.chunks.join('') },
        { signal: state.abortController.signal, ...(state.cancellationId ? { cancellationId: state.cancellationId } : {}) },
      );
      return { ...result, correlationId: state.correlationId, streamId: state.streamId, droppedChunks: state.droppedChunks };
    } finally { this.voiceStreams.delete(key); }
  }

  private async handleVoiceStreamCancel(params: VoiceStreamCancelParams): Promise<VoiceStreamCancelResult> {
    const key = this.voiceStreamKey(params.correlationId, params.streamId);
    const state = this.voiceStreams.get(key);
    if (!state) return { correlationId: params.correlationId, streamId: params.streamId, cancelled: false };
    state.cancelled = true;
    if (!state.abortController.signal.aborted) state.abortController.abort(new Error('voice.stream.cancel'));
    state.chunkQueue.clear();
    this.voiceStreams.delete(key);
    return { correlationId: params.correlationId, streamId: params.streamId, cancelled: true };
  }

  private streamAck(state: VoiceStreamState, sequence: number, accepted: boolean): VoiceStreamAckResult {
    return { correlationId: state.correlationId, streamId: state.streamId, sequence, accepted, queueDepth: state.chunkQueue.size, droppedChunks: state.droppedChunks };
  }

  private requireVoiceStream(correlationId: string, streamId: string): VoiceStreamState {
    const state = this.voiceStreams.get(this.voiceStreamKey(correlationId, streamId));
    if (!state) throw this.rpcError('Voice stream not found', GatewayErrors.VOICE_STREAM_NOT_FOUND);
    return state;
  }

  private assertSequence(state: VoiceStreamState, sequence: number): void {
    if (sequence !== state.expectedSequence) throw this.rpcError(`Unexpected voice stream sequence: expected ${state.expectedSequence}, got ${sequence}`, GatewayErrors.VOICE_STREAM_SEQUENCE);
  }

  private drainQueuedChunks(state: VoiceStreamState): void {
    while (state.chunkQueue.size > 0) {
      const chunk = state.chunkQueue.dequeue();
      if (chunk !== undefined) state.chunks.push(chunk);
    }
  }

  private deserializeMessage(message: unknown, options: { fieldName?: string; allowEmptyContent?: boolean } = {}): SubstrateMessage {
    const fieldName = options.fieldName ?? 'voice.handleMessage params.message';
    assertRpcSubstrateMessage(message, { fieldName, ...(options.allowEmptyContent ? { allowEmptyContent: true } : {}) });
    const gatewayRouting = parseGatewayRoutingEnvelope(message.routing?.gateway, `${fieldName}.routing.gateway`);
    if (this.options.companionId && gatewayRouting.companionId !== this.options.companionId) {
      throw new Error(`${fieldName} routing companionId does not match this gateway client binding: expected ${JSON.stringify(this.options.companionId)}, got ${JSON.stringify(gatewayRouting.companionId)}`);
    }
    return { ...message, routing: { ...message.routing, gateway: gatewayRouting }, timestamp: typeof message.timestamp === 'string' ? new Date(message.timestamp) : message.timestamp };
  }

  private voiceStreamKey(correlationId: string, streamId: string): string { return `${correlationId}::${streamId}`; }
  private rpcError(message: string, code: number): Error { return new JSONRPCErrorException(message, code); }
}
