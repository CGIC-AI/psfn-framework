import type { ContactStore } from '../../../core/contacts/store.js';
import type { MemoryStore } from '../../../memory/store.js';
import {
  CHANNEL_PRIVACY_LEVELS,
  CONTACT_MUTATION_AUDIT_FIELDS,
  VALID_RELATIONSHIP_TYPES,
} from '../../../core/contacts/types.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactIdentityLinkVerification,
  ContactMutationAuditEntry,
  ContactMutationAuditField,
  ContactMutationAuditQuery,
  RelationshipType,
  SocialGraphEntity,
  SocialRelationshipEdge,
} from '../../../core/contacts/types.js';
import type { TrustLevel } from '../../../trust/types.js';
import { TRUST_LEVELS } from '../../../trust/types.js';
import type { ContactProfileArtifact } from '../../../memory/store.js';
import {
  buildRelatedConversationChannelMap,
} from './contact-session-linker.js';
import type {
  AdminContactSocialGraphConnectionView,
  AdminContactDetailData,
  AdminContactListData,
  AdminContactSocialGraphView,
  AdminContactsService,
  ContactUpdateResult,
} from './types.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';

interface ChannelPrivacyUpdate {
  channel: string;
  userId?: string;
  channelId?: string;
  privacyLevel: ChannelPrivacyLevel;
}

interface AddChannelLink {
  channel: string;
  userId: string;
  privacyLevel?: ChannelPrivacyLevel;
}

interface ConversationChannelDeletePayload {
  channel?: string;
  channelId?: string;
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

function isMentionOnlyContact(contact: Contact | undefined): boolean {
  if (!contact) return false;
  return (contact.channels?.length ?? 0) === 0
    && (contact.channelIdentities?.length ?? 0) === 0
    && (contact.conversationChannels?.length ?? 0) === 0;
}

export class AdminContactsDataService implements AdminContactsService {
  constructor(private readonly deps: {
    contactStore?: ContactStore | null;
    memoryStore: MemoryStore;
    sessionStore: SessionStore;
  }) {}

  private normalizeContactMutationAuditField(value: string | null): ContactMutationAuditField | undefined {
    const trimmed = value?.trim();
    return trimmed && (CONTACT_MUTATION_AUDIT_FIELDS as readonly string[]).includes(trimmed)
      ? trimmed as ContactMutationAuditField
      : undefined;
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

  private buildSocialGraphMap(
    contacts: Contact[],
    profileMap: Map<string, ContactProfileArtifact>,
  ): Map<string, AdminContactSocialGraphView> {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return new Map();

    const contactById = new Map(contacts.map(contact => [contact.id, contact] as const));
    const entities = contactStore.listSocialGraphEntities({
      viewerTrustLevel: 'primary',
      viewerChannelVisibility: 'private',
      limit: Math.max(contacts.length * 4, 100),
    });
    const entityById = new Map(entities.map(entity => [entity.id, entity] as const));
    const entityByContactId = new Map(
      entities
        .filter((entity): entity is SocialGraphEntity & { contactId: string } => typeof entity.contactId === 'string')
        .map(entity => [entity.contactId, entity] as const),
    );
    const edges = contactStore.listSocialRelationshipEdges({
      viewerTrustLevel: 'primary',
      viewerChannelVisibility: 'private',
      limit: Math.max(contacts.length * 8, 200),
    });
    const edgesByEntityId = new Map<string, SocialRelationshipEdge[]>();

    const addEdge = (entityId: string, edge: SocialRelationshipEdge): void => {
      const existing = edgesByEntityId.get(entityId);
      if (existing) {
        existing.push(edge);
        return;
      }
      edgesByEntityId.set(entityId, [edge]);
    };

    for (const edge of edges) {
      addEdge(edge.sourceEntityId, edge);
      addEdge(edge.targetEntityId, edge);
    }

    const buildConnection = (
      entity: SocialGraphEntity,
      edge: SocialRelationshipEdge,
    ): AdminContactSocialGraphConnectionView | null => {
      const neighborEntityId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
      const neighborEntity = entityById.get(neighborEntityId);
      if (!neighborEntity) return null;

      const neighborContact = neighborEntity.contactId ? contactById.get(neighborEntity.contactId) : undefined;
      const neighborProfile = neighborContact ? profileMap.get(neighborContact.id) : undefined;
      const direction = edge.directional
        ? (edge.sourceEntityId === entity.id ? 'outgoing' : 'incoming')
        : 'undirected';

      return {
        edgeId: edge.id,
        relationshipType: edge.relationshipType,
        directional: edge.directional,
        direction,
        sensitivity: edge.sensitivity,
        confidence: edge.confidence,
        provenanceRefs: edge.provenanceRefs,
        evidenceMemoryIds: edge.evidenceMemoryIds,
        createdAt: edge.createdAt,
        updatedAt: edge.updatedAt,
        neighbor: {
          entityId: neighborEntity.id,
          contactId: neighborEntity.contactId,
          displayName: neighborContact?.displayName ?? neighborEntity.displayName,
          source: neighborEntity.source,
          sensitivity: neighborEntity.sensitivity,
          confidence: neighborEntity.confidence,
          provenanceRefs: neighborEntity.provenanceRefs,
          mentionOnly: isMentionOnlyContact(neighborContact),
          trustLevel: neighborContact?.trustLevel,
          relationshipType: neighborContact?.relationshipType,
          profileSummary: neighborProfile?.summary,
          profileUpdatedAt: neighborProfile?.updatedAt,
        },
      };
    };

    return new Map(contacts.map((contact) => {
      const entity = entityByContactId.get(contact.id);
      if (!entity) {
        return [contact.id, {
          edgeCount: 0,
          neighborCount: 0,
          evidenceCount: 0,
          provenanceCount: 0,
          mentionOnlyNeighborCount: 0,
          connections: [],
        } satisfies AdminContactSocialGraphView] as const;
      }

      const localEdges = edgesByEntityId.get(entity.id) ?? [];
      const connections = localEdges
        .map(edge => buildConnection(entity, edge))
        .filter((connection): connection is AdminContactSocialGraphConnectionView => connection !== null)
        .sort((left, right) => {
          if (right.confidence !== left.confidence) return right.confidence - left.confidence;
          return left.neighbor.displayName.localeCompare(right.neighbor.displayName);
        });
      const uniqueNeighborIds = new Set(connections.map(connection => connection.neighbor.entityId));
      const uniqueMentionOnlyNeighborIds = new Set(
        connections
          .filter(connection => connection.neighbor.mentionOnly)
          .map(connection => connection.neighbor.entityId),
      );
      const evidenceIds = new Set(connections.flatMap(connection => connection.evidenceMemoryIds));
      const provenanceRefs = new Set([
        ...entity.provenanceRefs,
        ...connections.flatMap(connection => connection.provenanceRefs),
        ...connections.flatMap(connection => connection.neighbor.provenanceRefs),
      ]);

      return [contact.id, {
        entity: {
          id: entity.id,
          displayName: entity.displayName,
          contactId: entity.contactId,
          source: entity.source,
          sensitivity: entity.sensitivity,
          confidence: entity.confidence,
          provenanceRefs: entity.provenanceRefs,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
        },
        edgeCount: localEdges.length,
        neighborCount: uniqueNeighborIds.size,
        evidenceCount: evidenceIds.size,
        provenanceCount: provenanceRefs.size,
        mentionOnlyNeighborCount: uniqueMentionOnlyNeighborIds.size,
        connections,
      } satisfies AdminContactSocialGraphView] as const;
    }));
  }

  listContacts(params?: URLSearchParams): AdminContactListData {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return {
        contacts: [],
        profileMap: new Map(),
        relatedChannelMap: new Map(),
        socialGraphMap: new Map(),
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
    const socialGraphMap = this.buildSocialGraphMap(contacts, profileMap);

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
      socialGraphMap,
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

  private updateIdentityProfile(
    contact: Contact,
    displayName: string,
    nickname?: string,
    actor?: string,
  ): boolean {
    const contactStore = this.deps.contactStore;
    if (!contactStore) return false;

    const storeWithIdentityProfile = contactStore as ContactStore & {
      updateIdentityProfile?: (contactId: string, name: string, nickname?: string, actor?: string) => boolean;
    };

    if (typeof storeWithIdentityProfile.updateIdentityProfile === 'function') {
      return storeWithIdentityProfile.updateIdentityProfile(contact.id, displayName, nickname, actor);
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

    if (!contactStore.unlinkChannelIdentity(contactId, channel, userId, 'admin:api')) {
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

  deleteConversationChannel(contactId: string, body: string): ContactUpdateResult {
    const contactStore = this.deps.contactStore;
    if (!contactStore) {
      return { ok: false, message: 'Contact store not available' };
    }

    let payload: ConversationChannelDeletePayload;
    try {
      payload = JSON.parse(body);
    } catch {
      return { ok: false, message: 'Request body must be valid JSON' };
    }

    const channel = payload.channel?.trim();
    const channelId = payload.channelId?.trim();
    if (!channel || !channelId) {
      return { ok: false, message: 'channel and channelId are required' };
    }

    const storeWithDeleteConversationChannel = contactStore as ContactStore & {
      deleteConversationChannel?: (id: string, channel: string, channelId: string, actor?: string) => boolean;
    };
    if (typeof storeWithDeleteConversationChannel.deleteConversationChannel !== 'function') {
      return { ok: false, message: 'Conversation channel deletion is not available' };
    }

    const contact = contactStore.getById(contactId);
    if (!contact) {
      return { ok: false, message: 'Contact not found' };
    }

    if (!storeWithDeleteConversationChannel.deleteConversationChannel(contactId, channel, channelId, 'admin:api')) {
      return { ok: false, message: 'Conversation channel not found on contact' };
    }

    const updated = contactStore.getById(contactId);
    return {
      ok: true,
      message: 'Conversation channel deleted',
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
      if (!this.updateIdentityProfile(contact, displayName, payload.nickname, 'admin:api')) {
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
      if (!contactStore.updateRelationshipType(contactId, payload.relationshipType, 'admin:api')) {
        return { ok: false, message: 'Unable to update relationship type' };
      }
    }

    if (payload.notes !== undefined) {
      contactStore.updateNotes(contactId, payload.notes, 'admin:api');
    }

    // Apply channel privacy updates
    if (Array.isArray(payload.channelPrivacy)) {
      for (const cp of payload.channelPrivacy) {
        if (!cp.channel.trim()) continue;
        if (!CHANNEL_PRIVACY_LEVELS.includes(cp.privacyLevel)) {
          return { ok: false, message: `Invalid privacy level: ${cp.privacyLevel}` };
        }
        const normalizedChannel = cp.channel.trim();
        const normalizedUserId = cp.userId?.trim();
        const normalizedChannelId = cp.channelId?.trim();
        const updated = normalizedChannelId
          ? contactStore.setConversationChannelPrivacy(
            contactId,
            normalizedChannel,
            normalizedChannelId,
            cp.privacyLevel,
            'admin:api',
          )
          : normalizedUserId
              ? contactStore.setChannelPrivacy(
                contactId,
                normalizedChannel,
                normalizedUserId,
                cp.privacyLevel,
                'admin:api',
              )
              : false;
        if (!updated) {
          const target = normalizedChannelId ?? normalizedUserId ?? 'unknown';
          return { ok: false, message: `Unable to update privacy for ${normalizedChannel}:${target}` };
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
        'admin:api',
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
