import type { AgentResponse, Attachment, SubstrateMessage } from '../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../system/config/runtime-config-contracts.js';
import type { ShardExecutionPort } from '../shards/port.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import { evaluateWyomingDelegation } from './wyoming-routing.js';

const DUPLICATE_MESSAGE_WINDOW_MS = 2 * 60_000;

interface RecentHandleMessageResult {
  completedAt: number;
  response: AgentResponse;
}

function buildMessageDedupKey(route: 'handle' | 'discord', message: SubstrateMessage): string | null {
  const messageId = message.id.trim();
  if (!messageId) return null;
  return `${route}:${message.channelId}:${messageId}`;
}

export interface GatewayMessageGateway {
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void;
  onDiscordMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  discordSend(channelId: string, content: string): Promise<void>;
  discordSendMedia(channelId: string, media: Attachment): Promise<void>;
}

export interface GatewayMessageAgentLoop {
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
}

export type GatewayMessageShardManager = Pick<ShardExecutionPort, 'delegateWyomingSession'>;

export interface GatewayMessageAuditTrail {
  append(event: string, details?: Record<string, unknown>): unknown;
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
  config: SubstrateConfig;
  log: GatewayMessageLogger;
  trackSessionActivity: (message: SubstrateMessage) => void;
}

export function registerGatewayMessageHandlers(deps: GatewayMessageHandlersDeps): void {
  const {
    gateway,
    agentLoop,
    shardManager,
    safeguardAuditTrail,
    config,
    log,
    trackSessionActivity,
  } = deps;

  const inFlightHandleMessages = new Map<string, Promise<AgentResponse>>();
  const recentHandleResponses = new Map<string, RecentHandleMessageResult>();
  const inFlightDiscordMessages = new Set<string>();
  const recentDiscordMessages = new Map<string, number>();

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
      const routingDecision = evaluateWyomingDelegation(message, config);
      if (routingDecision.isWyoming) {
        safeguardAuditTrail.append('wyoming.routing.decision', {
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

      if (routingDecision.delegate) {
        try {
          const delegated = await shardManager.delegateWyomingSession({
            message,
            routing: routingDecision.routing,
          });
          safeguardAuditTrail.append('wyoming.routing.delegated', {
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
          safeguardAuditTrail.append('wyoming.routing.fallback', {
            channelId: message.channelId,
            messageId: message.id,
            reason: 'delegation_error',
            error: delegationError,
            connectionId: routingDecision.routing?.connectionId,
            sessionId: routingDecision.routing?.sessionId,
            turnId: routingDecision.routing?.turnId,
          });
          log.warn('Wyoming delegation failed; falling back to primary path', {
            channelId: message.channelId,
            error: delegationError,
          });
        }
      }

      if (routingDecision.isWyoming) {
        safeguardAuditTrail.append('wyoming.routing.primary', {
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
      if (inFlightDiscordMessages.has(dedupeKey)) {
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
      inFlightDiscordMessages.add(dedupeKey);
    }

    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    try {
      trackSessionActivity(message);
      const attachments = message.attachments ?? [];
      log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
        channelId: message.channelId,
        attachmentCount: attachments.length,
        attachmentTypes: attachments.map((attachment) => attachment.contentType),
        attachmentNames: attachments.map((attachment) => attachment.name),
      });

      const response = await agentLoop.handleMessage(message);
      if (response.content.trim()) {
        await gateway.discordSend(message.channelId, response.content);
      }
      for (const attachment of response.attachments ?? []) {
        await gateway.discordSendMedia(message.channelId, attachment);
      }
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
        recentDiscordMessages.set(dedupeKey, Date.now());
      }
    }
  });
}
