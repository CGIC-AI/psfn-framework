import type {
  AgentResponse,
  Attachment,
  CompanionAvailabilityState,
  Lifecycle,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { ClarifyDeliverResult, PendingClarification } from '../../boundary/gateway/protocol.js';
import type { EligibilityRequirements } from '../../system/capabilities/eligibility.js';
import type {
  ChannelCapabilities,
  ChannelPromptAdapter,
  ChannelPromptDock,
  MessageHandlerOptions,
} from '../../shared/contracts/channel-prompt-port.js';

export type {
  ChannelCapabilities,
  ChannelPromptAdapter,
  ChannelPromptDock,
  MessageHandlerOptions,
};

export type MessageHandler = (
  message: SubstrateMessage,
  options?: MessageHandlerOptions,
) => Promise<AgentResponse>;

export interface ChannelAdapterMeta {
  label: string;
  emoji?: string;
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
  /**
   * vvf.5.2: render a structured clarification's ordered choices interactively
   * (Discord buttons, a Telegram numbered list) and await the human's answer up
   * to `timeoutMs`. Optional: only channels with a live interactive human
   * implement it. A resolved result carries a selection verified against the
   * delivered choices at source; timeout / unrecognized reply / out-of-range
   * choice fail closed as a `pending` no-answer (never a fabricated selection,
   * never a silent drop).
   *
   * `originatingUserId` is the channel-native id of the turn's author; the
   * channel binds the answer to that user so a different member of a shared
   * channel/group cannot answer another user's clarification. Implementations
   * fail closed when it is absent rather than accept an unbound answer.
   */
  deliverClarification?(
    clarification: PendingClarification,
    target: string,
    timeoutMs: number,
    originatingUserId?: string,
  ): Promise<ClarifyDeliverResult>;
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

export interface ChannelAvailabilityAdapter {
  setAvailability(
    state: CompanionAvailabilityState,
  ): Promise<'applied' | 'unsupported'>;
}

export interface ChannelThreadingAdapter {
  toThreadChannelId(channelId: string, threadId: string): string;
  fromThreadChannelId(channelId: string): string | null;
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
  availability?: ChannelAvailabilityAdapter;
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
  outbound: Pick<
    ChannelOutboundAdapter,
    'textChunkLimit' | 'sendText' | 'sendMedia' | 'sendReaction' | 'deliverClarification'
  >;
  availability?: Pick<ChannelAvailabilityAdapter, 'setAvailability'>;
}

export function asOutboundDock(adapter: ChannelAdapterPort): ChannelOutboundDock {
  return adapter;
}

export function asPromptDock(adapter: ChannelAdapterPort): ChannelPromptDock {
  return adapter;
}
