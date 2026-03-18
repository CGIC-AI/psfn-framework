import type { ContactStore } from '../../../contacts/store.js';
import type { MemoryStore } from '../../../memory/store.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditField,
  ContactMutationAuditQuery,
  RelationshipType,
} from '../../../contacts/types.js';
import type { TrustLevel } from '../../../trust/types.js';
import { TRUST_LEVELS } from '../../../trust/types.js';
import {
  CHANNEL_PRIVACY_LEVELS,
  VALID_RELATIONSHIP_TYPES,
} from '../../../contacts/types.js';
import {
  buildRelatedConversationChannelMap,
} from './contact-session-linker.js';
import type {
  AdminContactDetailData,
  AdminContactListData,
  AdminContactsService,
  ContactUpdateResult,
} from './types.js';
import type { SessionStore } from '../../../session/store.js';

interface ChannelPrivacyUpdate {
  channel: string;
  userId: string;
  privacyLevel: ChannelPrivacyLevel;
}

interface AddChannelLink {
  channel: string;
  userId: string;
  privacyLevel?: ChannelPrivacyLevel;
}

interface ContactUpdatePayload {
  displayName?: string;
  nickname?: string;
  trustLevel?: TrustLevel;
  relationshipType?: RelationshipType;
  notes?: string;
  channelPrivacy?: ChannelPrivacyUpdate[];
  addChannel?: AddChannelLink;
}

export class AdminContactsDataService implements AdminContactsService {
  constructor(private readonly deps: {
    contactStore?: ContactStore | null;
    memoryStore: MemoryStore;
    sessionStore: SessionStore;
  }) {}

  private normalizeContactMutationAuditField(value: string | null): ContactMutationAuditField | undefined {
    const trimmed = value?.trim();
    switch (trimmed) {
      case 'trust_level':
      case 'notes':
        return trimmed;
      default:
        return undefined;
    }
  }

  private parseContactMutationAuditQuery(params?: URLSearchParams): ContactMutationAuditQuery {
    const rawLimit = params?.get('limit');
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 200)) : 25;

    const contactId = params?.get('contactId')?.trim() || undefined;
    const actor = params?.get('actor')?.trim() || undefined;
    const field = this.normalizeContactMutationAuditField(params?.get('field') ?? null);

    return {
      contactId,
      actor,
      field,
      limit,
    };
  }

  listMutationAuditEntries(query: ContactMutationAuditQuery): ContactMutationAuditEntry[] {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return [];
    const storeWithAuditList = contactStore as ContactStore & {
      listMutationAuditEntries?: (auditQuery?: ContactMutationAuditQuery) => ContactMutationAuditEntry[];
    };
    if (typeof storeWithAuditList.listMutationAuditEntries !== 'function') return [];
    return storeWithAuditList.listMutationAuditEntries(query);
  }

  listContacts(params?: URLSearchParams): AdminContactListData {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return {
        contacts: [],
        profileMap: new Map(),
        relatedChannelMap: new Map(),
        verifications: [],
        mutationAudits: [],
        mutationAuditQuery: this.parseContactMutationAuditQuery(params),
      };
    }

    const contacts = contactStore.listAll();
    const profileMap = new Map(
      this.deps.memoryStore.listContactProfiles().map(profile => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = buildRelatedConversationChannelMap({
      contacts,
      sessionStore: this.deps.sessionStore,
    });

    const maybeVerificationLister = contactStore as ContactStore & {
      listIdentityLinkVerifications?: (limit?: number) => ContactIdentityLinkVerification[];
    };
    const verifications = typeof maybeVerificationLister.listIdentityLinkVerifications === 'function'
      ? maybeVerificationLister.listIdentityLinkVerifications(20)
      : [];
    const mutationAuditQuery = this.parseContactMutationAuditQuery(params);
    const mutationAudits = this.listMutationAuditEntries(mutationAuditQuery);

    return {
      contacts,
      profileMap,
      relatedChannelMap,
      verifications,
      mutationAudits,
      mutationAuditQuery,
    };
  }

  getContactDetail(contactId: string): AdminContactDetailData | null {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return null;
    const contact = contactStore.getById(contactId);
    if (!contact) return null;

    const relatedChannels = buildRelatedConversationChannelMap({
      contacts: [contact],
      sessionStore: this.deps.sessionStore,
    }).get(contact.id) ?? [];

    return {
      contact,
      profile: this.deps.memoryStore.getContactProfile(contact.id),
      relatedChannels,
    };
  }

  private updateIdentityProfile(contact: Contact, displayName: string, nickname?: string): boolean {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return false;

    const storeWithIdentityProfile = contactStore as ContactStore & {
      updateIdentityProfile?: (contactId: string, name: string, nickname?: string) => boolean;
    };

    if (typeof storeWithIdentityProfile.updateIdentityProfile === 'function') {
      return storeWithIdentityProfile.updateIdentityProfile(contact.id, displayName, nickname);
    }

    const updated = contactStore.upsert({
      id: contact.id,
      displayName,
      nickname,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      notes: contact.notes,
      discordUserId: contact.discordUserId,
      channels: contact.channels,
      channelIdentities: contact.channelIdentities,
      firstSeen: contact.firstSeen,
    });
    return updated.id === contact.id;
  }

  createContact(body: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    let payload: { displayName?: string; trustLevel?: TrustLevel; relationshipType?: RelationshipType; notes?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const displayName = payload.displayName?.trim();
    if (!displayName) {
      return { ok: false, message: 'displayName is required' };
    }

    if (payload.trustLevel !== undefined) {
      if (!TRUST_LEVELS.includes(payload.trustLevel)) {
        return { ok: false, message: `Invalid trust level: ${payload.trustLevel}` };
      }
      if (payload.trustLevel === 'primary') {
        return { ok: false, message: 'Cannot create a contact with primary trust level' };
      }
    }

    if (payload.relationshipType !== undefined && !VALID_RELATIONSHIP_TYPES.includes(payload.relationshipType)) {
      return { ok: false, message: `Invalid relationship type: ${payload.relationshipType}` };
    }

    const contact = contactStore.upsert({
      displayName,
      trustLevel: payload.trustLevel ?? 'regular',
      relationshipType: payload.relationshipType ?? 'acquaintance',
      notes: payload.notes,
    });

    return {
      ok: true,
      message: 'Contact created',
      contact,
      relatedChannels: [],
    };
  }

  deleteContact(contactId: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    const contact = contactStore.getById(contactId);
    if (!contact) {
      return { ok: false, message: 'Contact not found' };
    }

    if (contact.trustLevel === 'primary') {
      return { ok: false, message: 'Cannot delete the primary contact' };
    }

    if (!contactStore.deleteContact(contactId)) {
      return { ok: false, message: 'Failed to delete contact' };
    }

    return { ok: true, message: 'Contact deleted' };
  }

  mergeContacts(targetId: string, body: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    let payload: { sourceId?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const sourceId = payload.sourceId?.trim();
    if (!sourceId) {
      return { ok: false, message: 'sourceId is required' };
    }

    if (sourceId === targetId) {
      return { ok: false, message: 'Cannot merge a contact with itself' };
    }

    const target = contactStore.getById(targetId);
    if (!target) {
      return { ok: false, message: 'Target contact not found' };
    }

    const source = contactStore.getById(sourceId);
    if (!source) {
      return { ok: false, message: 'Source contact not found' };
    }

    if (!contactStore.mergeContacts(sourceId, targetId)) {
      return { ok: false, message: 'Merge failed' };
    }

    const merged = contactStore.getById(targetId);
    if (!merged) {
      return { ok: false, message: 'Merge succeeded but target not found after merge' };
    }

    return {
      ok: true,
      message: 'Contacts merged',
      contact: merged,
      relatedChannels: buildRelatedConversationChannelMap({
        contacts: [merged],
        sessionStore: this.deps.sessionStore,
      }).get(merged.id) ?? [],
    };
  }

  unlinkChannelIdentity(contactId: string, body: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    let payload: { channel?: string; userId?: string };
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const channel = payload.channel?.trim();
    const userId = payload.userId?.trim();
    if (!channel || !userId) {
      return { ok: false, message: 'channel and userId are required' };
    }

    const contact = contactStore.getById(contactId);
    if (!contact) {
      return { ok: false, message: 'Contact not found' };
    }

    if (!contactStore.unlinkChannelIdentity(contactId, channel, userId)) {
      return { ok: false, message: 'Channel identity not found or already unlinked' };
    }

    const updated = contactStore.getById(contactId);
    return {
      ok: true,
      message: 'Channel identity unlinked',
      contact: updated,
      relatedChannels: updated
        ? buildRelatedConversationChannelMap({
          contacts: [updated],
          sessionStore: this.deps.sessionStore,
        }).get(updated.id) ?? []
        : [],
    };
  }

  updateContact(contactId: string, body: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    const contact = contactStore.getById(contactId);
    if (!contact) {
      return { ok: false, message: 'Contact not found' };
    }

    let payload: ContactUpdatePayload;
    try {
      payload = JSON.parse(body) as ContactUpdatePayload;
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    if (payload.displayName !== undefined || payload.nickname !== undefined) {
      const displayName = payload.displayName?.trim() ?? contact.displayName;
      if (!displayName) {
        return { ok: false, message: 'displayName cannot be empty' };
      }
      if (!this.updateIdentityProfile(contact, displayName, payload.nickname)) {
        return { ok: false, message: 'Unable to update identity profile' };
      }
    }

    if (payload.trustLevel !== undefined) {
      if (!TRUST_LEVELS.includes(payload.trustLevel)) {
        return { ok: false, message: `Invalid trust level: ${payload.trustLevel}` };
      }
      if (!contactStore.setTrustLevel(contactId, payload.trustLevel, 'admin:api')) {
        return { ok: false, message: 'Unable to update trust level' };
      }
    }

    if (payload.relationshipType !== undefined) {
      if (!VALID_RELATIONSHIP_TYPES.includes(payload.relationshipType)) {
        return { ok: false, message: `Invalid relationship type: ${payload.relationshipType}` };
      }
      if (!contactStore.updateRelationshipType(contactId, payload.relationshipType)) {
        return { ok: false, message: 'Unable to update relationship type' };
      }
    }

    if (payload.notes !== undefined) {
      contactStore.updateNotes(contactId, payload.notes, 'admin:api');
    }

    // Apply channel privacy updates
    if (Array.isArray(payload.channelPrivacy)) {
      for (const cp of payload.channelPrivacy) {
        if (!cp.channel.trim() || !cp.userId.trim()) continue;
        if (!CHANNEL_PRIVACY_LEVELS.includes(cp.privacyLevel)) {
          return { ok: false, message: `Invalid privacy level: ${cp.privacyLevel}` };
        }
        const updated = contactStore.setChannelPrivacy(
          contactId,
          cp.channel.trim(),
          cp.userId.trim(),
          cp.privacyLevel,
        );
        if (!updated) {
          return { ok: false, message: `Unable to update privacy for ${cp.channel}:${cp.userId}` };
        }
      }
    }

    // Add new channel link
    if (payload.addChannel) {
      const ch = payload.addChannel;
      if (!ch.channel.trim() || !ch.userId.trim()) {
        return { ok: false, message: 'Channel and userId are required for addChannel' };
      }
      if (ch.privacyLevel && !CHANNEL_PRIVACY_LEVELS.includes(ch.privacyLevel)) {
        return { ok: false, message: `Invalid privacy level for new channel: ${ch.privacyLevel}` };
      }
      const linkResult = contactStore.linkChannelIdentity(
        contactId,
        ch.channel.trim(),
        ch.userId.trim(),
        { privacyLevel: ch.privacyLevel },
      );
      if (linkResult === 'identity_conflict') {
        return { ok: false, message: `Identity ${ch.channel}:${ch.userId} is already linked to another contact` };
      }
      if (linkResult === 'contact_not_found') {
        return { ok: false, message: `Contact ${contactId} was not found` };
      }
    }

    const updated = contactStore.getById(contactId);
    if (!updated) {
      return { ok: false, message: 'Update failed' };
    }

    return {
      ok: true,
      message: 'Contact updated',
      contact: updated,
      relatedChannels: buildRelatedConversationChannelMap({
        contacts: [updated],
        sessionStore: this.deps.sessionStore,
      }).get(updated.id) ?? [],
    };
  }
}
