import type {
  AgentResponse,
  SubstrateConfig,
  SubstrateMessage,
  WyomingRoutingMetadata,
} from '../types.js';
import { toErrorMessage } from '../utils/errors.js';
import { evaluateWyomingDelegation } from './wyoming-routing.js';

export interface GatewayMessageGateway {
  onHandleMessage(handler: (message: SubstrateMessage) => Promise<AgentResponse>): void;
  onDiscordMessage(handler: (message: SubstrateMessage) => void | Promise<void>): void;
  discordSend(channelId: string, content: string): Promise<void>;
}

export interface GatewayMessageAgentLoop {
  handleMessage(message: SubstrateMessage): Promise<AgentResponse>;
}

export interface WyomingShardDelegationResult {
  shardId: string;
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface GatewayMessageShardManager {
  delegateWyomingSession(request: {
    message: SubstrateMessage;
    routing?: WyomingRoutingMetadata;
  }): Promise<WyomingShardDelegationResult>;
}

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

  gateway.onHandleMessage(async (message: SubstrateMessage) => {
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
  });

  gateway.onDiscordMessage(async (message: SubstrateMessage) => {
    // Deserialize Date if it came as string
    if (typeof message.timestamp === 'string') {
      message.timestamp = new Date(message.timestamp);
    }

    trackSessionActivity(message);
    const attachments = message.attachments ?? [];
    log.info(`Message from ${message.authorName}: ${message.content.slice(0, 50)}...`, {
      channelId: message.channelId,
      attachmentCount: attachments.length,
      attachmentTypes: attachments.map((attachment) => attachment.contentType),
      attachmentNames: attachments.map((attachment) => attachment.name),
    });

    try {
      const response = await agentLoop.handleMessage(message);
      await gateway.discordSend(message.channelId, response.content);
    } catch (err) {
      log.error('Error handling message', { error: String(err) });
      try {
        await gateway.discordSend(message.channelId, 'Something went wrong. Please try again.');
      } catch {
        // ignore send errors
      }
    }
  });
}
