import type Database from 'better-sqlite3';
import type { ContactStorePort } from './contact-store-port.js';
import { ContactStore, type ContactStoreOptions } from './store.js';

function asyncContactStore(store: ContactStore): ContactStorePort {
  return {
    upsert: async (partial, options) => store.upsert(partial, options),
    getById: async (id) => store.getById(id),
    getByDiscordUserId: async (discordUserId) => store.getByDiscordUserId(discordUserId),
    getByChannelIdentity: async (channel, channelUserId) => store.getByChannelIdentity(channel, channelUserId),
    getByTrustLevel: async (trustLevel) => store.getByTrustLevel(trustLevel),
    getSocialGraphEntityById: async (entityId) => store.getSocialGraphEntityById(entityId),
    getSocialGraphEntityByContactId: async (contactId) => store.getSocialGraphEntityByContactId(contactId),
    listSocialGraphEntities: async (query) => store.listSocialGraphEntities(query),
    upsertSocialGraphEntity: async (input) => store.upsertSocialGraphEntity(input),
    upsertSocialRelationshipEdge: async (input) => store.upsertSocialRelationshipEdge(input),
    listSocialRelationshipEdges: async (query) => store.listSocialRelationshipEdges(query),
    listRelatedContacts: async (contactId, query) => store.listRelatedContacts(contactId, query),
    suggestLowTierTrustDrift: async (id, signals, actor) => store.suggestLowTierTrustDrift(id, signals, actor),
    applyLowTierTrustDriftSuggestion: async (id, suggestion, actor) => store.applyLowTierTrustDriftSuggestion(id, suggestion, actor),
    setTrustLevel: async (id, trustLevel, actor, options) => store.setTrustLevel(id, trustLevel, actor, options),
    updateLastSeen: async (id) => { store.updateLastSeen(id); },
    updateIdentityProfile: async (contactId, displayName, nickname, actor) => store.updateIdentityProfile(contactId, displayName, nickname, actor),
    recordChannelActivity: async (contactId, channel, channelId, privacyLevel) => {
      store.recordChannelActivity(contactId, channel, channelId, privacyLevel);
    },
    mergeContacts: async (sourceContactId, targetContactId) => store.mergeContacts(sourceContactId, targetContactId),
    updateNotes: async (id, notes, actor) => store.updateNotes(id, notes, actor),
    updateEmotionalBaseline: async (id, observation) => store.updateEmotionalBaseline(id, observation),
    getEmotionalSnapshot: async (id) => store.getEmotionalSnapshot(id),
    updateRelationshipType: async (id, relationshipType, actor) => store.updateRelationshipType(id, relationshipType, actor),
    setChannelPrivacy: async (contactId, channel, channelUserId, privacyLevel, actor) => store.setChannelPrivacy(contactId, channel, channelUserId, privacyLevel, actor),
    setConversationChannelPrivacy: async (contactId, channel, channelId, privacyLevel, actor) => store.setConversationChannelPrivacy(contactId, channel, channelId, privacyLevel, actor),
    getConversationChannelPrivacy: async (contactId, channel, channelId) => store.getConversationChannelPrivacy(contactId, channel, channelId),
    deleteConversationChannel: async (contactId, channel, channelId, actor) => store.deleteConversationChannel(contactId, channel, channelId, actor),
    createIdentityLinkChallenge: async (input) => store.createIdentityLinkChallenge(input),
    verifyIdentityLinkChallenge: async (input) => store.verifyIdentityLinkChallenge(input),
    linkChannelIdentity: async (contactId, channel, channelUserId, options, actor) => store.linkChannelIdentity(contactId, channel, channelUserId, options, actor),
    listAll: async () => store.listAll(),
    listIdentityLinkVerifications: async (limit) => store.listIdentityLinkVerifications(limit),
    listMutationAuditEntries: async (query) => store.listMutationAuditEntries(query),
    resolveChannelIdentity: async (channel, channelUserId, displayName) => store.resolveChannelIdentity(channel, channelUserId, displayName),
    resolveUserId: async (discordUserId) => store.resolveUserId(discordUserId),
    getCanonicalContactKey: async (channel, channelUserId) => store.getCanonicalContactKey(channel, channelUserId),
    deleteContact: async (id) => store.deleteContact(id),
    unlinkChannelIdentity: async (contactId, channel, channelUserId, actor) => store.unlinkChannelIdentity(contactId, channel, channelUserId, actor),
  };
}

export function createSQLiteContactStore(
  db: Database.Database,
  primaryUserId?: string,
  options: ContactStoreOptions = {},
): ContactStorePort {
  return asyncContactStore(new ContactStore(db, primaryUserId, options));
}
