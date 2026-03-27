import type { DatabaseAdapter } from './persistence/db-adapter.js';
import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Contact,
  ContactChannel,
  ContactChannelIdentity,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  ChannelPrivacyLevel,
  RelationshipType,
  SocialGraphEntity,
  SocialGraphEntityQuery,
  SocialGraphEntityUpsertInput,
  SocialRelationshipEdge,
  SocialRelationshipEdgeQuery,
  SocialRelationshipEdgeUpsertInput,
} from './types.js';
import type { TrustLevel, LowTierTrustLevel, TrustMutationSource } from '../trust/types.js';
import { isHighTierTrustLevel, isLowTierTrustLevel } from '../trust/types.js';
import {
  evaluateLowTierTrustDriftSuggestion,
  isManualHighTierTrustMutationAuthorized,
  resolveTrustMutationSource,
  type LowTierTrustDriftSuggestion,
  type TrustDriftBehaviorSignals,
} from '../trust/policy.js';
import { createComponentLogger } from '../logger.js';
import { writeJsonAtomic } from '../utils/fs.js';
import { appendMutationAuditEntry, listMutationAuditEntries } from './store/audit.js';
import {
  computeUpdatedEmotionalBaseline,
  hasLearnedMoodSnapshot,
  parseMoodSnapshot,
} from './store/emotional-baseline.js';
import {
  createIdentityLinkChallenge,
  verifyIdentityLinkChallenge,
} from './store/identity-link-verification.js';
import {
  LEGACY_DISCORD_CHANNEL,
  isPrimaryIdentity,
  isValidChannelPrivacyLevel,
  normalizeIdentity,
  normalizeNicknameValue,
  normalizePrivacyLevel,
} from './store/identity-utils.js';
import { mergeContacts as mergeContactsOperation } from './store/merge-operations.js';
import {
  deleteConversationChannel as deleteConversationChannelOperation,
  deleteContact as deleteContactOperation,
  recordContactChannelActivity,
  setContactTrustLevel,
  unlinkChannelIdentity as unlinkChannelIdentityOperation,
  updateConversationChannelPrivacy,
  updateContactChannelPrivacy,
  updateContactEmotionalBaseline,
  updateContactIdentityProfile,
  updateContactLastSeen,
  updateContactNotes,
  updateContactRelationshipType,
} from './store/mutation-operations.js';
import {
  getCanonicalContactKey,
  getContactByChannelIdentity,
  getConversationChannelPrivacy,
  getContactByDiscordUserId,
  getContactById,
  getContactsByTrustLevel,
  listAllContacts,
  listIdentityLinkVerifications,
} from './store/read-operations.js';
import { initializeContactStoreSchema } from './store/schema.js';
import {
  ensureContactSocialGraphEntity,
  getSocialGraphEntityByContactId,
  getSocialGraphEntityById,
  listRelatedContactIds,
  listSocialGraphEntities,
  listSocialRelationshipEdges,
  upsertSocialGraphEntity,
  upsertSocialRelationshipEdge,
} from './store/social-graph.js';
import {
  collectUpsertIdentities,
  findUpsertTarget,
} from './store/upsert.js';
import {
  linkChannelIdentity,
  resolveChannelIdentity,
  resolveUserId,
  type UpsertResolveContext,
  upsertContact,
} from './store/upsert-resolve-operations.js';

const log = createComponentLogger('ContactStore');

interface ContactStoreOptions {
  exportDir?: string;
}

interface TrustMutationOptions {
  allowPrimaryTrustAssignment?: boolean;
  mutationSource?: TrustMutationSource;
}

interface UpsertMutationOptions extends TrustMutationOptions {
  actor?: string;
}

type PrimaryTrustMutationSource = 'upsert' | 'set_trust_level';
type PrimaryTrustMutationOutcome = 'allowed' | 'denied';

export interface ContactTrustDriftSuggestion extends LowTierTrustDriftSuggestion {
  contactId: string;
  createdAt: string;
}

export interface ContactTrustDriftApplyResult {
  applied: boolean;
  reason: string;
}

function sanitizeContactFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function serializeChannelPrivacyAuditValue(params: {
  channel: string;
  privacyLevel: ChannelPrivacyLevel;
  userId?: string;
  channelId?: string;
}): string {
  return JSON.stringify(params);
}

function serializeChannelLinkAuditValue(params: {
  channel: string;
  userId: string;
  privacyLevel: ChannelPrivacyLevel;
}): string {
  return JSON.stringify(params);
}

function serializeConversationChannelAuditValue(params: {
  channel: string;
  channelId: string;
  privacyLevel?: ChannelPrivacyLevel;
}): string {
  return JSON.stringify(params);
}

export class ContactStore {
  private adapter: DatabaseAdapter;
  private primaryUserId?: string;
  private exportDir: string | null;

  constructor(adapter: DatabaseAdapter, primaryUserId?: string, options: ContactStoreOptions = {}) {
    this.adapter = adapter;
    this.primaryUserId = primaryUserId;
    this.exportDir = options.exportDir?.trim() ? options.exportDir.trim() : null;
  }

  async init(): Promise<void> {
    await initializeContactStoreSchema(this.adapter);
    await this.syncContactExports();
  }

  private buildUpsertResolveContext(): UpsertResolveContext {
    return {
      adapter: this.adapter,
      primaryUserId: this.primaryUserId,
      getById: id => this.getById(id),
      getByDiscordUserId: discordUserId => this.getByDiscordUserId(discordUserId),
      getByChannelIdentity: (channel, channelUserId) => this.getByChannelIdentity(channel, channelUserId),
      mergeContacts: (sourceContactId, targetContactId) => this.mergeContacts(sourceContactId, targetContactId),
      onIdentityConflict: ({ contactId, channel, userId }) => {
        log.warn('Identity conflict while linking contact identity', {
          contactId,
          channel,
          userId,
        });
      },
    };
  }

  private async resolveUpsertTarget(
    partial: Partial<Contact>,
    identities: ContactChannelIdentity[],
  ): Promise<Contact | undefined> {
    return findUpsertTarget(partial, identities, {
      getById: id => this.getById(id),
      getByDiscordUserId: discordUserId => this.getByDiscordUserId(discordUserId),
      getByChannelIdentity: (channel, userId) => this.getByChannelIdentity(channel, userId),
    });
  }

  private isPrimaryTrustAssignmentAuthorized(
    contact: Contact | undefined,
    identities: ContactChannelIdentity[],
    discordUserId: string | undefined,
    options: TrustMutationOptions = {},
  ): boolean {
    if (options.allowPrimaryTrustAssignment === true) return true;

    const configuredPrimaryUserId = this.primaryUserId?.trim();
    if (!configuredPrimaryUserId) return false;

    if (contact?.discordUserId?.trim() === configuredPrimaryUserId) return true;
    if (discordUserId?.trim() === configuredPrimaryUserId) return true;

    const candidates: ContactChannelIdentity[] = [
      ...identities,
      ...(Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : []),
      ...(contact?.discordUserId ? [{ channel: LEGACY_DISCORD_CHANNEL, userId: contact.discordUserId }] : []),
      ...(discordUserId ? [{ channel: LEGACY_DISCORD_CHANNEL, userId: discordUserId }] : []),
    ];

    return candidates.some(identity => isPrimaryIdentity(identity, configuredPrimaryUserId));
  }

  private async recordPrimaryTrustMutationAudit(params: {
    contactId?: string;
    previousTrustLevel: TrustLevel | null;
    actor?: string;
    source: PrimaryTrustMutationSource;
    outcome: PrimaryTrustMutationOutcome;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const baseActor = params.actor?.trim() || `system:contact_store:${params.source}`;
    const auditActor = `${baseActor}:primary_${params.outcome}`;

    if (params.contactId) {
      await appendMutationAuditEntry(
        this.adapter,
        params.contactId,
        'trust_level',
        params.previousTrustLevel,
        'primary',
        auditActor,
      );
    }

    const message = params.outcome === 'allowed'
      ? 'Allowed primary trust mutation'
      : 'Denied primary trust mutation';
    const payload = {
      contactId: params.contactId,
      previousTrustLevel: params.previousTrustLevel,
      actor: baseActor,
      source: params.source,
      ...(params.details ?? {}),
    };
    if (params.outcome === 'allowed') {
      log.info(message, payload);
      return;
    }
    log.warn(message, payload);
  }

  async upsert(
    partial: Partial<Contact> & { displayName: string },
    options: UpsertMutationOptions = {},
  ): Promise<Contact> {
    const identities = collectUpsertIdentities(partial);
    const target = await this.resolveUpsertTarget(partial, identities);
    const mutationSource = resolveTrustMutationSource(options.actor, options.mutationSource);

    if (
      partial.trustLevel !== undefined
      && isHighTierTrustLevel(partial.trustLevel)
      && !isManualHighTierTrustMutationAuthorized(options.actor, mutationSource)
    ) {
      throw new Error('High-tier trust assignment denied: manual operator authorization required');
    }

    if (
      partial.trustLevel === 'primary'
      && !this.isPrimaryTrustAssignmentAuthorized(target, identities, partial.discordUserId, options)
    ) {
      await this.recordPrimaryTrustMutationAudit({
        contactId: target?.id,
        previousTrustLevel: target?.trustLevel ?? null,
        actor: options.actor,
        source: 'upsert',
        outcome: 'denied',
        details: {
          requestedTrustLevel: partial.trustLevel,
          hasConfiguredPrimaryUserId: Boolean(this.primaryUserId?.trim()),
        },
      });
      throw new Error('Primary trust assignment denied: identity does not match configured owner mapping');
    }

    const previousTrustLevel = target?.trustLevel ?? null;
    const contact = await upsertContact(this.buildUpsertResolveContext(), partial);
    const row = await this.adapter.queryOne<{ id: string; display_name: string; first_seen: string; last_seen: string }>(`
      SELECT id, display_name, first_seen, last_seen
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `, [contact.id]);
    if (row) {
      await ensureContactSocialGraphEntity(this.adapter, row);
    }
    if (contact.trustLevel === 'primary' && previousTrustLevel !== 'primary') {
      await this.recordPrimaryTrustMutationAudit({
        contactId: contact.id,
        previousTrustLevel,
        actor: options.actor,
        source: 'upsert',
        outcome: 'allowed',
      });
    }
    log.debug('Upserted contact', { id: contact.id, displayName: partial.displayName });
    await this.syncContactExports();
    return contact;
  }

  async getById(id: string): Promise<Contact | undefined> {
    return getContactById(this.adapter, id);
  }

  async getByDiscordUserId(discordUserId: string): Promise<Contact | undefined> {
    return getContactByDiscordUserId(this.adapter, discordUserId);
  }

  async getByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined> {
    return getContactByChannelIdentity(this.adapter, channel, channelUserId);
  }

  async getByTrustLevel(trustLevel: TrustLevel): Promise<Contact[]> {
    return getContactsByTrustLevel(this.adapter, trustLevel);
  }

  async getSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined> {
    return getSocialGraphEntityById(this.adapter, entityId);
  }

  async getSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
    return getSocialGraphEntityByContactId(this.adapter, contactId);
  }

  async listSocialGraphEntities(query: SocialGraphEntityQuery = {}): Promise<SocialGraphEntity[]> {
    return listSocialGraphEntities(this.adapter, query);
  }

  async upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): Promise<SocialGraphEntity> {
    const entity = await upsertSocialGraphEntity(this.adapter, input);
    await this.syncContactExports();
    return entity;
  }

  async upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): Promise<SocialRelationshipEdge> {
    return upsertSocialRelationshipEdge(this.adapter, input);
  }

  async listSocialRelationshipEdges(query: SocialRelationshipEdgeQuery = {}): Promise<SocialRelationshipEdge[]> {
    return listSocialRelationshipEdges(this.adapter, query);
  }

  async listRelatedContacts(contactId: string, query: SocialRelationshipEdgeQuery = {}): Promise<Contact[]> {
    const relatedIds = await listRelatedContactIds(this.adapter, contactId, query);
    const contacts: Contact[] = [];
    for (const id of relatedIds) {
      const contact = await this.getById(id);
      if (contact) contacts.push(contact);
    }
    return contacts;
  }

  private isBehaviorDriftMutationAllowed(
    contactId: string,
    currentTrustLevel: TrustLevel,
    requestedTrustLevel: TrustLevel,
    actor?: string,
  ): boolean {
    if (isHighTierTrustLevel(currentTrustLevel) || isHighTierTrustLevel(requestedTrustLevel)) {
      log.warn('Denied behavior-driven trust mutation touching high-tier trust', {
        contactId,
        currentTrustLevel,
        requestedTrustLevel,
        actor,
      });
      return false;
    }
    return true;
  }

  private isHighTierMutationAllowed(
    contactId: string,
    currentTrustLevel: TrustLevel,
    requestedTrustLevel: TrustLevel,
    actor: string | undefined,
    mutationSource: TrustMutationSource,
  ): boolean {
    if (!isHighTierTrustLevel(currentTrustLevel) && !isHighTierTrustLevel(requestedTrustLevel)) {
      return true;
    }

    if (isManualHighTierTrustMutationAuthorized(actor, mutationSource)) {
      return true;
    }

    log.warn('Denied trust mutation touching high-tier trust without manual authorization', {
      contactId,
      currentTrustLevel,
      requestedTrustLevel,
      actor,
      mutationSource,
    });
    return false;
  }

  async suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    actor?: string,
  ): Promise<ContactTrustDriftSuggestion | null> {
    const contact = await this.getById(id);
    if (!contact) return null;

    const suggestion = evaluateLowTierTrustDriftSuggestion(contact.trustLevel, signals);
    if (!suggestion) return null;

    const contactSuggestion: ContactTrustDriftSuggestion = {
      ...suggestion,
      contactId: contact.id,
      createdAt: new Date().toISOString(),
    };
    log.info('Generated low-tier trust drift suggestion', {
      contactId: contact.id,
      fromTrustLevel: contactSuggestion.fromTrustLevel,
      suggestedTrustLevel: contactSuggestion.suggestedTrustLevel,
      confidence: contactSuggestion.confidence,
      actor,
    });
    return contactSuggestion;
  }

  async applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): Promise<ContactTrustDriftApplyResult> {
    const contact = await this.getById(id);
    if (!contact) {
      return { applied: false, reason: `Contact ${id} not found` };
    }

    if (suggestion.contactId !== id) {
      return { applied: false, reason: 'Trust drift suggestion contact mismatch' };
    }

    if (!isLowTierTrustLevel(contact.trustLevel)) {
      return { applied: false, reason: 'High-tier trust requires manual-only mutation paths' };
    }

    const currentTrustLevel = contact.trustLevel as LowTierTrustLevel;
    if (suggestion.fromTrustLevel !== currentTrustLevel) {
      return {
        applied: false,
        reason: `Stale trust drift suggestion: expected ${suggestion.fromTrustLevel}, found ${currentTrustLevel}`,
      };
    }

    if (!isLowTierTrustLevel(suggestion.suggestedTrustLevel)) {
      return {
        applied: false,
        reason: 'Trust drift suggestion denied: high-tier trust cannot be set through suggestion flow',
      };
    }

    const applied = await this.setTrustLevel(
      id,
      suggestion.suggestedTrustLevel,
      actor,
      { mutationSource: 'behavior_drift' },
    );
    if (!applied) {
      return { applied: false, reason: 'Trust drift suggestion denied by trust guardrails' };
    }

    return {
      applied: true,
      reason: `Applied low-tier trust drift: ${suggestion.fromTrustLevel} -> ${suggestion.suggestedTrustLevel}`,
    };
  }

  async setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options: TrustMutationOptions = {},
  ): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === trustLevel) return true;

    const mutationSource = resolveTrustMutationSource(actor, options.mutationSource);
    if (
      mutationSource === 'behavior_drift'
      && !this.isBehaviorDriftMutationAllowed(id, contact.trustLevel, trustLevel, actor)
    ) {
      return false;
    }

    if (!this.isHighTierMutationAllowed(id, contact.trustLevel, trustLevel, actor, mutationSource)) {
      return false;
    }

    if (contact.trustLevel === 'primary') {
      log.warn('Attempted to change primary user trust level', { id });
      return false;
    }

    if (trustLevel === 'primary') {
      const authorized = this.isPrimaryTrustAssignmentAuthorized(
        contact,
        contact.channelIdentities ?? [],
        contact.discordUserId,
        options,
      );
      if (!authorized) {
        await this.recordPrimaryTrustMutationAudit({
          contactId: contact.id,
          previousTrustLevel: contact.trustLevel,
          actor,
          source: 'set_trust_level',
          outcome: 'denied',
          details: {
            requestedTrustLevel: trustLevel,
            hasConfiguredPrimaryUserId: Boolean(this.primaryUserId?.trim()),
          },
        });
        return false;
      }
    }

    await setContactTrustLevel(this.adapter, id, trustLevel);
    if (trustLevel === 'primary') {
      await this.recordPrimaryTrustMutationAudit({
        contactId: id,
        previousTrustLevel: contact.trustLevel,
        actor,
        source: 'set_trust_level',
        outcome: 'allowed',
      });
    } else {
      await appendMutationAuditEntry(this.adapter, id, 'trust_level', contact.trustLevel, trustLevel, actor);
    }
    log.debug('Updated trust level', { id, trustLevel });
    await this.syncContactExports();
    return true;
  }

  async updateLastSeen(id: string): Promise<void> {
    await updateContactLastSeen(this.adapter, id);
  }

  async updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;

    const nextDisplayName = displayName.trim() || contact.displayName;
    const requestedNickname = normalizeNicknameValue(nickname);
    const nextNickname = requestedNickname === undefined
      ? (contact.nickname ?? null)
      : requestedNickname;

    if (contact.displayName === nextDisplayName && (contact.nickname ?? null) === nextNickname) {
      return true;
    }

    const updated = await updateContactIdentityProfile(
      this.adapter,
      contactId,
      contact.displayName,
      contact.nickname,
      nextDisplayName,
      nickname,
    );
    if (updated) {
      await ensureContactSocialGraphEntity(this.adapter, {
        id: contactId,
        display_name: nextDisplayName,
        first_seen: contact.firstSeen,
        last_seen: contact.lastSeen,
      });
      if (contact.displayName !== nextDisplayName) {
        await appendMutationAuditEntry(this.adapter, contactId, 'display_name', contact.displayName, nextDisplayName, actor);
      }
      if ((contact.nickname ?? null) !== nextNickname) {
        await appendMutationAuditEntry(this.adapter, contactId, 'nickname', contact.nickname ?? null, nextNickname, actor);
      }
      await this.syncContactExports();
    }
    return updated;
  }

  async recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<void> {
    await recordContactChannelActivity(this.adapter, contactId, channel, channelId, privacyLevel);
    await this.syncContactExports();
  }

  async mergeContacts(sourceContactId: string, targetContactId: string): Promise<boolean> {
    const merged = await mergeContactsOperation(
      { adapter: this.adapter },
      sourceContactId,
      targetContactId,
    );
    if (merged) {
      await this.syncContactExports();
    }
    return merged;
  }

  async updateNotes(id: string, notes: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;

    const previousNotes = contact.notes ?? null;
    if (previousNotes === notes) return true;

    await updateContactNotes(this.adapter, id, notes);
    await appendMutationAuditEntry(this.adapter, id, 'notes', previousNotes, notes, actor);
    await this.syncContactExports();
    return true;
  }

  async updateEmotionalBaseline(
    id: string,
    observation: {
      valence: number;
      confidence?: number;
      observedAtMs?: number;
    },
  ): Promise<Contact | undefined> {
    const contact = await this.getById(id);
    if (!contact) return undefined;

    const updatedBaseline = computeUpdatedEmotionalBaseline(contact.emotionalBaseline, observation);
    await updateContactEmotionalBaseline(this.adapter, id, updatedBaseline);
    await this.syncContactExports();
    return this.getById(id);
  }

  async getEmotionalSnapshot(
    id: string,
  ): Promise<{
    baselineValence: number;
    moodValence: number;
    moodDrift: number;
    moodSamples: number;
    lastMoodUpdateEpochMs?: number;
  } | undefined> {
    const contact = await this.getById(id);
    if (!contact) return undefined;

    const snapshot = parseMoodSnapshot(contact.emotionalBaseline);
    return hasLearnedMoodSnapshot(snapshot) ? snapshot : undefined;
  }

  async updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.relationshipType === relationshipType) return true;

    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      log.warn('Attempted to change primary user relationship type', { id, relationshipType });
      return false;
    }

    await updateContactRelationshipType(this.adapter, id, relationshipType);
    await appendMutationAuditEntry(this.adapter, id, 'relationship_type', contact.relationshipType, relationshipType, actor);
    await this.syncContactExports();
    return true;
  }

  async setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
    if (!isValidChannelPrivacyLevel(privacyLevel)) return false;
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    if (existingLink.privacyLevel === privacyLevel) return true;

    const updated = await updateContactChannelPrivacy(this.adapter, contactId, channel, channelUserId, privacyLevel);
    if (updated) {
      await appendMutationAuditEntry(
        this.adapter,
        contactId,
        'channel_privacy',
        serializeChannelPrivacyAuditValue({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel: existingLink.privacyLevel,
        }),
        serializeChannelPrivacyAuditValue({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel,
        }),
        actor,
      );
      await this.syncContactExports();
    }
    return updated;
  }

  async setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
    if (!isValidChannelPrivacyLevel(privacyLevel)) return false;
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return false;
    const existingChannel = contact.conversationChannels?.find(entry => (
      entry.channel === normalizedChannel && entry.channelId === trimmedChannelId
    ));
    const previousPrivacyLevel = existingChannel?.privacyLevel;
    const normalizedPrivacyLevel = normalizePrivacyLevel(privacyLevel, normalizedChannel);
    if (previousPrivacyLevel === normalizedPrivacyLevel) return true;

    const updated = await updateConversationChannelPrivacy(this.adapter, contactId, channel, channelId, privacyLevel);
    if (updated) {
      await appendMutationAuditEntry(
        this.adapter,
        contactId,
        'channel_privacy',
        previousPrivacyLevel
          ? serializeChannelPrivacyAuditValue({
            channel: normalizedChannel,
            channelId: trimmedChannelId,
            privacyLevel: previousPrivacyLevel,
          })
          : null,
        serializeChannelPrivacyAuditValue({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          privacyLevel: normalizedPrivacyLevel,
        }),
        actor,
      );
      await this.syncContactExports();
    }
    return updated;
  }

  async getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): Promise<ChannelPrivacyLevel | undefined> {
    return getConversationChannelPrivacy(this.adapter, contactId, channel, channelId);
  }

  async deleteConversationChannel(contactId: string, channel: ContactChannel, channelId: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;

    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return false;

    const existingChannel = contact.conversationChannels?.find(entry => (
      entry.channel === normalizedChannel && entry.channelId === trimmedChannelId
    ));
    if (!existingChannel) return false;

    const deleted = await deleteConversationChannelOperation(this.adapter, contactId, channel, channelId);
    if (deleted) {
      await appendMutationAuditEntry(
        this.adapter,
        contactId,
        'conversation_channel',
        serializeConversationChannelAuditValue({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          ...(existingChannel.privacyLevel ? { privacyLevel: existingChannel.privacyLevel } : {}),
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }

    return deleted;
  }

  async createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): Promise<ContactIdentityLinkChallengeResult> {
    return createIdentityLinkChallenge(
      {
        adapter: this.adapter,
        getById: contactId => this.getById(contactId),
        getByChannelIdentity: (channel, channelUserId) => this.getByChannelIdentity(channel, channelUserId),
        linkChannelIdentity: async (contactId, channel, channelUserId, options) => (
          this.linkChannelIdentity(contactId, channel, channelUserId, options)
        ),
      },
      input,
    );
  }

  async verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): Promise<ContactIdentityLinkVerificationResult> {
    return verifyIdentityLinkChallenge(
      {
        adapter: this.adapter,
        getById: contactId => this.getById(contactId),
        getByChannelIdentity: (channel, channelUserId) => this.getByChannelIdentity(channel, channelUserId),
        linkChannelIdentity: async (contactId, channel, channelUserId, options) => (
          this.linkChannelIdentity(contactId, channel, channelUserId, options)
        ),
      },
      input,
    );
  }

  async linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    actor?: string,
  ): Promise<ContactIdentityLinkResult> {
    const result = await linkChannelIdentity(
      this.buildUpsertResolveContext(),
      contactId,
      channel,
      channelUserId,
      options,
    );
    if (result === 'linked') {
      const normalizedIdentity = normalizeIdentity(channel, channelUserId);
      const updatedContact = await this.getById(contactId);
      const linkedChannel = updatedContact?.channels?.find(link => (
        link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
      ));
      await appendMutationAuditEntry(
        this.adapter,
        contactId,
        'channel_link',
        null,
        serializeChannelLinkAuditValue({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel: linkedChannel?.privacyLevel ?? normalizePrivacyLevel(options?.privacyLevel, normalizedIdentity.channel),
        }),
        actor,
      );
    }
    await this.syncContactExports();
    return result;
  }

  async listAll(): Promise<Contact[]> {
    return listAllContacts(this.adapter);
  }

  async listIdentityLinkVerifications(limit = 25): Promise<ContactIdentityLinkVerification[]> {
    return listIdentityLinkVerifications(this.adapter, limit);
  }

  async listMutationAuditEntries(query: ContactMutationAuditQuery = {}): Promise<ContactMutationAuditEntry[]> {
    return listMutationAuditEntries(this.adapter, query);
  }

  async resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Promise<Contact> {
    const contact = await resolveChannelIdentity(this.buildUpsertResolveContext(), channel, channelUserId, displayName);
    await ensureContactSocialGraphEntity(this.adapter, {
      id: contact.id,
      display_name: contact.displayName,
      first_seen: contact.firstSeen,
      last_seen: contact.lastSeen,
    });
    await this.syncContactExports();
    return contact;
  }

  async resolveUserId(discordUserId: string): Promise<Contact> {
    const contact = await resolveUserId(this.buildUpsertResolveContext(), discordUserId);
    await ensureContactSocialGraphEntity(this.adapter, {
      id: contact.id,
      display_name: contact.displayName,
      first_seen: contact.firstSeen,
      last_seen: contact.lastSeen,
    });
    await this.syncContactExports();
    return contact;
  }

  async getCanonicalContactKey(channel: ContactChannel, channelUserId: string): Promise<string | undefined> {
    return getCanonicalContactKey(this.adapter, channel, channelUserId);
  }

  async deleteContact(id: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.trustLevel === 'primary') {
      log.warn('Attempted to delete primary user contact', { id });
      return false;
    }
    const deleted = await deleteContactOperation(this.adapter, id);
    if (deleted) {
      await this.syncContactExports();
    }
    return deleted;
  }

  async unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    const unlinked = await unlinkChannelIdentityOperation(this.adapter, contactId, channel, channelUserId);
    if (unlinked) {
      await appendMutationAuditEntry(
        this.adapter,
        contactId,
        'channel_link',
        serializeChannelLinkAuditValue({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel: existingLink.privacyLevel,
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }
    return unlinked;
  }

  private async syncContactExports(): Promise<void> {
    if (!this.exportDir) return;

    try {
      mkdirSync(this.exportDir, { recursive: true });
      const contacts = await listAllContacts(this.adapter);
      const indexPath = join(this.exportDir, 'index.json');

      writeJsonAtomic(indexPath, {
        updatedAt: new Date().toISOString(),
        count: contacts.length,
        contacts: contacts.map(contact => ({
          id: contact.id,
          displayName: contact.displayName,
          nickname: contact.nickname,
          trustLevel: contact.trustLevel,
          relationshipType: contact.relationshipType,
          lastSeen: contact.lastSeen,
        })),
      });

      const expectedFiles = new Set<string>(['index.json']);
      for (const contact of contacts) {
        const fileName = `contact-${sanitizeContactFileComponent(contact.id)}.json`;
        expectedFiles.add(fileName);
        writeJsonAtomic(join(this.exportDir, fileName), contact);
      }

      for (const fileName of readdirSync(this.exportDir)) {
        if (!fileName.endsWith('.json')) continue;
        if (expectedFiles.has(fileName)) continue;
        unlinkSync(join(this.exportDir, fileName));
      }
    } catch (error) {
      log.warn('Failed to sync contact file exports', {
        exportDir: this.exportDir,
        error: String(error),
      });
    }
  }
}