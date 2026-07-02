import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  RelationshipType,
} from '../../../core/contacts/types.js';
import { CHANNEL_PRIVACY_LEVELS } from '../../../core/contacts/types.js';
import type { ModelCatalogEntry } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  createBootstrapStarterCard,
  isBootstrapStarterCard,
  loadCharacterCard,
} from '../../../core/identity/loader.js';
import { resolveCompanionIdFromConfig } from '../../../core/identity/companion-runtime.js';
import type { CharacterCardV2 } from '../../../core/identity/types.js';
import type {
  AdminChatBootstrapResponse,
  AdminChatBootstrapUpdateInput,
  AdminChatContactOption,
  AdminChatLinkedChannelOption,
  AdminChatOnboardingMetadata,
  AdminChatRuntimeModelConfig,
  AdminModelRoomBootstrapResponse,
  AdminModelRoomParticipant,
} from './types.js';
import {
  buildAbsoluteAdminChatApiUrl,
  resolveAdminChatApiBaseUrl,
} from './api-base-url.js';

const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const VOICE_WEBSOCKET_PATH = '/v1/voice/ws';
const OPENAI_API_BASE_PATH = '/v1';
const DEFAULT_MODEL_ROOM_ID = 'garden-model-room';
const STARTER_IDENTITY_ONBOARDING_MESSAGE = 'Starter identity is active. Import a character card or edit Identity to personalize your companion.';
const MODEL_ROOM_DIRECT_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

export class AdminChatBootstrapSetupError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    const normalized = issues.map(issue => issue.trim()).filter(Boolean);
    super(`Admin chat bootstrap incomplete: ${normalized.join('; ')}`);
    this.name = 'AdminChatBootstrapSetupError';
    this.issues = normalized;
  }
}

interface ContactCandidate extends AdminChatContactOption {
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
}

interface SelectionState {
  canonicalContactId?: string;
  channel?: string;
  userId?: string;
  channelId?: string;
  defaultAuthorName?: string;
  defaultAuthorId?: string;
}

interface AdminChatBootstrapServiceOptions {
  apiKey?: string;
  apiBaseUrl?: string;
  apiHost?: string;
  apiPort?: number;
  config?: SubstrateConfig;
  resolveGlobalDefaultSessionId?: () => string | null;
}

interface AdminChatBootstrapRuntimeOptions {
  requestOrigin?: string;
  /** Per-call override for the API base URL, e.g. from editable settings.
   *  Takes priority over the constructor-level `apiBaseUrl` option. */
  settingsApiBaseUrl?: string;
}

function normalizeTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeChannel(channel: string): string {
  const trimmed = channel.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function isSameTarget(
  left: Pick<AdminChatLinkedChannelOption, 'targetKind' | 'channel' | 'userId' | 'channelId'>,
  right: Pick<AdminChatLinkedChannelOption, 'targetKind' | 'channel' | 'userId' | 'channelId'>,
): boolean {
  if (left.targetKind !== right.targetKind || left.channel !== right.channel) return false;
  return left.targetKind === 'conversation'
    ? left.channelId === right.channelId
    : left.userId === right.userId;
}

function sanitizePurposeSuffix(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_');
}

function humanizeSlotKey(slotKey: string): string {
  const text = slotKey
    .replace(/[_./-]+/g, ' ')
    .trim();
  if (!text) return 'Model Participant';
  return text
    .split(/\s+/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function resolveParticipantDisplayName(slotKey: string, entry: ModelCatalogEntry): string {
  const described = entry.defaults?.description?.trim();
  if (described) return described;
  return humanizeSlotKey(slotKey);
}

function throwBootstrapSetupError(...issues: string[]): never {
  throw new AdminChatBootstrapSetupError(issues);
}

function isDefaultBootstrapStarterCard(card: CharacterCardV2): boolean {
  const expected = createBootstrapStarterCard();
  return JSON.stringify(card) === JSON.stringify(expected);
}

export class AdminChatBootstrapService {
  private readonly contactStore: ContactStorePort | null;
  private readonly configuredApiKey?: string;
  private readonly configuredApiBaseUrl?: string;
  private readonly configuredApiHost?: string;
  private readonly configuredApiPort?: number;
  private readonly runtimeConfig?: SubstrateConfig;
  private readonly resolveGlobalDefaultSessionIdFn: (() => string | null) | null;
  private selection: SelectionState = {};
  private selectionPinnedByUser = false;

  constructor(contactStore?: ContactStorePort | null, options: AdminChatBootstrapServiceOptions = {}) {
    this.contactStore = contactStore ?? null;
    this.configuredApiKey = normalizeTrimmed(options.apiKey);
    this.configuredApiBaseUrl = normalizeTrimmed(options.apiBaseUrl);
    this.configuredApiHost = normalizeTrimmed(options.apiHost);
    this.configuredApiPort = options.apiPort;
    this.runtimeConfig = options.config;
    this.resolveGlobalDefaultSessionIdFn = options.resolveGlobalDefaultSessionId ?? null;
  }

  async buildBootstrap(options: AdminChatBootstrapRuntimeOptions = {}): Promise<AdminChatBootstrapResponse> {
    return this.composeBootstrap(options);
  }

  async updateSelection(
    input: AdminChatBootstrapUpdateInput,
    options: AdminChatBootstrapRuntimeOptions = {},
  ): Promise<AdminChatBootstrapResponse> {
    const previousSelection: SelectionState = { ...this.selection };
    const previousSelectionPinnedByUser = this.selectionPinnedByUser;
    this.applySelectionInput(input);
    if (
      input.canonicalContactId !== undefined
      || input.channel !== undefined
      || input.userId !== undefined
      || input.channelId !== undefined
    ) {
      this.selectionPinnedByUser = true;
    }
    try {
      await this.persistSelectionMapping(input);
      return await this.composeBootstrap(options);
    } catch (error) {
      this.selection = previousSelection;
      this.selectionPinnedByUser = previousSelectionPinnedByUser;
      throw error;
    }
  }

  async buildModelRoomBootstrap(
    config: SubstrateConfig,
    options: AdminChatBootstrapRuntimeOptions = {},
  ): Promise<AdminModelRoomBootstrapResponse> {
    const apiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: options.settingsApiBaseUrl ?? this.configuredApiBaseUrl,
      apiHost: this.configuredApiHost,
      apiPort: this.configuredApiPort,
      browserOrigin: options.requestOrigin,
    });
    const chatCompletionsUrl = buildAbsoluteAdminChatApiUrl(CHAT_COMPLETIONS_PATH, apiBaseUrl);
    const participants = this.resolveModelRoomParticipants(config);
    if (participants.length === 0) {
      throwBootstrapSetupError(
        'no direct model-room participants are configured',
        'configure at least one direct provider model slot in models.json before opening model room bootstrap',
      );
    }

    return {
      api: {
        chatCompletionsUrl,
      },
      defaultRoomId: DEFAULT_MODEL_ROOM_ID,
      companion: {
        id: resolveCompanionIdFromConfig(config),
        displayName: this.resolveAssistantName(),
        defaultSystemPromptMode: 'default',
      },
      participants,
      constraints: {
        allowedProviders: [...MODEL_ROOM_DIRECT_PROVIDERS],
        deniedProviders: ['openrouter'],
      },
    };
  }

  private applySelectionInput(input: AdminChatBootstrapUpdateInput): void {
    const previousCanonicalContactId = this.selection.canonicalContactId;
    const previousChannel = this.selection.channel;
    const previousUserId = this.selection.userId;
    const previousChannelId = this.selection.channelId;
    let selectedTargetChanged = false;

    if (input.canonicalContactId !== undefined) {
      this.selection.canonicalContactId = normalizeTrimmed(input.canonicalContactId);
      if (this.selection.canonicalContactId !== previousCanonicalContactId) {
        selectedTargetChanged = true;
      }
    }

    if (input.defaultAuthorName !== undefined) {
      this.selection.defaultAuthorName = normalizeTrimmed(input.defaultAuthorName);
    }

    if (input.defaultAuthorId !== undefined) {
      this.selection.defaultAuthorId = normalizeTrimmed(input.defaultAuthorId);
    }

    if (input.privacyLevel && !CHANNEL_PRIVACY_LEVELS.includes(input.privacyLevel)) {
      throw new Error(`Invalid privacy level: ${input.privacyLevel}`);
    }

    const hasChannelField = input.channel !== undefined;
    const hasUserIdField = input.userId !== undefined;
    const hasChannelIdField = input.channelId !== undefined;
    const hasTargetIdentifier = hasUserIdField || hasChannelIdField;
    if (hasChannelField !== hasTargetIdentifier) {
      throw new Error('channel is required when updating a chat target');
    }
    if (hasUserIdField && hasChannelIdField) {
      throw new Error('Provide either userId or channelId, not both');
    }

    if (!hasChannelField || !hasTargetIdentifier) {
      if (selectedTargetChanged) {
        if (input.defaultAuthorName === undefined) {
          this.selection.defaultAuthorName = undefined;
        }
        if (input.defaultAuthorId === undefined) {
          this.selection.defaultAuthorId = undefined;
        }
      }
      return;
    }

    const normalizedChannel = normalizeTrimmed(input.channel);
    const normalizedUserId = normalizeTrimmed(input.userId);
    const normalizedChannelId = normalizeTrimmed(input.channelId);
    if (!normalizedChannel || (!normalizedUserId && !normalizedChannelId)) {
      throw new Error('channel and either userId or channelId must be non-empty');
    }

    this.selection.channel = normalizeChannel(normalizedChannel);
    this.selection.userId = normalizedUserId;
    this.selection.channelId = normalizedChannelId;
    if (
      this.selection.channel !== previousChannel
      || this.selection.userId !== previousUserId
      || this.selection.channelId !== previousChannelId
    ) {
      selectedTargetChanged = true;
    }

    if (selectedTargetChanged) {
      if (input.defaultAuthorName === undefined) {
        this.selection.defaultAuthorName = undefined;
      }
      if (input.defaultAuthorId === undefined) {
        this.selection.defaultAuthorId = undefined;
      }
    }
  }

  private async persistSelectionMapping(input: AdminChatBootstrapUpdateInput): Promise<void> {
    if (!this.contactStore) return;
    const selectedChannel = this.selection.channel;
    const selectedUserId = this.selection.userId;
    const selectedChannelId = this.selection.channelId;
    if (!selectedChannel || (!selectedUserId && !selectedChannelId)) return;

    const contacts = await this.loadContacts();
    const selectedContact = this.resolveSelectedContact(contacts, this.selection.canonicalContactId);

    if (selectedChannelId) {
      if (!input.privacyLevel) return;
      const updated = await this.contactStore.setConversationChannelPrivacy(
        selectedContact.canonicalContactId,
        selectedChannel,
        selectedChannelId,
        input.privacyLevel,
        'admin:chat:bootstrap',
      );
      if (!updated) {
        throw new Error(`Unable to update privacy for ${selectedChannel}:${selectedChannelId}`);
      }
      return;
    }
    if (!selectedUserId) return;

    const existingIdentity = selectedContact.linkedChannels.find(identity => (
      identity.channel === selectedChannel && identity.userId === selectedUserId
    ));

    if (!existingIdentity) {
      const linkResult = await this.contactStore.linkChannelIdentity(
        selectedContact.canonicalContactId,
        selectedChannel,
        selectedUserId,
        { privacyLevel: input.privacyLevel },
        'admin:chat:bootstrap',
      );

      if (linkResult === 'identity_conflict') {
        throw new Error(`Identity ${selectedChannel}:${selectedUserId} is already linked to another contact`);
      }
      if (linkResult === 'contact_not_found') {
        throw new Error(`Contact ${selectedContact.canonicalContactId} was not found`);
      }
    }

    if (input.privacyLevel) {
      const updated = await this.contactStore.setChannelPrivacy(
        selectedContact.canonicalContactId,
        selectedChannel,
        selectedUserId,
        input.privacyLevel,
        'admin:chat:bootstrap',
      );
      if (!updated) {
        throw new Error(`Unable to update privacy for ${selectedChannel}:${selectedUserId}`);
      }
    }
  }

  private async composeBootstrap(options: AdminChatBootstrapRuntimeOptions): Promise<AdminChatBootstrapResponse> {
    const contacts = await this.loadContacts();
    const selectedContact = this.resolveSelectedContact(contacts, this.selection.canonicalContactId);
    const selectedTarget = this.resolveSelectedTarget(
      selectedContact,
      this.selection.channel,
      this.selection.userId,
      this.selection.channelId,
    );
    const apiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: options.settingsApiBaseUrl ?? this.configuredApiBaseUrl,
      apiHost: this.configuredApiHost,
      apiPort: this.configuredApiPort,
      browserOrigin: options.requestOrigin,
    });
    const selectedLinkedChannels = this.withSelectedTarget(
      selectedContact.linkedChannels,
      selectedTarget,
    );

    this.selection.canonicalContactId = selectedContact.canonicalContactId;
    this.selection.channel = selectedTarget.channel;
    this.selection.userId = selectedTarget.userId;
    this.selection.channelId = selectedTarget.channelId;

    const defaultAuthorName = this.selection.defaultAuthorName ?? (selectedContact.nickname ?? selectedContact.displayName);
    const defaultAuthorId = this.selection.defaultAuthorId ?? this.resolveDefaultAuthorId(selectedContact, selectedTarget);
    this.selection.defaultAuthorName = defaultAuthorName;
    this.selection.defaultAuthorId = defaultAuthorId;
    const selectedSessionId = selectedTarget.targetKind === 'conversation'
      ? selectedTarget.channelId ?? `${selectedTarget.channel}:unknown`
      : `${selectedTarget.channel}:${selectedTarget.userId ?? 'unknown'}`;
    const globalDefaultSessionId = this.selectionPinnedByUser
      ? undefined
      : normalizeTrimmed(this.resolveGlobalDefaultSessionIdFn?.() ?? undefined);
    const defaultSessionId = globalDefaultSessionId ?? selectedSessionId;
    const transportHeaders = this.buildTransportHeaders(
      defaultSessionId,
      defaultAuthorId,
      defaultAuthorName,
      selectedTarget.privacyLevel,
      selectedContact.canonicalContactId,
    );
    const chatCompletionsUrl = buildAbsoluteAdminChatApiUrl(CHAT_COMPLETIONS_PATH, apiBaseUrl);
    const voiceWebSocketUrl = buildAbsoluteAdminChatApiUrl(VOICE_WEBSOCKET_PATH, apiBaseUrl);
    const openAiBaseUrl = buildAbsoluteAdminChatApiUrl(OPENAI_API_BASE_PATH, apiBaseUrl);
    const runtimeModel = this.resolveRuntimeModel(openAiBaseUrl, transportHeaders);
    const assistantName = this.resolveAssistantName();
    const onboarding = this.resolveOnboardingMetadata();

    return {
      contactOptions: contacts.map(contact => ({
        canonicalContactId: contact.canonicalContactId,
        displayName: contact.displayName,
        nickname: contact.nickname,
        linkedChannels: contact.canonicalContactId === selectedContact.canonicalContactId
          ? selectedLinkedChannels
          : contact.linkedChannels,
      })),
      assistantName,
      canonicalContactId: selectedContact.canonicalContactId,
      displayName: selectedContact.displayName,
      nickname: selectedContact.nickname,
      linkedChannels: selectedLinkedChannels,
      selectedTarget: {
        canonicalContactId: selectedContact.canonicalContactId,
        targetKind: selectedTarget.targetKind,
        channel: selectedTarget.channel,
        userId: selectedTarget.userId,
        channelId: selectedTarget.channelId,
        privacyLevel: selectedTarget.privacyLevel,
        sessionId: selectedSessionId,
      },
      privacy: {
        availableLevels: [...CHANNEL_PRIVACY_LEVELS],
        selectedLevel: selectedTarget.privacyLevel,
      },
      onboarding,
      api: {
        chatCompletionsUrl,
        voiceWebSocketUrl,
      },
      runtime: {
        transportHeaders,
        model: runtimeModel,
      },
      defaultSessionId,
      defaultAuthorName,
      defaultAuthorId,
    };
  }

  private resolveModelRoomParticipants(config: SubstrateConfig): AdminModelRoomParticipant[] {
    const catalog = config.modelCatalog ?? {};
    const assignments = config.modelRoleAssignments ?? {};
    const purposeBySlot = new Map<string, string>();
    for (const [purpose, slotKey] of Object.entries(assignments)) {
      if (!purpose || !slotKey) continue;
      if (!purposeBySlot.has(slotKey)) {
        purposeBySlot.set(slotKey, purpose);
      }
    }

    const participants: AdminModelRoomParticipant[] = [];
    for (const [slotKey, entry] of Object.entries(catalog)) {
      const provider = entry.provider.trim().toLowerCase();
      if (!MODEL_ROOM_DIRECT_PROVIDERS.has(provider)) continue;
      participants.push({
        id: slotKey,
        slotKey,
        purpose: purposeBySlot.get(slotKey) ?? `model_room.${sanitizePurposeSuffix(slotKey)}`,
        displayName: resolveParticipantDisplayName(slotKey, entry),
        provider,
        model: entry.model,
        ...(entry.overrides?.maxTokens !== undefined
          ? { maxTokens: entry.overrides.maxTokens }
          : (entry.defaults?.maxTokens !== undefined ? { maxTokens: entry.defaults.maxTokens } : {})),
        ...(entry.overrides?.contextWindow !== undefined
          ? { contextWindow: entry.overrides.contextWindow }
          : (entry.defaults?.contextWindow !== undefined ? { contextWindow: entry.defaults.contextWindow } : {})),
        defaultSystemPrompt: '',
      });
    }

    return participants.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  private resolveApiKey(): string | undefined {
    return this.configuredApiKey ?? normalizeTrimmed(process.env.API_KEY);
  }

  private resolveRuntimeModel(
    openAiBaseUrl: string,
    transportHeaders: Record<string, string>,
  ): AdminChatRuntimeModelConfig {
    const config = this.runtimeConfig;
    const chatSlot = config?.modelRoster.chat;
    const slotKey = config?.modelRoleAssignments?.chat;
    const catalogEntry = slotKey ? config.modelCatalog?.[slotKey] : undefined;
    const provider = normalizeTrimmed(catalogEntry?.provider)
      ?? normalizeTrimmed(chatSlot?.provider)
      ?? normalizeTrimmed(config?.primaryProvider);
    const modelId = normalizeTrimmed(catalogEntry?.model)
      ?? normalizeTrimmed(chatSlot?.model)
      ?? normalizeTrimmed(config?.primaryModel);
    if (!provider || !modelId) {
      throwBootstrapSetupError(
        !provider ? 'chat runtime provider is not configured' : '',
        !modelId ? 'chat runtime model is not configured' : '',
      );
    }
    const modelName = normalizeTrimmed(catalogEntry?.defaults?.description)
      ?? normalizeTrimmed(chatSlot?.model)
      ?? normalizeTrimmed(config?.primaryModel)
      ?? modelId;

    return {
      id: modelId,
      name: modelName,
      provider: provider.toLowerCase(),
      api: 'openai-completions',
      baseUrl: openAiBaseUrl,
      headers: transportHeaders,
    };
  }

  private buildTransportHeaders(
    defaultSessionId: string,
    defaultAuthorId: string,
    defaultAuthorName: string,
    privacyLevel: ChannelPrivacyLevel,
    canonicalContactId: string,
  ): Record<string, string> {
    return {
      'X-Session-ID': defaultSessionId,
      'X-User-ID': defaultAuthorId,
      'X-User-Name': defaultAuthorName,
      'X-Channel-Privacy': privacyLevel,
      'X-Canonical-Contact-ID': canonicalContactId,
    };
  }

  private withSelectedTarget(
    channels: AdminChatLinkedChannelOption[],
    selected: AdminChatLinkedChannelOption,
  ): AdminChatLinkedChannelOption[] {
    if (channels.some(channel => isSameTarget(channel, selected))) {
      return [...channels];
    }
    return [selected, ...channels];
  }

  private resolveSelectedContact(
    contacts: ContactCandidate[],
    preferredCanonicalContactId: string | undefined,
  ): ContactCandidate {
    const preferred = preferredCanonicalContactId
      ? contacts.find(contact => contact.canonicalContactId === preferredCanonicalContactId)
      : undefined;
    if (preferred) return preferred;

    const selectableContacts = contacts.filter(contact => contact.linkedChannels.length > 0);
    const primary = selectableContacts.find(contact => contact.trustLevel === 'primary');
    if (primary) return primary;

    const partner = selectableContacts.find(contact => contact.relationshipType === 'partner');
    if (partner) return partner;

    const firstSelectable = selectableContacts.at(0);
    if (firstSelectable) return firstSelectable;

    throwBootstrapSetupError(
      'no selectable contacts are available',
      'contacts must have at least one linked channel for admin chat bootstrap',
    );
  }

  private resolveSelectedTarget(
    selectedContact: ContactCandidate,
    preferredChannel: string | undefined,
    preferredUserId: string | undefined,
    preferredChannelId: string | undefined,
  ): AdminChatLinkedChannelOption {
    if (preferredChannel && preferredChannelId) {
      const conversation = selectedContact.linkedChannels.find(link => (
        link.targetKind === 'conversation'
        && link.channel === preferredChannel
        && link.channelId === preferredChannelId
      ));
      if (conversation) return conversation;

      throwBootstrapSetupError(
        `selected contact does not have conversation target ${preferredChannel}:${preferredChannelId}`,
      );
    }

    if (preferredChannel && preferredUserId) {
      const linked = selectedContact.linkedChannels.find(link => (
        link.targetKind === 'identity'
        && link.channel === preferredChannel
        && link.userId === preferredUserId
      ));
      if (linked) return linked;

      throwBootstrapSetupError(
        `selected contact does not have linked identity ${preferredChannel}:${preferredUserId}`,
      );
    }

    const firstLinkedChannel = selectedContact.linkedChannels.at(0);
    if (firstLinkedChannel) return firstLinkedChannel;

    throwBootstrapSetupError(
      `contact ${selectedContact.canonicalContactId} has no linked channels for admin chat bootstrap`,
    );
  }

  private resolveDefaultAuthorId(
    selectedContact: ContactCandidate,
    selectedTarget: AdminChatLinkedChannelOption,
  ): string {
    if (selectedTarget.targetKind === 'identity' && selectedTarget.userId) {
      return selectedTarget.userId;
    }

    return selectedTarget.channelId ?? selectedContact.canonicalContactId;
  }

  private async loadContacts(): Promise<ContactCandidate[]> {
    if (!this.contactStore) {
      throwBootstrapSetupError('contact store is not configured');
    }

    const contacts = await this.contactStore.listAll();
    if (contacts.length === 0) {
      throwBootstrapSetupError('no contacts are available for admin chat bootstrap');
    }

    return contacts.map(contact => this.contactToCandidate(contact));
  }

  private contactToCandidate(contact: Contact): ContactCandidate {
    const linkedChannels = this.getChannelTargets(contact);
    return {
      canonicalContactId: contact.id,
      displayName: contact.displayName,
      nickname: normalizeTrimmed(contact.nickname),
      linkedChannels,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
    };
  }

  private getChannelTargets(contact: Contact): AdminChatLinkedChannelOption[] {
    const links: AdminChatLinkedChannelOption[] = [];
    const seen = new Set<string>();
    const addIdentity = (channel: string, userId: string, privacyLevel?: ChannelPrivacyLevel): void => {
      const normalizedUserId = normalizeTrimmed(userId);
      if (!normalizedUserId) return;
      const normalizedChannel = normalizeChannel(channel);
      const key = `identity:${normalizedChannel}:${normalizedUserId}`;
      if (seen.has(key)) return;
      seen.add(key);

      links.push({
        targetKind: 'identity',
        channel: normalizedChannel,
        userId: normalizedUserId,
        privacyLevel: privacyLevel && CHANNEL_PRIVACY_LEVELS.includes(privacyLevel)
          ? privacyLevel
          : this.defaultPrivacyForChannel(normalizedChannel),
      });
    };
    const addConversation = (channel: string, channelId: string, privacyLevel?: ChannelPrivacyLevel): void => {
      const normalizedChannelId = normalizeTrimmed(channelId);
      if (!normalizedChannelId) return;
      const normalizedChannel = normalizeChannel(channel);
      const key = `conversation:${normalizedChannel}:${normalizedChannelId}`;
      if (seen.has(key)) return;
      seen.add(key);

      links.push({
        targetKind: 'conversation',
        channel: normalizedChannel,
        channelId: normalizedChannelId,
        privacyLevel: privacyLevel && CHANNEL_PRIVACY_LEVELS.includes(privacyLevel)
          ? privacyLevel
          : this.defaultPrivacyForChannel(normalizedChannel),
      });
    };

    if (Array.isArray(contact.channels) && contact.channels.length > 0) {
      for (const channel of contact.channels) {
        addIdentity(channel.channel, channel.userId, channel.privacyLevel);
      }
    }

    if (Array.isArray(contact.channelIdentities) && contact.channelIdentities.length > 0) {
      for (const identity of contact.channelIdentities) {
        addIdentity(identity.channel, identity.userId);
      }
    }

    if (Array.isArray(contact.conversationChannels) && contact.conversationChannels.length > 0) {
      for (const channel of contact.conversationChannels) {
        addConversation(channel.channel, channel.channelId, channel.privacyLevel);
      }
    }

    if (contact.discordUserId) {
      addIdentity('discord', contact.discordUserId, 'invite_only');
    }

    return links;
  }

  private resolveAssistantName(): string {
    const card = this.loadCurrentCharacterCard();
    const configuredName = normalizeTrimmed(this.runtimeConfig?.characterName);
    if (card && !(configuredName && isDefaultBootstrapStarterCard(card))) {
      const cardName = normalizeTrimmed(card.data.name);
      if (cardName) return cardName;
    }
    if (configuredName) return configuredName;
    throwBootstrapSetupError(
      'assistant name is not configured',
      'provide a character card name or runtime characterName before opening admin chat',
    );
  }

  private resolveOnboardingMetadata(): AdminChatOnboardingMetadata {
    const card = this.loadCurrentCharacterCard();
    const configuredName = normalizeTrimmed(this.runtimeConfig?.characterName);
    if (card && isBootstrapStarterCard(card) && !(configuredName && isDefaultBootstrapStarterCard(card))) {
      return {
        required: true,
        message: STARTER_IDENTITY_ONBOARDING_MESSAGE,
      };
    }
    return { required: false };
  }

  private loadCurrentCharacterCard(): CharacterCardV2 | null {
    const path = normalizeTrimmed(this.runtimeConfig?.characterCardPath);
    if (!path) return null;
    try {
      return loadCharacterCard(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throwBootstrapSetupError(`character card could not be loaded: ${message}`);
    }
  }

  private defaultPrivacyForChannel(channel: string): ChannelPrivacyLevel {
    const normalizedChannel = normalizeChannel(channel);
    if (
      normalizedChannel === 'api'
      || normalizedChannel === 'internal'
      || normalizedChannel === 'subagent'
      || normalizedChannel === 'shard'
    ) {
      return 'private';
    }
    if (normalizedChannel === 'twitter' || normalizedChannel === 'rss' || normalizedChannel === 'broadcast') {
      return 'broadcast';
    }
    return 'invite_only';
  }
}
