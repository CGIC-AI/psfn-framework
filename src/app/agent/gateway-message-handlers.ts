import type { AgentResponse, Attachment, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ShardExecutionPort } from '../../faculties/shards/port.js';
import type { SatelliteRoutingPort } from '../../core/agent/satellite-adapter-port.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { resolveCompanionIdFromConfig } from '../../core/identity/companion-runtime.js';

const DUPLICATE_MESSAGE_WINDOW_MS = 2 * 60_000;
const AGENT_BUSY_PATTERN = /already processing a prompt/i;
const MAX_AGENT_BUSY_RETRIES = 3;

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
  observeMessage(message: SubstrateMessage): Promise<void>;
  /** Resolves when the agent has finished all in-flight work (prompt + steering + follow-ups). */
  waitForIdle(): Promise<void>;
}

export type GatewayMessageShardManager = Pick<ShardExecutionPort, 'delegateSatelliteSession'>;

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
  satelliteRouting: SatelliteRoutingPort;
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
    satelliteRouting,
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

  // A conversational message that lands while a turn is in flight must not be
  // dropped: hold it until the agent goes idle and deliver it as its own turn.
  // Bounded so a pathological prompt storm still surfaces as an error instead
  // of waiting forever.
  const handleMessageWhenIdle = async (message: SubstrateMessage): Promise<AgentResponse> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await agentLoop.handleMessage(message);
      } catch (err) {
        const busy = err instanceof Error && AGENT_BUSY_PATTERN.test(err.message);
        if (!busy || attempt >= MAX_AGENT_BUSY_RETRIES) throw err;
        log.info('Agent busy; holding message until the in-flight turn finishes', {
          channelId: message.channelId,
          messageId: message.id,
          attempt: attempt + 1,
        });
        await agentLoop.waitForIdle();
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
      const isObservationOnly = message.routing?.responseMode === 'observe';
      log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
        channelId: message.channelId,
        attachmentCount: attachments.length,
        attachmentTypes: attachments.map((attachment) => attachment.contentType),
        attachmentNames: attachments.map((attachment) => attachment.name),
        responseMode: message.routing?.responseMode ?? 'respond',
      });

      if (isObservationOnly) {
        await agentLoop.observeMessage(message);
        safeguardAuditTrail.append('discord.message.observed', {
          channelId: message.channelId,
          messageId: message.id,
          authorId: message.authorId,
        });
        return;
      }

      const response = await handleMessageWhenIdle(message);
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
