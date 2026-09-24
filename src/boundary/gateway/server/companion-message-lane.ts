// ── Inter-companion channel lane ──
// `companion.message.send`: the ONLY way a companion message moves between
// agents. The sender identity is the connection's BOUND companionId (never a
// parameter); the lane resolves recipients (room = presence at the place,
// DM = the addressed peer); every delivery is an ordinary inbound channel
// notification (`companion.message`) so the receiving agent runs it through
// the normal turn pipeline — fatigue (MI↔MI charging, hard suppression),
// trust, and extraction apply with zero new mechanism. No side-channel
// dispatch exists; docs/specifications.md defines the same-cluster autonomy
// boundary and forbids bypassing ordinary-channel fatigue controls.
import { randomUUID } from 'node:crypto';
import { JSONRPCErrorException } from 'json-rpc-2.0';
import { IcpDyadLifecycleConflictError } from '../../../core/icp/autonomy-store-ports.js';
import { COMPANION_CHANNEL_TYPE } from '../../../shared/contracts/companion-channels.js';
import { deriveIcpTransportMessageId } from '../../../shared/contracts/icp-autonomy.js';
import { createComponentLogger } from '../../../shared/logger.js';
import { createCompanionId } from '../../../shared/routing/companion-id.js';
import {
  GatewayErrors,
  type CompanionMessageDeliveryFailureNotification,
  type CompanionMessageFailureReportResult,
  type CompanionMessageSendResult,
} from '../protocol.js';
import {
  CompanionDeliveryFailureReceipts,
  parseCompanionMessageFailureReport,
} from '../companion-delivery-failures.js';
import type { GatewayRpcConnection } from '../transport.js';
import { parseCompanionMessageSendParams } from './companion-message-send-params.js';
import type { GatewayServerPorts } from './ports.js';

const log = createComponentLogger('Gateway');
const ICP_DELIVERY_REPLAY_CACHE_TTL_MS = 15 * 60_000;

export class GatewayCompanionMessageLane {
  private readonly companionDeliveryFailureReceipts = new CompanionDeliveryFailureReceipts();
  /**
   * Same-process retry accelerator only. This map deliberately is not the
   * durable exactly-once boundary: an RPC acknowledgement can be lost across
   * a gateway restart, so correlated sends retain one deterministic message
   * id and may be notified again. Recipient agents must claim that id before
   * durable recovery reads and use their L0 source-id lookup for cross-process
   * idempotency.
   */
  private readonly deliveredIcpMessages = new Map<string, {
    content: string;
    correlation: string;
    humanRelay?: string;
    expiresAtMs: number;
    result: CompanionMessageSendResult;
  }>();

  constructor(
    private readonly ports: Pick<
      GatewayServerPorts,
      | 'multiCompanion'
      | 'options'
      | 'icpAutonomyBroker'
      | 'connectionStatuses'
      | 'alarmCompanionViolation'
      | 'refreshConnectionHealth'
      | 'resolveReadyCompanionConnection'
      | 'notifyOne'
    >,
  ) {}

  clearDeliveryFailureReceipts(): void {
    this.companionDeliveryFailureReceipts.clear();
  }

  async handleCompanionMessageSend(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<CompanionMessageSendResult> {
    const parsed = parseCompanionMessageSendParams(params);
    const senderCompanionId = this.ports.connectionStatuses.get(conn)?.companionId;
    let release: () => void = () => undefined;
    if (senderCompanionId && this.ports.icpAutonomyBroker) {
      if (parsed.continuation) {
        release = await this.ports.icpAutonomyBroker.acquireDyadOperation(parsed.continuation.dyadId);
      } else {
        const peerCompanionId = parsed.initiation?.recipientCompanionId
          ?? parsed.correlation?.peerCompanionId;
        if (peerCompanionId) {
          release = await this.ports.icpAutonomyBroker.acquireDyadPairOperation(
            senderCompanionId,
            peerCompanionId,
          );
        }
      }
    }
    try {
      return await this.handleCompanionMessageSendUnderDyadFence(conn, params);
    } finally {
      release();
    }
  }

  async handleCompanionMessageSendUnderDyadFence(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<CompanionMessageSendResult> {
    if (!this.ports.multiCompanion.enabled) {
      throw new Error(
        'Inter-companion channels do not exist in single-companion topology '
        + '(enable multi-companion mode to use companion.message.send)',
      );
    }
    const lane = this.ports.options.companionChannels;
    if (!lane) {
      this.ports.alarmCompanionViolation(
        'companion_lane_unconfigured',
        'companion.message.send rejected: multi-companion is enabled but no companion channel lane is wired',
        {},
      );
      throw new JSONRPCErrorException(
        'Inter-companion channel lane is not configured on this gateway',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const status = this.ports.connectionStatuses.get(conn);
    const senderCompanionId = status?.role === 'agent' ? status.companionId : undefined;
    if (!senderCompanionId) {
      this.ports.alarmCompanionViolation(
        'companion_send_unidentified',
        'companion.message.send rejected: connection has no bound agent companionId',
        {},
      );
      throw new Error('companion.message.send requires an identified agent companion connection');
    }

    const {
      channelId,
      content,
      authorName,
      messageId: requestedMessageId,
      initiation,
      continuation,
      correlation,
      replyToMessageId,
      humanRelay,
    } = parseCompanionMessageSendParams(params);
    let initiationPermitOutcome: 'consumed' | 'replayed' | undefined;
    let initiationPermitExpiresAtMs: number | undefined;
    let messageCorrelation: import('../../../shared/contracts/icp-autonomy.js').IcpConversationCorrelation | undefined;
    if (initiation) {
      if (!this.ports.icpAutonomyBroker) {
        throw new JSONRPCErrorException(
          'ICP autonomy broker is not configured',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      const { correlation } = initiation;
      if (correlation.localCompanionId !== senderCompanionId
        || correlation.peerCompanionId !== initiation.recipientCompanionId
        || correlation.initiatedByCompanionId !== senderCompanionId
        || correlation.channelId !== channelId
        || correlation.conversationId !== initiation.conversationId) {
        this.ports.alarmCompanionViolation(
          'icp_initiation_delivery_mismatch',
          'ICP initiation delivery correlation does not match the authenticated sender binding',
          { senderCompanionId, channelId, recipientCompanionId: initiation.recipientCompanionId },
        );
        throw new Error('ICP initiation delivery correlation mismatch');
      }
      const consumption = await this.ports.icpAutonomyBroker.consumePermit(senderCompanionId, {
        permitId: initiation.permitId,
        conversationId: initiation.conversationId,
        recipientCompanionId: initiation.recipientCompanionId,
        channelId,
        rootInitiationId: correlation.rootInitiationId,
        peerContactId: correlation.peerContactId,
      });
      if ((consumption.outcome !== 'consumed' && consumption.outcome !== 'replayed')
        || !consumption.permit) {
        throw new JSONRPCErrorException(
          `ICP initiation permit delivery rejected: ${consumption.reasonCode ?? consumption.outcome}`,
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      if (correlation.messageId !== `icp-initiation:${consumption.permit.candidateId}`
        || correlation.requestId !== correlation.messageId) {
        this.ports.alarmCompanionViolation(
          'icp_initiation_delivery_mismatch',
          'ICP initiation delivery correlation does not match the consumed permit',
          { senderCompanionId, channelId, conversationId: initiation.conversationId },
        );
        throw new Error('ICP initiation delivery permit/correlation mismatch');
      }
      initiationPermitOutcome = consumption.outcome;
      initiationPermitExpiresAtMs = consumption.permit.expiresAtMs;
      messageCorrelation = {
        ...correlation,
        rootInitiationId: consumption.episode.rootInitiationId,
      };
    } else if (continuation) {
      if (!this.ports.icpAutonomyBroker) {
        throw new JSONRPCErrorException(
          'ICP autonomy broker is not configured',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      const authorized = await this.ports.icpAutonomyBroker.authorizeDyadContinuationDelivery(
        senderCompanionId,
        {
          dyadId: continuation.dyadId,
          deliveryId: continuation.deliveryId,
          peerContactId: continuation.peerContactId,
        },
      );
      const candidate = continuation.correlation;
      if (authorized.dyad.channelId !== channelId
        || authorized.delivery.recipientCompanionId !== continuation.recipientCompanionId
        || authorized.episode.conversationId !== candidate.conversationId
        || authorized.episode.rootInitiationId !== candidate.rootInitiationId
        || candidate.localCompanionId !== senderCompanionId
        || candidate.peerCompanionId !== continuation.recipientCompanionId
        || candidate.peerContactId !== continuation.peerContactId
        || candidate.messageId !== `icp-continuation:${continuation.deliveryId}`
        || candidate.requestId !== candidate.messageId
        || candidate.channelId !== channelId
        || candidate.costOriginStage !== 'initiation') {
        throw new Error('ICP dyad continuation delivery correlation mismatch');
      }
      messageCorrelation = candidate;
    } else if (correlation) {
      if (!this.ports.icpAutonomyBroker) {
        throw new JSONRPCErrorException(
          'ICP autonomy broker is not configured',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
        );
      }
      try {
        messageCorrelation = await this.ports.icpAutonomyBroker.bindConversationReplyCorrelation(
          senderCompanionId,
          correlation,
        );
      } catch (error) {
        if (!(error instanceof IcpDyadLifecycleConflictError)) throw error;
        throw new JSONRPCErrorException(
          'ICP reply unavailable',
          GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          { reasonCode: error.reasonCode },
        );
      }
    }

    if (humanRelay) {
      const request = humanRelay.requestCapsule;
      const response = humanRelay.responseCapsule;
      if (!messageCorrelation
        || request.source.companionId !== (continuation ? senderCompanionId : messageCorrelation.peerCompanionId)
        || request.target.companionId !== (continuation
          ? continuation.recipientCompanionId
          : senderCompanionId)
        || request.target.dyadId !== messageCorrelation.dyadId
        || request.target.channelId !== channelId) {
        throw new Error('Human relay custody does not match the authenticated ICP dyad');
      }
      if (continuation ? response !== undefined : !correlation || response === undefined) {
        throw new Error('Human relay custody is on the wrong ICP transport stage');
      }
      if (response && (response.response.companionId !== senderCompanionId
        || response.response.dyadId !== messageCorrelation.dyadId
        || response.response.channelId !== channelId
        || response.destination.companionId !== messageCorrelation.peerCompanionId
        || response.content !== content)) {
        throw new Error('Human relay response custody changed its source, destination, or exact bytes');
      }
    }

    const stableIcpMessageId = messageCorrelation
      ? deriveIcpTransportMessageId(messageCorrelation)
      : undefined;
    if (stableIcpMessageId !== requestedMessageId) {
      this.ports.alarmCompanionViolation(
        'icp_delivery_message_id_mismatch',
        'Correlated ICP send did not use its deterministic gateway-bound message id',
        { senderCompanionId, channelId, requestedMessageId, stableIcpMessageId },
      );
      throw new Error('Correlated ICP transport message id mismatch');
    }
    const now = Date.now();
    for (const [cachedMessageId, delivered] of this.deliveredIcpMessages.entries()) {
      if (delivered.expiresAtMs <= now) this.deliveredIcpMessages.delete(cachedMessageId);
    }
    if (stableIcpMessageId) {
      // Collapse an identical retry while this gateway process still owns the
      // result. On restart the cache is empty and at-least-once redelivery is
      // intentional; the recipient's durable source-envelope binding is
      // authoritative across gateway process restarts.
      const delivered = this.deliveredIcpMessages.get(stableIcpMessageId);
      if (delivered) {
        if (delivered.content !== content
          || delivered.correlation !== JSON.stringify(messageCorrelation)
          || delivered.humanRelay !== (humanRelay ? JSON.stringify(humanRelay) : undefined)) {
          this.ports.alarmCompanionViolation(
            'icp_delivery_replay_mismatch',
            'Replayed ICP message changed its already-delivered content or correlation',
            { senderCompanionId, channelId, messageId: stableIcpMessageId },
          );
          throw new Error('Replayed ICP delivery mismatch');
        }
        if (continuation && this.ports.icpAutonomyBroker) {
          await this.ports.icpAutonomyBroker.recordDyadContinuationDelivery(senderCompanionId, {
            dyadId: continuation.dyadId,
            deliveryId: continuation.deliveryId,
            peerContactId: continuation.peerContactId,
            outcome: 'duplicate',
            attempt: 1,
            gatewayMessageId: delivered.result.messageId,
          });
        }
        return {
          ...delivered.result,
          ...(initiationPermitOutcome ? { permitOutcome: 'replayed' as const } : {}),
        };
      }
    }

    // The envelope timestamp is minted BEFORE recipient resolution and handed
    // to the lane: private-room windowing (bead s10rm) compares each
    // recipient's presence `since` against this exact instant, so the window
    // check and the delivered envelope can never disagree on the clock.
    const mintedAt = new Date(this.ports.options.companionChannelNow?.() ?? Date.now());
    const senderReplyReceipt = replyToMessageId !== undefined
      ? this.companionDeliveryFailureReceipts.claimReply(
        senderCompanionId,
        channelId,
        replyToMessageId,
        mintedAt.getTime(),
      )
      : null;
    if (replyToMessageId !== undefined && !senderReplyReceipt) {
      this.ports.alarmCompanionViolation(
        'companion_reply_unverified',
        'Companion reply does not match an unclaimed gateway delivery receipt',
        { senderCompanionId, channelId, replyToMessageId },
      );
      throw new JSONRPCErrorException(
        'Companion reply does not match an unclaimed gateway delivery receipt',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }
    const resolution = await lane.resolveDelivery(senderCompanionId, channelId, {
      messageTimestampMs: mintedAt.getTime(),
      ...(senderReplyReceipt?.roomPresenceEpoch
        ? { senderReplyPresenceEpoch: senderReplyReceipt.roomPresenceEpoch }
        : {}),
    });
    if (!resolution.ok) {
      this.ports.alarmCompanionViolation(
        resolution.violation.event,
        resolution.violation.message,
        resolution.violation.details,
      );
      throw new JSONRPCErrorException(
        resolution.violation.message,
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }
    if (initiation && !resolution.recipients.includes(
      createCompanionId(initiation.recipientCompanionId, 'ICP initiation recipientCompanionId'),
    )) {
      throw new JSONRPCErrorException(
        'ICP initiation recipient is outside the current channel delivery window',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    // Gateway-authoritative message envelope: id and timestamp are minted
    // here, the author identity is the verified sender companionId, and the
    // machine-intelligence marker is stamped by construction (every sender on
    // this lane is a companion) so observed-MI contact tagging and fatigue
    // relationship classes apply on the recipient with no trust in
    // sender-supplied metadata.
    const message = {
      id: stableIcpMessageId
        ? stableIcpMessageId
        : `companion-${randomUUID()}`,
      channelId,
      channelType: COMPANION_CHANNEL_TYPE,
      authorId: senderCompanionId,
      authorName: authorName ?? senderCompanionId,
      content,
      timestamp: mintedAt.toISOString(),
      isDirectMessage: resolution.kind === 'dm',
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
        ...(messageCorrelation ? { icpCorrelation: messageCorrelation } : {}),
        ...(humanRelay ? { humanRelay } : {}),
        ...(resolution.kind === 'room'
          ? {
            channelPrivacy: resolution.roomPrivacy,
            room: {
              placeId: resolution.placeId,
              privacy: resolution.roomPrivacy,
            },
          }
          : {}),
      },
      ...(senderReplyReceipt ? { replyToMessageId: senderReplyReceipt.messageId } : {}),
    };

    this.ports.refreshConnectionHealth();
    const deliveredTo: string[] = [];
    const skippedOffline: string[] = [];
    for (const recipientId of resolution.recipients) {
      const recipientConn = this.ports.resolveReadyCompanionConnection(recipientId);
      if (!recipientConn) {
        if (resolution.kind === 'dm') {
          // DM to a disconnected peer fails closed back to the sender.
          this.ports.alarmCompanionViolation(
            'companion_dm_peer_unavailable',
            `Companion DM peer "${recipientId}" has no ready agent connection`,
            { senderCompanionId, channelId, peerCompanionId: recipientId },
          );
          throw new JSONRPCErrorException(
            `Companion DM peer "${recipientId}" is not connected`,
            GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
          );
        }
        // A room with an offline member still works: skip with a log.
        log.info('Companion room recipient has no ready connection; skipping delivery', {
          senderCompanionId,
          channelId,
          recipientCompanionId: recipientId,
        });
        skippedOffline.push(recipientId);
        continue;
      }
      const roomPresenceEpoch = resolution.kind === 'room'
        ? resolution.recipientPresenceEpochs[recipientId]
        : undefined;
      this.companionDeliveryFailureReceipts.record({
        channelId,
        messageId: message.id,
        senderCompanionId,
        recipientCompanionId: recipientId,
        deliveredAt: mintedAt.getTime(),
        ...(roomPresenceEpoch ? { roomPresenceEpoch } : {}),
      });
      try {
        this.ports.notifyOne(recipientConn, 'companion.message', { message });
      } catch (error) {
        this.companionDeliveryFailureReceipts.consume(recipientId, message.id);
        throw error;
      }
      deliveredTo.push(recipientId);
    }

    if (resolution.kind === 'room' && resolution.windowExcluded && resolution.windowExcluded.length > 0) {
      // Private-room join race: present companions whose window opened after
      // the mint receive nothing pre-join (bead s10rm). Loud log,
      // not a violation — this is the window working as designed.
      log.info('Companion room recipients excluded by presence window', {
        senderCompanionId,
        channelId,
        messageId: message.id,
        windowExcluded: resolution.windowExcluded,
      });
    }

    log.info('Companion message routed', {
      senderCompanionId,
      channelId,
      kind: resolution.kind,
      messageId: message.id,
      deliveredTo,
      skippedOffline,
    });

    const result: CompanionMessageSendResult = {
      channelId,
      messageId: message.id,
      deliveredTo,
      skippedOffline,
      ...(initiationPermitOutcome ? { permitOutcome: initiationPermitOutcome } : {}),
    };
    if (continuation && this.ports.icpAutonomyBroker) {
      await this.ports.icpAutonomyBroker.recordDyadContinuationDelivery(senderCompanionId, {
        dyadId: continuation.dyadId,
        deliveryId: continuation.deliveryId,
        peerContactId: continuation.peerContactId,
        outcome: 'delivered',
        attempt: 1,
        gatewayMessageId: message.id,
      });
    }
    if (stableIcpMessageId && messageCorrelation) {
      this.deliveredIcpMessages.set(stableIcpMessageId, {
        content,
        correlation: JSON.stringify(messageCorrelation),
        ...(humanRelay ? { humanRelay: JSON.stringify(humanRelay) } : {}),
        expiresAtMs: initiationPermitExpiresAtMs ?? (now + ICP_DELIVERY_REPLAY_CACHE_TTL_MS),
        result,
      });
    }
    return result;
  }

  async handleCompanionMessageFailureReport(
    conn: GatewayRpcConnection,
    params: unknown,
  ): Promise<CompanionMessageFailureReportResult> {
    if (!this.ports.multiCompanion.enabled || !this.ports.options.companionChannels) {
      throw new JSONRPCErrorException(
        'Inter-companion channel lane is not configured on this gateway',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const status = this.ports.connectionStatuses.get(conn);
    const reportingCompanionId = status?.role === 'agent' ? status.companionId : undefined;
    if (!reportingCompanionId) {
      throw new Error('companion.message.report_failure requires an identified agent companion connection');
    }

    const { channelId, messageId, reason } = parseCompanionMessageFailureReport(params);
    const receipt = this.companionDeliveryFailureReceipts.findVerified(
      reportingCompanionId,
      { channelId, messageId, reason },
    );
    if (!receipt) {
      this.ports.alarmCompanionViolation(
        'companion_failure_report_unverified',
        'Companion failure report does not match a gateway delivery receipt',
        { reportingCompanionId, channelId, messageId },
      );
      throw new JSONRPCErrorException(
        'Companion failure report does not match a gateway delivery receipt',
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    this.ports.refreshConnectionHealth();
    const senderConn = this.ports.resolveReadyCompanionConnection(receipt.senderCompanionId);
    if (!senderConn) {
      throw new JSONRPCErrorException(
        `Original companion sender "${receipt.senderCompanionId}" is not connected`,
        GatewayErrors.COMPANION_ROUTING_UNAVAILABLE,
      );
    }

    const notification: CompanionMessageDeliveryFailureNotification = {
      channelId,
      messageId,
      reportingCompanionId,
      reason,
      reportedAt: new Date().toISOString(),
    };
    this.ports.notifyOne(senderConn, 'companion.message.delivery_failure', notification);
    this.companionDeliveryFailureReceipts.consume(reportingCompanionId, messageId);
    log.warn('Companion message delivery failure reported to original sender', notification);
    return { reportedTo: receipt.senderCompanionId };
  }
}
