import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type TextChannel,
  type User,
} from 'discord.js';
import type { SubstrateMessage, SubstrateConfig } from '../../types.js';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  MediaAttachment,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  MessageHandler,
  OutboundContext,
} from '../types.js';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import type { EventBus } from '../../event-bus.js';
import type { SessionStore } from '../../session/store.js';
import type { EligibilityGate } from '../../capabilities/eligibility.js';
import { createComponentLogger } from '../../logger.js';
import { DiscordVoiceRuntime } from './voice.js';
import {
  DeferredLatestByChannel,
  emitTurnContentionTelemetry,
  type TurnContentionPhase,
  type TurnContentionPolicy,
} from '../../lifecycle/turn-contention.js';
import { toErrorMessage } from '../../utils/errors.js';

const log = createComponentLogger('Discord');

const TYPING_INTERVAL_MS = 9_000;
const MAX_DISCORD_LENGTH = 2000;
const STARTUP_BACKFILL_LIMIT = 100;
const BACKFILL_DEDUP_WINDOW = 500;
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;
const DISCORD_TRIGGER_REACTION_DEFAULT = '👆';
const DISCORD_LISTEN_WINDOW_DEFAULT_MS = 120_000;
const DISCORD_LISTEN_WINDOW_MIN_MS = 10_000;
const DISCORD_LISTEN_WINDOW_MAX_MS = 600_000;
const DISCORD_TRIGGER_OPT_OUT_PREFIX = '!i';
const DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE = 4;
const DISCORD_MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const DISCORD_INLINE_IMAGE_URL_PATTERN = /https?:\/\/[^\s<>()]+/gi;
const DISCORD_IMAGE_LINK_HOST_SUFFIXES = [
  '.discordapp.com',
  '.discordapp.net',
];
const DISCORD_IMAGE_EXTENSION_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};
const LONG_RUNNING_STATUS_INITIAL_DELAY_MS = 12_000;
const LONG_RUNNING_STATUS_POLL_MS = 5_000;
const LONG_RUNNING_STATUS_UPDATE_MIN_INTERVAL_MS = 20_000;
type StatusKind = 'compaction' | 'retry' | 'long-running';

interface DiscordAdapterOptions {
  sessionStore?: SessionStore;
  eligibilityGate?: EligibilityGate;
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

interface PendingDiscordTurn {
  msg: Message;
  substrateMsg: SubstrateMessage;
  replyToOriginal: boolean;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord';
  readonly name = this.id;
  readonly meta = {
    label: 'Discord',
    emoji: ':speech_balloon:',
  };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct', 'channel', 'thread'],
    media: true,
    reactions: true,
    threads: true,
    streaming: true,
    promptChannelType: 'discord_text',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter;
  readonly streaming: ChannelStreamingAdapter;
  readonly threading: ChannelThreadingAdapter;
  readonly prompt: ChannelPromptAdapter;

  private client: Client;
  private runtimeConfig: SubstrateConfig;
  private eventBus: EventBus;
  private sessionStore: SessionStore | null;
  private handler: MessageHandler | null = null;
  private voiceHandler: MessageHandler | null = null;
  private agent: SubstrateAgent | null = null;
  private processing = new Set<string>();
  private pendingByChannel = new DeferredLatestByChannel<PendingDiscordTurn>();
  private lockStartedAt = new Map<string, number>();
  private lockContention = new Map<string, number>();
  private lockPolicy = new Map<string, TurnContentionPolicy>();
  private listeningWindows = new Map<string, number>();
  private voice: DiscordVoiceRuntime;
  private statusMessages = new Map<string, Message>();
  private statusUnsubscribers: Array<() => void> = [];
  private longRunningTools = new Map<string, LongRunningToolState>();

  constructor(config: SubstrateConfig, eventBus: EventBus, options: DiscordAdapterOptions = {}) {
    this.runtimeConfig = config;
    this.eventBus = eventBus;
    this.sessionStore = options.sessionStore ?? null;
    this.config = {
      enabled: Boolean(config.discordToken),
      accountId: config.discordBotId || undefined,
      connectionLabel: 'discord',
    };
    this.outbound = {
      textChunkLimit: MAX_DISCORD_LENGTH,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        await this.send(ctx.channelId, text);
      },
      sendMedia: async (ctx: OutboundContext, media: MediaAttachment): Promise<void> => {
        await this.sendMediaInternal(ctx, media);
      },
    };
    this.gateway = this;
    this.security = {
      supportsDirectMessages: true,
      requiresMentionForChannelMessages: true,
    };
    this.streaming = {
      typingIntervalMs: TYPING_INTERVAL_MS,
      sendTyping: async (channelId: string): Promise<void> => {
        await this.sendTypingToChannel(channelId);
      },
    };
    this.threading = {
      toThreadChannelId: (channelId: string, threadId: string): string => `${channelId}:${threadId}`,
      fromThreadChannelId: (channelId: string): string | null => {
        const idx = channelId.indexOf(':');
        if (idx <= 0 || idx >= channelId.length - 1) return null;
        return channelId.slice(idx + 1);
      },
    };
    this.prompt = {
      resolveChannelType: (message: SubstrateMessage): string | undefined => {
        if (message.channelId.startsWith('discord-voice:')) return 'discord_voice';
        return 'discord_text';
      },
    };
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });

    this.voice = new DiscordVoiceRuntime({
      client: this.client,
      config,
      eventBus,
      getHandler: () => this.voiceHandler ?? this.handler,
      eligibilityGate: options.eligibilityGate,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Set a separate handler for voice messages (e.g. reverse RPC to agent in gateway mode) */
  setVoiceHandler(handler: MessageHandler): void {
    this.voiceHandler = handler;
  }

  /** Set direct agent reference for steering support */
  setAgent(agent: SubstrateAgent): void {
    this.agent = agent;
    this.handler = (msg) => agent.handleMessage(msg);
  }

  async init(): Promise<void> {
    this.client.on(Events.MessageCreate, (msg) => {
      this.onDiscordMessage(msg).catch(err => {
        log.error('Message handling error', { error: String(err) });
      });
    });
    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.onReactionAdd(reaction, user).catch(err => {
        log.error('Reaction handling error', { error: String(err) });
      });
    });

    this.client.once(Events.ClientReady, (c) => {
      log.info(`Logged in as ${c.user.tag}`);
    });

    this.voice.init();
    this.registerStatusListeners();
  }

  async start(): Promise<void> {
    if (!this.runtimeConfig.discordToken) {
      log.warn('Discord adapter disabled: DISCORD_TOKEN not configured');
      return;
    }
    await this.client.login(this.runtimeConfig.discordToken);
    if (this.runtimeConfig.discordBackfillOnStartup !== false) {
      await this.backfillOnStartup();
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.statusUnsubscribers) unsub();
    this.statusUnsubscribers = [];
    this.clearAllLongRunningTools();
    await this.clearAllStatusMessages();
    this.listeningWindows.clear();
    await this.voice.stop();
    this.client.destroy();
  }

  isConnected(): boolean {
    return this.client.isReady();
  }

  async send(channelId: string, content: string): Promise<void> {
    const normalized = content.trim();
    if (!normalized) {
      log.debug('Skipping empty Discord send', { channelId });
      return;
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const chunks = splitMessage(normalized);
    for (const chunk of chunks) {
      await (channel as TextChannel).send(chunk);
    }
  }

  private async sendMediaInternal(ctx: OutboundContext, media: MediaAttachment): Promise<void> {
    const channel = await this.client.channels.fetch(ctx.channelId);
    if (!channel?.isTextBased()) return;

    const fileName = media.name?.trim() || 'attachment';
    const file = media.localPath?.trim()
      ? media.localPath.trim()
      : await this.fetchRemoteMediaAttachment(media.url, fileName);

    await (channel as TextChannel).send({
      files: [file],
      ...(ctx.replyToMessageId ? { reply: { messageReference: ctx.replyToMessageId } } : {}),
    });
  }

  private async fetchRemoteMediaAttachment(
    mediaUrl: string,
    fileName: string,
  ): Promise<{ attachment: Buffer; name: string }> {
    if (!mediaUrl.trim()) {
      throw new Error('Discord media attachment URL is required');
    }

    const response = await fetch(mediaUrl);
    if (!response.ok) {
      throw new Error(`Discord media fetch failed (${response.status})`);
    }

    return {
      attachment: Buffer.from(await response.arrayBuffer()),
      name: fileName,
    };
  }

  private async onDiscordMessage(msg: Message): Promise<void> {
    const runtimeBotId = this.resolveRuntimeBotId();

    // Ignore self + bots
    if (runtimeBotId && msg.author.id === runtimeBotId) return;
    if (msg.author.bot) return;
    if (!this.handler) return;

    // Respond to DMs always, guild messages by mention/trigger/listening window.
    const isDM = !msg.guild;
    const channelId = msg.channelId;
    if (!isDM) {
      if (msg.content.trimStart().startsWith(DISCORD_TRIGGER_OPT_OUT_PREFIX)) return;

      const isMentioned = runtimeBotId ? msg.mentions.has(runtimeBotId) : false;
      const isTriggered = this.matchesTriggerWord(msg.content);
      const listenKey = this.listeningWindowKey(channelId, msg.author.id);
      const isListening = this.isInListeningWindow(listenKey);

      if (!isMentioned && !isTriggered && !isListening) return;

      this.openListeningWindow(listenKey);

      if (isTriggered && !isMentioned) {
        log.debug('Discord trigger word matched', { channelId, authorId: msg.author.id });
      } else if (isListening && !isMentioned) {
        log.debug('Discord listening window accepted follow-up', { channelId, authorId: msg.author.id });
      }
    }

    const substrateMsg = this.buildSubstrateMessage(msg, isDM, runtimeBotId);
    await this.processMessage({
      msg,
      substrateMsg,
      replyToOriginal: false,
    });
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    const runtimeBotId = this.resolveRuntimeBotId();
    if (runtimeBotId && user.id === runtimeBotId) return;
    if (user.bot) return;

    const emojiName = reaction.emoji.name ?? '';
    const isDeleteReaction = emojiName === '❌';

    if (!isDeleteReaction) {
      if (!this.handler) return;
      if (!this.matchesTriggerReaction(emojiName, reaction.emoji.id)) return;
    }

    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const targetMessage = fullReaction.message.partial
      ? await fullReaction.message.fetch()
      : fullReaction.message;

    if (isDeleteReaction) {
      if (runtimeBotId && targetMessage.author.id === runtimeBotId) {
        log.info('Discord delete reaction received for bot message', {
          messageId: targetMessage.id,
          channelId: targetMessage.channelId,
          reactorId: user.id,
        });
        await targetMessage.delete().catch((error) => {
          log.warn('Failed to delete Discord bot message from reaction', {
            messageId: targetMessage.id,
            channelId: targetMessage.channelId,
            error: String(error),
          });
        });
      }
      return;
    }

    if (targetMessage.author.bot) return;
    if (runtimeBotId && targetMessage.author.id === runtimeBotId) return;

    const channelId = targetMessage.channelId;
    log.debug('Discord reaction trigger matched', {
      channelId,
      messageId: targetMessage.id,
      emoji: emojiName,
      reactorId: user.id,
    });

    const authorListenKey = this.listeningWindowKey(channelId, targetMessage.author.id);
    this.openListeningWindow(authorListenKey);
    const reactorListenKey = this.listeningWindowKey(channelId, user.id);
    if (reactorListenKey !== authorListenKey) {
      this.openListeningWindow(reactorListenKey);
    }

    fullReaction.remove().catch(() => undefined);

    const substrateMsg = this.buildSubstrateMessage(
      targetMessage as Message,
      !targetMessage.guild,
      runtimeBotId,
    );
    await this.processMessage({
      msg: targetMessage as Message,
      substrateMsg,
      replyToOriginal: true,
    });
  }

  private async processMessage(turn: PendingDiscordTurn): Promise<void> {
    const { msg, substrateMsg, replyToOriginal } = turn;
    const channelId = substrateMsg.channelId;

    if (!this.handler) return;

    // If already processing this channel, steer (interrupt) instead of dropping.
    if (this.processing.has(channelId)) {
      const lockStartMs = this.lockStartedAt.get(channelId) ?? Date.now();
      const queueDepth = (this.lockContention.get(channelId) ?? 0) + 1;
      this.lockContention.set(channelId, queueDepth);
      const lockPolicy = this.lockPolicy.get(channelId) ?? (this.agent ? 'steer' : 'defer-latest');
      const waitMs = Math.max(0, Date.now() - lockStartMs);
      if (lockPolicy === 'steer' && this.agent) {
        this.emitQueueTelemetry(channelId, 'contended', lockPolicy, {
          queueDepth,
          waitMs,
        });
        log.debug('Steering message into active stream', { channelId });
        this.agent.steer(substrateMsg);
      } else {
        // Gateway mode has no direct agent instance, so keep latest message queued
        // instead of dropping it during lock contention.
        const deferred = this.pendingByChannel.set(channelId, turn);
        this.emitQueueTelemetry(channelId, 'contended', 'defer-latest', {
          queueDepth: deferred.queueDepth,
          waitMs,
          superseded: deferred.replaced,
        });
        log.debug('Queueing contended Discord message for deferred processing', { channelId });
      }
      return;
    }

    this.processing.add(channelId);
    const lockStartMs = Date.now();
    this.lockStartedAt.set(channelId, lockStartMs);
    this.lockContention.set(channelId, 0);
    const lockPolicy: TurnContentionPolicy = this.agent ? 'steer' : 'defer-latest';
    this.lockPolicy.set(channelId, lockPolicy);
    this.emitQueueTelemetry(channelId, 'acquired', lockPolicy, {
      queueDepth: 0,
      waitMs: 0,
    });

    // Start typing indicator
    const typingInterval = this.startTyping(msg);
    this.clearStatus(channelId, 'compaction').catch(() => undefined);
    this.clearStatus(channelId, 'retry').catch(() => undefined);
    this.clearStatus(channelId, 'long-running').catch(() => undefined);

    try {
      await this.eventBus.emit('message.received', { message: substrateMsg });

      const response = await this.handler(substrateMsg);
      const trimmedResponse = response.content.trim();
      const hasText = trimmedResponse.length > 0;
      const responseAttachments = response.attachments ?? [];
      if (hasText) {
        if (replyToOriginal) {
          await this.sendReply(msg, trimmedResponse);
        } else {
          await this.outbound.sendText({ channelId }, response.content);
        }
      }
      if (responseAttachments.length > 0) {
        const mediaContext = replyToOriginal && !hasText
          ? { channelId, replyToMessageId: msg.id }
          : { channelId };
        for (const attachment of responseAttachments) {
          await this.outbound.sendMedia?.(mediaContext, attachment);
        }
      }
      if (hasText || responseAttachments.length > 0) {
        await this.eventBus.emit('message.sent', { response });
      } else {
        log.debug('Suppressing empty handler response for Discord channel', { channelId });
      }

    } catch (error) {
      const errorText = toErrorMessage(error);
      log.error('Error processing message', {
        channelId,
        messageId: substrateMsg.id,
        error: errorText,
      });
      await this.eventBus.emit('channel.message.error', {
        channelId,
        channelType: 'discord',
        messageId: substrateMsg.id,
        phase: 'handler',
        error: errorText,
      }).catch(() => undefined);
    } finally {
      clearInterval(typingInterval);
      this.processing.delete(channelId);
      const lockHeldMs = Math.max(0, Date.now() - lockStartMs);
      const releasePolicy = this.lockPolicy.get(channelId) ?? lockPolicy;
      this.emitQueueTelemetry(channelId, 'released', releasePolicy, {
        queueDepth: this.lockContention.get(channelId) ?? 0,
        waitMs: lockHeldMs,
      });
      this.lockStartedAt.delete(channelId);
      this.lockContention.delete(channelId);
      this.lockPolicy.delete(channelId);
      this.clearLongRunningToolsForChannel(channelId);
      await this.clearStatus(channelId, 'compaction');
      await this.clearStatus(channelId, 'long-running');
      const pending = this.pendingByChannel.take(channelId);
      if (pending) {
        queueMicrotask(() => {
          this.processMessage(pending).catch((error) => {
            log.error('Deferred Discord message handling error', { channelId, error: String(error) });
          });
        });
      }
    }
  }

  private buildSubstrateMessage(
    msg: Message,
    isDirectMessage: boolean,
    runtimeBotId?: string,
  ): SubstrateMessage {
    const attachments: NonNullable<SubstrateMessage['attachments']> = this.extractAttachments(msg);
    if (attachments.length < DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) {
      const seenUrls = new Set(attachments.map((attachment) => attachment.url));
      const remaining = DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE - attachments.length;
      const inlineAttachments = this.extractInlineImageLinks(msg.content, seenUrls, remaining);
      if (inlineAttachments.length > 0) {
        attachments.push(...inlineAttachments);
      }
    }
    const content = this.sanitizeMessageContent(msg.content, runtimeBotId);
    const resolvedContent = content === '(empty message)' && attachments.length > 0
      ? '(image attachment)'
      : content;
    return {
      id: msg.id,
      channelId: msg.channelId,
      channelType: 'discord',
      isDirectMessage,
      authorId: msg.author.id,
      authorName: msg.author.displayName,
      content: resolvedContent,
      ...(attachments.length > 0 ? { attachments } : {}),
      timestamp: msg.createdAt,
    };
  }

  private extractAttachments(msg: Message): NonNullable<SubstrateMessage['attachments']> {
    const rawAttachments = msg.attachments.values();

    const attachments: NonNullable<SubstrateMessage['attachments']> = [];
    for (const raw of rawAttachments) {
      if (attachments.length >= DISCORD_MAX_IMAGE_ATTACHMENTS_PER_MESSAGE) break;

      const contentType = this.resolveDiscordImageContentType(raw);
      if (!contentType) continue;

      const size = typeof raw.size === 'number' && Number.isFinite(raw.size)
        ? Math.max(0, Math.trunc(raw.size))
        : 0;
      if (size > DISCORD_MAX_IMAGE_ATTACHMENT_BYTES) {
        log.debug('Skipping oversized Discord image attachment', {
          channelId: msg.channelId,
          messageId: msg.id,
          name: raw.name,
          size,
        });
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- discord.js types claim non-null but mocks/edge cases disagree
      const url = (raw.proxyURL ?? raw.url ?? '').trim();
      if (!url) continue;

      attachments.push({
        url,
        contentType,
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive for partial mock data
        name: raw.name ?? `attachment-${raw.id ?? attachments.length + 1}`,
      });
    }

    return attachments;
  }

  private extractInlineImageLinks(
    content: string,
    seenUrls: Set<string>,
    remaining: number,
  ): NonNullable<SubstrateMessage['attachments']> {
    if (!content || remaining <= 0) return [];
    const attachments: NonNullable<SubstrateMessage['attachments']> = [];
    const matches = content.matchAll(DISCORD_INLINE_IMAGE_URL_PATTERN);
    for (const match of matches) {
      if (attachments.length >= remaining) break;
      const normalizedUrl = normalizeInlineUrl(match[0]);
      if (!normalizedUrl || seenUrls.has(normalizedUrl)) continue;
      if (!isDiscordHostedImageUrl(normalizedUrl)) continue;
      const contentType = inferImageMimeTypeFromCandidate(normalizedUrl);
      if (!contentType) continue;

      attachments.push({
        url: normalizedUrl,
        contentType,
        name: inferFileNameFromUrl(normalizedUrl) ?? `attachment-inline-${attachments.length + 1}`,
      });
      seenUrls.add(normalizedUrl);
    }
    return attachments;
  }

  private resolveDiscordImageContentType(raw: {
    contentType?: string | null;
    name?: string | null;
    url?: string | null;
    proxyURL?: string | null;
    width?: number | null;
    height?: number | null;
  }): string | null {
    const normalizedContentType = raw.contentType?.trim().toLowerCase();
    if (normalizedContentType?.startsWith('image/')) {
      return normalizedContentType;
    }

    const candidates = [raw.name, raw.proxyURL, raw.url];
    for (const candidate of candidates) {
      const inferred = inferImageMimeTypeFromCandidate(candidate);
      if (inferred) return inferred;
    }

    const hasDimensions = typeof raw.width === 'number'
      && Number.isFinite(raw.width)
      && raw.width > 0
      && typeof raw.height === 'number'
      && Number.isFinite(raw.height)
      && raw.height > 0;
    if (hasDimensions) {
      return 'image/png';
    }

    return null;
  }

  private sanitizeMessageContent(content: string, runtimeBotId?: string): string {
    let normalized = content;
    if (runtimeBotId) {
      normalized = normalized.replace(new RegExp(`<@!?${runtimeBotId}>`, 'g'), '');
    }
    normalized = normalized.trim();
    return normalized.length > 0 ? normalized : '(empty message)';
  }

  private async sendReply(msg: Message, content: string): Promise<void> {
    const chunks = splitMessage(content);
    if (chunks.length === 0) return;

    await msg.reply(chunks[0]);
    for (let i = 1; i < chunks.length; i++) {
      await (msg.channel as TextChannel).send(chunks[i]);
    }
  }

  private resolveRuntimeBotId(): string | undefined {
    const liveBotId = this.client.user?.id;
    if (liveBotId) return liveBotId;
    const configuredBotId = this.runtimeConfig.discordBotId.trim();
    return configuredBotId.length > 0 ? configuredBotId : undefined;
  }

  private listeningWindowKey(channelId: string, userId: string): string {
    return `${channelId}:${userId}`;
  }

  private isInListeningWindow(key: string): boolean {
    const expiry = this.listeningWindows.get(key);
    if (expiry === undefined) return false;
    if (Date.now() > expiry) {
      this.listeningWindows.delete(key);
      return false;
    }
    return true;
  }

  private openListeningWindow(key: string): void {
    const windowMs = this.resolveListeningWindowMs();
    this.listeningWindows.set(key, Date.now() + windowMs);
    log.debug('Discord listening window opened/extended', { key, windowMs });
  }

  private resolveListeningWindowMs(): number {
    const configured = this.runtimeConfig.discordTriggerListenWindowMs;
    if (typeof configured !== 'number' || Number.isNaN(configured)) {
      return DISCORD_LISTEN_WINDOW_DEFAULT_MS;
    }
    return Math.min(
      DISCORD_LISTEN_WINDOW_MAX_MS,
      Math.max(DISCORD_LISTEN_WINDOW_MIN_MS, Math.floor(configured)),
    );
  }

  private matchesTriggerWord(content: string): boolean {
    const lower = content.toLowerCase();
    if (!lower) return false;

    const characterName = this.runtimeConfig.characterName?.trim();
    if (characterName && lower.includes(characterName.toLowerCase())) {
      return true;
    }

    const configuredWords = this.runtimeConfig.discordTriggerWords ?? [];
    for (const configured of configuredWords) {
      const candidate = configured.trim().toLowerCase();
      if (candidate && lower.includes(candidate)) {
        return true;
      }
    }

    return false;
  }

  private matchesTriggerReaction(emojiName: string, emojiId: string | null): boolean {
    const normalizedEmoji = emojiName.trim();
    if (!normalizedEmoji) return false;

    const candidates = new Set<string>([normalizedEmoji]);
    if (emojiId) {
      candidates.add(`<:${normalizedEmoji}:${emojiId}>`);
      candidates.add(`<a:${normalizedEmoji}:${emojiId}>`);
    }

    for (const reaction of this.getTriggerReactions()) {
      if (candidates.has(reaction)) return true;
    }
    return false;
  }

  private getTriggerReactions(): string[] {
    const configured = (this.runtimeConfig.discordTriggerReactions ?? [])
      .map((reaction) => reaction.trim())
      .filter((reaction) => reaction.length > 0);

    return configured.length > 0
      ? configured
      : [DISCORD_TRIGGER_REACTION_DEFAULT];
  }

  private startTyping(msg: Message): ReturnType<typeof setInterval> {
    const channel = msg.channel;
    if ('sendTyping' in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }
    return setInterval(() => {
      if ('sendTyping' in channel) {
        (channel as TextChannel).sendTyping().catch(() => {});
      }
    }, TYPING_INTERVAL_MS);
  }

  private emitQueueTelemetry(
    channelId: string,
    phase: TurnContentionPhase,
    policy: TurnContentionPolicy,
    details: { queueDepth: number; waitMs: number; superseded?: boolean },
  ): void {
    const telemetry = {
      channelId,
      phase,
      policy,
      source: 'discord',
      queueDepth: details.queueDepth,
      waitMs: details.waitMs,
      processingChannels: this.processing.size,
      ...(details.superseded !== undefined ? { superseded: details.superseded } : {}),
    };
    log.debug('Queue lock telemetry', telemetry);
    emitTurnContentionTelemetry(this.eventBus, telemetry);
  }

  private registerStatusListeners(): void {
    if (this.statusUnsubscribers.length > 0) return;

    this.statusUnsubscribers.push(this.eventBus.on('agent.compaction.start', async ({
      channelId,
      tokensBefore,
      tokenBudget,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('Compaction started', { channelId, tokensBefore, tokenBudget });
      await this.sendTypingToChannel(channelId);
      await this.setStatus(
        channelId,
        'compaction',
        'Organizing context to stay within token budget...',
      );
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.compaction.end', async ({
      channelId,
      tokensBefore,
      tokensAfter,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('Compaction finished', { channelId, tokensBefore, tokensAfter });
      await this.clearStatus(channelId, 'compaction');
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.retry.start', async ({
      channelId,
      attempt,
      maxAttempts,
      delayMs,
      error,
    }) => {
      if (!this.processing.has(channelId)) return;
      const delaySec = (delayMs / 1000).toFixed(1);
      log.warn('LLM retry scheduled', { channelId, attempt, maxAttempts, delayMs, error });
      await this.sendTypingToChannel(channelId);
      await this.setStatus(
        channelId,
        'retry',
        `Connection hiccup, retrying (${attempt}/${maxAttempts}) in ${delaySec}s...`,
      );
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.retry.end', async ({
      channelId,
      success,
      attempt,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('LLM retry finished', { channelId, success, attempt });
      if (success) {
        await this.clearStatus(channelId, 'retry');
      } else {
        await this.setStatus(
          channelId,
          'retry',
          'Having trouble reaching my thoughts. Please try again.',
        );
      }
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.tool.start', async ({
      channelId,
      toolCallId,
      toolName,
    }) => {
      if (!this.processing.has(channelId)) return;
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
    if (!this.processing.has(state.channelId)) return;

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
      await this.sendTypingToChannel(state.channelId);
      await this.setStatus(
        state.channelId,
        'long-running',
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
    await this.clearStatus(channelId, 'long-running');
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

  private async sendTypingToChannel(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      if ('sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // Ignore typing errors (permissions/network/transient fetch failures)
    }
  }

  private statusKey(channelId: string, kind: StatusKind): string {
    return `${channelId}:${kind}`;
  }

  private async setStatus(channelId: string, kind: StatusKind, content: string): Promise<void> {
    const key = this.statusKey(channelId, kind);
    const existing = this.statusMessages.get(key);
    if (existing) {
      try {
        await existing.edit(content);
        return;
      } catch {
        this.statusMessages.delete(key);
      }
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    try {
      const sent = await (channel as TextChannel).send(content);
      this.statusMessages.set(key, sent as Message);
    } catch {
      // Ignore status send failures to avoid breaking primary response path
    }
  }

  private async clearStatus(channelId: string, kind: StatusKind): Promise<void> {
    const key = this.statusKey(channelId, kind);
    const existing = this.statusMessages.get(key);
    if (!existing) return;
    this.statusMessages.delete(key);
    try {
      await existing.delete();
    } catch {
      // Ignore cleanup failures (already deleted / permission changes)
    }
  }

  private async clearAllStatusMessages(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const message of this.statusMessages.values()) {
      pending.push(message.delete().catch(() => undefined));
    }
    this.statusMessages.clear();
    await Promise.allSettled(pending);
  }

  private async backfillOnStartup(): Promise<void> {
    if (!this.sessionStore) return;

    const sessionChannelIds = this.sessionStore.listChannels()
      .filter(channel => channel.messageCount > 0)
      .map(channel => channel.channelId)
      .filter(channelId => this.toDiscordChannelId(channelId) !== null);

    for (const sessionChannelId of sessionChannelIds) {
      const discordChannelId = this.toDiscordChannelId(sessionChannelId);
      if (!discordChannelId) continue;

      try {
        const channel = await this.client.channels.fetch(discordChannelId);
        if (!channel?.isTextBased()) continue;

        const cursor = this.findBackfillCursor(sessionChannelId);
        const options: { limit: number; after?: string } = { limit: STARTUP_BACKFILL_LIMIT };
        if (cursor) options.after = cursor;

        const messages = await (channel as TextChannel).messages.fetch(options);
        if (messages.size === 0) continue;

        const dedupIds = this.sessionStore.getRecentDiscordMessageIds(sessionChannelId, BACKFILL_DEDUP_WINDOW);
        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const msg of sorted) {
          if (msg.author.bot) continue;
          if (dedupIds.has(msg.id)) continue;

          this.sessionStore.append({
            channelId: sessionChannelId,
            role: 'user',
            content: msg.content.trim() || '(empty message)',
            authorId: msg.author.id,
            authorName: msg.author.displayName,
            timestamp: msg.createdTimestamp,
            discordMessageId: msg.id,
          });
          dedupIds.add(msg.id);
        }
      } catch (err) {
        log.warn('Discord startup backfill failed for channel', {
          channelId: sessionChannelId,
          error: String(err),
        });
      }
    }
  }

  private findBackfillCursor(sessionChannelId: string): string | undefined {
    const last = this.sessionStore?.getLastEntry(sessionChannelId);
    if (last?.discordMessageId) return last.discordMessageId;

    const recent = this.sessionStore?.getRecent(sessionChannelId, BACKFILL_DEDUP_WINDOW) ?? [];
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].discordMessageId) return recent[i].discordMessageId;
    }
    return undefined;
  }

  private toDiscordChannelId(sessionChannelId: string): string | null {
    if (sessionChannelId.startsWith('discord:')) {
      const value = sessionChannelId.slice('discord:'.length);
      return DISCORD_CHANNEL_ID_PATTERN.test(value) ? value : null;
    }
    return DISCORD_CHANNEL_ID_PATTERN.test(sessionChannelId) ? sessionChannelId : null;
  }

}

function inferImageMimeTypeFromCandidate(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  let value = trimmed;
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      value = new URL(trimmed).pathname;
    }
  } catch {
    value = trimmed;
  }

  const lower = value.toLowerCase();
  for (const [extension, mimeType] of Object.entries(DISCORD_IMAGE_EXTENSION_TO_MIME)) {
    if (lower.endsWith(extension)) {
      return mimeType;
    }
  }
  return null;
}

function normalizeInlineUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutTrailingPunctuation = trimmed.replace(/[),.!?:;]+$/g, '');
  if (!withoutTrailingPunctuation) return null;
  try {
    const parsed = new URL(withoutTrailingPunctuation);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function isDiscordHostedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return DISCORD_IMAGE_LINK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
  } catch {
    return false;
  }
}

function inferFileNameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const fileName = parts.at(-1)?.trim();
    return fileName && fileName.length > 0 ? fileName : null;
  } catch {
    return null;
  }
}

function splitMessage(content: string): string[] {
  if (content.length <= MAX_DISCORD_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > MAX_DISCORD_LENGTH) {
    // Try to split at sentence boundary
    let splitIdx = remaining.lastIndexOf('. ', MAX_DISCORD_LENGTH - 1);
    if (splitIdx === -1 || splitIdx < MAX_DISCORD_LENGTH / 2) {
      // Try newline
      splitIdx = remaining.lastIndexOf('\n', MAX_DISCORD_LENGTH - 1);
    }
    if (splitIdx === -1 || splitIdx < MAX_DISCORD_LENGTH / 2) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', MAX_DISCORD_LENGTH - 1);
    }
    if (splitIdx === -1) {
      splitIdx = MAX_DISCORD_LENGTH - 1;
    }

    chunks.push(remaining.slice(0, splitIdx + 1));
    remaining = remaining.slice(splitIdx + 1);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
