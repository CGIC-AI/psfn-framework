import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  MediaAttachment,
  MessageHandler,
  OutboundContext,
} from '../types.js';
import type { SubstrateMessage } from '../../types.js';
import type { EventBus } from '../../event-bus.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TelegramChannelConfig } from '../config.js';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  DeferredLatestByChannel,
  emitTurnContentionTelemetry,
  type TurnContentionPolicy,
} from '../../lifecycle/turn-contention.js';

const log = createComponentLogger('Telegram');

const TELEGRAM_TEXT_LIMIT = 4_096;
const DEFAULT_TYPING_INTERVAL_MS = 4_000;
const DEFAULT_LONG_POLL_TIMEOUT_SECONDS = 20;
const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 512 * 1_024;
const THREAD_DELIMITER = '/thread/';
const MAX_CONTEXT_MAP_SIZE = 2_000;
const MAX_POLL_BACKOFF_MS = 30_000;
const LONG_RUNNING_STATUS_INITIAL_DELAY_MS = 12_000;
const LONG_RUNNING_STATUS_POLL_MS = 5_000;
const LONG_RUNNING_STATUS_UPDATE_MIN_INTERVAL_MS = 20_000;

type FetchLike = typeof fetch;
type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export interface TelegramCommand {
  command: string;
  args: string;
  raw: string;
}

export interface TelegramCommandContext {
  command: string;
  args: string;
  raw: string;
  channelId: string;
  chatId: string;
  messageId: string;
  isDirectMessage: boolean;
  authorId: string;
  authorName: string;
}

export type TelegramCommandRouter = (
  command: TelegramCommandContext,
) => Promise<string | void> | string | void;

interface TelegramAdapterOptions {
  fetchImpl?: FetchLike;
  commandRouter?: TelegramCommandRouter;
  longPollTimeoutSeconds?: number;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramChat {
  id: number | string;
  type: TelegramChatType;
}

interface TelegramPhotoSize {
  file_id: string;
  file_unique_id?: string;
}

interface TelegramVoice {
  file_id: string;
  mime_type?: string;
}

interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

interface TelegramIncomingMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  reply_to_message?: { message_id: number };
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  voice?: TelegramVoice;
  document?: TelegramDocument;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
}

interface TelegramSentMessage {
  message_id: number;
  message_thread_id?: number;
}

interface MessagePointer {
  chatId: string;
  messageId: number;
  threadId?: string;
}

interface OutboundTarget {
  chatId: string;
  threadId?: string;
  replyToMessageId?: number;
}

interface LongRunningToolState {
  channelId: string;
  toolName: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  lastStatusAt: number;
  statusSent: boolean;
  inFlight: boolean;
}

interface TelegramStatusMessageRef {
  chatId: string;
  messageId: number;
}

interface TelegramStreamResponseState {
  channelId: string;
  target: OutboundTarget;
  accumulatedText: string;
  lastAppliedText: string;
  sentMessageId?: number;
  pending: Promise<void>;
  failure: Error | null;
}

type TelegramMediaMethod = 'sendPhoto' | 'sendDocument' | 'sendVoice';
type TelegramMediaField = 'photo' | 'document' | 'voice';

export function parseTelegramCommand(content: string): TelegramCommand | null {
  const normalized = content.trim();
  if (!normalized.startsWith('/')) return null;

  const match = normalized.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: (((match[2] as string | undefined) ?? '')).trim(),
    raw: normalized,
  };
}

function splitMessage(content: string): string[] {
  if (content.length <= TELEGRAM_TEXT_LIMIT) return [content];

  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > TELEGRAM_TEXT_LIMIT) {
    let splitIdx = remaining.lastIndexOf('\n', TELEGRAM_TEXT_LIMIT - 1);
    if (splitIdx < TELEGRAM_TEXT_LIMIT / 2) {
      splitIdx = remaining.lastIndexOf(' ', TELEGRAM_TEXT_LIMIT - 1);
    }
    if (splitIdx < TELEGRAM_TEXT_LIMIT / 2) {
      splitIdx = TELEGRAM_TEXT_LIMIT - 1;
    }

    chunks.push(remaining.slice(0, splitIdx + 1));
    remaining = remaining.slice(splitIdx + 1);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function normalizeAllowlistEntry(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return '';
  return normalized.startsWith('@') ? normalized.slice(1) : normalized;
}

function resolveAuthorName(user: TelegramUser): string {
  if (user.username) return user.username;
  const combined = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  if (combined.length > 0) return combined;
  return `telegram-${user.id}`;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram';
  readonly name = this.id;
  readonly meta = {
    label: 'Telegram',
    emoji: ':speech_balloon:',
  };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct', 'channel', 'thread'],
    media: true,
    reactions: false,
    threads: true,
    streaming: true,
    promptChannelType: 'telegram_group',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter;
  readonly streaming: ChannelStreamingAdapter;
  readonly threading: ChannelThreadingAdapter;
  readonly prompt: ChannelPromptAdapter;

  private eventBus: EventBus;
  private telegram: TelegramChannelConfig;
  private fetchImpl: FetchLike;
  private handler: MessageHandler | null = null;
  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private activePoll: Promise<void> | undefined;
  private nextUpdateOffset = 0;
  private webhookServer: Server | undefined;
  private requestControllers = new Set<AbortController>();
  private processingChannels = new Set<string>();
  private pendingByChannel = new DeferredLatestByChannel<TelegramIncomingMessage>();
  private lockStartedAt = new Map<string, number>();
  private lockContention = new Map<string, number>();
  private messagePointers = new Map<string, MessagePointer>();
  private allowlist = new Set<string>();
  private longPollTimeoutSeconds: number;
  private commandRouter?: TelegramCommandRouter;
  private consecutivePollFailures = 0;
  private attemptedPollingConflictRecovery = false;
  private statusUnsubscribers: Array<() => void> = [];
  private longRunningTools = new Map<string, LongRunningToolState>();
  private longRunningStatusMessages = new Map<string, TelegramStatusMessageRef>();
  private streamResponses = new Map<string, TelegramStreamResponseState>();

  constructor(
    telegramConfig: TelegramChannelConfig,
    eventBus: EventBus,
    options: TelegramAdapterOptions = {},
  ) {
    this.telegram = telegramConfig;
    this.eventBus = eventBus;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.commandRouter = options.commandRouter;
    this.longPollTimeoutSeconds = options.longPollTimeoutSeconds ?? DEFAULT_LONG_POLL_TIMEOUT_SECONDS;

    for (const entry of telegramConfig.allowedUsers) {
      const normalized = normalizeAllowlistEntry(entry);
      if (normalized) this.allowlist.add(normalized);
    }

    this.config = {
      enabled: telegramConfig.enabled,
      connectionLabel: `telegram:${telegramConfig.mode}`,
    };
    this.outbound = {
      textChunkLimit: TELEGRAM_TEXT_LIMIT,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        await this.sendTextInternal(ctx, text);
      },
      sendMedia: async (ctx: OutboundContext, media: MediaAttachment): Promise<void> => {
        await this.sendMediaInternal(ctx, media);
      },
    };
    this.gateway = this;
    this.security = {
      supportsDirectMessages: true,
      allowlist: telegramConfig.allowedUsers,
    };
    this.streaming = {
      typingIntervalMs: DEFAULT_TYPING_INTERVAL_MS,
      sendTyping: async (channelId: string): Promise<void> => {
        const target = this.resolveOutboundTarget({ channelId });
        await this.callApi('sendChatAction', {
          chat_id: target.chatId,
          action: 'typing',
          ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
        });
      },
    };
    this.threading = {
      toThreadChannelId: (channelId: string, threadId: string): string => {
        return `${channelId}${THREAD_DELIMITER}${threadId}`;
      },
      fromThreadChannelId: (channelId: string): string | null => {
        const idx = channelId.indexOf(THREAD_DELIMITER);
        if (idx < 0 || idx + THREAD_DELIMITER.length >= channelId.length) return null;
        return channelId.slice(idx + THREAD_DELIMITER.length);
      },
    };
    this.prompt = {
      resolveChannelType: (message: SubstrateMessage): string | undefined => {
        return message.isDirectMessage ? 'telegram_dm' : 'telegram_group';
      },
      resolveTaskKind: (message: SubstrateMessage): string | undefined => {
        return parseTelegramCommand(message.content) ? 'telegram_command' : undefined;
      },
    };
    this.registerStatusListeners();
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async init(): Promise<void> {
    this.registerStatusListeners();
  }

  async start(): Promise<void> {
    if (!this.telegram.enabled) {
      log.info('Telegram adapter disabled in channels config');
      return;
    }
    if (!this.telegram.token) {
      throw new Error('Telegram is enabled but no bot token is configured');
    }

    this.running = true;
    this.consecutivePollFailures = 0;
    this.attemptedPollingConflictRecovery = false;
    if (this.telegram.mode === 'webhook') {
      await this.startWebhookMode();
      return;
    }

    try {
      await this.callApi('deleteWebhook', { drop_pending_updates: false });
    } catch (error) {
      log.warn('Telegram polling startup could not clear webhook state', {
        error: toErrorMessage(error),
      });
    }
    this.schedulePoll(0);
  }

  async stop(): Promise<void> {
    const wasRunning = this.running;
    this.running = false;
    this.consecutivePollFailures = 0;
    this.attemptedPollingConflictRecovery = false;
    for (const unsub of this.statusUnsubscribers) unsub();
    this.statusUnsubscribers = [];
    this.clearAllLongRunningTools();
    this.streamResponses.clear();
    await this.clearAllLongRunningStatusMessages();
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.telegram.mode === 'webhook') {
      if (wasRunning) {
        try {
          await this.callApi('deleteWebhook', { drop_pending_updates: false });
        } catch (error) {
          log.warn('Failed to delete Telegram webhook during shutdown', {
            error: toErrorMessage(error),
          });
        }
      }
      await this.stopWebhookServer();
    }

    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();

    try {
      await this.activePoll;
    } catch {
      // ignore shutdown race errors
    } finally {
      this.activePoll = undefined;
    }
  }

  async send(channelId: string, content: string): Promise<void> {
    await this.outbound.sendText({ channelId }, content);
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.activePoll = this.pollOnce()
        .then(() => {
          this.consecutivePollFailures = 0;
        })
        .catch((error: unknown) => {
          if (this.isAbortError(error) && !this.running) {
            return;
          }
          this.consecutivePollFailures += 1;
          const errorText = toErrorMessage(error);
          log.error('Telegram polling error', {
            error: errorText,
            consecutiveFailures: this.consecutivePollFailures,
          });
        })
        .finally(() => {
          this.activePoll = undefined;
          const delay = this.resolveNextPollDelayMs();
          this.schedulePoll(delay);
        });
    }, delayMs);
  }

  private resolveNextPollDelayMs(): number {
    if (this.consecutivePollFailures <= 0) {
      return this.telegram.pollIntervalMs;
    }
    const exponent = Math.max(0, this.consecutivePollFailures - 1);
    const nextDelay = this.telegram.pollIntervalMs * (2 ** exponent);
    return Math.min(MAX_POLL_BACKOFF_MS, nextDelay);
  }

  private isAbortError(error: unknown): boolean {
    if (error instanceof Error && error.name === 'AbortError') return true;
    return toErrorMessage(error).toLowerCase().includes('aborted');
  }

  private isPollingConflictError(error: unknown): boolean {
    const text = toErrorMessage(error).toLowerCase();
    return text.includes('http 409')
      || text.includes('terminated by other getupdates request')
      || text.includes('webhook is active');
  }

  private async pollOnce(): Promise<void> {
    let updates: TelegramUpdate[] = [];
    try {
      updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
        offset: this.nextUpdateOffset,
        timeout: this.longPollTimeoutSeconds,
        allowed_updates: ['message', 'edited_message'],
      });
      this.attemptedPollingConflictRecovery = false;
    } catch (error) {
      if (this.isPollingConflictError(error) && !this.attemptedPollingConflictRecovery) {
        this.attemptedPollingConflictRecovery = true;
        log.warn('Telegram polling conflict detected; attempting webhook cleanup and retry', {
          error: toErrorMessage(error),
        });
        await this.callApi('deleteWebhook', { drop_pending_updates: false }).catch((cleanupError: unknown) => {
          log.warn('Telegram polling conflict cleanup failed', {
            error: toErrorMessage(cleanupError),
          });
        });
        updates = await this.callApi<TelegramUpdate[]>('getUpdates', {
          offset: this.nextUpdateOffset,
          timeout: this.longPollTimeoutSeconds,
          allowed_updates: ['message', 'edited_message'],
        });
      } else {
        throw error;
      }
    }

    for (const update of updates) {
      this.nextUpdateOffset = Math.max(this.nextUpdateOffset, update.update_id + 1);
      await this.handleUpdate(update);
    }
  }

  private async startWebhookMode(): Promise<void> {
    if (!this.telegram.webhook.url) {
      this.running = false;
      throw new Error('Telegram webhook mode requires webhook.url to be configured');
    }

    await this.startWebhookServer();
    try {
      await this.callApi('setWebhook', {
        url: this.telegram.webhook.url,
        allowed_updates: ['message', 'edited_message'],
        ...(this.telegram.webhook.secret
          ? { secret_token: this.telegram.webhook.secret }
          : {}),
      });
    } catch (error) {
      this.running = false;
      await this.stopWebhookServer();
      throw error;
    }
  }

  private async startWebhookServer(): Promise<void> {
    if (this.webhookServer) return;

    const server = createServer((req, res) => {
      void this.handleWebhookRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.telegram.webhook.port, this.telegram.webhook.host);
    });

    this.webhookServer = server;
  }

  private async stopWebhookServer(): Promise<void> {
    const server = this.webhookServer;
    if (!server) return;
    this.webhookServer = undefined;

    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  private async handleWebhookRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      this.writeWebhookResponse(res, 405, 'method not allowed');
      return;
    }
    if (!this.isWebhookPath(req.url)) {
      this.writeWebhookResponse(res, 404, 'not found');
      return;
    }
    if (!this.isWebhookSecretValid(req)) {
      this.writeWebhookResponse(res, 401, 'unauthorized');
      return;
    }

    let rawBody = '';
    try {
      rawBody = await this.readWebhookBody(req);
    } catch (error) {
      const message = toErrorMessage(error);
      const statusCode = message.includes('too large') ? 413 : 400;
      this.writeWebhookResponse(res, statusCode, message);
      return;
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      this.writeWebhookResponse(res, 400, 'invalid json');
      return;
    }

    try {
      await this.handleUpdate(update);
      this.writeWebhookResponse(res, 200, 'ok');
    } catch (error) {
      log.error('Telegram webhook update handling error', {
        error: toErrorMessage(error),
      });
      this.writeWebhookResponse(res, 500, 'error');
    }
  }

  private isWebhookPath(url: string | undefined): boolean {
    if (!url) return false;
    try {
      const pathname = new URL(url, 'http://127.0.0.1').pathname;
      return pathname === this.telegram.webhook.path;
    } catch {
      return false;
    }
  }

  private isWebhookSecretValid(req: IncomingMessage): boolean {
    if (!this.telegram.webhook.secret) return true;
    const header = req.headers['x-telegram-bot-api-secret-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    return provided === this.telegram.webhook.secret;
  }

  private async readWebhookBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > TELEGRAM_WEBHOOK_MAX_BODY_BYTES) {
        throw new Error('payload too large');
      }
      chunks.push(part);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private writeWebhookResponse(res: ServerResponse, statusCode: number, body: string): void {
    if (res.writableEnded) return;
    res.statusCode = statusCode;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(body);
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message) return;
    await this.handleIncomingMessage(message);
  }

  private async handleIncomingMessage(message: TelegramIncomingMessage): Promise<void> {
    if (!this.handler) return;
    if (!message.from) return;
    if (message.from.is_bot) return;
    if (!this.isAllowed(message.from)) return;

    const chatId = String(message.chat.id);
    const threadId = message.message_thread_id !== undefined
      ? String(message.message_thread_id)
      : undefined;
    const baseChannelId = `telegram:${chatId}`;
    const channelId = threadId
      ? this.threading.toThreadChannelId(baseChannelId, threadId)
      : baseChannelId;

    const attachments = this.extractAttachments(message);
    const contentText = (message.text ?? message.caption ?? '').trim();
    if (!contentText && attachments.length === 0) return;

    let content = contentText || '[media message]';
    const command = parseTelegramCommand(content);
    if (command && this.commandRouter) {
      const rewritten = await this.commandRouter({
        command: command.command,
        args: command.args,
        raw: command.raw,
        channelId,
        chatId,
        messageId: String(message.message_id),
        isDirectMessage: message.chat.type === 'private',
        authorId: String(message.from.id),
        authorName: resolveAuthorName(message.from),
      });
      if (typeof rewritten === 'string' && rewritten.trim().length > 0) {
        content = rewritten.trim();
      }
    }

    const messageId = this.toSubstrateMessageId(chatId, message.message_id);
    const replyToId = message.reply_to_message
      ? this.toSubstrateMessageId(chatId, message.reply_to_message.message_id)
      : undefined;
    this.recordMessagePointer(messageId, {
      chatId,
      messageId: message.message_id,
      threadId,
    });

    if (this.processingChannels.has(channelId)) {
      const lockStartMs = this.lockStartedAt.get(channelId) ?? Date.now();
      const queueDepth = (this.lockContention.get(channelId) ?? 0) + 1;
      this.lockContention.set(channelId, queueDepth);
      const deferred = this.pendingByChannel.set(channelId, message);
      this.emitQueueTelemetry(channelId, 'contended', 'defer-latest', {
        queueDepth: deferred.queueDepth,
        waitMs: Math.max(0, Date.now() - lockStartMs),
        superseded: deferred.replaced,
      });
      log.debug('Telegram channel already processing turn; deferring latest concurrent message', {
        channelId,
        superseded: deferred.replaced,
      });
      return;
    }
    this.processingChannels.add(channelId);
    this.lockStartedAt.set(channelId, Date.now());
    this.lockContention.set(channelId, 0);
    this.emitQueueTelemetry(channelId, 'acquired', 'defer-latest', {
      queueDepth: 0,
      waitMs: 0,
    });

    const typingInterval = this.startTypingLoop(channelId);
    const substrateMessage: SubstrateMessage = {
      id: messageId,
      channelId,
      channelType: 'telegram',
      isDirectMessage: message.chat.type === 'private',
      authorId: String(message.from.id),
      authorName: resolveAuthorName(message.from),
      content,
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: new Date(message.date * 1000),
    };
    const replyContext: OutboundContext = {
      channelId,
      replyToMessageId: replyToId ?? messageId,
      threadId,
    };
    this.beginStreamResponse(replyContext);

    try {
      await this.eventBus.emit('message.received', { message: substrateMessage });
      let response: Awaited<ReturnType<MessageHandler>>;
      try {
        response = await this.handler(substrateMessage);
      } catch (error) {
        const errorText = toErrorMessage(error);
        log.error('Telegram message handling error', {
          channelId,
          messageId,
          error: errorText,
        });
        await this.eventBus.emit('channel.message.error', {
          channelId,
          channelType: 'telegram',
          messageId,
          phase: 'handler',
          error: errorText,
        }).catch(() => undefined);
        return;
      }

      const hasText = response.content.trim().length > 0;
      const responseAttachments = response.attachments ?? [];
      if (!hasText && responseAttachments.length === 0) return;

      try {
        const streamed = hasText
          ? await this.finalizeStreamResponse(channelId, response.content)
          : false;
        if (hasText && !streamed) {
          await this.outbound.sendText(replyContext, response.content);
        }
        if (responseAttachments.length > 0) {
          const mediaContext: OutboundContext = hasText
            ? {
              channelId,
              ...(threadId ? { threadId } : {}),
            }
            : replyContext;
          for (const attachment of responseAttachments) {
            await this.outbound.sendMedia?.(mediaContext, attachment);
          }
        }
        await this.eventBus.emit('message.sent', { response });
      } catch (error) {
        const errorText = toErrorMessage(error);
        log.error('Telegram message send error', {
          channelId,
          messageId,
          error: errorText,
        });
        await this.eventBus.emit('channel.message.error', {
          channelId,
          channelType: 'telegram',
          messageId,
          phase: 'egress',
          error: errorText,
        }).catch(() => undefined);
      }
    } finally {
      clearInterval(typingInterval);
      const lockStartMs = this.lockStartedAt.get(channelId) ?? Date.now();
      this.emitQueueTelemetry(channelId, 'released', 'defer-latest', {
        queueDepth: this.lockContention.get(channelId) ?? 0,
        waitMs: Math.max(0, Date.now() - lockStartMs),
      });
      this.lockStartedAt.delete(channelId);
      this.lockContention.delete(channelId);
      this.processingChannels.delete(channelId);
      this.streamResponses.delete(channelId);
      this.clearLongRunningToolsForChannel(channelId);
      await this.clearLongRunningStatus(channelId);
      const pending = this.pendingByChannel.take(channelId);
      if (pending) {
        queueMicrotask(() => {
          this.handleIncomingMessage(pending).catch((error) => {
            log.error('Deferred Telegram message handling error', {
              channelId,
              error: toErrorMessage(error),
            });
          });
        });
      }
    }
  }

  private startTypingLoop(channelId: string): ReturnType<typeof setInterval> {
    void this.streaming.sendTyping(channelId).catch(() => undefined);
    return setInterval(() => {
      void this.streaming.sendTyping(channelId).catch(() => undefined);
    }, this.streaming.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS);
  }

  private emitQueueTelemetry(
    channelId: string,
    phase: 'acquired' | 'contended' | 'released',
    policy: TurnContentionPolicy,
    details: { queueDepth: number; waitMs: number; superseded?: boolean },
  ): void {
    emitTurnContentionTelemetry(this.eventBus, {
      channelId,
      phase,
      policy,
      source: 'telegram',
      queueDepth: details.queueDepth,
      waitMs: details.waitMs,
      processingChannels: this.processingChannels.size,
      ...(details.superseded !== undefined ? { superseded: details.superseded } : {}),
    });
  }

  private registerStatusListeners(): void {
    if (this.statusUnsubscribers.length > 0) return;

    this.statusUnsubscribers.push(this.eventBus.on('agent.tool.start', async ({
      channelId,
      toolCallId,
      toolName,
    }) => {
      if (!this.processingChannels.has(channelId)) return;
      if (!this.isLongRunningTool(toolName)) return;
      this.startLongRunningToolStatus(toolCallId, channelId, toolName);
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.tool.end', async ({
      channelId,
      toolCallId,
      toolName,
    }) => {
      if (!this.isLongRunningTool(toolName)) return;
      await this.stopLongRunningToolStatus(toolCallId, channelId);
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.stream.delta', async ({
      channelId,
      text,
    }) => {
      if (!this.processingChannels.has(channelId)) return;
      await this.appendStreamResponseDelta(channelId, text);
    }));
  }

  private isLongRunningTool(toolName: string): boolean {
    return toolName === 'think';
  }

  private buildLongRunningStatusText(toolName: string, elapsedMs: number): string {
    const elapsedSeconds = Math.max(1, Math.floor(elapsedMs / 1000));
    if (toolName === 'think') {
      return `Still thinking deeply (${elapsedSeconds}s elapsed)...`;
    }
    return `Still running ${toolName} (${elapsedSeconds}s elapsed)...`;
  }

  private startLongRunningToolStatus(toolCallId: string, channelId: string, toolName: string): void {
    if (this.longRunningTools.has(toolCallId)) return;
    const state: LongRunningToolState = {
      channelId,
      toolName,
      startedAt: Date.now(),
      timer: setInterval(() => {
        this.tickLongRunningToolStatus(toolCallId).catch(() => undefined);
      }, LONG_RUNNING_STATUS_POLL_MS),
      lastStatusAt: 0,
      statusSent: false,
      inFlight: false,
    };
    this.longRunningTools.set(toolCallId, state);
  }

  private async tickLongRunningToolStatus(toolCallId: string): Promise<void> {
    const state = this.longRunningTools.get(toolCallId);
    if (!state) return;
    if (state.inFlight) return;
    if (!this.processingChannels.has(state.channelId)) return;

    const now = Date.now();
    const elapsedMs = now - state.startedAt;
    if (!state.statusSent && elapsedMs < LONG_RUNNING_STATUS_INITIAL_DELAY_MS) {
      return;
    }
    if (state.statusSent && (now - state.lastStatusAt) < LONG_RUNNING_STATUS_UPDATE_MIN_INTERVAL_MS) {
      return;
    }

    state.inFlight = true;
    try {
      await this.streaming.sendTyping(state.channelId).catch(() => undefined);
      await this.setLongRunningStatus(
        state.channelId,
        this.buildLongRunningStatusText(state.toolName, elapsedMs),
      );
      state.statusSent = true;
      state.lastStatusAt = now;
    } finally {
      state.inFlight = false;
    }
  }

  private async stopLongRunningToolStatus(toolCallId: string, channelId: string): Promise<void> {
    const state = this.longRunningTools.get(toolCallId);
    if (state) {
      clearInterval(state.timer);
      this.longRunningTools.delete(toolCallId);
    }
    if (this.hasActiveLongRunningToolForChannel(channelId)) return;
    await this.clearLongRunningStatus(channelId);
  }

  private hasActiveLongRunningToolForChannel(channelId: string): boolean {
    for (const state of this.longRunningTools.values()) {
      if (state.channelId === channelId) return true;
    }
    return false;
  }

  private clearLongRunningToolsForChannel(channelId: string): void {
    for (const [toolCallId, state] of this.longRunningTools.entries()) {
      if (state.channelId !== channelId) continue;
      clearInterval(state.timer);
      this.longRunningTools.delete(toolCallId);
    }
  }

  private clearAllLongRunningTools(): void {
    for (const state of this.longRunningTools.values()) {
      clearInterval(state.timer);
    }
    this.longRunningTools.clear();
  }

  private async setLongRunningStatus(channelId: string, content: string): Promise<void> {
    const existing = this.longRunningStatusMessages.get(channelId);
    if (existing) {
      try {
        await this.callApi('editMessageText', {
          chat_id: existing.chatId,
          message_id: existing.messageId,
          text: content,
        });
        return;
      } catch {
        this.longRunningStatusMessages.delete(channelId);
      }
    }

    const parsed = this.parseChannelId(channelId);
    if (!parsed) return;
    try {
      const sent = await this.callApi<TelegramSentMessage>('sendMessage', {
        chat_id: parsed.chatId,
        text: content,
        ...(parsed.threadId ? { message_thread_id: Number(parsed.threadId) } : {}),
      });
      this.longRunningStatusMessages.set(channelId, {
        chatId: parsed.chatId,
        messageId: sent.message_id,
      });
    } catch {
      // Ignore status send failures to avoid blocking primary response flow.
    }
  }

  private async clearLongRunningStatus(channelId: string): Promise<void> {
    const existing = this.longRunningStatusMessages.get(channelId);
    if (!existing) return;
    this.longRunningStatusMessages.delete(channelId);
    await this.callApi('deleteMessage', {
      chat_id: existing.chatId,
      message_id: existing.messageId,
    }).catch(() => undefined);
  }

  private async clearAllLongRunningStatusMessages(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const [channelId, ref] of this.longRunningStatusMessages.entries()) {
      this.longRunningStatusMessages.delete(channelId);
      pending.push(this.callApi('deleteMessage', {
        chat_id: ref.chatId,
        message_id: ref.messageId,
      }).catch(() => undefined));
    }
    await Promise.allSettled(pending);
  }

  private beginStreamResponse(ctx: OutboundContext): void {
    this.streamResponses.set(ctx.channelId, {
      channelId: ctx.channelId,
      target: this.resolveOutboundTarget(ctx),
      accumulatedText: '',
      lastAppliedText: '',
      pending: Promise.resolve(),
      failure: null,
    });
  }

  private async appendStreamResponseDelta(channelId: string, text: string): Promise<void> {
    if (!text) return;
    const state = this.streamResponses.get(channelId);
    if (!state) return;
    state.accumulatedText += text;
    await this.queueStreamResponseUpdate(state, state.accumulatedText, false);
  }

  private async finalizeStreamResponse(channelId: string, finalContent: string): Promise<boolean> {
    const state = this.streamResponses.get(channelId);
    if (!state) return false;

    await state.pending.catch(() => undefined);
    if (state.failure) throw state.failure;
    if (state.sentMessageId === undefined && state.accumulatedText.length === 0) {
      return false;
    }
    if (finalContent.trim().length === 0) {
      return state.sentMessageId !== undefined;
    }

    await this.queueStreamResponseUpdate(state, finalContent, true);
    await state.pending.catch(() => undefined);
    const failure = this.streamResponses.get(channelId)?.failure;
    if (failure instanceof Error) throw failure;
    return state.sentMessageId !== undefined;
  }

  private queueStreamResponseUpdate(
    state: TelegramStreamResponseState,
    content: string,
    isFinal: boolean,
  ): Promise<void> {
    const previous = state.pending;
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        if (state.failure) throw state.failure;
        if (!isFinal && content === state.lastAppliedText) return;
        await this.applyStreamResponseUpdate(state, content, isFinal);
        state.lastAppliedText = content;
      });

    state.pending = next.catch((error) => {
      const normalized = error instanceof Error ? error : new Error(toErrorMessage(error));
      state.failure = normalized;
      throw normalized;
    });
    return state.pending;
  }

  private async applyStreamResponseUpdate(
    state: TelegramStreamResponseState,
    content: string,
    isFinal: boolean,
  ): Promise<void> {
    if (content.trim().length === 0) return;
    if (content.length > TELEGRAM_TEXT_LIMIT) {
      throw new Error(
        `Telegram streaming responses cannot exceed ${TELEGRAM_TEXT_LIMIT} characters in a single edited message`,
      );
    }

    if (state.sentMessageId !== undefined) {
      await this.callApi('editMessageText', {
        chat_id: state.target.chatId,
        message_id: state.sentMessageId,
        text: content,
        ...(isFinal ? { parse_mode: 'Markdown' } : {}),
      });
      return;
    }

    const sent = await this.callApi<TelegramSentMessage>('sendMessage', {
      chat_id: state.target.chatId,
      text: content,
      ...(isFinal ? { parse_mode: 'Markdown' } : {}),
      ...(state.target.threadId ? { message_thread_id: Number(state.target.threadId) } : {}),
      ...(state.target.replyToMessageId ? { reply_to_message_id: state.target.replyToMessageId } : {}),
    });
    state.sentMessageId = sent.message_id;
    this.recordMessagePointer(this.toSubstrateMessageId(state.target.chatId, sent.message_id), {
      chatId: state.target.chatId,
      messageId: sent.message_id,
      ...(state.target.threadId ? { threadId: state.target.threadId } : {}),
    });
  }

  private isAllowed(user: TelegramUser): boolean {
    if (this.allowlist.size === 0) return true;

    const userId = String(user.id);
    if (this.allowlist.has(userId)) return true;

    const username = normalizeAllowlistEntry(user.username ?? '');
    if (username && this.allowlist.has(username)) return true;

    return false;
  }

  private parseChannelId(channelId: string): { chatId: string; threadId?: string } | null {
    const withoutPrefix = channelId.startsWith('telegram:')
      ? channelId.slice('telegram:'.length)
      : channelId;
    if (!withoutPrefix) return null;

    const threadIndex = withoutPrefix.indexOf(THREAD_DELIMITER);
    if (threadIndex === -1) {
      return { chatId: withoutPrefix };
    }

    const chatId = withoutPrefix.slice(0, threadIndex);
    const threadId = withoutPrefix.slice(threadIndex + THREAD_DELIMITER.length);
    if (!chatId) return null;

    return {
      chatId,
      ...(threadId ? { threadId } : {}),
    };
  }

  private parseSubstrateMessageId(messageId: string): MessagePointer | null {
    if (!messageId.startsWith('telegram:')) return null;
    const raw = messageId.slice('telegram:'.length);
    const separatorIdx = raw.lastIndexOf(':');
    if (separatorIdx <= 0 || separatorIdx >= raw.length - 1) return null;

    const chatId = raw.slice(0, separatorIdx);
    const telegramMessageId = Number.parseInt(raw.slice(separatorIdx + 1), 10);
    if (!Number.isFinite(telegramMessageId)) return null;

    return {
      chatId,
      messageId: telegramMessageId,
    };
  }

  private toSubstrateMessageId(chatId: string, messageId: number): string {
    return `telegram:${chatId}:${messageId}`;
  }

  private recordMessagePointer(key: string, pointer: MessagePointer): void {
    this.messagePointers.set(key, pointer);
    if (this.messagePointers.size <= MAX_CONTEXT_MAP_SIZE) return;

    const firstKey = this.messagePointers.keys().next().value;
    if (firstKey) this.messagePointers.delete(firstKey);
  }

  private resolveOutboundTarget(ctx: OutboundContext): OutboundTarget {
    const fromChannel = this.parseChannelId(ctx.channelId);
    const fromReplyMap = ctx.replyToMessageId
      ? this.messagePointers.get(ctx.replyToMessageId)
      : undefined;
    const fromReplyId = ctx.replyToMessageId
      ? this.parseSubstrateMessageId(ctx.replyToMessageId)
      : null;

    const chatId = fromChannel?.chatId ?? fromReplyMap?.chatId ?? fromReplyId?.chatId;
    if (!chatId) {
      throw new Error(`Unable to resolve Telegram chat ID from outbound context: ${ctx.channelId}`);
    }

    const threadId = ctx.threadId
      ?? fromChannel?.threadId
      ?? fromReplyMap?.threadId;

    const replyToMessageId = fromReplyMap?.messageId ?? fromReplyId?.messageId;

    return {
      chatId,
      ...(threadId ? { threadId } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
    };
  }

  private async sendTextInternal(ctx: OutboundContext, text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) return;

    const target = this.resolveOutboundTarget(ctx);
    const chunks = splitMessage(normalized);
    for (let i = 0; i < chunks.length; i++) {
      const sent = await this.callApi<TelegramSentMessage>('sendMessage', {
        chat_id: target.chatId,
        text: chunks[i],
        parse_mode: 'Markdown',
        ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
        ...(target.replyToMessageId && i === 0 ? { reply_to_message_id: target.replyToMessageId } : {}),
      });

      const pointer: MessagePointer = {
        chatId: target.chatId,
        messageId: sent.message_id,
        ...(target.threadId ? { threadId: target.threadId } : {}),
      };
      this.recordMessagePointer(this.toSubstrateMessageId(target.chatId, sent.message_id), pointer);
    }
  }

  private async sendMediaInternal(ctx: OutboundContext, media: MediaAttachment): Promise<void> {
    const mediaUrl = this.toTelegramMediaInput(media.url);
    if (!mediaUrl) {
      throw new Error('Telegram media attachment URL is required');
    }

    const target = this.resolveOutboundTarget(ctx);
    const { method, field } = this.resolveMediaMethod(media.contentType);
    const sent = await this.callApi<TelegramSentMessage>(method, {
      chat_id: target.chatId,
      [field]: mediaUrl,
      ...(target.threadId ? { message_thread_id: Number(target.threadId) } : {}),
      ...(target.replyToMessageId ? { reply_to_message_id: target.replyToMessageId } : {}),
    });

    const pointer: MessagePointer = {
      chatId: target.chatId,
      messageId: sent.message_id,
      ...(target.threadId ? { threadId: target.threadId } : {}),
    };
    this.recordMessagePointer(this.toSubstrateMessageId(target.chatId, sent.message_id), pointer);
  }

  private resolveMediaMethod(contentType: string | undefined): {
    method: TelegramMediaMethod;
    field: TelegramMediaField;
  } {
    const normalized = (contentType ?? '').toLowerCase();
    if (normalized.startsWith('image/')) {
      return { method: 'sendPhoto', field: 'photo' };
    }
    if (normalized.startsWith('audio/')) {
      return { method: 'sendVoice', field: 'voice' };
    }
    return { method: 'sendDocument', field: 'document' };
  }

  private toTelegramMediaInput(mediaUrl: string): string {
    const prefix = 'telegram://file/';
    if (mediaUrl.startsWith(prefix)) {
      return mediaUrl.slice(prefix.length);
    }
    return mediaUrl;
  }

  private extractAttachments(message: TelegramIncomingMessage): MediaAttachment[] {
    const attachments: MediaAttachment[] = [];

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      attachments.push({
        url: `telegram://file/${photo.file_id}`,
        contentType: 'image/jpeg',
        name: `photo-${photo.file_unique_id ?? photo.file_id}.jpg`,
      });
    }

    if (message.voice) {
      attachments.push({
        url: `telegram://file/${message.voice.file_id}`,
        contentType: message.voice.mime_type ?? 'audio/ogg',
        name: `voice-${message.voice.file_id}.ogg`,
      });
    }

    if (message.document) {
      attachments.push({
        url: `telegram://file/${message.document.file_id}`,
        contentType: message.document.mime_type ?? 'application/octet-stream',
        name: message.document.file_name ?? `document-${message.document.file_id}`,
      });
    }

    return attachments;
  }

  private async callApi<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.telegram.token) {
      throw new Error('Telegram token is not configured');
    }

    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timeoutMs = (this.longPollTimeoutSeconds + 5) * 1_000;
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.telegram.token}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        let description = '';
        try {
          const errorBody = await response.json() as Partial<TelegramApiResponse<unknown>>;
          description = typeof errorBody.description === 'string' ? errorBody.description.trim() : '';
        } catch {
          description = '';
        }
        throw new Error(`Telegram API HTTP ${response.status}${description ? `: ${description}` : ''}`);
      }
      const body = await response.json() as TelegramApiResponse<T>;
      if (!body.ok) {
        throw new Error(body.description ?? `Telegram API ${method} failed`);
      }
      return body.result;
    } finally {
      clearTimeout(timeoutHandle);
      this.requestControllers.delete(controller);
    }
  }
}
