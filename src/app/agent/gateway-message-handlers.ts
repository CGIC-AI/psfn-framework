import type { AgentResponse, Attachment, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import type { ObservedGroupMemoryScheduleDecision } from '../../faculties/memory/extraction/group-observed-scheduler.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { resolveCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';
import type { OutboundReplyGuardPort } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type {
  CompanionDeliveryFailureReason,
  CompanionMessageDeliveryFailureNotification,
  CompanionMessageFailureReportParams,
} from '../../boundary/gateway/protocol.js';
import {
  createDiscordDeliveryCheckpoint,
  deliverDiscordReply,
  DiscordFailedDeliveryCache,
  DiscordReplyDeliveryError,
  DISCORD_DELIVERY_FAILURE_NOTICE,
  DISCORD_TURN_FAILURE_NOTICE,
  type DiscordDeliveryCheckpoint,
  type DiscordFailureStage,
} from './discord-reply-delivery.js';

const DUPLICATE_MESSAGE_WINDOW_MS = 2 * 60_000;
const AGENT_BUSY_PATTERN = /already processing a prompt/i;

interface QueuedDiscordMessage {
  message: SubstrateMessage;
  dedupeKey: string | null;
  retryDelivery?: DiscordDeliveryCheckpoint;
}

interface RecentHandleMessageResult {
  completedAt: number;
  response: AgentResponse;
}

function buildMessageDedupKey(route: 'handle' | 'discord' | 'companion', message: SubstrateMessage): string | null {
  const messageId = message.id.trim();
  if (!messageId) return null;
  return `${route}:${message.channelId}:${messageId}`;
}

export interface GatewayMessageGateway {
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void;
  onDiscordMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  discordSend(channelId: string, content: string): Promise<void>;
  discordSendMedia(channelId: string, media: Attachment): Promise<void>;
  /** Inter-companion lane (sprint 10, W6): inbound peer messages + outbound replies. */
  onCompanionMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  companionSend(channelId: string, content: string, authorName?: string): Promise<unknown>;
  companionReportFailure(params: CompanionMessageFailureReportParams): Promise<unknown>;
  onCompanionDeliveryFailure(
    handler: (notification: CompanionMessageDeliveryFailureNotification) => void | Promise<void>,
  ): void;
}

export interface GatewayMessageAgentLoop {
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
  observeMessage(message: SubstrateMessage): Promise<void>;
  /** Resolves when the agent has finished all in-flight work (prompt + steering + follow-ups). */
  waitForIdle(): Promise<void>;
}

export type GatewayMessageShardManager = Pick<ShardExecutionPort, 'delegateSatelliteSession'>;

export interface GatewayMessageAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
}

export interface ObservedGroupMemorySchedulerPort {
  observeMessage(message: SubstrateMessage): Promise<ObservedGroupMemoryScheduleDecision>;
}

export interface GatewayMessageLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface GatewayMessageHandlersDeps {
  gateway: GatewayMessageGateway;
  agentLoop: GatewayMessageAgentLoop;
  shardManager: GatewayMessageShardManager;
  safeguardAuditTrail: GatewayMessageAuditTrail;
  satelliteRouting: SatelliteRoutingPort;
  config: SubstrateConfig;
  log: GatewayMessageLogger;
  trackSessionActivity: (message: SubstrateMessage) => void;
  observedGroupMemoryScheduler?: ObservedGroupMemorySchedulerPort;
  /**
   * Records primary replies delivered to Discord so replay-prone senders (the
   * deferred-tool-handoff continuation) can detect and suppress a duplicate of
   * an already-delivered reply. See `outbound-reply-dedupe.ts`.
   */
  outboundReplyGuard?: OutboundReplyGuardPort;
  /**
   * Display name stamped on companion-lane replies (the character card name).
   * Identity is always the gateway-verified companionId; this is cosmetic.
   */
  companionAuthorName?: string;
}

export function registerGatewayMessageHandlers(deps: GatewayMessageHandlersDeps): void {
  const {
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    satelliteRouting,
    config,
    log,
    trackSessionActivity,
    observedGroupMemoryScheduler,
    outboundReplyGuard,
    companionAuthorName,
  } = deps;

  const inFlightHandleMessages = new Map<string, Promise<AgentResponse>>();
  const recentHandleResponses = new Map<string, RecentHandleMessageResult>();
  const inFlightDiscordMessages = new Set<string>();
  const recentDiscordMessages = new Map<string, number>();
  const failedDiscordDeliveries = new DiscordFailedDeliveryCache();
  const inFlightCompanionMessages = new Set<string>();
  const recentCompanionMessages = new Map<string, number>();

  const pruneDuplicateCaches = (now: number): void => {
    const minTimestamp = now - DUPLICATE_MESSAGE_WINDOW_MS;
    for (const [key, cached] of recentHandleResponses.entries()) {
      if (cached.completedAt < minTimestamp) {
        recentHandleResponses.delete(key);
      }
    }
    for (const [key, seenAt] of recentDiscordMessages.entries()) {
      if (seenAt < minTimestamp) {
        recentDiscordMessages.delete(key);
      }
    }
    failedDiscordDeliveries.prune(minTimestamp);
    for (const [key, seenAt] of recentCompanionMessages.entries()) {
      if (seenAt < minTimestamp) {
        recentCompanionMessages.delete(key);
      }
    }
  };

  // No conversational message is ever dropped: if the agent is busy we wait
  // for idle and try again, indefinitely and loudly. A wedged agent surfaces
  // as repeated warnings in the journal, never as silent message loss.
  const promptWhenIdle = async (message: SubstrateMessage): Promise<AgentResponse> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await agentLoop.handleMessage(message);
      } catch (err) {
        if (!(err instanceof Error) || !AGENT_BUSY_PATTERN.test(err.message)) throw err;
        log.warn('Agent busy; holding discord message until in-flight work finishes', {
          channelId: message.channelId,
          messageId: message.id,
          attempt,
        });
        await agentLoop.waitForIdle();
      }
    }
  };

  // Messages that arrive while a turn is in flight queue here and are
  // bundled — same channel, same author, contiguous — into a single turn, so
  // a burst of operator messages gets one reply that has seen all of them.
  const discordPromptQueue: QueuedDiscordMessage[] = [];
  let discordPumpActive = false;

  const takeNextDiscordBundle = (): QueuedDiscordMessage[] => {
    const first = discordPromptQueue.shift();
    if (!first) return [];
    const bundle = [first];
    if (first.retryDelivery) return bundle;
    let index = 0;
    while (index < discordPromptQueue.length) {
      const entry = discordPromptQueue[index];
      if (entry.retryDelivery) break;
      if (entry.message.channelId === first.message.channelId) {
        if (entry.message.authorId !== first.message.authorId) break;
        bundle.push(entry);
        discordPromptQueue.splice(index, 1);
        continue;
      }
      index += 1;
    }
    return bundle;
  };

  const bundleDiscordMessages = (entries: readonly QueuedDiscordMessage[]): SubstrateMessage => {
    if (entries.length === 1) return entries[0].message;
    const messages = entries.map((entry) => entry.message);
    const newest = messages[messages.length - 1];
    return {
      ...newest,
      content: messages
        .map((entry) => entry.content)
        .filter((content) => content.trim().length > 0)
        .join('\n'),
      attachments: messages.flatMap((entry) => entry.attachments ?? []),
    };
  };

  const pumpDiscordQueue = async (): Promise<void> => {
    if (discordPumpActive) return;
    discordPumpActive = true;
    try {
      while (discordPromptQueue.length > 0) {
        const entries = takeNextDiscordBundle();
        if (entries.length === 0) break;
        const message = bundleDiscordMessages(entries);
        if (entries.length > 1) {
          const messageIds = entries.map((entry) => entry.message.id);
          log.info('Bundling discord messages that arrived during an in-flight turn', {
            channelId: message.channelId,
            messageIds,
          });
          safeguardAuditTrail.append('discord.message.bundled', {
            channelId: message.channelId,
            messageIds,
            count: entries.length,
          });
        }
        let completed = false;
        let failureStage: DiscordFailureStage = 'handle_message';
        let checkpoint = entries[0].retryDelivery;
        const dedupeKeys = checkpoint?.dedupeKeys
          ?? entries.flatMap((entry) => entry.dedupeKey ? [entry.dedupeKey] : []);
        try {
          if (!checkpoint) {
            const response = await promptWhenIdle(message);
            checkpoint = createDiscordDeliveryCheckpoint(response, dedupeKeys);
          }
          await deliverDiscordReply(message.channelId, checkpoint, {
            sendText: (channelId, content) => gateway.discordSend(channelId, content),
            sendMedia: (channelId, attachment) => gateway.discordSendMedia(channelId, attachment),
            onTextDelivered: (content) => {
              // A deferred-tool-handoff continuation can now suppress a replay
              // of the primary text even when later media delivery fails.
              outboundReplyGuard?.noteDelivered({
                channelId: message.channelId,
                content,
                sourceTurnId: message.id,
                senderKind: 'discord_inbound_reply',
              });
            },
          });
          completed = true;
        } catch (err) {
          if (err instanceof DiscordReplyDeliveryError) {
            failureStage = err.stage;
          }
          const errorText = toErrorMessage(err);
          log.error('Error handling message', {
            channelId: message.channelId,
            messageId: message.id,
            error: errorText,
            stage: failureStage,
          });
          safeguardAuditTrail.append('discord.message.error', {
            channelId: message.channelId,
            messageId: message.id,
            error: errorText,
            stage: failureStage,
          });
          if (checkpoint) {
            failedDiscordDeliveries.recordFailure(checkpoint, Date.now());
          }
          const failureNotice = failureStage === 'handle_message'
            ? DISCORD_TURN_FAILURE_NOTICE
            : DISCORD_DELIVERY_FAILURE_NOTICE;
          try {
            await gateway.discordSend(message.channelId, failureNotice);
            safeguardAuditTrail.append('discord.message.failure_notice', {
              channelId: message.channelId,
              messageId: message.id,
              stage: failureStage,
              delivered: true,
            });
          } catch (noticeError) {
            const noticeErrorText = toErrorMessage(noticeError);
            log.error('Failed to deliver system-derived discord failure notice', {
              channelId: message.channelId,
              messageId: message.id,
              error: noticeErrorText,
            });
            safeguardAuditTrail.append('discord.message.failure_notice', {
              channelId: message.channelId,
              messageId: message.id,
              stage: failureStage,
              delivered: false,
              error: noticeErrorText,
            });
          }
        } finally {
          const finishedAt = Date.now();
          for (const key of dedupeKeys) {
            inFlightDiscordMessages.delete(key);
            if (completed) {
              failedDiscordDeliveries.delete(key);
              recentDiscordMessages.set(key, finishedAt);
            }
          }
        }
      }
    } finally {
      discordPumpActive = false;
    }
  };

  gateway.onHandleMessage(async (message: SubstrateMessage) => {
    const dedupeKey = buildMessageDedupKey('handle', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    if (dedupeKey) {
      const cached = recentHandleResponses.get(dedupeKey);
      if (cached && now - cached.completedAt < DUPLICATE_MESSAGE_WINDOW_MS) {
        log.warn('Dropping duplicate gateway handle message; reusing cached response', {
          channelId: message.channelId,
          messageId: message.id,
          dedupeWindowMs: DUPLICATE_MESSAGE_WINDOW_MS,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'handle',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'cached',
        });
        return cached.response;
      }
      const inFlight = inFlightHandleMessages.get(dedupeKey);
      if (inFlight) {
        log.warn('Dropping duplicate gateway handle message; awaiting in-flight response', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'handle',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'in_flight',
        });
        return inFlight;
      }
    }

    const processMessage = async (): Promise<AgentResponse> => {
      trackSessionActivity(message);
      log.info(`Voice message from ${message.authorName}: ${message.content.slice(0, 50)}...`);
      const routingDecision = satelliteRouting.evaluateDelegation(
        message,
        config,
        resolveCompanionIdFromConfig(config),
      );
      if (routingDecision?.isSatellite) {
        safeguardAuditTrail.append('satellite.routing.decision', {
          channelId: message.channelId,
          messageId: message.id,
          delegated: routingDecision.delegate,
          reason: routingDecision.reason,
          connectionId: routingDecision.routing?.connectionId,
          sessionId: routingDecision.routing?.sessionId,
          turnId: routingDecision.routing?.turnId,
          siteId: routingDecision.routing?.siteId,
          satelliteId: routingDecision.routing?.satelliteId,
        });
      }

      if (routingDecision?.delegate) {
        try {
          const delegated = await shardManager.delegateSatelliteSession({
            message,
            routing: routingDecision.routing,
          });
          safeguardAuditTrail.append('satellite.routing.delegated', {
            channelId: message.channelId,
            messageId: message.id,
            shardId: delegated.shardId,
            connectionId: routingDecision.routing?.connectionId,
            sessionId: routingDecision.routing?.sessionId,
            turnId: routingDecision.routing?.turnId,
            siteId: routingDecision.routing?.siteId,
            satelliteId: routingDecision.routing?.satelliteId,
          });
          return {
            content: delegated.content,
            channelId: message.channelId,
            metadata: {
              model: delegated.model,
              inputTokens: delegated.inputTokens,
              outputTokens: delegated.outputTokens,
              durationMs: delegated.durationMs,
            },
          };
        } catch (error) {
          const delegationError = toErrorMessage(error);
          safeguardAuditTrail.append('satellite.routing.fallback', {
            channelId: message.channelId,
            messageId: message.id,
            reason: 'delegation_error',
            error: delegationError,
            connectionId: routingDecision.routing?.connectionId,
            sessionId: routingDecision.routing?.sessionId,
            turnId: routingDecision.routing?.turnId,
          });
          log.warn('Satellite delegation failed; falling back to primary path', {
            channelId: message.channelId,
            error: delegationError,
          });
        }
      }

      if (routingDecision?.isSatellite) {
        safeguardAuditTrail.append('satellite.routing.primary', {
          channelId: message.channelId,
          messageId: message.id,
          reason: routingDecision.reason,
          connectionId: routingDecision.routing?.connectionId,
          sessionId: routingDecision.routing?.sessionId,
          turnId: routingDecision.routing?.turnId,
          siteId: routingDecision.routing?.siteId,
          satelliteId: routingDecision.routing?.satelliteId,
        });
      }

      return agentLoop.handleMessage(message);
    };

    const execution = processMessage();
    if (dedupeKey) {
      inFlightHandleMessages.set(dedupeKey, execution);
    }

    try {
      const response = await execution;
      if (dedupeKey) {
        recentHandleResponses.set(dedupeKey, {
          completedAt: Date.now(),
          response,
        });
      }
      return response;
    } finally {
      if (dedupeKey) {
        inFlightHandleMessages.delete(dedupeKey);
      }
    }
  });

  gateway.onDiscordMessage(async (message: SubstrateMessage) => {
    const dedupeKey = buildMessageDedupKey('discord', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    const retryDelivery = dedupeKey ? failedDiscordDeliveries.find(dedupeKey) : undefined;
    if (dedupeKey) {
      const seenAt = recentDiscordMessages.get(dedupeKey);
      if (seenAt && now - seenAt < DUPLICATE_MESSAGE_WINDOW_MS) {
        log.warn('Dropping duplicate discord notification message', {
          channelId: message.channelId,
          messageId: message.id,
          dedupeWindowMs: DUPLICATE_MESSAGE_WINDOW_MS,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'discord',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'cached',
        });
        return;
      }
      const deliveryKeys = retryDelivery?.dedupeKeys ?? [dedupeKey];
      if (deliveryKeys.some((key) => inFlightDiscordMessages.has(key))) {
        log.warn('Dropping duplicate discord notification message while first copy is in-flight', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'discord',
          channelId: message.channelId,
          messageId: message.id,
          disposition: 'in_flight',
        });
        return;
      }
      for (const key of deliveryKeys) {
        inFlightDiscordMessages.add(key);
      }
    }

    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    const attachments = message.attachments ?? [];
    const isObservationOnly = message.routing?.responseMode === 'observe';
    log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
      channelId: message.channelId,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.contentType),
      attachmentNames: attachments.map((attachment) => attachment.name),
      responseMode: message.routing?.responseMode ?? 'respond',
    });

    if (isObservationOnly) {
      let completed = false;
      try {
        trackSessionActivity(message);
        await agentLoop.observeMessage(message);
        safeguardAuditTrail.append('discord.message.observed', {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.authorId,
        });
        if (observedGroupMemoryScheduler) {
          try {
            const decision = await observedGroupMemoryScheduler.observeMessage(message);
            if (decision.status === 'scheduled') {
              safeguardAuditTrail.append('memory.group_observed.scheduled', {
                channelId: decision.channelId,
                messageId: message.id,
                triggerReason: decision.triggerReason,
                spanStartMessageId: decision.spanStartMessageId,
                spanEndMessageId: decision.spanEndMessageId,
                newEntryCount: decision.newEntryCount,
                watermarkLagMessageIds: decision.watermarkLagMessageIds,
                hasDeferredBacklog: decision.hasDeferredBacklog,
              });
            } else if (decision.reason === 'extraction_failed') {
              log.warn('Observed group memory extraction failed', {
                channelId: decision.channelId,
                messageId: message.id,
                watermarkLagMessageIds: decision.watermarkLagMessageIds,
                error: decision.error,
              });
              safeguardAuditTrail.append('memory.group_observed.error', {
                channelId: decision.channelId,
                messageId: message.id,
                reason: decision.reason,
                error: decision.error,
              });
            }
          } catch (schedulerError) {
            const errorText = toErrorMessage(schedulerError);
            log.warn('Observed group memory scheduling failed', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
            safeguardAuditTrail.append('memory.group_observed.error', {
              channelId: message.channelId,
              messageId: message.id,
              error: errorText,
            });
          }
        }
        completed = true;
      } catch (err) {
        const errorText = toErrorMessage(err);
        log.error('Error handling message', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
        safeguardAuditTrail.append('discord.message.error', {
          channelId: message.channelId,
          messageId: message.id,
          error: errorText,
        });
      } finally {
        if (dedupeKey) {
          inFlightDiscordMessages.delete(dedupeKey);
          if (completed) {
            recentDiscordMessages.set(dedupeKey, Date.now());
          }
        }
      }
      return;
    }

    trackSessionActivity(message);
    discordPromptQueue.push({ message, dedupeKey, ...(retryDelivery ? { retryDelivery } : {}) });
    // The pump owns reply delivery, error reporting, and dedupe bookkeeping
    // for everything queued. Notification receipt must not await backend turn
    // work such as memory retrieval or model generation.
    void pumpDiscordQueue().catch((err: unknown) => {
      log.error('Discord message pump failed', {
        channelId: message.channelId,
        messageId: message.id,
        error: toErrorMessage(err),
      });
    });
  });

  // ── Inter-companion channel lane (sprint 10, W6) ──
  // Inbound peer messages run the NORMAL turn pipeline (fatigue, trust,
  // extraction) via agentLoop.handleMessage; the reply — when there is one —
  // goes back through the gateway's companion lane addressed to the same
  // channel, so the peer receives it as its own ordinary inbound turn. A
  // fatigue-suppressed turn returns empty content, which sends nothing: that
  // is exactly how a bot↔bot exchange terminates. No side-channel dispatch.
  const companionPromptQueue: SubstrateMessage[] = [];
  let companionPumpActive = false;

  const pumpCompanionQueue = async (): Promise<void> => {
    if (companionPumpActive) return;
    companionPumpActive = true;
    try {
      while (companionPromptQueue.length > 0) {
        const message = companionPromptQueue.shift()!;
        const dedupeKey = buildMessageDedupKey('companion', message);
        let completed = false;
        let failureReason: CompanionDeliveryFailureReason = 'processing_failed';
        try {
          const response = await promptWhenIdle(message);
          if (response.attachments?.length) {
            // The companion lane carries text only for now; surface the drop
            // loudly instead of silently losing media.
            log.warn('Companion lane reply attachments are not deliverable; dropping media', {
              channelId: message.channelId,
              attachmentCount: response.attachments.length,
            });
          }
          if (response.content.trim()) {
            failureReason = 'reply_delivery_failed';
            await gateway.companionSend(message.channelId, response.content, companionAuthorName);
          }
          completed = true;
        } catch (err) {
          const errorText = toErrorMessage(err);
          log.error('Error handling companion message', {
            channelId: message.channelId,
            messageId: message.id,
            error: errorText,
          });
          safeguardAuditTrail.append('companion.message.error', {
            channelId: message.channelId,
            messageId: message.id,
            error: errorText,
            reason: failureReason,
          });
          try {
            await gateway.companionReportFailure({
              channelId: message.channelId,
              messageId: message.id,
              reason: failureReason,
            });
            safeguardAuditTrail.append('companion.message.failure_reported', {
              channelId: message.channelId,
              messageId: message.id,
              reason: failureReason,
            });
          } catch (reportError) {
            const reportErrorText = toErrorMessage(reportError);
            log.error('Failed to report companion message delivery failure', {
              channelId: message.channelId,
              messageId: message.id,
              error: reportErrorText,
            });
            safeguardAuditTrail.append('companion.message.failure_report_error', {
              channelId: message.channelId,
              messageId: message.id,
              reason: failureReason,
              error: reportErrorText,
            });
          }
        } finally {
          if (dedupeKey) {
            inFlightCompanionMessages.delete(dedupeKey);
            if (completed) {
              recentCompanionMessages.set(dedupeKey, Date.now());
            }
          }
        }
      }
    } finally {
      companionPumpActive = false;
    }
  };

  gateway.onCompanionMessage((message: SubstrateMessage) => {
    const dedupeKey = buildMessageDedupKey('companion', message);
    const now = Date.now();
    pruneDuplicateCaches(now);
    if (dedupeKey) {
      const seenAt = recentCompanionMessages.get(dedupeKey);
      if ((seenAt && now - seenAt < DUPLICATE_MESSAGE_WINDOW_MS) || inFlightCompanionMessages.has(dedupeKey)) {
        log.warn('Dropping duplicate companion notification message', {
          channelId: message.channelId,
          messageId: message.id,
        });
        safeguardAuditTrail.append('gateway.message.duplicate', {
          route: 'companion',
          channelId: message.channelId,
          messageId: message.id,
          disposition: inFlightCompanionMessages.has(dedupeKey) ? 'in_flight' : 'cached',
        });
        return;
      }
      inFlightCompanionMessages.add(dedupeKey);
    }

    // Deserialize Date if it came as string (gateway serializes for transport).
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    log.info(`Companion message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
      channelId: message.channelId,
      authorId: message.authorId,
    });
    safeguardAuditTrail.append('companion.message.received', {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.authorId,
    });

    trackSessionActivity(message);
    companionPromptQueue.push(message);
    void pumpCompanionQueue().catch((err: unknown) => {
      log.error('Companion message pump failed', {
        channelId: message.channelId,
        messageId: message.id,
        error: toErrorMessage(err),
      });
    });
  });

  gateway.onCompanionDeliveryFailure(async (notification) => {
    log.warn('Peer companion could not process or answer a delivered message', notification);
    safeguardAuditTrail.append('companion.message.delivery_failed', notification);
    const observation: SubstrateMessage = {
      id: `companion-delivery-failure:${notification.messageId}:${notification.reportingCompanionId}`,
      channelId: notification.channelId,
      channelType: 'companion',
      authorId: 'system:companion-delivery',
      authorName: 'Companion Delivery',
      content: `Message ${notification.messageId} could not be completed by companion `
        + `${notification.reportingCompanionId} (${notification.reason}).`,
      timestamp: new Date(notification.reportedAt),
      routing: {
        source: 'companion',
        responseMode: 'observe',
      },
    };
    try {
      trackSessionActivity(observation);
      await agentLoop.observeMessage(observation);
    } catch (err) {
      const errorText = toErrorMessage(err);
      log.error('Failed to record companion delivery failure observation', {
        channelId: notification.channelId,
        messageId: notification.messageId,
        error: errorText,
      });
      safeguardAuditTrail.append('companion.message.delivery_failure_observation_error', {
        channelId: notification.channelId,
        messageId: notification.messageId,
        error: errorText,
      });
    }
  });
}
