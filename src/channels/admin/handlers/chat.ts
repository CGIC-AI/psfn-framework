import type { ServerResponse } from 'node:http';
import type { ContactStore } from '../../../contacts/store.js';
import type { SessionStore } from '../../../session/store.js';
import type { EventBus, EventMap } from '../../../event-bus.js';
import type { SubstrateConfig } from '../../../types.js';
import { restoreLastActiveSession } from '../../../lifecycle/notifications.js';
import { loadSettings } from '../../../settings.js';
import {
  AdminChatBootstrapService,
  type AdminChatBootstrapResponse,
  type AdminModelRoomBootstrapResponse,
} from '../chat/index.js';
import type {
  AdminChatDebugCategory,
  AdminChatDebugDetailValue,
  AdminChatDebugEventPayload,
  AdminChatDebugStreamOptions,
} from '../types.js';
import * as tpl from '../templates.js';
import { truncateDebugText } from '../utils.js';
import { parseChatBootstrapUpdate } from './chat/bootstrap-update.js';
import {
  CHAT_DEBUG_EVENTS,
  MAX_DEBUG_MESSAGE_CHARS,
  type ChatDebugEventName,
} from './chat/constants.js';
import { toChatDebugPayload as mapChatDebugPayload } from './chat/debug-payload.js';

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
    const update = parseChatBootstrapUpdate(body, contentTypeHeader);
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

  private toChatDebugPayload(
    eventName: ChatDebugEventName,
    data: EventMap[ChatDebugEventName],
  ): AdminChatDebugEventPayload {
    return mapChatDebugPayload(eventName, data, (name, category, message, options) =>
      this.buildChatDebugEvent(name, category, message, options));
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
}
