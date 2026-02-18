import type { ChannelPrivacyLevel } from '../../../contacts/types.js';

export interface AdminChatLinkedChannelOption {
  channel: string;
  userId: string;
  privacyLevel: ChannelPrivacyLevel;
}

export interface AdminChatContactOption {
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: AdminChatLinkedChannelOption[];
}

export interface AdminChatSelectedIdentity extends AdminChatLinkedChannelOption {
  canonicalContactId: string;
}

export interface AdminChatBootstrapApiConfig {
  chatCompletionsUrl: string;
  voiceWebSocketUrl: string;
  apiKey?: string;
}

export interface AdminChatPrivacyMetadata {
  availableLevels: ChannelPrivacyLevel[];
  selectedLevel: ChannelPrivacyLevel;
}

export interface AdminChatBootstrapResponse {
  contactOptions: AdminChatContactOption[];
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: AdminChatLinkedChannelOption[];
  selectedIdentity: AdminChatSelectedIdentity;
  privacy: AdminChatPrivacyMetadata;
  api: AdminChatBootstrapApiConfig;
  defaultSessionId: string;
  defaultAuthorName: string;
  defaultAuthorId: string;
}

export interface AdminChatBootstrapUpdateInput {
  canonicalContactId?: string;
  channel?: string;
  userId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  defaultAuthorName?: string;
  defaultAuthorId?: string;
}
