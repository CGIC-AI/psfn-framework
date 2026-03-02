import type { ContactStore } from '../../../contacts/store.js';
import type { TrustLevel } from '../../../trust/types.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  RelationshipType,
} from '../../../contacts/types.js';
import { CHANNEL_PRIVACY_LEVELS } from '../../../contacts/types.js';
import type {
  ModelCatalogEntry,
  SubstrateConfig,
} from '../../../types.js';
import type {
  AdminChatBootstrapResponse,
  AdminChatBootstrapUpdateInput,
  AdminChatContactOption,
  AdminChatLinkedChannelOption,
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
const PI_WEB_UI_MODULE_ROUTE = '/static/pi-web-ui/index.js';
const PI_WEB_UI_STYLESHEET_ROUTE = '/static/pi-web-ui/app.css';
const DEFAULT_RUNTIME_PROVIDER = 'openai';
const DEFAULT_RUNTIME_MODEL_ID = 'openai/gpt-4.1-mini';
const DEFAULT_RUNTIME_MODEL_NAME = 'Garden Chat';
const SYNTHETIC_CONTACT_ID = 'admin.synthetic.default';
const SYNTHETIC_DISPLAY_NAME = 'Primary Contact';
const SYNTHETIC_CHANNEL = 'api';
const SYNTHETIC_USER_ID = 'admin-user';
const DEFAULT_MODEL_ROOM_ID = 'garden-model-room';
const MODEL_ROOM_DIRECT_PROVIDERS = new Set(['anthropic', 'openai', 'google']);

interface ContactCandidate extends AdminChatContactOption {
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  synthetic: boolean;
}

interface SelectionState {
  canonicalContactId?: string;
  channel?: string;
  userId?: string;
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

function isSameIdentity(
  left: Pick<AdminChatLinkedChannelOption, 'channel' | 'userId'>,
  right: Pick<AdminChatLinkedChannelOption, 'channel' | 'userId'>,
): boolean {
  return left.channel === right.channel && left.userId === right.userId;
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

export class AdminChatBootstrapService {
  private readonly contactStore: ContactStore | null;
  private readonly configuredApiKey?: string;
  private readonly configuredApiBaseUrl?: string;
  private readonly configuredApiHost?: string;
  private readonly configuredApiPort?: number;
  private readonly runtimeConfig?: SubstrateConfig;
  private readonly resolveGlobalDefaultSessionIdFn: (() => string | null) | null;
  private selection: SelectionState = {};
  private selectionPinnedByUser = false;

  constructor(contactStore?: ContactStore | null, options: AdminChatBootstrapServiceOptions = {}) {
    this.contactStore = contactStore ?? null;
    this.configuredApiKey = normalizeTrimmed(options.apiKey);
    this.configuredApiBaseUrl = normalizeTrimmed(options.apiBaseUrl);
    this.configuredApiHost = normalizeTrimmed(options.apiHost);
    this.configuredApiPort = options.apiPort;
    this.runtimeConfig = options.config;
    this.resolveGlobalDefaultSessionIdFn = options.resolveGlobalDefaultSessionId ?? null;
  }

  buildBootstrap(options: AdminChatBootstrapRuntimeOptions = {}): AdminChatBootstrapResponse {
    return this.composeBootstrap(options);
  }

  updateSelection(
    input: AdminChatBootstrapUpdateInput,
    options: AdminChatBootstrapRuntimeOptions = {},
  ): AdminChatBootstrapResponse {
    this.applySelectionInput(input);
    if (
      input.canonicalContactId !== undefined
      || input.channel !== undefined
      || input.userId !== undefined
    ) {
      this.selectionPinnedByUser = true;
    }
    this.persistSelectionMapping(input);
    return this.composeBootstrap(options);
  }

  buildModelRoomBootstrap(
    config: SubstrateConfig,
    options: AdminChatBootstrapRuntimeOptions = {},
  ): AdminModelRoomBootstrapResponse {
    const apiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: options.settingsApiBaseUrl ?? this.configuredApiBaseUrl,
      apiHost: this.configuredApiHost,
      apiPort: this.configuredApiPort,
      browserOrigin: options.requestOrigin,
    });
    const chatCompletionsUrl = buildAbsoluteAdminChatApiUrl(CHAT_COMPLETIONS_PATH, apiBaseUrl);
    const participants = this.resolveModelRoomParticipants(config);

    return {
      api: {
        chatCompletionsUrl,
        apiKey: this.resolveApiKey(),
      },
      defaultRoomId: DEFAULT_MODEL_ROOM_ID,
      psfn: {
        id: 'psfn',
        displayName: 'PSFN',
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
    if (input.canonicalContactId !== undefined) {
      this.selection.canonicalContactId = normalizeTrimmed(input.canonicalContactId);
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
    if (hasChannelField !== hasUserIdField) {
      throw new Error('Both channel and userId are required to update selected identity');
    }

    if (!hasChannelField || !hasUserIdField) return;

    const normalizedChannel = normalizeTrimmed(input.channel);
    const normalizedUserId = normalizeTrimmed(input.userId);
    if (!normalizedChannel || !normalizedUserId) {
      throw new Error('Both channel and userId must be non-empty');
    }

    this.selection.channel = normalizeChannel(normalizedChannel);
    this.selection.userId = normalizedUserId;
  }

  private persistSelectionMapping(input: AdminChatBootstrapUpdateInput): void {
    if (!this.contactStore) return;
    const selectedChannel = this.selection.channel;
    const selectedUserId = this.selection.userId;
    if (!selectedChannel || !selectedUserId) return;

    const contacts = this.loadContacts();
    const selectedContact = this.resolveSelectedContact(contacts, this.selection.canonicalContactId);
    if (selectedContact.synthetic) return;

    const existingIdentity = selectedContact.linkedChannels.find(identity => (
      identity.channel === selectedChannel && identity.userId === selectedUserId
    ));

    if (!existingIdentity) {
      const linkResult = this.contactStore.linkChannelIdentity(
        selectedContact.canonicalContactId,
        selectedChannel,
        selectedUserId,
        { privacyLevel: input.privacyLevel },
      );

      if (linkResult === 'identity_conflict') {
        throw new Error(`Identity ${selectedChannel}:${selectedUserId} is already linked to another contact`);
      }
      if (linkResult === 'contact_not_found') {
        throw new Error(`Contact ${selectedContact.canonicalContactId} was not found`);
      }
    }

    if (input.privacyLevel) {
      const updated = this.contactStore.setChannelPrivacy(
        selectedContact.canonicalContactId,
        selectedChannel,
        selectedUserId,
        input.privacyLevel,
      );
      if (!updated) {
        throw new Error(`Unable to update privacy for ${selectedChannel}:${selectedUserId}`);
      }
    }
  }

  private composeBootstrap(options: AdminChatBootstrapRuntimeOptions): AdminChatBootstrapResponse {
    const contacts = this.loadContacts();
    const selectedContact = this.resolveSelectedContact(contacts, this.selection.canonicalContactId);
    const selectedIdentity = this.resolveSelectedIdentity(
      selectedContact,
      this.selection.channel,
      this.selection.userId,
    );
    const apiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: options.settingsApiBaseUrl ?? this.configuredApiBaseUrl,
      apiHost: this.configuredApiHost,
      apiPort: this.configuredApiPort,
      browserOrigin: options.requestOrigin,
    });
    const selectedLinkedChannels = this.withSelectedIdentity(
      selectedContact.linkedChannels,
      selectedIdentity,
    );

    this.selection.canonicalContactId = selectedContact.canonicalContactId;
    this.selection.channel = selectedIdentity.channel;
    this.selection.userId = selectedIdentity.userId;

    const defaultAuthorName = this.selection.defaultAuthorName ?? selectedContact.displayName;
    const defaultAuthorId = this.selection.defaultAuthorId ?? selectedIdentity.userId;
    this.selection.defaultAuthorName = defaultAuthorName;
    this.selection.defaultAuthorId = defaultAuthorId;
    const selectedIdentitySessionId = `${selectedIdentity.channel}:${selectedIdentity.userId}`;
    const globalDefaultSessionId = this.selectionPinnedByUser
      ? undefined
      : normalizeTrimmed(this.resolveGlobalDefaultSessionIdFn?.() ?? undefined);
    const defaultSessionId = globalDefaultSessionId ?? selectedIdentitySessionId;
    const apiKey = this.resolveApiKey();
    const transportHeaders = this.buildTransportHeaders(defaultSessionId, defaultAuthorId, defaultAuthorName);
    const chatCompletionsUrl = buildAbsoluteAdminChatApiUrl(CHAT_COMPLETIONS_PATH, apiBaseUrl);
    const voiceWebSocketUrl = buildAbsoluteAdminChatApiUrl(VOICE_WEBSOCKET_PATH, apiBaseUrl);
    const openAiBaseUrl = buildAbsoluteAdminChatApiUrl(OPENAI_API_BASE_PATH, apiBaseUrl);
    const runtimeModel = this.resolveRuntimeModel(openAiBaseUrl, transportHeaders);

    return {
      contactOptions: contacts.map(contact => ({
        canonicalContactId: contact.canonicalContactId,
        displayName: contact.displayName,
        nickname: contact.nickname,
        linkedChannels: contact.canonicalContactId === selectedContact.canonicalContactId
          ? selectedLinkedChannels
          : contact.linkedChannels,
      })),
      canonicalContactId: selectedContact.canonicalContactId,
      displayName: selectedContact.displayName,
      nickname: selectedContact.nickname,
      linkedChannels: selectedLinkedChannels,
      selectedIdentity: {
        canonicalContactId: selectedContact.canonicalContactId,
        channel: selectedIdentity.channel,
        userId: selectedIdentity.userId,
        privacyLevel: selectedIdentity.privacyLevel,
      },
      privacy: {
        availableLevels: [...CHANNEL_PRIVACY_LEVELS],
        selectedLevel: selectedIdentity.privacyLevel,
      },
      api: {
        chatCompletionsUrl,
        voiceWebSocketUrl,
        apiKey,
      },
      runtime: {
        assets: {
          moduleUrl: PI_WEB_UI_MODULE_ROUTE,
          stylesheetUrl: PI_WEB_UI_STYLESHEET_ROUTE,
        },
        transportHeaders,
        model: runtimeModel,
        apiKey,
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
    const chatSlot = config?.modelRoster?.chat;
    const slotKey = config?.modelRoleAssignments?.chat;
    const catalogEntry = slotKey ? config?.modelCatalog?.[slotKey] : undefined;
    const provider = normalizeTrimmed(catalogEntry?.provider)
      ?? normalizeTrimmed(chatSlot?.provider)
      ?? normalizeTrimmed(config?.primaryProvider)
      ?? DEFAULT_RUNTIME_PROVIDER;
    const modelId = normalizeTrimmed(catalogEntry?.model)
      ?? normalizeTrimmed(chatSlot?.model)
      ?? normalizeTrimmed(config?.primaryModel)
      ?? DEFAULT_RUNTIME_MODEL_ID;
    const modelName = normalizeTrimmed(catalogEntry?.defaults?.description)
      ?? normalizeTrimmed(chatSlot?.model)
      ?? normalizeTrimmed(config?.primaryModel)
      ?? DEFAULT_RUNTIME_MODEL_NAME;

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
  ): Record<string, string> {
    return {
      'X-Session-ID': defaultSessionId,
      'X-User-ID': defaultAuthorId,
      'X-User-Name': defaultAuthorName,
    };
  }

  private withSelectedIdentity(
    channels: AdminChatLinkedChannelOption[],
    selected: AdminChatLinkedChannelOption,
  ): AdminChatLinkedChannelOption[] {
    if (channels.some(channel => isSameIdentity(channel, selected))) {
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

    const primary = contacts.find(contact => contact.trustLevel === 'primary');
    if (primary) return primary;

    const partner = contacts.find(contact => contact.relationshipType === 'partner');
    if (partner) return partner;

    return contacts[0];
  }

  private resolveSelectedIdentity(
    selectedContact: ContactCandidate,
    preferredChannel: string | undefined,
    preferredUserId: string | undefined,
  ): AdminChatLinkedChannelOption {
    if (preferredChannel && preferredUserId) {
      const linked = selectedContact.linkedChannels.find(link => (
        link.channel === preferredChannel && link.userId === preferredUserId
      ));
      if (linked) return linked;

      return {
        channel: preferredChannel,
        userId: preferredUserId,
        privacyLevel: this.defaultPrivacyForChannel(preferredChannel),
      };
    }

    return selectedContact.linkedChannels[0];
  }

  private loadContacts(): ContactCandidate[] {
    if (!this.contactStore) return [this.syntheticContact()];

    const contacts = this.contactStore.listAll();
    if (contacts.length === 0) return [this.syntheticContact()];

    return contacts.map(contact => this.contactToCandidate(contact));
  }

  private contactToCandidate(contact: Contact): ContactCandidate {
    const linkedChannels = this.getLinkedChannels(contact);
    return {
      canonicalContactId: contact.id,
      displayName: contact.displayName,
      nickname: normalizeTrimmed(contact.nickname),
      linkedChannels: linkedChannels.length > 0
        ? linkedChannels
        : [this.fallbackContactChannel(contact.id)],
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      synthetic: false,
    };
  }

  private getLinkedChannels(contact: Contact): AdminChatLinkedChannelOption[] {
    const links: AdminChatLinkedChannelOption[] = [];
    const seen = new Set<string>();
    const addChannel = (channel: string, userId: string, privacyLevel?: ChannelPrivacyLevel): void => {
      const normalizedUserId = normalizeTrimmed(userId);
      if (!normalizedUserId) return;
      const normalizedChannel = normalizeChannel(channel);
      const key = `${normalizedChannel}:${normalizedUserId}`;
      if (seen.has(key)) return;
      seen.add(key);

      links.push({
        channel: normalizedChannel,
        userId: normalizedUserId,
        privacyLevel: privacyLevel && CHANNEL_PRIVACY_LEVELS.includes(privacyLevel)
          ? privacyLevel
          : this.defaultPrivacyForChannel(normalizedChannel),
      });
    };

    if (Array.isArray(contact.channels) && contact.channels.length > 0) {
      for (const channel of contact.channels) {
        addChannel(channel.channel, channel.userId, channel.privacyLevel);
      }
      return links;
    }

    if (Array.isArray(contact.channelIdentities) && contact.channelIdentities.length > 0) {
      for (const identity of contact.channelIdentities) {
        addChannel(identity.channel, identity.userId);
      }
      return links;
    }

    if (contact.discordUserId) {
      addChannel('discord', contact.discordUserId, 'semi_private');
    }

    return links;
  }

  private fallbackContactChannel(contactId: string): AdminChatLinkedChannelOption {
    return {
      channel: 'contact',
      userId: contactId,
      privacyLevel: 'private',
    };
  }

  private syntheticContact(): ContactCandidate {
    return {
      canonicalContactId: SYNTHETIC_CONTACT_ID,
      displayName: SYNTHETIC_DISPLAY_NAME,
      nickname: undefined,
      linkedChannels: [{
        channel: SYNTHETIC_CHANNEL,
        userId: SYNTHETIC_USER_ID,
        privacyLevel: this.defaultPrivacyForChannel(SYNTHETIC_CHANNEL),
      }],
      trustLevel: 'regular',
      relationshipType: 'stranger',
      synthetic: true,
    };
  }

  private defaultPrivacyForChannel(channel: string): ChannelPrivacyLevel {
    const normalizedChannel = normalizeChannel(channel);
    if (normalizedChannel === 'api' || normalizedChannel === 'internal' || normalizedChannel === 'shard') {
      return 'private';
    }
    if (normalizedChannel === 'twitter' || normalizedChannel === 'rss' || normalizedChannel === 'broadcast') {
      return 'broadcast';
    }
    return 'semi_private';
  }
}
