import type { EventMap } from '../../../../event-bus.js';
import type {
  AdminChatDebugCategory,
  AdminChatDebugDetailValue,
  AdminChatDebugEventPayload,
} from '../../types.js';
import { truncateDebugText } from '../../utils.js';
import { MAX_DEBUG_MESSAGE_CHARS, type ChatDebugEventName } from './constants.js';
import {
  compactDebugDetails,
  extractDebugExtras,
  formatRejectionBreakdown,
} from './debug-details.js';

export interface ChatDebugEventOptions {
  channelId?: string;
  details?: Record<string, AdminChatDebugDetailValue>;
}

export type ChatDebugEventFactory = (
  eventName: ChatDebugEventName,
  category: AdminChatDebugCategory,
  message: string,
  options?: ChatDebugEventOptions,
) => AdminChatDebugEventPayload;

export function toChatDebugPayload(
  eventName: ChatDebugEventName,
  data: EventMap[ChatDebugEventName],
  buildChatDebugEvent: ChatDebugEventFactory,
): AdminChatDebugEventPayload {
  switch (eventName) {
    case 'agent.turn.start': {
      const event = data as EventMap['agent.turn.start'];
      return buildChatDebugEvent(eventName, 'text', 'Turn started', {
        channelId: event.message.channelId,
        details: compactDebugDetails({
          messageId: event.message.id,
          authorId: event.message.authorId,
          authorName: event.message.authorName,
          contentPreview: truncateDebugText(event.message.content, 120),
        }),
      });
    }
    case 'agent.turn.stage': {
      const event = data as EventMap['agent.turn.stage'];
      const extras = extractDebugExtras(event as Record<string, unknown>, [
        'turnId',
        'channelId',
        'stage',
        'elapsedMs',
      ]);
      return buildChatDebugEvent(eventName, 'text', `Turn stage: ${event.stage}`, {
        channelId: event.channelId,
        details: compactDebugDetails({
          turnId: event.turnId,
          elapsedMs: event.elapsedMs,
          ...(extras ?? {}),
        }),
      });
    }
    case 'agent.turn.end': {
      const event = data as EventMap['agent.turn.end'];
      return buildChatDebugEvent(eventName, 'text', 'Turn completed', {
        channelId: event.message.channelId,
        details: compactDebugDetails({
          model: event.response.metadata.model,
          durationMs: event.response.metadata.durationMs,
          inputTokens: event.response.metadata.inputTokens,
          outputTokens: event.response.metadata.outputTokens,
          responsePreview: truncateDebugText(event.response.content, 120),
        }),
      });
    }
    case 'agent.stream.thinking': {
      const event = data as EventMap['agent.stream.thinking'];
      return buildChatDebugEvent(
        eventName,
        'thinking',
        truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[thinking chunk]',
        {
          channelId: event.channelId,
          details: compactDebugDetails({ chars: event.text.length }),
        },
      );
    }
    case 'agent.stream.delta': {
      const event = data as EventMap['agent.stream.delta'];
      return buildChatDebugEvent(
        eventName,
        'text',
        truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[text chunk]',
        {
          channelId: event.channelId,
          details: compactDebugDetails({ chars: event.text.length }),
        },
      );
    }
    case 'agent.tool.start': {
      const event = data as EventMap['agent.tool.start'];
      return buildChatDebugEvent(eventName, 'tools', `Tool start: ${event.toolName}`, {
        channelId: event.channelId,
        details: compactDebugDetails({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          shardId: event.shardId,
        }),
      });
    }
    case 'agent.tool.end': {
      const event = data as EventMap['agent.tool.end'];
      return buildChatDebugEvent(eventName, 'tools', `Tool end: ${event.toolName}`, {
        channelId: event.channelId,
        details: compactDebugDetails({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          isError: event.isError,
          shardId: event.shardId,
        }),
      });
    }
    case 'memory.extraction.start': {
      const event = data as EventMap['memory.extraction.start'];
      return buildChatDebugEvent(eventName, 'memory', 'Memory extraction started', {
        channelId: event.channelId,
        details: compactDebugDetails({
          triggerReason: event.triggerReason,
        }),
      });
    }
    case 'memory.extraction.end': {
      const event = data as EventMap['memory.extraction.end'];
      return buildChatDebugEvent(eventName, 'memory', 'Memory extraction completed', {
        channelId: event.channelId,
        details: compactDebugDetails({
          count: event.count,
          parsedCount: event.parsedCount,
          acceptedCount: event.acceptedCount,
          rejectedCount: event.rejectedCount,
          writeCount: event.writeCount,
          rejectionBreakdown: formatRejectionBreakdown(event.rejectionBreakdown),
        }),
      });
    }
    case 'memory.retrieval': {
      const event = data as EventMap['memory.retrieval'];
      return buildChatDebugEvent(eventName, 'memory', 'Memory retrieval', {
        channelId: event.channelId,
        details: compactDebugDetails({
          count: event.count,
          candidates: event.candidates,
          ranked: event.ranked,
          returned: event.returned,
          reason: event.reason,
        }),
      });
    }
    case 'model.budget.blocked': {
      const event = data as EventMap['model.budget.blocked'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Model budget blocked: ${event.provider}/${event.model}`,
        {
          channelId: event.channelId,
          details: compactDebugDetails({
            reason: event.reason,
            purpose: event.purpose,
            service: event.service,
            process: event.process,
            estimatedRequestCostUsd: event.estimatedRequestCostUsd.toFixed(6),
            dailySpentUsd: event.budget.dailySpentUsd.toFixed(6),
            dailyLimitUsd: event.budget.dailyLimitUsd.toFixed(6),
            monthlySpentUsd: event.budget.monthlySpentUsd.toFixed(6),
            monthlyLimitUsd: event.budget.monthlyLimitUsd.toFixed(6),
          }),
        },
      );
    }
    case 'agent.error': {
      const event = data as EventMap['agent.error'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Agent error: ${truncateDebugText(event.error.message, 120)}`,
        {
          channelId: event.message.channelId,
          details: compactDebugDetails({
            messageId: event.message.id,
            authorId: event.message.authorId,
            contentPreview: truncateDebugText(event.message.content, 120),
          }),
        },
      );
    }
    case 'channel.voice.error': {
      const event = data as EventMap['channel.voice.error'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Voice channel error: ${truncateDebugText(event.error, 120)}`,
        {
          channelId: event.channelId,
          details: compactDebugDetails({
            guildId: event.guildId,
            userId: event.userId,
          }),
        },
      );
    }
    case 'voice.turn.error': {
      const event = data as EventMap['voice.turn.error'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Voice turn error: ${truncateDebugText(event.error, 120)}`,
        {
          channelId: event.channelId,
          details: compactDebugDetails({
            turnId: event.turnId,
            userId: event.userId,
            stage: event.stage,
            code: event.code,
          }),
        },
      );
    }
    case 'wyoming.session.start': {
      const event = data as EventMap['wyoming.session.start'];
      return buildChatDebugEvent(
        eventName,
        'text',
        `Wyoming session started: ${event.sessionId}`,
        {
          details: compactDebugDetails({
            connectionId: event.connectionId,
            sessionId: event.sessionId,
            activeSessions: event.activeSessions,
            maxSessions: event.maxSessions,
          }),
        },
      );
    }
    case 'wyoming.session.end': {
      const event = data as EventMap['wyoming.session.end'];
      const category = event.reason.includes('policy')
        || event.reason.includes('error')
        || event.reason.includes('timeout')
        ? 'errors'
        : 'text';
      return buildChatDebugEvent(
        eventName,
        category,
        `Wyoming session ended: ${event.sessionId}`,
        {
          details: compactDebugDetails({
            connectionId: event.connectionId,
            reason: event.reason,
            durationMs: event.durationMs,
            activeSessions: event.activeSessions,
          }),
        },
      );
    }
    case 'wyoming.connection.error': {
      const event = data as EventMap['wyoming.connection.error'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Wyoming connection error: ${truncateDebugText(event.error, 120)}`,
        {
          details: compactDebugDetails({
            connectionId: event.connectionId,
            code: event.code,
          }),
        },
      );
    }
    case 'wyoming.policy.violation': {
      const event = data as EventMap['wyoming.policy.violation'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `Wyoming policy violation: ${event.code}`,
        {
          details: compactDebugDetails({
            connectionId: event.connectionId,
            code: event.code,
            scope: event.scope,
            sessionId: event.sessionId,
            eventType: event.eventType,
            limit: event.limit,
            observed: event.observed,
            action: event.action,
          }),
        },
      );
    }
    case 'wyoming.audit.summary': {
      const event = data as EventMap['wyoming.audit.summary'];
      return buildChatDebugEvent(
        eventName,
        event.decision === 'ALLOW' ? 'text' : 'errors',
        `Wyoming audit summary: ${event.method}`,
        {
          details: compactDebugDetails({
            method: event.method,
            decision: event.decision,
            error: event.error,
          }),
        },
      );
    }
    case 'system.error': {
      const event = data as EventMap['system.error'];
      return buildChatDebugEvent(
        eventName,
        'errors',
        `System error: ${truncateDebugText(event.error.message, 120)}`,
        {
          details: compactDebugDetails({
            context: event.context,
          }),
        },
      );
    }
    default: {
      return buildChatDebugEvent(eventName, 'text', eventName);
    }
  }
}
