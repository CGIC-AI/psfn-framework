import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChannelType, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { isIntentionalNoReplyResponse } from '../../../shared/agent-response-disposition.js';
import type {
  SatelliteClientCertIdentity,
  SatelliteRegistryConfig,
  SatelliteRegistryProvider,
} from '../../../shared/contracts/satellite-registry.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { SubstrateAgent } from '../../../core/agent/substrate-agent.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { ExternalChannelProfileConfig } from '../../backplane/config.js';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import { sendJson } from '../../backplane/http/primitives.js';
import {
  type FifoChannelLease,
  FifoChannelLock,
  emitTurnContentionTelemetry,
  isBusyTurnError,
} from '../../../system/lifecycle/turn-contention.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { resolveApiTurnIdentity } from '../external-channel-claim.js';
import type {
  ApiServerRuntime,
  ApiChatCompletionRpcSuccess,
  ChatCompletionRequest,
} from '../types.js';
import { buildChatCompletionResponse } from '../response-format.js';
import {
  createDeferred,
  RequestLifecycleError,
  type LifecycleInterrupt,
} from '../server-lifecycle.js';
import {
  canWriteResponse,
  sendApiError,
  type ApiServerLogger,
} from './http.js';
import {
  clampApiHeader,
  extractRpcHeaders,
  parseTurnRoutingOverrides,
  readChatCompletionRequest,
  resolveChannelPrivacy,
  singleApiHeader,
} from './request.js';
import {
  buildSubstrateMessage,
  deriveAuthor,
  deriveChannelId,
  getLastUserMessage,
  getLastUserMessageAttachments,
  getLastUserMessageFileParts,
  ingestApiDocumentFileParts,
  seedSession,
  type ApiDocumentIngestConfig,
} from './session.js';
import { SseStreamingTransport } from './streaming.js';
import {
  GatewayHubDeviceIngressService,
  type AuthenticatedHubDeviceConnection,
} from '../../../boundary/fleet-auth/hub-device-ingress.js';
import type {
  HubDeviceAttachmentSnapshot,
  HubDevicePrincipalSnapshot,
} from '../../../shared/contracts/hub-device-ingress.js';
import {
  HubDeviceIngressRequestError,
  sanitizeHubDeviceChatRequest,
} from './hub-device-ingress.js';
import { HubDeviceAssertionRejectedError } from '../../../boundary/fleet-auth/hub-device-assertion.js';
import {
  BEARER_COMPANION_SELECTOR_HEADER,
  resolveBearerCompanionTarget,
  type BearerCompanionRoutingConfig,
} from './bearer-companion-selector.js';
import { screenChatMessageBody } from '../../../core/cogsec/intake/chat-message-screening.js';

const IDENTITY_LINK_CHALLENGE_TTL_MS = 5 * 60_000;

const IDENTITY_CLAIM_HEADERS = {
  canonicalContactId: 'x-canonical-contact-id',
  sourceChannel: 'x-identity-claim-channel',
  sourceUserId: 'x-identity-claim-user-id',
  nonce: 'x-identity-claim-nonce',
  expires: 'x-identity-claim-expires',
  signature: 'x-identity-claim-signature',
} as const;

type AgentTurnResult = Awaited<ReturnType<SubstrateAgent['handleMessage']>>;

interface PendingTurn {
  channelId: string;
  wasQueued: boolean;
  releaseChannel: () => void;
  substrateMsg: SubstrateMessage;
}

interface PreparedTurn {
  channelId: string;
  turnPromise: Promise<AgentTurnResult>;
}

interface AcquiredChannel {
  wasQueued: boolean;
  releaseChannel: () => void;
}

interface IdentityClaimHeaders {
  canonicalContactId: string;
  sourceChannel: string;
  sourceUserId: string;
  nonce?: string;
  expiresAt?: string;
  signature?: string;
}

function isNoReplyRuntimeCompletion(
  response: ApiChatCompletionRpcSuccess['response'],
): boolean {
  return response.noReply?.disposition === 'intentional_no_reply'
    || response.disposition === 'no_op';
}

export interface ApiChatCompletionsHandlerConfig {
  agentLoop: SubstrateAgent;
  eventBus: EventBus;
  sessionManager: SessionManager;
  contactStore: ContactStorePort | null;
  runtime: ApiServerRuntime | null;
  modelName: string;
  requestTimeoutMs: number;
  externalChannelProfiles: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  satelliteRegistry: SatelliteRegistryConfig | undefined;
  satelliteRegistryProvider: SatelliteRegistryProvider | undefined;
  logger: ApiServerLogger;
  /** Shared chat-body screening and document ingestion; null when not configured. */
  documentIngest: ApiDocumentIngestConfig | null;
  /** Gateway-owned routing and entitlement contract for the Bearer surface. */
  bearerCompanionRouting?: BearerCompanionRoutingConfig;
}

export interface PendingHubDeviceAdmission {
  assertion: string;
  connection: AuthenticatedHubDeviceConnection;
  ingress: GatewayHubDeviceIngressService;
}

export interface FleetGardenChatRouting {
  companionId: string;
}

export class ApiChatCompletionsHandler {
  private readonly agentLoop: SubstrateAgent;
  private readonly eventBus: EventBus;
  private readonly sessionManager: SessionManager;
  private readonly contactStore: ContactStorePort | null;
  private readonly runtime: ApiServerRuntime | null;
  private readonly modelName: string;
  private readonly requestTimeoutMs: number;
  private readonly externalChannelProfiles: Partial<Record<ChannelType, ExternalChannelProfileConfig>>;
  private readonly satelliteRegistry: SatelliteRegistryConfig | undefined;
  private readonly satelliteRegistryProvider: SatelliteRegistryProvider | undefined;
  private readonly logger: ApiServerLogger;
  private readonly documentIngest: ApiDocumentIngestConfig | null;
  private readonly bearerCompanionRouting: BearerCompanionRoutingConfig | undefined;
  private readonly channelTurnLock = new FifoChannelLock();
  private readonly processingChannels = new Set<string>();

  constructor(config: ApiChatCompletionsHandlerConfig) {
    this.agentLoop = config.agentLoop;
    this.eventBus = config.eventBus;
    this.sessionManager = config.sessionManager;
    this.contactStore = config.contactStore;
    this.runtime = config.runtime;
    this.modelName = config.modelName;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.externalChannelProfiles = config.externalChannelProfiles;
    this.satelliteRegistry = config.satelliteRegistry;
    this.satelliteRegistryProvider = config.satelliteRegistryProvider;
    this.logger = config.logger;
    this.documentIngest = config.documentIngest;
    this.bearerCompanionRouting = config.bearerCompanionRouting;
  }

  externalChannelProfile(channelType: ChannelType): ExternalChannelProfileConfig | undefined {
    return this.externalChannelProfiles[channelType];
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert?: SatelliteClientCertIdentity,
    pendingHubDevice?: PendingHubDeviceAdmission,
    fleetRouting?: FleetGardenChatRouting,
  ): Promise<void> {
    let parsed = await readChatCompletionRequest(req, res, this.logger);
    if (!parsed) return;

    let effectiveFleetRouting = fleetRouting;
    if (!effectiveFleetRouting && this.bearerCompanionRouting) {
      const rawSelector = req.headers[BEARER_COMPANION_SELECTOR_HEADER];
      if (rawSelector !== undefined || principal.scope !== 'satellite') {
        const requestedCompanionId = singleApiHeader(rawSelector)?.trim();
        const resolution = resolveBearerCompanionTarget({
          requestedCompanionId,
          principal,
          routing: this.bearerCompanionRouting,
        });
        if (!resolution.ok) {
          sendApiError(res, resolution.status, resolution.type, resolution.message);
          return;
        }
        effectiveFleetRouting = { companionId: resolution.companionId };
      }
    }

    let hubDevicePrincipal: HubDevicePrincipalSnapshot | undefined;
    let hubDeviceAttachment: HubDeviceAttachmentSnapshot | undefined;
    if (pendingHubDevice) {
      try {
        parsed = sanitizeHubDeviceChatRequest(parsed);
        const admission = await pendingHubDevice.ingress.admit({
          assertion: pendingHubDevice.assertion,
          connection: pendingHubDevice.connection,
        });
        hubDevicePrincipal = admission.devicePrincipal;
        hubDeviceAttachment = admission.attachment;
      } catch (error) {
        if (error instanceof HubDeviceIngressRequestError) {
          sendApiError(res, error.status, error.type, error.message);
        } else if (error instanceof HubDeviceAssertionRejectedError) {
          sendApiError(res, 401, 'hub_device_assertion_rejected', 'Hub device assertion was rejected');
        } else {
          this.logger.error('Hub device assertion verifier unavailable');
          sendApiError(res, 503, 'hub_device_ingress_unavailable', 'Hub device authentication is temporarily unavailable');
        }
        return;
      }
    }

    if (parsed.stream) {
      await this.handleStreaming(
        parsed,
        req,
        res,
        principal,
        clientCert,
        hubDevicePrincipal,
        hubDeviceAttachment,
        effectiveFleetRouting,
      );
    } else {
      await this.handleNonStreaming(
        parsed,
        req,
        res,
        principal,
        clientCert,
        hubDevicePrincipal,
        hubDeviceAttachment,
        effectiveFleetRouting,
      );
    }
  }

  private attachTurnCleanup(
    releaseChannel: () => void,
    turnPromise: Promise<unknown>,
  ): void {
    turnPromise
      .catch((err) => { this.logger.debug('Turn promise rejected during cleanup', { error: String(err) }); })
      .finally(() => {
        releaseChannel();
      });
  }

  private emitQueueTelemetry(
    channelId: string,
    phase: 'acquired' | 'contended' | 'released',
    details: { queueDepth: number; waitMs: number; reason?: string },
  ): void {
    emitTurnContentionTelemetry(this.eventBus, {
      channelId,
      phase,
      policy: 'queue',
      source: 'api',
      queueDepth: details.queueDepth,
      waitMs: details.waitMs,
      processingChannels: this.processingChannels.size,
      ...(details.reason ? { reason: details.reason } : {}),
    });
  }

  private async waitForQueueLeaseOrInterrupt<T>(
    req: IncomingMessage,
    res: ServerResponse,
    leasePromise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const lease = await Promise.race([leasePromise, interruptionPromise]);
      settled = true;
      return lease;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private async acquireChannel(
    channelId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<AcquiredChannel | null> {
    const queued = this.channelTurnLock.acquire(channelId);
    if (queued.contended) {
      this.emitQueueTelemetry(channelId, 'contended', {
        queueDepth: queued.queueDepth,
        waitMs: 0,
        reason: 'active_turn',
      });
    }

    let lease: FifoChannelLease;
    try {
      lease = await this.waitForQueueLeaseOrInterrupt(req, res, queued.lease);
    } catch (err) {
      if (!queued.cancel()) {
        queued.lease.then((lateLease) => {
          lateLease.release();
        }).catch((leaseErr) => { this.logger.debug('Late lease release failed', { error: String(leaseErr) }); });
      }

      if (err instanceof RequestLifecycleError && err.reason === 'timeout' && canWriteResponse(res)) {
        sendApiError(res, 504, 'request_timeout', 'Request timed out before turn started');
      }
      return null;
    }

    const lockStartMs = Date.now();
    this.processingChannels.add(channelId);
    this.emitQueueTelemetry(channelId, 'acquired', {
      queueDepth: Math.max(0, this.channelTurnLock.pending(channelId) - 1),
      waitMs: lease.waitMs,
    });

    let released = false;
    return {
      wasQueued: queued.contended,
      releaseChannel: () => {
        if (released) return;
        released = true;
        lease.release();
        this.processingChannels.delete(channelId);
        this.emitQueueTelemetry(channelId, 'released', {
          queueDepth: this.channelTurnLock.pending(channelId),
          waitMs: Math.max(0, Date.now() - lockStartMs),
        });
      },
    };
  }

  private isAgentBusyError(err: unknown): boolean {
    return isBusyTurnError(err);
  }

  private abortActiveTurn(channelId: string, reason: LifecycleInterrupt): void {
    const maybeAbortable = this.agentLoop as unknown as { abort?: () => void };
    if (typeof maybeAbortable.abort !== 'function') return;
    try {
      maybeAbortable.abort();
      this.logger.warn('Aborted active turn due to request lifecycle interruption', {
        channelId,
        reason,
      });
    } catch (err) {
      this.logger.error('Failed to abort active turn', {
        channelId,
        reason,
        error: toErrorMessage(err),
      });
    }
  }

  private async awaitTurnOrInterrupt<T>(
    channelId: string,
    req: IncomingMessage,
    res: ServerResponse,
    turnPromise: Promise<T>,
  ): Promise<T> {
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        this.abortActiveTurn(channelId, reason);
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const result = await Promise.race([turnPromise, interruptionPromise]);
      settled = true;
      return result;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private async awaitRuntimeOrInterrupt<T>(
    req: IncomingMessage,
    res: ServerResponse,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let settled = false;
    let cleanup: () => void = () => {};

    const interruptionPromise = new Promise<never>((_, reject) => {
      const fail = (reason: LifecycleInterrupt) => {
        if (settled) return;
        settled = true;
        controller.abort();
        reject(new RequestLifecycleError(reason));
      };

      const onAborted = () => fail('client_disconnected');
      const onClose = () => {
        if (res.writableEnded) return;
        fail('client_disconnected');
      };

      req.once('aborted', onAborted);
      res.once('close', onClose);
      const timer = setTimeout(() => fail('timeout'), this.requestTimeoutMs);
      cleanup = () => {
        req.off('aborted', onAborted);
        res.off('close', onClose);
        clearTimeout(timer);
      };
    });

    try {
      const result = await Promise.race([operation(controller.signal), interruptionPromise]);
      settled = true;
      return result;
    } finally {
      settled = true;
      cleanup();
    }
  }

  private sendRuntimeError(
    res: ServerResponse,
    status: number,
    type: string,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (!canWriteResponse(res)) return;
    sendApiError(res, status, type, message, details);
  }

  private readIdentityClaimHeaders(req: IncomingMessage): IdentityClaimHeaders | null {
    const canonicalContactId = clampApiHeader(
      singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.canonicalContactId]),
      128,
    );
    if (!canonicalContactId) return null;

    return {
      canonicalContactId,
      sourceChannel: clampApiHeader(
        singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.sourceChannel]),
        64,
      ) ?? '',
      sourceUserId: clampApiHeader(
        singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.sourceUserId]),
        256,
      ) ?? '',
      nonce: clampApiHeader(
        singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.nonce]),
        128,
      ),
      expiresAt: clampApiHeader(
        singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.expires]),
        64,
      ),
      signature: clampApiHeader(
        singleApiHeader(req.headers[IDENTITY_CLAIM_HEADERS.signature]),
        256,
      ),
    };
  }

  private challengePayload(
    claim: IdentityClaimHeaders,
    authorId: string,
    challenge: {
      nonce: string;
      expiresAt: string;
      signature: string;
    },
  ): Record<string, unknown> {
    return {
      canonicalContactId: claim.canonicalContactId,
      sourceChannel: claim.sourceChannel,
      sourceUserId: claim.sourceUserId,
      targetChannel: 'api',
      targetUserId: authorId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      signature: challenge.signature,
      requiredHeaders: {
        canonicalContactId: 'X-Canonical-Contact-ID',
        sourceChannel: 'X-Identity-Claim-Channel',
        sourceUserId: 'X-Identity-Claim-User-ID',
        nonce: 'X-Identity-Claim-Nonce',
        expiresAt: 'X-Identity-Claim-Expires',
        signature: 'X-Identity-Claim-Signature',
      },
    };
  }

  private async enforceIdentityClaim(
    req: IncomingMessage,
    res: ServerResponse,
    authorId: string,
  ): Promise<boolean> {
    const claim = this.readIdentityClaimHeaders(req);
    if (!claim) return true;

    if (!this.contactStore) {
      sendApiError(
        res,
        503,
        'identity_claim_unavailable',
        'Identity claim verification is unavailable because contact store is not configured',
      );
      return false;
    }

    if (!claim.sourceChannel || !claim.sourceUserId) {
      sendApiError(
        res,
        400,
        'invalid_identity_claim',
        'X-Identity-Claim-Channel and X-Identity-Claim-User-ID are required when claiming a canonical contact',
      );
      return false;
    }

    const hasCompleteVerificationHeaders = Boolean(claim.nonce && claim.expiresAt && claim.signature);
    const existingApiIdentity = await this.contactStore.getByChannelIdentity('api', authorId);
    if (existingApiIdentity?.id === claim.canonicalContactId && !hasCompleteVerificationHeaders) {
      return true;
    }
    if (existingApiIdentity && existingApiIdentity.id !== claim.canonicalContactId) {
      sendApiError(
        res,
        409,
        'identity_claim_conflict',
        `API identity api:${authorId} is already linked to another canonical contact`,
      );
      return false;
    }

    const requiresChallenge = !claim.nonce || !claim.expiresAt || !claim.signature;
    if (requiresChallenge) {
      const challengeResult = await this.contactStore.createIdentityLinkChallenge({
        contactId: claim.canonicalContactId,
        sourceChannel: claim.sourceChannel,
        sourceUserId: claim.sourceUserId,
        targetChannel: 'api',
        targetUserId: authorId,
        ttlMs: IDENTITY_LINK_CHALLENGE_TTL_MS,
      });

      switch (challengeResult.status) {
        case 'challenge_created':
        case 'pending_exists': {
          const payload = this.challengePayload(claim, authorId, challengeResult.verification);
          sendApiError(
            res,
            428,
            'identity_verification_required',
            'Identity claim requires challenge verification headers',
            { verification: payload },
          );
          return false;
        }
        case 'already_linked':
          return true;
        case 'contact_not_found':
          sendApiError(
            res,
            404,
            'identity_claim_contact_not_found',
            `Canonical contact ${claim.canonicalContactId} was not found`,
          );
          return false;
        case 'source_identity_not_linked':
          sendApiError(
            res,
            403,
            'identity_claim_source_not_linked',
            `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
          );
          return false;
        case 'identity_conflict':
          sendApiError(
            res,
            409,
            'identity_claim_conflict',
            `API identity api:${authorId} is already linked to a different canonical contact`,
          );
          return false;
        default:
          sendApiError(res, 400, 'invalid_identity_claim', 'Unable to create identity claim challenge');
          return false;
      }
    }

    const nonce = claim.nonce;
    const expiresAt = claim.expiresAt;
    const signature = claim.signature;
    if (!nonce || !expiresAt || !signature) {
      sendApiError(res, 400, 'invalid_identity_claim', 'Identity claim verification headers were incomplete');
      return false;
    }

    const verificationResult = await this.contactStore.verifyIdentityLinkChallenge({
      contactId: claim.canonicalContactId,
      sourceChannel: claim.sourceChannel,
      sourceUserId: claim.sourceUserId,
      targetChannel: 'api',
      targetUserId: authorId,
      nonce,
      expiresAt,
      signature,
    });

    switch (verificationResult.status) {
      case 'linked':
      case 'already_linked':
        return true;
      case 'verification_not_found':
        sendApiError(
          res,
          428,
          'identity_verification_required',
          'Identity claim challenge not found. Request a fresh challenge and retry with the returned headers.',
        );
        return false;
      case 'verification_replayed':
        sendApiError(res, 409, 'identity_verification_replayed', 'Identity claim challenge has already been used');
        return false;
      case 'verification_expired':
        sendApiError(res, 410, 'identity_verification_expired', 'Identity claim challenge has expired');
        return false;
      case 'invalid_signature':
        sendApiError(res, 401, 'identity_verification_invalid_signature', 'Identity claim signature did not match challenge');
        return false;
      case 'claim_mismatch':
        sendApiError(
          res,
          403,
          'identity_verification_claim_mismatch',
          'Identity claim payload did not match the issued challenge',
        );
        return false;
      case 'source_identity_not_linked':
        sendApiError(
          res,
          403,
          'identity_claim_source_not_linked',
          `${claim.sourceChannel}:${claim.sourceUserId} is not linked to canonical contact ${claim.canonicalContactId}`,
        );
        return false;
      case 'identity_conflict':
        sendApiError(
          res,
          409,
          'identity_claim_conflict',
          `API identity api:${authorId} is already linked to a different canonical contact`,
        );
        return false;
      case 'contact_not_found':
        sendApiError(
          res,
          404,
          'identity_claim_contact_not_found',
          `Canonical contact ${claim.canonicalContactId} was not found`,
        );
        return false;
      default:
        sendApiError(res, 400, 'invalid_identity_claim', 'Unable to verify identity claim');
        return false;
    }
  }

  private async prepareTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): Promise<PendingTurn | null> {
    const routingOverrides = parseTurnRoutingOverrides(request);
    if (!routingOverrides.ok) {
      sendApiError(res, 400, 'invalid_request', routingOverrides.error);
      return null;
    }
    const channelPrivacy = resolveChannelPrivacy(req);
    if (!channelPrivacy.ok) {
      sendApiError(res, 400, 'invalid_request', channelPrivacy.error);
      return null;
    }

    const defaultChannelId = deriveChannelId(req, principal);
    const defaultAuthor = deriveAuthor(principal);
    const turnIdentity = resolveApiTurnIdentity({
      headers: req.headers,
      principal,
      defaultChannelId,
      defaultAuthorId: defaultAuthor.authorId,
      defaultAuthorName: defaultAuthor.authorName,
      externalChannelProfiles: this.externalChannelProfiles,
      satelliteRegistry: this.satelliteRegistry,
      satelliteRegistryProvider: this.satelliteRegistryProvider,
      ...(clientCert ? { clientCert } : {}),
    });
    if (!turnIdentity.ok) {
      sendApiError(res, turnIdentity.status, turnIdentity.type, turnIdentity.message);
      return null;
    }
    const {
      channelId,
      channelType,
      authorId,
      authorName,
      source,
      channelPrivacy: claimedChannelPrivacy,
      canonicalContactId: claimedCanonicalContactId,
      satellite,
    } = turnIdentity.value;
    if (!(await this.enforceIdentityClaim(req, res, authorId))) {
      return null;
    }

    const canonicalContactId = clampApiHeader(
      singleApiHeader(req.headers['x-canonical-contact-id']),
      256,
    ) ?? claimedCanonicalContactId;
    const resolvedChannelPrivacy = channelPrivacy.value ?? claimedChannelPrivacy;
    if (source !== 'api') {
      if (!canonicalContactId) {
        sendApiError(
          res,
          503,
          'external_channel_not_configured',
          'External channel claims require a canonical contact mapping',
        );
        return null;
      }
      if (!resolvedChannelPrivacy) {
        sendApiError(
          res,
          503,
          'external_channel_not_configured',
          'External channel claims require a configured channel privacy level',
        );
        return null;
      }
    }
    const lastUserMsg = getLastUserMessage(request.messages);
    const lastUserAttachments = getLastUserMessageAttachments(request.messages);
    const bodyMessageId = `api-body-${randomUUID()}`;
    const screenedBody = await screenChatMessageBody({
      content: lastUserMsg,
      screening: this.documentIngest?.intakeScreening,
      sourceClass: source === 'api'
        ? 'primary_user'
        : resolvedChannelPrivacy === 'public'
          ? 'public_contact'
          : 'regular_contact',
      surface: 'api',
      channelId,
      messageId: bodyMessageId,
      ...(canonicalContactId ? { canonicalContactId } : {}),
    });
    // htm9.9: `file` content parts run the shared file-ingest pipeline
    // (quarantine -> parse -> intake screening) before prompt assembly.
    const ingestedFiles = await ingestApiDocumentFileParts({
      extraction: getLastUserMessageFileParts(request.messages),
      content: screenedBody.content,
      channelId,
      messageId: `api-file-${randomUUID()}`,
      authorId,
      attachmentIndexBase: lastUserAttachments.length,
      documentIngest: this.documentIngest,
    });
    const substrateMsg = buildSubstrateMessage({
      channelId,
      channelType,
      source,
      content: ingestedFiles.content,
      authorId,
      authorName,
      req,
      overrides: routingOverrides.value,
      channelPrivacy: resolvedChannelPrivacy,
      canonicalContactId,
      satellite,
      attachments: [...lastUserAttachments, ...ingestedFiles.attachments],
      intakeEnvelopes: [
        ...(screenedBody.snapshot ? [screenedBody.snapshot] : []),
        ...ingestedFiles.intakeEnvelopes,
      ],
    });

    const acquiredChannel = await this.acquireChannel(channelId, req, res);
    if (!acquiredChannel) return null;

    seedSession({
      sessionManager: this.sessionManager,
      channelId,
      messages: request.messages,
      authorId,
      authorName,
      channelPrivacy: resolvedChannelPrivacy,
    });

    return {
      channelId,
      wasQueued: acquiredChannel.wasQueued,
      releaseChannel: acquiredChannel.releaseChannel,
      substrateMsg,
    };
  }

  private beginPreparedTurn(turn: PendingTurn): PreparedTurn {
    if (turn.wasQueued) {
      const maybeFollowUp = (this.agentLoop as unknown as {
        followUp?: (message: SubstrateMessage) => Promise<void> | void;
      }).followUp;
      if (typeof maybeFollowUp === 'function') {
        const turnDeferred = createDeferred<AgentTurnResult>();
        let settled = false;
        const settle = (action: () => void) => {
          if (settled) return;
          settled = true;
          unsubscribeEnd();
          unsubscribeError();
          action();
        };
        const unsubscribeEnd = this.eventBus.on('agent.turn.end', ({ message, response }) => {
          if (message.id !== turn.substrateMsg.id) return;
          settle(() => {
            turnDeferred.resolve(response);
          });
        });
        const unsubscribeError = this.eventBus.on('agent.error', ({ message, error }) => {
          if (message.id !== turn.substrateMsg.id) return;
          settle(() => {
            turnDeferred.reject(error);
          });
        });

        Promise.resolve()
          .then(() => maybeFollowUp.call(this.agentLoop, turn.substrateMsg))
          .catch((error) => {
            settle(() => {
              turnDeferred.reject(error);
            });
          });

        this.attachTurnCleanup(turn.releaseChannel, turnDeferred.promise);
        return {
          channelId: turn.channelId,
          turnPromise: turnDeferred.promise,
        };
      }
    }

    const turnPromise = this.agentLoop.handleMessage(turn.substrateMsg);
    this.attachTurnCleanup(turn.releaseChannel, turnPromise);
    return {
      channelId: turn.channelId,
      turnPromise,
    };
  }

  private async startTurn(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
  ): Promise<PreparedTurn | null> {
    const pending = await this.prepareTurn(request, req, res, principal, clientCert);
    if (!pending) return null;
    return this.beginPreparedTurn(pending);
  }

  private handleNonStreamingTurnError(res: ServerResponse, err: unknown): void {
    if (!canWriteResponse(res)) return;
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout') {
        sendApiError(res, 504, 'request_timeout', 'Request timed out before turn completed');
      }
      return;
    }
    if (this.isAgentBusyError(err)) {
      res.setHeader('Retry-After', '1');
      sendApiError(res, 503, 'agent_busy', 'Agent is already processing another prompt');
      return;
    }
    this.logger.error('Non-streaming completion error', { error: String(err) });
    sendApiError(res, 500, 'internal_error', 'Internal server error');
  }

  private handleStreamingTurnError(
    res: ServerResponse,
    err: unknown,
    transport: SseStreamingTransport,
  ): void {
    if (err instanceof RequestLifecycleError) {
      if (err.reason === 'timeout' && canWriteResponse(res)) {
        transport.writeErrorAndDone('request_timeout', 'Request timed out before turn completed');
      }
      return;
    }

    if (this.isAgentBusyError(err)) {
      if (canWriteResponse(res)) {
        transport.writeErrorAndDone('agent_busy', 'Agent is already processing another prompt');
      }
      return;
    }

    this.logger.error('Streaming completion error', { error: String(err) });
    if (canWriteResponse(res)) {
      transport.writeErrorAndDone('internal_error', 'Internal server error');
    }
  }

  private async handleNonStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
    hubDevicePrincipal: HubDevicePrincipalSnapshot | undefined,
    hubDeviceAttachment: HubDeviceAttachmentSnapshot | undefined,
    fleetRouting: FleetGardenChatRouting | undefined,
  ): Promise<void> {
    const runtime = this.runtime;
    if (runtime) {
      try {
        const result = await this.awaitRuntimeOrInterrupt(
          req,
          res,
          (signal) => runtime.handleChatCompletion({
            request,
            principal,
            headers: extractRpcHeaders(req),
            ...(fleetRouting ? { companionId: fleetRouting.companionId } : {}),
            ...(clientCert ? { clientCert } : {}),
            ...(hubDevicePrincipal ? { hubDevicePrincipal } : {}),
            ...(hubDeviceAttachment ? { hubDeviceAttachment } : {}),
            signal,
          }),
        );
        if (!canWriteResponse(res)) return;
        if (!result.ok) {
          this.sendRuntimeError(
            res,
            result.error.status,
            result.error.type,
            result.error.message,
            result.error.details,
          );
          return;
        }
        if (!result.response.content.trim() && !isNoReplyRuntimeCompletion(result.response)) {
          this.sendRuntimeError(
            res,
            502,
            'model_error',
            'Agent returned empty content without an intentional no-reply marker',
          );
          return;
        }

        const response = buildChatCompletionResponse({
          id: `chatcmpl-${randomUUID()}`,
          created: Math.floor(Date.now() / 1000),
          model: result.response.companionId ?? fleetRouting?.companionId ?? this.modelName,
          content: result.response.content,
          inputTokens: result.response.inputTokens,
          outputTokens: result.response.outputTokens,
        });

        sendJson(res, 200, response);
      } catch (err) {
        this.handleNonStreamingTurnError(res, err);
      }
      return;
    }

    if (hubDevicePrincipal) {
      sendApiError(res, 503, 'hub_device_ingress_unavailable', 'Hub device turns require the authenticated gateway runtime');
      return;
    }

    const turn = await this.startTurn(request, req, res, principal, clientCert);
    if (!turn) return;

    try {
      const agentResponse = await this.awaitTurnOrInterrupt(
        turn.channelId,
        req,
        res,
        turn.turnPromise,
      );
      if (!canWriteResponse(res)) return;
      if (!agentResponse.content.trim() && !isIntentionalNoReplyResponse(agentResponse)) {
        sendApiError(res, 502, 'model_error', 'Agent returned empty content without an intentional no-reply marker');
        return;
      }

      const response = buildChatCompletionResponse({
        id: `chatcmpl-${randomUUID()}`,
        created: Math.floor(Date.now() / 1000),
        model: this.modelName,
        content: agentResponse.content,
        inputTokens: agentResponse.metadata.inputTokens,
        outputTokens: agentResponse.metadata.outputTokens,
      });

      sendJson(res, 200, response);
    } catch (err) {
      this.handleNonStreamingTurnError(res, err);
    }
  }

  private async handleStreaming(
    request: ChatCompletionRequest,
    req: IncomingMessage,
    res: ServerResponse,
    principal: ApiAuthPrincipal,
    clientCert: SatelliteClientCertIdentity | undefined,
    hubDevicePrincipal: HubDevicePrincipalSnapshot | undefined,
    hubDeviceAttachment: HubDeviceAttachmentSnapshot | undefined,
    fleetRouting: FleetGardenChatRouting | undefined,
  ): Promise<void> {
    const completionId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const runtime = this.runtime;

    if (runtime) {
      let transport: SseStreamingTransport | undefined;
      let responseModel: string | undefined;
      const ensureTransport = (model: string): SseStreamingTransport => {
        if (transport) {
          if (responseModel !== model) {
            throw new Error('Streaming response companion identity changed during the request');
          }
          return transport;
        }
        responseModel = model;
        transport = new SseStreamingTransport(res, { completionId, created, model });
        transport.open();
        transport.writeRole();
        return transport;
      };
      if (fleetRouting) {
        ensureTransport(fleetRouting.companionId);
      }

      try {
        const result = await this.awaitRuntimeOrInterrupt(
          req,
          res,
          (signal) => runtime.handleChatCompletion({
            request,
            principal,
            headers: extractRpcHeaders(req),
            ...(fleetRouting ? { companionId: fleetRouting.companionId } : {}),
            ...(clientCert ? { clientCert } : {}),
            ...(hubDevicePrincipal ? { hubDevicePrincipal } : {}),
            ...(hubDeviceAttachment ? { hubDeviceAttachment } : {}),
            signal,
            onDelta: (text, companionId) => {
              ensureTransport(
                companionId ?? fleetRouting?.companionId ?? this.modelName,
              ).writeContent(text);
            },
          }),
        );
        if (!canWriteResponse(res)) return;
        if (!result.ok) {
          ensureTransport(fleetRouting?.companionId ?? this.modelName)
            .writeErrorAndDone(result.error.type, result.error.message, result.error.details);
          return;
        }
        const respondingTransport = ensureTransport(
          result.response.companionId ?? fleetRouting?.companionId ?? this.modelName,
        );
        if (!result.response.content.trim() && !isNoReplyRuntimeCompletion(result.response)) {
          respondingTransport.writeErrorAndDone('empty_response', 'Agent returned empty content');
          return;
        }

        respondingTransport.writeFinish();
        respondingTransport.writeDone();
      } catch (err) {
        this.handleStreamingTurnError(
          res,
          err,
          transport ?? ensureTransport(fleetRouting?.companionId ?? this.modelName),
        );
      } finally {
        transport?.endIfWritable();
      }
      return;
    }

    if (hubDevicePrincipal) {
      sendApiError(res, 503, 'hub_device_ingress_unavailable', 'Hub device turns require the authenticated gateway runtime');
      return;
    }

    const pendingTurn = await this.prepareTurn(request, req, res, principal, clientCert);
    if (!pendingTurn) return;

    const transport = new SseStreamingTransport(res, {
      completionId,
      created,
      model: this.modelName,
    });
    transport.open();
    transport.writeRole();

    const unsubscribe = this.eventBus.on('agent.stream.delta', (data) => {
      if (data.channelId !== pendingTurn.channelId) return;
      transport.writeContent(data.text);
    });
    const turn = this.beginPreparedTurn(pendingTurn);

    try {
      const agentResponse = await this.awaitTurnOrInterrupt(turn.channelId, req, res, turn.turnPromise);
      if (!canWriteResponse(res)) return;
      if (!agentResponse.content.trim() && !isIntentionalNoReplyResponse(agentResponse)) {
        transport.writeErrorAndDone('empty_response', 'Agent returned empty content');
        return;
      }

      transport.writeFinish();
      transport.writeDone();
    } catch (err) {
      this.handleStreamingTurnError(res, err, transport);
    } finally {
      unsubscribe();
      transport.endIfWritable();
    }
  }
}
