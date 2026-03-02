import { TRUST_LEVELS, type TrustLevel } from '../../../trust/types.js';
import {
  CHANNEL_PRIVACY_LEVELS,
  VALID_RELATIONSHIP_TYPES,
  type ChannelPrivacyLevel,
  type RelationshipType,
} from '../../../contacts/types.js';
import * as tpl from '../templates.js';
import type { LegacyAdminHandlers } from '../handlers-legacy.js';

export class AdminContactsHandlers {
  constructor(private readonly legacy: LegacyAdminHandlers) {}

  private get adapter(): any {
    return this.legacy as any;
  }

  contactsPage(): string {
    if (!this.adapter.contactStore) {
      return tpl.layout('Garden Visitors', '<div class="empty">Contact store not available</div>', 'contacts');
    }
    const contacts = this.adapter.contactStore.listAll();
    const profileMap = new Map(
      this.adapter.memoryStore.listContactProfiles().map((profile: any) => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.adapter.buildRelatedConversationChannelMap(contacts);
    const maybeVerificationLister = this.adapter.contactStore as {
      listIdentityLinkVerifications?: (limit?: number) => unknown[];
    };
    const verifications = typeof maybeVerificationLister.listIdentityLinkVerifications === 'function'
      ? maybeVerificationLister.listIdentityLinkVerifications(20)
      : [];
    const mutationAuditQuery = this.adapter.parseContactMutationAuditQuery();
    const mutationAudits = this.adapter.listContactMutationAuditEntries(mutationAuditQuery);
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
    const query = this.adapter.parseContactMutationAuditQuery(params);
    const entries = this.adapter.listContactMutationAuditEntries(query);
    return tpl.contactMutationAuditFragment(entries);
  }

  contactsListFragment(): string {
    if (!this.adapter.contactStore) return '<tr><td colspan="5" class="empty">Contact store not available</td></tr>';
    const contacts = this.adapter.contactStore.listAll();
    if (contacts.length === 0) return '<tr><td colspan="5" class="empty">No visitors found</td></tr>';
    const profileMap = new Map(
      this.adapter.memoryStore.listContactProfiles().map((profile: any) => [profile.contactId, profile] as const),
    );
    const relatedChannelMap = this.adapter.buildRelatedConversationChannelMap(contacts);
    return contacts.map((contact: any) => tpl.contactRow(
      contact,
      profileMap.get(contact.id),
      relatedChannelMap.get(contact.id) ?? [],
    )).join('');
  }

  contactEditFormFragment(contactId: string): string {
    if (!this.adapter.contactStore) return '';
    const contact = this.adapter.contactStore.getById(contactId);
    if (!contact) return '';
    return tpl.contactEditForm(contact);
  }

  handleContactUpdate(contactId: string, body: string): string {
    if (!this.adapter.contactStore) {
      return tpl.settingsFormResult(false, 'Contact store not available');
    }

    const contact = this.adapter.contactStore.getById(contactId);
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
    const currentNickname = this.adapter.getContactNickname(contact);

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

    // Validate trust level
    if (trustLevel && !TRUST_LEVELS.includes(trustLevel)) {
      return tpl.settingsFormResult(false, `Invalid trust level: ${trustLevel}`);
    }

    // Validate relationship type
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
      const updatedIdentity = this.adapter.updateIdentityProfile(contact, displayName, nickname);
      if (!updatedIdentity) {
        return tpl.settingsFormResult(false, 'Unable to update contact identity profile');
      }
    }

    if (trustLevel && trustLevel !== contact.trustLevel) {
      const updatedTrust = this.adapter.contactStore.setTrustLevel(contactId, trustLevel, 'admin:gui');
      if (!updatedTrust) {
        return tpl.settingsFormResult(false, 'Unable to update trust level for this contact');
      }
    }

    if (relationshipType && relationshipType !== contact.relationshipType) {
      const updatedRelationship = this.adapter.contactStore.updateRelationshipType(contactId, relationshipType);
      if (!updatedRelationship) {
        return tpl.settingsFormResult(false, 'Unable to update relationship type for this contact');
      }
    }

    if (notes !== null) {
      this.adapter.contactStore.updateNotes(contactId, notes, 'admin:gui');
    }

    for (const update of channelPrivacyUpdates) {
      const updated = this.adapter.contactStore.setChannelPrivacy(
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
      const linkResult = this.adapter.contactStore.linkChannelIdentity(contactId, newChannel, newChannelUserId, {
        privacyLevel: newChannelPrivacy || 'semi_private',
      });
      if (linkResult === 'identity_conflict') {
        return tpl.settingsFormResult(false, `Identity ${newChannel}:${newChannelUserId} is already linked to another contact`);
      }
      if (linkResult === 'contact_not_found') {
        return tpl.settingsFormResult(false, 'Contact not found while linking new channel');
      }
    }

    // Return the updated row
    const updated = this.adapter.contactStore.getById(contactId);
    if (!updated) return tpl.settingsFormResult(false, 'Update failed');

    const identityTouched = (
      displayName !== contact.displayName
      || nickname !== currentNickname
      || channelPrivacyUpdates.length > 0
      || wantsNewChannelLink
    );
    if (identityTouched) {
      this.adapter.appendAuditTimelineEntry(
        'identity_edit',
        'allowed',
        `PSFN updated identity details for contact "${updated.displayName}".`,
        [
          displayName !== contact.displayName ? `displayName=${updated.displayName}` : null,
          nickname !== currentNickname ? `nickname=${nickname ?? '(none)'}` : null,
          channelPrivacyUpdates.length > 0 ? `privacyUpdates=${channelPrivacyUpdates.length}` : null,
          wantsNewChannelLink ? `linked=${newChannel}:${newChannelUserId}` : null,
        ],
      );
    }

    // Return a fresh table row so htmx replaces the edit form
    const relatedChannels = this.adapter.buildRelatedConversationChannelMap([updated]).get(updated.id) ?? [];
    return tpl.contactRow(updated, this.adapter.memoryStore.getContactProfile(updated.id), relatedChannels);
  }
}
