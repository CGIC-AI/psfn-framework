import type { AgentResponse, Attachment, Lifecycle, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { EligibilityRequirements } from '../../system/capabilities/eligibility.js';

/**
 * mmo9.6.1: in-process turn-control options threaded alongside a dispatched
 * message. `cancellationId` is the transport-agnostic turn identity (also
 * carried on {@link SubstrateMessage.routing} for serialized hops); `signal`
 * is a non-serializable AbortSignal that, when aborted, cancels the specific
 * in-flight turn it was dispatched with. Both are optional and additive: a
 * handler that ignores them behaves exactly as before.
 */
export interface MessageHandlerOptions {
  signal?: AbortSignal;
  cancellationId?: string;
}

export type MessageHandler = (
  message: SubstrateMessage,
  options?: MessageHandlerOptions,
) => Promise<AgentResponse>;
export type ChannelChatType = 'direct' | 'channel' | 'thread';

export interface ChannelAdapterMeta {
  label: string;
  emoji?: string;
}

export interface ChannelCapabilities {
  chatTypes: readonly ChannelChatType[];
  media: boolean;
  reactions: boolean;
  threads: boolean;
  streaming: boolean;
  promptChannelType?: string;
}

export interface ChannelConfigAdapter {
  enabled: boolean;
  accountId?: string;
  connectionLabel?: string;
}

export interface OutboundContext {
  channelId: string;
  replyToMessageId?: string;
  threadId?: string;
}

export interface MediaAttachment extends Attachment {}

export interface ChannelOutboundAdapter {
  textChunkLimit: number;
  sendText(ctx: OutboundContext, text: string): Promise<void>;
  sendMedia?(ctx: OutboundContext, media: MediaAttachment): Promise<void>;
  /**
   * jp36.3.1: outbound emoji reaction as a first-class social action
   * (design bible §8.3 / §13.5). Optional and gated by
   * {@link ChannelCapabilities.reactions}; a channel that advertises
   * `reactions: true` must implement this. A failed reaction
   * (unsupported emoji, missing permission, unresolved target) rejects so
   * the caller surfaces a visible delivery failure — it is never silently
   * converted into a text reply.
   */
  sendReaction?(ctx: OutboundContext, messageId: string, emoji: string): Promise<void>;
}

export interface ChannelGatewayAdapter extends Lifecycle {
  onMessage?(handler: MessageHandler): void;
}

export interface ChannelSecurityAdapter {
  supportsDirectMessages: boolean;
  requiresMentionForChannelMessages?: boolean;
  allowlist?: readonly string[];
}

export interface ChannelStreamingAdapter {
  typingIntervalMs?: number;
  sendTyping(channelId: string): Promise<void>;
}

export interface ChannelThreadingAdapter {
  toThreadChannelId(channelId: string, threadId: string): string;
  fromThreadChannelId(channelId: string): string | null;
}

export interface ChannelPromptAdapter {
  resolveChannelType(message: SubstrateMessage): string | undefined;
  resolveTaskKind?(message: SubstrateMessage): string | undefined;
}

export interface ChannelAdapterPort extends Lifecycle {
  id: string;
  name: string;
  meta: ChannelAdapterMeta;
  capabilities: ChannelCapabilities;
  config: ChannelConfigAdapter;
  outbound: ChannelOutboundAdapter;
  gateway: ChannelGatewayAdapter;
  security?: ChannelSecurityAdapter;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  prompt?: ChannelPromptAdapter;

  // Compatibility shim for existing call sites.
  onMessage?(handler: MessageHandler): void;
  send?(channelId: string, content: string): Promise<void>;
}

export type ChannelAdapter = ChannelAdapterPort;

export interface ChannelAdapterManifestEntry {
  id: string;
  enabled: boolean;
  required?: boolean;
  label?: string;
  eligibility?: EligibilityRequirements;
}

export interface ChannelAdapterFactoryPort {
  manifest: ChannelAdapterManifestEntry;
  create: () => Promise<ChannelAdapterPort> | ChannelAdapterPort;
}

export type ChannelAdapterFactoryEntry = ChannelAdapterFactoryPort;

// Lightweight docks for shared call sites that only need a focused channel facet.
export interface ChannelOutboundDock {
  id: string;
  outbound: Pick<ChannelOutboundAdapter, 'textChunkLimit' | 'sendText' | 'sendMedia' | 'sendReaction'>;
}

export interface ChannelPromptDock {
  id: string;
  capabilities: Pick<ChannelCapabilities, 'promptChannelType'>;
  prompt?: Pick<ChannelPromptAdapter, 'resolveChannelType' | 'resolveTaskKind'>;
}

export function asOutboundDock(adapter: ChannelAdapterPort): ChannelOutboundDock {
  return adapter;
}

export function asPromptDock(adapter: ChannelAdapterPort): ChannelPromptDock {
  return adapter;
}
