import type { ChannelPrivacyLevel } from '../../../core/contacts/types.js';

export interface AdminChatLinkedChannelOption {
  targetKind: 'identity' | 'conversation';
  channel: string;
  userId?: string;
  channelId?: string;
  privacyLevel: ChannelPrivacyLevel;
}

export interface AdminChatContactOption {
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: AdminChatLinkedChannelOption[];
}

export interface AdminChatSelectedTarget extends AdminChatLinkedChannelOption {
  canonicalContactId: string;
  sessionId: string;
}

export interface AdminChatBootstrapApiConfig {
  chatCompletionsUrl: string;
  voiceWebSocketUrl: string;
  apiKey?: string;
}

export interface AdminChatRuntimeAssetConfig {
  moduleUrl: string;
  stylesheetUrl: string;
}

export interface AdminChatRuntimeModelConfig {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  headers: Record<string, string>;
}

export interface AdminChatRuntimeConfig {
  assets: AdminChatRuntimeAssetConfig;
  transportHeaders: Record<string, string>;
  model: AdminChatRuntimeModelConfig;
  apiKey?: string;
}

export interface AdminChatPrivacyMetadata {
  availableLevels: ChannelPrivacyLevel[];
  selectedLevel: ChannelPrivacyLevel;
}

export interface AdminChatOnboardingMetadata {
  required: boolean;
  message?: string;
}

export interface AdminChatBootstrapResponse {
  contactOptions: AdminChatContactOption[];
  assistantName: string;
  canonicalContactId: string;
  displayName: string;
  nickname?: string;
  linkedChannels: AdminChatLinkedChannelOption[];
  selectedTarget: AdminChatSelectedTarget;
  privacy: AdminChatPrivacyMetadata;
  onboarding: AdminChatOnboardingMetadata;
  api: AdminChatBootstrapApiConfig;
  runtime: AdminChatRuntimeConfig;
  defaultSessionId: string;
  defaultAuthorName: string;
  defaultAuthorId: string;
}

export interface AdminChatBootstrapUpdateInput {
  canonicalContactId?: string;
  channel?: string;
  userId?: string;
  channelId?: string;
  privacyLevel?: ChannelPrivacyLevel;
  defaultAuthorName?: string;
  defaultAuthorId?: string;
}

export interface AdminModelRoomParticipant {
  id: string;
  slotKey: string;
  purpose: string;
  displayName: string;
  provider: string;
  model: string;
  maxTokens?: number;
  contextWindow?: number;
  defaultSystemPrompt?: string;
}

export interface AdminModelRoomBootstrapApiConfig {
  chatCompletionsUrl: string;
  apiKey?: string;
}

export interface AdminModelRoomCompanionConfig {
  id: string;
  displayName: string;
  defaultSystemPromptMode: 'default';
}

export interface AdminModelRoomBootstrapResponse {
  api: AdminModelRoomBootstrapApiConfig;
  defaultRoomId: string;
  companion: AdminModelRoomCompanionConfig;
  participants: AdminModelRoomParticipant[];
  constraints: {
    allowedProviders: string[];
    deniedProviders: string[];
  };
}
