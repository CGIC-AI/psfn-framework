import type Database from 'better-sqlite3';
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
import type { TrustLevel, LowTierTrustLevel, TrustMutationSource } from '../../system/trust/types.js';
import { isHighTierTrustLevel, isLowTierTrustLevel } from '../../system/trust/types.js';
import {
  evaluateLowTierTrustDriftSuggestion,
  isManualHighTierTrustMutationAuthorized,
  resolveTrustMutationSource,
  type TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import { createComponentLogger } from '../../shared/logger.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { appendMutationAuditEntry, listMutationAuditEntries } from './store/audit.js';
import {
  appendEmotionalObservationToTimeSeries,
  computeUpdatedEmotionalBaseline,
  type EmotionalTimeSeriesPoint,
  hasLearnedMoodSnapshot,
  normalizeEmotionalTimeSeries,
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
import type {
  ContactStorePort,
  ContactTrustDriftApplyResult,
  ContactTrustDriftSuggestion,
  ContactTrustMutationOptions,
  ContactUpsertMutationOptions,
} from './contact-store-port.js';

const log = createComponentLogger('ContactStore');

export interface ContactStoreOptions {
  exportDir?: string;
}

type PrimaryTrustMutationSource = 'upsert' | 'set_trust_level';
type PrimaryTrustMutationOutcome = 'allowed' | 'denied';

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

export class ContactStore implements ContactStorePort {
  private db: Database.Database;
  private primaryUserId?: string;
  private exportDir: string | null;

  constructor(db: Database.Database, primaryUserId?: string, options: ContactStoreOptions = {}) {
    this.db = db;
    this.primaryUserId = primaryUserId;
    this.exportDir = options.exportDir?.trim() ? options.exportDir.trim() : null;
    initializeContactStoreSchema(this.db);
    this.syncContactExports();
  }

  private buildUpsertResolveContext(): UpsertResolveContext {
    return {
      db: this.db,
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

  private resolveUpsertTarget(
    partial: Partial<Contact>,
    identities: ContactChannelIdentity[],
  ): Contact | undefined {
    return findUpsertTarget(partial, identities, {
      getById: id => this.getById(id),
      getByDiscordUserId: discordUserId => this.getByDiscordUserId(discordUserId),
      getByChannelIdentity: (channel, userId) => this.getByChannelIdentity(channel, userId),
    });
  }

  private getStoredEmotionalTimeSeries(id: string, limit?: number): EmotionalTimeSeriesPoint[] {
    const row = this.db.prepare(`
      SELECT emotional_time_series
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `).get(id) as { emotional_time_series?: string } | undefined;
    return normalizeEmotionalTimeSeries(row?.emotional_time_series, limit);
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

  private recordPrimaryTrustMutationAudit(params: {
    contactId?: string;
    previousTrustLevel: TrustLevel | null;
    actor?: string;
    source: PrimaryTrustMutationSource;
    outcome: PrimaryTrustMutationOutcome;
    details?: Record<string, unknown>;
  }): void {
    const baseActor = params.actor?.trim() || `system:contact_store:${params.source}`;
    const auditActor = `${baseActor}:primary_${params.outcome}`;

    if (params.contactId) {
      appendMutationAuditEntry(
        this.db,
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

  upsert(
    partial: Partial<Contact> & { displayName: string },
    options: ContactUpsertMutationOptions = {},
  ): Contact {
    const identities = collectUpsertIdentities(partial);
    const target = this.resolveUpsertTarget(partial, identities);
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
      this.recordPrimaryTrustMutationAudit({
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
    const contact = upsertContact(this.buildUpsertResolveContext(), partial);
    const row = this.db.prepare(`
      SELECT id, display_name, first_seen, last_seen
      FROM contacts
      WHERE id = ?
      LIMIT 1
    `).get(contact.id) as { id: string; display_name: string; first_seen: string; last_seen: string } | undefined;
    if (row) {
      ensureContactSocialGraphEntity(this.db, row);
    }
    if (contact.trustLevel === 'primary' && previousTrustLevel !== 'primary') {
      this.recordPrimaryTrustMutationAudit({
        contactId: contact.id,
        previousTrustLevel,
        actor: options.actor,
        source: 'upsert',
        outcome: 'allowed',
      });
    }
    log.debug('Upserted contact', { id: contact.id, displayName: partial.displayName });
    this.syncContactExports();
    return contact;
  }

  getById(id: string): Contact | undefined {
    return getContactById(this.db, id);
  }

  getByDiscordUserId(discordUserId: string): Contact | undefined {
    return getContactByDiscordUserId(this.db, discordUserId);
  }

  getByChannelIdentity(channel: ContactChannel, channelUserId: string): Contact | undefined {
    return getContactByChannelIdentity(this.db, channel, channelUserId);
  }

  getByTrustLevel(trustLevel: TrustLevel): Contact[] {
    return getContactsByTrustLevel(this.db, trustLevel);
  }

  getSocialGraphEntityById(entityId: string): SocialGraphEntity | undefined {
    return getSocialGraphEntityById(this.db, entityId);
  }

  getSocialGraphEntityByContactId(contactId: string): SocialGraphEntity | undefined {
    return getSocialGraphEntityByContactId(this.db, contactId);
  }

  listSocialGraphEntities(query: SocialGraphEntityQuery = {}): SocialGraphEntity[] {
    return listSocialGraphEntities(this.db, query);
  }

  upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): SocialGraphEntity {
    const entity = upsertSocialGraphEntity(this.db, input);
    this.syncContactExports();
    return entity;
  }

  upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): SocialRelationshipEdge {
    return upsertSocialRelationshipEdge(this.db, input);
  }

  listSocialRelationshipEdges(query: SocialRelationshipEdgeQuery = {}): SocialRelationshipEdge[] {
    return listSocialRelationshipEdges(this.db, query);
  }

  listRelatedContacts(contactId: string, query: SocialRelationshipEdgeQuery = {}): Contact[] {
    return listRelatedContactIds(this.db, contactId, query)
      .map(id => this.getById(id))
      .filter((contact): contact is Contact => contact !== undefined);
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

  suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    actor?: string,
  ): ContactTrustDriftSuggestion | null {
    const contact = this.getById(id);
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

  applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): ContactTrustDriftApplyResult {
    const contact = this.getById(id);
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

    const applied = this.setTrustLevel(
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

  setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options: ContactTrustMutationOptions = {},
  ): boolean {
    const contact = this.getById(id);
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
        this.recordPrimaryTrustMutationAudit({
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

    setContactTrustLevel(this.db, id, trustLevel);
    if (trustLevel === 'primary') {
      this.recordPrimaryTrustMutationAudit({
        contactId: id,
        previousTrustLevel: contact.trustLevel,
        actor,
        source: 'set_trust_level',
        outcome: 'allowed',
      });
    } else {
      appendMutationAuditEntry(this.db, id, 'trust_level', contact.trustLevel, trustLevel, actor);
    }
    log.debug('Updated trust level', { id, trustLevel });
    this.syncContactExports();
    return true;
  }

  setMachineIntelligence(id: string, isMachineIntelligence: boolean, actor?: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;
    const current = contact.isMachineIntelligence === true;
    if (current === isMachineIntelligence) return true;
    this.db.prepare('UPDATE contacts SET is_machine_intelligence = ? WHERE id = ?')
      .run(isMachineIntelligence ? 1 : 0, id);
    appendMutationAuditEntry(this.db, id, 'is_machine_intelligence', String(current), String(isMachineIntelligence), actor);
    return true;
  }

  updateLastSeen(id: string): void {
    updateContactLastSeen(this.db, id);
  }

  updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;

    const nextDisplayName = displayName.trim() || contact.displayName;
    const requestedNickname = normalizeNicknameValue(nickname);
    const nextNickname = requestedNickname === undefined
      ? (contact.nickname ?? null)
      : requestedNickname;

    if (contact.displayName === nextDisplayName && (contact.nickname ?? null) === nextNickname) {
      return true;
    }

    const updated = updateContactIdentityProfile(
      this.db,
      contactId,
      contact.displayName,
      contact.nickname,
      nextDisplayName,
      nickname,
    );
    if (updated) {
      ensureContactSocialGraphEntity(this.db, {
        id: contactId,
        display_name: nextDisplayName,
        first_seen: contact.firstSeen,
        last_seen: contact.lastSeen,
      });
      if (contact.displayName !== nextDisplayName) {
        appendMutationAuditEntry(this.db, contactId, 'display_name', contact.displayName, nextDisplayName, actor);
      }
      if ((contact.nickname ?? null) !== nextNickname) {
        appendMutationAuditEntry(this.db, contactId, 'nickname', contact.nickname ?? null, nextNickname, actor);
      }
      this.syncContactExports();
    }
    return updated;
  }

  recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): void {
    recordContactChannelActivity(this.db, contactId, channel, channelId, privacyLevel);
    this.syncContactExports();
  }

  mergeContacts(sourceContactId: string, targetContactId: string): boolean {
    const merged = mergeContactsOperation(
      { db: this.db },
      sourceContactId,
      targetContactId,
    );
    if (merged) {
      this.syncContactExports();
    }
    return merged;
  }

  updateNotes(id: string, notes: string, actor?: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    const previousNotes = contact.notes ?? null;
    if (previousNotes === notes) return true;

    updateContactNotes(this.db, id, notes);
    appendMutationAuditEntry(this.db, id, 'notes', previousNotes, notes, actor);
    this.syncContactExports();
    return true;
  }

  updateEmotionalBaseline(
    id: string,
    observation: {
      valence: number;
      confidence?: number;
      observedAtMs?: number;
    },
  ): Contact | undefined {
    const contact = this.getById(id);
    if (!contact) return undefined;

    const updatedBaseline = computeUpdatedEmotionalBaseline(contact.emotionalBaseline, observation);
    const updatedTimeSeries = appendEmotionalObservationToTimeSeries(
      this.getStoredEmotionalTimeSeries(id),
      observation,
    );
    updateContactEmotionalBaseline(this.db, id, updatedBaseline, updatedTimeSeries);
    this.syncContactExports();
    return this.getById(id);
  }

  getEmotionalSnapshot(
    id: string,
  ): {
    baselineValence: number;
    moodValence: number;
    moodDrift: number;
    moodSamples: number;
    lastMoodUpdateEpochMs?: number;
  } | undefined {
    const contact = this.getById(id);
    if (!contact) return undefined;

    const snapshot = parseMoodSnapshot(contact.emotionalBaseline);
    return hasLearnedMoodSnapshot(snapshot) ? snapshot : undefined;
  }

  getEmotionalTimeSeries(
    id: string,
    limit?: number,
  ): EmotionalTimeSeriesPoint[] {
    return this.getStoredEmotionalTimeSeries(id, limit);
  }

  updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;
    if (contact.relationshipType === relationshipType) return true;

    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      log.warn('Attempted to change primary user relationship type', { id, relationshipType });
      return false;
    }

    updateContactRelationshipType(this.db, id, relationshipType);
    appendMutationAuditEntry(this.db, id, 'relationship_type', contact.relationshipType, relationshipType, actor);
    this.syncContactExports();
    return true;
  }

  setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): boolean {
    if (!isValidChannelPrivacyLevel(privacyLevel)) return false;
    const contact = this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    if (existingLink.privacyLevel === privacyLevel) return true;

    const updated = updateContactChannelPrivacy(this.db, contactId, channel, channelUserId, privacyLevel);
    if (updated) {
      appendMutationAuditEntry(
        this.db,
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
      this.syncContactExports();
    }
    return updated;
  }

  setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): boolean {
    if (!isValidChannelPrivacyLevel(privacyLevel)) return false;
    const contact = this.getById(contactId);
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

    const updated = updateConversationChannelPrivacy(this.db, contactId, channel, channelId, privacyLevel);
    if (updated) {
      appendMutationAuditEntry(
        this.db,
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
      this.syncContactExports();
    }
    return updated;
  }

  getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): ChannelPrivacyLevel | undefined {
    return getConversationChannelPrivacy(this.db, contactId, channel, channelId);
  }

  deleteConversationChannel(contactId: string, channel: ContactChannel, channelId: string, actor?: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;

    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return false;

    const existingChannel = contact.conversationChannels?.find(entry => (
      entry.channel === normalizedChannel && entry.channelId === trimmedChannelId
    ));
    if (!existingChannel) return false;

    const deleted = deleteConversationChannelOperation(this.db, contactId, channel, channelId);
    if (deleted) {
      appendMutationAuditEntry(
        this.db,
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
      this.syncContactExports();
    }

    return deleted;
  }

  createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): ContactIdentityLinkChallengeResult {
    return createIdentityLinkChallenge(
      {
        db: this.db,
        getById: contactId => this.getById(contactId),
        getByChannelIdentity: (channel, channelUserId) => this.getByChannelIdentity(channel, channelUserId),
        linkChannelIdentity: (contactId, channel, channelUserId, options) => (
          this.linkChannelIdentity(contactId, channel, channelUserId, options)
        ),
      },
      input,
    );
  }

  verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): ContactIdentityLinkVerificationResult {
    return verifyIdentityLinkChallenge(
      {
        db: this.db,
        getById: contactId => this.getById(contactId),
        getByChannelIdentity: (channel, channelUserId) => this.getByChannelIdentity(channel, channelUserId),
        linkChannelIdentity: (contactId, channel, channelUserId, options) => (
          this.linkChannelIdentity(contactId, channel, channelUserId, options)
        ),
      },
      input,
    );
  }

  linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    actor?: string,
  ): ContactIdentityLinkResult {
    const result = linkChannelIdentity(
      this.buildUpsertResolveContext(),
      contactId,
      channel,
      channelUserId,
      options,
    );
    if (result === 'linked') {
      const normalizedIdentity = normalizeIdentity(channel, channelUserId);
      const updatedContact = this.getById(contactId);
      const linkedChannel = updatedContact?.channels?.find(link => (
        link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
      ));
      appendMutationAuditEntry(
        this.db,
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
    this.syncContactExports();
    return result;
  }

  listAll(): Contact[] {
    return listAllContacts(this.db);
  }

  listIdentityLinkVerifications(limit = 25): ContactIdentityLinkVerification[] {
    return listIdentityLinkVerifications(this.db, limit);
  }

  listMutationAuditEntries(query: ContactMutationAuditQuery = {}): ContactMutationAuditEntry[] {
    return listMutationAuditEntries(this.db, query);
  }

  resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Contact {
    const contact = resolveChannelIdentity(this.buildUpsertResolveContext(), channel, channelUserId, displayName);
    ensureContactSocialGraphEntity(this.db, {
      id: contact.id,
      display_name: contact.displayName,
      first_seen: contact.firstSeen,
      last_seen: contact.lastSeen,
    });
    this.syncContactExports();
    return contact;
  }

  resolveUserId(discordUserId: string): Contact {
    const contact = resolveUserId(this.buildUpsertResolveContext(), discordUserId);
    ensureContactSocialGraphEntity(this.db, {
      id: contact.id,
      display_name: contact.displayName,
      first_seen: contact.firstSeen,
      last_seen: contact.lastSeen,
    });
    this.syncContactExports();
    return contact;
  }

  getCanonicalContactKey(channel: ContactChannel, channelUserId: string): string | undefined {
    return getCanonicalContactKey(this.db, channel, channelUserId);
  }

  deleteContact(id: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;
    if (contact.trustLevel === 'primary') {
      log.warn('Attempted to delete primary user contact', { id });
      return false;
    }
    const deleted = deleteContactOperation(this.db, id);
    if (deleted) {
      this.syncContactExports();
    }
    return deleted;
  }

  unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    const unlinked = unlinkChannelIdentityOperation(this.db, contactId, channel, channelUserId);
    if (unlinked) {
      appendMutationAuditEntry(
        this.db,
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
      this.syncContactExports();
    }
    return unlinked;
  }

  private syncContactExports(): void {
    if (!this.exportDir) return;

    try {
      mkdirSync(this.exportDir, { recursive: true });
      const contacts = listAllContacts(this.db);
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
