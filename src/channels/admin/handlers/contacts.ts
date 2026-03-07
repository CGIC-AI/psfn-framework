import type { LegacyAdminHandlers } from '../handlers-legacy.js';
import type { ContactStore } from '../../../contacts/store.js';
import type { TrustLevel } from '../../../trust/types.js';
import type { ContactProfileArtifact } from '../../../memory/store.js';
import {
  TRUST_LEVELS,
} from '../../../trust/types.js';
import {
  VALID_RELATIONSHIP_TYPES,
  CHANNEL_PRIVACY_LEVELS,
  type Contact,
  type RelationshipType,
  type ChannelPrivacyLevel,
  type ContactIdentityLinkVerification,
  type ContactMutationAuditEntry,
  type ContactMutationAuditField,
  type ContactMutationAuditQuery,
} from '../../../contacts/types.js';
import type {
  ContactConversationChannelView,
  ContactIdentityLinkView,
} from '../services/contact-session-linker.js';
import {
  buildRelatedConversationChannelMap as buildRelatedConversationChannelMapFromContacts,
  getContactIdentityLinks as getContactIdentityLinksFromContact,
  getPersistedConversationChannels as getPersistedConversationChannelsFromContact,
  sessionMatchesIdentity as sessionMatchesIdentityFromId,
  splitSessionChannelId as splitSessionChannelIdFromSession,
} from '../services/contact-session-linker.js';
import * as tpl from '../templates.js';

export class AdminContactsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private getContactNickname(contact: Contact): string | undefined {
    const nickname = (contact as Contact & { nickname?: string }).nickname;
    if (typeof nickname !== 'string') return undefined;
    const trimmed = nickname.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private getContactIdentityLinks(contact: Contact): ContactIdentityLinkView[] {
    return getContactIdentityLinksFromContact(contact);
  }

  private getPersistedConversationChannels(contact: Contact): ContactConversationChannelView[] {
    return getPersistedConversationChannelsFromContact(contact);
  }

  private splitSessionChannelId(channelId: string): { channel: string; channelId: string } {
    return splitSessionChannelIdFromSession(channelId);
  }

  private sessionMatchesIdentity(sessionChannelId: string, identity: ContactIdentityLinkView): boolean {
    return sessionMatchesIdentityFromId(sessionChannelId, identity);
  }

  private buildRelatedConversationChannelMap(contacts: Contact[]): Map<string, ContactConversationChannelView[]> {
    const legacy = this.legacy as any;
    return buildRelatedConversationChannelMapFromContacts({
      contacts,
      sessionStore: legacy.sessionStore,
    });
  }

  private updateIdentityProfile(contact: Contact, displayName: string, nickname: string | undefined): boolean {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) return false;
    const storeWithIdentityProfile = legacy.contactStore as ContactStore & {
      updateIdentityProfile?: (contactId: string, displayName: string, nickname?: string) => boolean;
    };

    if (typeof storeWithIdentityProfile.updateIdentityProfile === 'function') {
      return storeWithIdentityProfile.updateIdentityProfile(contact.id, displayName, nickname);
    }

    const updated = legacy.contactStore.upsert({
      id: contact.id,
      displayName,
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

  private listContactMutationAuditEntries(query: ContactMutationAuditQuery): ContactMutationAuditEntry[] {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) return [];
    const storeWithAuditList = legacy.contactStore as ContactStore & {
      listMutationAuditEntries?: (auditQuery?: ContactMutationAuditQuery) => ContactMutationAuditEntry[];
    };
    if (typeof storeWithAuditList.listMutationAuditEntries !== 'function') return [];
    return storeWithAuditList.listMutationAuditEntries(query);
  }

  contactsPage(): string {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) {
      return tpl.layout('Garden Visitors', '<div class="empty">Contact store not available</div>', 'contacts');
    }
    const contacts = legacy.contactStore.listAll();
    const profileMap = new Map<string, ContactProfileArtifact>(
      legacy.memoryStore.listContactProfiles().map((profile: any) => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.buildRelatedConversationChannelMap(contacts);
    const maybeVerificationLister = legacy.contactStore as ContactStore & {
      listIdentityLinkVerifications?: (limit?: number) => ContactIdentityLinkVerification[];
    };
    const verifications = typeof maybeVerificationLister.listIdentityLinkVerifications === 'function'
      ? maybeVerificationLister.listIdentityLinkVerifications(20)
      : [];
    const mutationAuditQuery = this.parseContactMutationAuditQuery();
    const mutationAudits = this.listContactMutationAuditEntries(mutationAuditQuery);
    return tpl.layout(
      'Garden Visitors',
      tpl.contactsPage(
        contacts,
        profileMap,
        relatedChannelMap,
        verifications,
        mutationAudits,
        mutationAuditQuery,
      ),
      'contacts',
    );
  }

  contactMutationAuditFragment(params?: URLSearchParams): string {
    const query = this.parseContactMutationAuditQuery(params);
    const entries = this.listContactMutationAuditEntries(query);
    return tpl.contactMutationAuditFragment(entries);
  }

  contactsListFragment(): string {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) return '<tr><td colspan="5" class="empty">Contact store not available</td></tr>';
    const contacts = legacy.contactStore.listAll();
    if (contacts.length === 0) return '<tr><td colspan="5" class="empty">No visitors found</td></tr>';
    const profileMap = new Map<string, ContactProfileArtifact>(
      legacy.memoryStore.listContactProfiles().map((profile: any) => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.buildRelatedConversationChannelMap(contacts);
    return contacts.map((contact: Contact) => tpl.contactRow(
      contact,
      profileMap.get(contact.id),
      relatedChannelMap.get(contact.id) ?? [],
    )).join('');
  }

  contactEditFormFragment(contactId: string): string {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) return '';
    const contact = legacy.contactStore.getById(contactId);
    if (!contact) return '';
    return tpl.contactEditForm(contact);
  }

  handleContactUpdate(contactId: string, body: string): string {
    const legacy = this.legacy as any;
    if (!legacy.contactStore) {
      return tpl.settingsFormResult(false, 'Contact store not available');
    }

    const contact = legacy.contactStore.getById(contactId);
    if (!contact) {
      return tpl.settingsFormResult(false, 'Contact not found');
    }

    const params = new URLSearchParams(body);
    const displayName = (params.get('displayName') ?? '').trim();
    const nicknameField = params.get('nickname');
    const nickname = nicknameField === null ? undefined : (nicknameField.trim() || undefined);
    const trustLevel = params.get('trustLevel') as TrustLevel | null;
    const relationshipType = params.get('relationshipType') as RelationshipType | null;
    const notes = params.get('notes');
    const channelCount = Number.parseInt(params.get('channelCount') ?? '0', 10);
    const newChannel = (params.get('newChannel') ?? '').trim();
    const newChannelUserId = (params.get('newChannelUserId') ?? '').trim();
    const newChannelPrivacyRaw = (params.get('newChannelPrivacy') ?? '').trim();
    const newChannelPrivacy = (newChannelPrivacyRaw || 'semi_private') as ChannelPrivacyLevel;
    const wantsNewChannelLink = newChannel.length > 0 || newChannelUserId.length > 0;
    const currentNickname = this.getContactNickname(contact);

    if (!displayName) {
      return tpl.settingsFormResult(false, 'Display name is required');
    }

    const channelPrivacyUpdates: Array<{
      channel: string;
      channelUserId: string;
      privacyLevel: ChannelPrivacyLevel;
    }> = [];

    if (!Number.isNaN(channelCount) && channelCount > 0) {
      for (let index = 0; index < channelCount; index += 1) {
        const channel = params.get(`channel_${index}`);
        const channelUserId = params.get(`channelUserId_${index}`);
        const privacyLevel = params.get(`channelPrivacy_${index}`);
        if (!channel || !channelUserId || !privacyLevel) continue;
        if (!CHANNEL_PRIVACY_LEVELS.includes(privacyLevel as ChannelPrivacyLevel)) {
          return tpl.settingsFormResult(false, `Invalid channel privacy level: ${privacyLevel}`);
        }
        channelPrivacyUpdates.push({
          channel,
          channelUserId,
          privacyLevel: privacyLevel as ChannelPrivacyLevel,
        });
      }
    }

    if (trustLevel && !TRUST_LEVELS.includes(trustLevel)) {
      return tpl.settingsFormResult(false, `Invalid trust level: ${trustLevel}`);
    }

    if (relationshipType && !VALID_RELATIONSHIP_TYPES.includes(relationshipType)) {
      return tpl.settingsFormResult(false, `Invalid relationship type: ${relationshipType}`);
    }

    if (wantsNewChannelLink && (!newChannel || !newChannelUserId)) {
      return tpl.settingsFormResult(false, 'To link a new channel, both channel and channel user ID are required');
    }

    if (wantsNewChannelLink && !CHANNEL_PRIVACY_LEVELS.includes(newChannelPrivacy)) {
      return tpl.settingsFormResult(false, `Invalid new channel privacy level: ${newChannelPrivacyRaw}`);
    }

    if (displayName !== contact.displayName || nickname !== currentNickname) {
      const updatedIdentity = this.updateIdentityProfile(contact, displayName, nickname);
      if (!updatedIdentity) {
        return tpl.settingsFormResult(false, 'Unable to update contact identity profile');
      }
    }

    if (trustLevel && trustLevel !== contact.trustLevel) {
      const updatedTrust = legacy.contactStore.setTrustLevel(contactId, trustLevel, 'admin:gui');
      if (!updatedTrust) {
        return tpl.settingsFormResult(false, 'Unable to update trust level for this contact');
      }
    }

    if (relationshipType && relationshipType !== contact.relationshipType) {
      const updatedRelationship = legacy.contactStore.updateRelationshipType(contactId, relationshipType);
      if (!updatedRelationship) {
        return tpl.settingsFormResult(false, 'Unable to update relationship type for this contact');
      }
    }

    if (notes !== null) {
      legacy.contactStore.updateNotes(contactId, notes, 'admin:gui');
    }

    for (const update of channelPrivacyUpdates) {
      const updated = legacy.contactStore.setChannelPrivacy(
        contactId,
        update.channel,
        update.channelUserId,
        update.privacyLevel,
      );
      if (!updated) {
        return tpl.settingsFormResult(
          false,
          `Unable to update channel privacy for ${update.channel}:${update.channelUserId}`,
        );
      }
    }

    if (wantsNewChannelLink && newChannel && newChannelUserId) {
      const linkResult = legacy.contactStore.linkChannelIdentity(contactId, newChannel, newChannelUserId, {
        privacyLevel: newChannelPrivacy,
      });
      if (linkResult === 'identity_conflict') {
        return tpl.settingsFormResult(false, `Identity ${newChannel}:${newChannelUserId} is already linked to another contact`);
      }
      if (linkResult === 'contact_not_found') {
        return tpl.settingsFormResult(false, 'Contact not found while linking new channel');
      }
    }

    const updated = legacy.contactStore.getById(contactId);
    if (!updated) return tpl.settingsFormResult(false, 'Update failed');

    const identityTouched = (
      displayName !== contact.displayName
      || nickname !== currentNickname
      || channelPrivacyUpdates.length > 0
      || wantsNewChannelLink
    );
    if (identityTouched) {
      legacy.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `${legacy.resolveCompanionName()} updated identity details for contact "${updated.displayName}".`,
        [
          displayName !== contact.displayName ? `displayName=${updated.displayName}` : null,
          nickname !== currentNickname ? `nickname=${nickname ?? '(none)'}` : null,
          channelPrivacyUpdates.length > 0 ? `privacyUpdates=${channelPrivacyUpdates.length}` : null,
          wantsNewChannelLink ? `linked=${newChannel}:${newChannelUserId}` : null,
        ],
      );
    }

    const relatedChannels = this.buildRelatedConversationChannelMap([updated]).get(updated.id) ?? [];
    return tpl.contactRow(updated, legacy.memoryStore.getContactProfile(updated.id), relatedChannels);
  }
}
