import type { ContactStore } from '../../../contacts/store.js';
import type { TrustLevel } from '../../../trust/types.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  RelationshipType,
} from '../../../contacts/types.js';
import { CHANNEL_PRIVACY_LEVELS } from '../../../contacts/types.js';
import type {
  AdminChatBootstrapResponse,
  AdminChatBootstrapUpdateInput,
  AdminChatContactOption,
  AdminChatLinkedChannelOption,
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
const DEFAULT_RUNTIME_MODEL_ID = 'purrsephone-admin-chat';
const DEFAULT_RUNTIME_MODEL_NAME = 'PSFN Garden Chat';
const SYNTHETIC_CONTACT_ID = 'admin.synthetic.default';
const SYNTHETIC_DISPLAY_NAME = 'Primary Contact';
const SYNTHETIC_CHANNEL = 'api';
const SYNTHETIC_USER_ID = 'admin-user';

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

export class AdminChatBootstrapService {
  private readonly contactStore: ContactStore | null;
  private readonly configuredApiKey?: string;
  private readonly apiBaseUrl: string;
  private selection: SelectionState = {};

  constructor(contactStore?: ContactStore | null, options: AdminChatBootstrapServiceOptions = {}) {
    this.contactStore = contactStore ?? null;
    this.configuredApiKey = normalizeTrimmed(options.apiKey);
    this.apiBaseUrl = resolveAdminChatApiBaseUrl({
      explicitApiBaseUrl: options.apiBaseUrl,
    });
  }

  buildBootstrap(): AdminChatBootstrapResponse {
    return this.composeBootstrap();
  }

  updateSelection(input: AdminChatBootstrapUpdateInput): AdminChatBootstrapResponse {
    this.applySelectionInput(input);
    this.persistSelectionMapping(input);
    return this.composeBootstrap();
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

  private composeBootstrap(): AdminChatBootstrapResponse {
    const contacts = this.loadContacts();
    const selectedContact = this.resolveSelectedContact(contacts, this.selection.canonicalContactId);
    const selectedIdentity = this.resolveSelectedIdentity(
      selectedContact,
      this.selection.channel,
      this.selection.userId,
    );
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
    const defaultSessionId = `${selectedIdentity.channel}:${selectedIdentity.userId}`;
    const apiKey = this.resolveApiKey();
    const transportHeaders = this.buildTransportHeaders(defaultSessionId, defaultAuthorId, defaultAuthorName);
    const chatCompletionsUrl = buildAbsoluteAdminChatApiUrl(CHAT_COMPLETIONS_PATH, this.apiBaseUrl);
    const voiceWebSocketUrl = buildAbsoluteAdminChatApiUrl(VOICE_WEBSOCKET_PATH, this.apiBaseUrl);
    const openAiBaseUrl = buildAbsoluteAdminChatApiUrl(OPENAI_API_BASE_PATH, this.apiBaseUrl);

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
        model: {
          id: DEFAULT_RUNTIME_MODEL_ID,
          name: DEFAULT_RUNTIME_MODEL_NAME,
          provider: 'openai',
          api: 'openai-completions',
          baseUrl: openAiBaseUrl,
          headers: transportHeaders,
        },
        apiKey,
      },
      defaultSessionId,
      defaultAuthorName,
      defaultAuthorId,
    };
  }

  private resolveApiKey(): string | undefined {
    return this.configuredApiKey ?? normalizeTrimmed(process.env.API_KEY);
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
