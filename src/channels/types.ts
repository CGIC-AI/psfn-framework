import type { AgentResponse, Lifecycle, SubstrateMessage } from '../types.js';

export type MessageHandler = (message: SubstrateMessage) => Promise<AgentResponse>;

export interface ChannelAdapter extends Lifecycle {
  readonly name: string;
  onMessage(handler: MessageHandler): void;
  send(channelId: string, content: string): Promise<void>;
}
