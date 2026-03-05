import type { AgentResponse, Attachment, Lifecycle, SubstrateMessage } from '../types.js';

export type MessageHandler = (message: SubstrateMessage) => Promise<AgentResponse>;
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

export interface ChannelAdapter extends Lifecycle {
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

export interface ChannelAdapterManifestEntry {
  id: string;
  enabled: boolean;
  required?: boolean;
  label?: string;
}

export interface ChannelAdapterFactoryEntry {
  manifest: ChannelAdapterManifestEntry;
  create: () => Promise<ChannelAdapter> | ChannelAdapter;
}

// Lightweight docks for shared call sites that only need a focused channel facet.
export interface ChannelOutboundDock {
  id: string;
  outbound: Pick<ChannelOutboundAdapter, 'textChunkLimit' | 'sendText'>;
}

export interface ChannelPromptDock {
  id: string;
  capabilities: Pick<ChannelCapabilities, 'promptChannelType'>;
  prompt?: Pick<ChannelPromptAdapter, 'resolveChannelType' | 'resolveTaskKind'>;
}

export function asOutboundDock(adapter: ChannelAdapter): ChannelOutboundDock {
  return adapter;
}

export function asPromptDock(adapter: ChannelAdapter): ChannelPromptDock {
  return adapter;
}
