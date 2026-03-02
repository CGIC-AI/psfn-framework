import type { ServerResponse } from 'node:http';
import type { ContactStore } from '../../../contacts/store.js';
import type { SessionStore } from '../../../session/store.js';
import type { EventBus, EventMap } from '../../../event-bus.js';
import type { ChannelPrivacyLevel } from '../../../contacts/types.js';
import type { SubstrateConfig } from '../../../types.js';
import { restoreLastActiveSession } from '../../../lifecycle/notifications.js';
import { loadSettings } from '../../../settings.js';
import { parseJsonBody } from '../../http/primitives.js';
import {
  AdminChatBootstrapService,
  type AdminChatBootstrapResponse,
  type AdminChatBootstrapUpdateInput,
  type AdminModelRoomBootstrapResponse,
} from '../chat/index.js';
import type {
  AdminChatDebugCategory,
  AdminChatDebugDetailValue,
  AdminChatDebugEventPayload,
  AdminChatDebugStreamOptions,
} from '../types.js';
import * as tpl from '../templates.js';
import { toDebugDetailValue, truncateDebugText } from '../utils.js';

type ChatDebugEventName =
  | 'agent.turn.start'
  | 'agent.turn.stage'
  | 'agent.turn.end'
  | 'agent.stream.thinking'
  | 'agent.stream.delta'
  | 'agent.tool.start'
  | 'agent.tool.end'
  | 'memory.extraction.start'
  | 'memory.extraction.end'
  | 'memory.retrieval'
  | 'agent.error'
  | 'channel.voice.error'
  | 'voice.turn.error'
  | 'wyoming.session.start'
  | 'wyoming.session.end'
  | 'wyoming.connection.error'
  | 'wyoming.policy.violation'
  | 'wyoming.audit.summary'
  | 'system.error';

const CHAT_DEBUG_EVENTS: ChatDebugEventName[] = [
  'agent.turn.start',
  'agent.turn.stage',
  'agent.turn.end',
  'agent.stream.thinking',
  'agent.stream.delta',
  'agent.tool.start',
  'agent.tool.end',
  'memory.extraction.start',
  'memory.extraction.end',
  'memory.retrieval',
  'agent.error',
  'channel.voice.error',
  'voice.turn.error',
  'wyoming.session.start',
  'wyoming.session.end',
  'wyoming.connection.error',
  'wyoming.policy.violation',
  'wyoming.audit.summary',
  'system.error',
];

const MAX_DEBUG_MESSAGE_CHARS = 220;
const MAX_DEBUG_DETAILS = 6;

export interface AdminChatHandlersDeps {
  config: SubstrateConfig;
  sessionStore: SessionStore;
  eventBus: EventBus;
  contactStore?: ContactStore | null;
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
}

export class AdminChatHandlers {
  private readonly config: SubstrateConfig;
  private readonly sessionStore: SessionStore;
  private readonly eventBus: EventBus;
  private readonly chatBootstrapService: AdminChatBootstrapService;
  private chatDebugCounter = 0;

  constructor(deps: AdminChatHandlersDeps) {
    this.config = deps.config;
    this.sessionStore = deps.sessionStore;
    this.eventBus = deps.eventBus;
    this.chatBootstrapService = new AdminChatBootstrapService(deps.contactStore, {
      apiBaseUrl: deps.apiBaseUrl,
      apiHost: deps.apiHost,
      apiPort: deps.apiPort,
      config: this.config,
      resolveGlobalDefaultSessionId: () => this.resolveGlobalDefaultSessionId(),
    });
  }

  chatPage(): string {
    return tpl.layout('Garden Chat', tpl.chatPage(), 'chat');
  }

  chatBootstrap(requestOrigin?: string): AdminChatBootstrapResponse {
    const settingsApiBaseUrl = this.resolveChatApiBaseUrlFromSettings();
    return this.chatBootstrapService.buildBootstrap({ requestOrigin, settingsApiBaseUrl });
  }

  chatModelRoomBootstrap(requestOrigin?: string): AdminModelRoomBootstrapResponse {
    const settingsApiBaseUrl = this.resolveChatApiBaseUrlFromSettings();
    return this.chatBootstrapService.buildModelRoomBootstrap(this.config, {
      requestOrigin,
      settingsApiBaseUrl,
    });
  }

  updateChatBootstrap(
    body: string,
    contentTypeHeader: string | string[] | undefined,
    requestOrigin?: string,
  ): AdminChatBootstrapResponse {
    const update = this.parseChatBootstrapUpdate(body, contentTypeHeader);
    const settingsApiBaseUrl = this.resolveChatApiBaseUrlFromSettings();
    return this.chatBootstrapService.updateSelection(update, { requestOrigin, settingsApiBaseUrl });
  }

  setupChatDebugSSE(
    res: ServerResponse,
    options: AdminChatDebugStreamOptions = {},
  ): () => void {
    const channelIdFilter = options.channelId?.trim() || undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(':ok\n\n');

    const unsubscribers: Array<() => void> = [];
    for (const eventName of CHAT_DEBUG_EVENTS) {
      const unsub = this.eventBus.on(eventName, (data: EventMap[typeof eventName]) => {
        if (res.writableEnded || res.destroyed) return;
        const payload = this.toChatDebugPayload(eventName, data);
        if (channelIdFilter && payload.channelId !== channelIdFilter) return;
        res.write(`event: chat-debug\ndata: ${JSON.stringify(payload)}\n\n`);
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }

  private resolveGlobalDefaultSessionId(): string | null {
    const restored = restoreLastActiveSession({
      dataDir: this.config.dataDir,
      computedLatestSession: this.sessionStore.getLatestSessionByTimestamp(),
      isSessionValid: (sessionId) => this.sessionStore.count(sessionId) > 0,
    });
    return restored?.sessionId ?? null;
  }

  private resolveChatApiBaseUrlFromSettings(): string | undefined {
    try {
      const settings = loadSettings(this.config.dataDir);
      const raw = settings.chatApiBaseUrl;
      if (typeof raw !== 'string') return undefined;
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  private parseChatBootstrapUpdate(
    body: string,
    contentTypeHeader: string | string[] | undefined,
  ): AdminChatBootstrapUpdateInput {
    const contentType = Array.isArray(contentTypeHeader)
      ? (contentTypeHeader[0] ?? '')
      : (contentTypeHeader ?? '');
    const normalizedContentType = contentType.toLowerCase();
    const trimmedBody = body.trim();
    if (!trimmedBody) return {};

    if (normalizedContentType.includes('application/json') || trimmedBody.startsWith('{')) {
      const parsed = parseJsonBody(trimmedBody);
      if (!parsed.ok) {
        throw new Error('Invalid JSON payload');
      }
      return this.parseChatBootstrapUpdateObject(parsed.value);
    }

    const params = new URLSearchParams(body);
    const privacyLevel = params.get('privacyLevel');

    return {
      canonicalContactId: params.get('canonicalContactId') ?? undefined,
      channel: params.get('channel') ?? undefined,
      userId: params.get('userId') ?? undefined,
      privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
      defaultAuthorName: params.get('defaultAuthorName') ?? undefined,
      defaultAuthorId: params.get('defaultAuthorId') ?? undefined,
    };
  }

  private parseChatBootstrapUpdateObject(parsed: unknown): AdminChatBootstrapUpdateInput {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON payload must be an object');
    }

    const payload = parsed as Record<string, unknown>;
    const privacyLevel = this.readOptionalStringField(payload, 'privacyLevel');

    return {
      canonicalContactId: this.readOptionalStringField(payload, 'canonicalContactId'),
      channel: this.readOptionalStringField(payload, 'channel'),
      userId: this.readOptionalStringField(payload, 'userId'),
      privacyLevel: privacyLevel ? privacyLevel as ChannelPrivacyLevel : undefined,
      defaultAuthorName: this.readOptionalStringField(payload, 'defaultAuthorName'),
      defaultAuthorId: this.readOptionalStringField(payload, 'defaultAuthorId'),
    };
  }

  private readOptionalStringField(payload: Record<string, unknown>, key: string): string | undefined {
    const value = payload[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new Error(`Field "${key}" must be a string`);
    }
    return value;
  }

  private toChatDebugPayload(
    eventName: ChatDebugEventName,
    data: EventMap[ChatDebugEventName],
  ): AdminChatDebugEventPayload {
    switch (eventName) {
      case 'agent.turn.start': {
        const event = data as EventMap['agent.turn.start'];
        return this.buildChatDebugEvent(eventName, 'text', 'Turn started', {
          channelId: event.message.channelId,
          details: this.compactDebugDetails({
            messageId: event.message.id,
            authorId: event.message.authorId,
            authorName: event.message.authorName,
            contentPreview: truncateDebugText(event.message.content, 120),
          }),
        });
      }
      case 'agent.turn.stage': {
        const event = data as EventMap['agent.turn.stage'];
        const extras = this.extractDebugExtras(event as Record<string, unknown>, [
          'turnId',
          'channelId',
          'stage',
          'elapsedMs',
        ]);
        return this.buildChatDebugEvent(eventName, 'text', `Turn stage: ${event.stage}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            turnId: event.turnId,
            elapsedMs: event.elapsedMs,
            ...(extras ?? {}),
          }),
        });
      }
      case 'agent.turn.end': {
        const event = data as EventMap['agent.turn.end'];
        return this.buildChatDebugEvent(eventName, 'text', 'Turn completed', {
          channelId: event.message.channelId,
          details: this.compactDebugDetails({
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
        return this.buildChatDebugEvent(
          eventName,
          'thinking',
          truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[thinking chunk]',
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({ chars: event.text.length }),
          },
        );
      }
      case 'agent.stream.delta': {
        const event = data as EventMap['agent.stream.delta'];
        return this.buildChatDebugEvent(
          eventName,
          'text',
          truncateDebugText(event.text, MAX_DEBUG_MESSAGE_CHARS) || '[text chunk]',
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({ chars: event.text.length }),
          },
        );
      }
      case 'agent.tool.start': {
        const event = data as EventMap['agent.tool.start'];
        return this.buildChatDebugEvent(eventName, 'tools', `Tool start: ${event.toolName}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            shardId: event.shardId,
          }),
        });
      }
      case 'agent.tool.end': {
        const event = data as EventMap['agent.tool.end'];
        return this.buildChatDebugEvent(eventName, 'tools', `Tool end: ${event.toolName}`, {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            isError: event.isError,
            shardId: event.shardId,
          }),
        });
      }
      case 'memory.extraction.start': {
        const event = data as EventMap['memory.extraction.start'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory extraction started', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            triggerReason: event.triggerReason,
          }),
        });
      }
      case 'memory.extraction.end': {
        const event = data as EventMap['memory.extraction.end'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory extraction completed', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            count: event.count,
            parsedCount: event.parsedCount,
            acceptedCount: event.acceptedCount,
            rejectedCount: event.rejectedCount,
            writeCount: event.writeCount,
            rejectionBreakdown: this.formatRejectionBreakdown(event.rejectionBreakdown),
          }),
        });
      }
      case 'memory.retrieval': {
        const event = data as EventMap['memory.retrieval'];
        return this.buildChatDebugEvent(eventName, 'memory', 'Memory retrieval', {
          channelId: event.channelId,
          details: this.compactDebugDetails({
            count: event.count,
            candidates: event.candidates,
            ranked: event.ranked,
            returned: event.returned,
            reason: event.reason,
          }),
        });
      }
      case 'agent.error': {
        const event = data as EventMap['agent.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Agent error: ${truncateDebugText(event.error.message, 120)}`,
          {
            channelId: event.message.channelId,
            details: this.compactDebugDetails({
              messageId: event.message.id,
              authorId: event.message.authorId,
              contentPreview: truncateDebugText(event.message.content, 120),
            }),
          },
        );
      }
      case 'channel.voice.error': {
        const event = data as EventMap['channel.voice.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Voice channel error: ${truncateDebugText(event.error, 120)}`,
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({
              guildId: event.guildId,
              userId: event.userId,
            }),
          },
        );
      }
      case 'voice.turn.error': {
        const event = data as EventMap['voice.turn.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Voice turn error: ${truncateDebugText(event.error, 120)}`,
          {
            channelId: event.channelId,
            details: this.compactDebugDetails({
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
        return this.buildChatDebugEvent(
          eventName,
          'text',
          `Wyoming session started: ${event.sessionId}`,
          {
            details: this.compactDebugDetails({
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
        return this.buildChatDebugEvent(
          eventName,
          category,
          `Wyoming session ended: ${event.sessionId}`,
          {
            details: this.compactDebugDetails({
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
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Wyoming connection error: ${truncateDebugText(event.error, 120)}`,
          {
            details: this.compactDebugDetails({
              connectionId: event.connectionId,
              code: event.code,
            }),
          },
        );
      }
      case 'wyoming.policy.violation': {
        const event = data as EventMap['wyoming.policy.violation'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `Wyoming policy violation: ${event.code}`,
          {
            details: this.compactDebugDetails({
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
        return this.buildChatDebugEvent(
          eventName,
          event.decision === 'ALLOW' ? 'text' : 'errors',
          `Wyoming audit summary: ${event.method}`,
          {
            details: this.compactDebugDetails({
              method: event.method,
              decision: event.decision,
              error: event.error,
            }),
          },
        );
      }
      case 'system.error': {
        const event = data as EventMap['system.error'];
        return this.buildChatDebugEvent(
          eventName,
          'errors',
          `System error: ${truncateDebugText(event.error.message, 120)}`,
          {
            details: this.compactDebugDetails({
              context: event.context,
            }),
          },
        );
      }
      default: {
        return this.buildChatDebugEvent(eventName, 'text', eventName);
      }
    }
  }

  private buildChatDebugEvent(
    eventName: ChatDebugEventName,
    category: AdminChatDebugCategory,
    message: string,
    options: {
      channelId?: string;
      details?: Record<string, AdminChatDebugDetailValue>;
    } = {},
  ): AdminChatDebugEventPayload {
    const payload: AdminChatDebugEventPayload = {
      id: `chat-debug-${Date.now()}-${++this.chatDebugCounter}`,
      timestamp: Date.now(),
      event: eventName,
      category,
      message: truncateDebugText(message, MAX_DEBUG_MESSAGE_CHARS) || eventName,
    };

    if (options.channelId) {
      payload.channelId = options.channelId;
    }
    if (options.details && Object.keys(options.details).length > 0) {
      payload.details = options.details;
    }
    return payload;
  }

  private compactDebugDetails(
    details: Record<string, unknown>,
  ): Record<string, AdminChatDebugDetailValue> | undefined {
    const compact: Record<string, AdminChatDebugDetailValue> = {};
    let count = 0;
    for (const [key, value] of Object.entries(details)) {
      if (value === undefined || count >= MAX_DEBUG_DETAILS) continue;
      const normalizedValue = toDebugDetailValue(value);
      if (normalizedValue === undefined) continue;
      compact[key] = normalizedValue;
      count += 1;
    }
    return count > 0 ? compact : undefined;
  }

  private extractDebugExtras(
    data: Record<string, unknown>,
    excludedKeys: string[],
  ): Record<string, AdminChatDebugDetailValue> | undefined {
    const excluded = new Set(excludedKeys);
    const extras: Record<string, AdminChatDebugDetailValue> = {};
    let count = 0;
    for (const [key, value] of Object.entries(data)) {
      if (excluded.has(key) || count >= MAX_DEBUG_DETAILS) continue;
      const normalized = toDebugDetailValue(value);
      if (normalized === undefined) continue;
      extras[key] = normalized;
      count += 1;
    }
    return count > 0 ? extras : undefined;
  }

  private formatRejectionBreakdown(breakdown?: Record<string, number>): string | undefined {
    if (!breakdown) return undefined;
    const entries = Object.entries(breakdown);
    if (entries.length === 0) return undefined;
    const summary = entries
      .slice(0, 4)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(', ');
    return truncateDebugText(summary, 160);
  }
}
