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
} from './types.js';
import type { TrustLevel } from '../trust/types.js';
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
} from './store/identity-utils.js';
import { mergeContacts as mergeContactsOperation } from './store/merge-operations.js';
import {
  deleteContact as deleteContactOperation,
  recordContactChannelActivity,
  setContactTrustLevel,
  unlinkChannelIdentity as unlinkChannelIdentityOperation,
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
  getContactByDiscordUserId,
  getContactById,
  getContactsByTrustLevel,
  listAllContacts,
  listIdentityLinkVerifications,
} from './store/read-operations.js';
import { initializeContactStoreSchema } from './store/schema.js';
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
}

interface UpsertMutationOptions extends TrustMutationOptions {
  actor?: string;
}

type PrimaryTrustMutationSource = 'upsert' | 'set_trust_level';
type PrimaryTrustMutationOutcome = 'allowed' | 'denied';

function sanitizeContactFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export class ContactStore {
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
    options: UpsertMutationOptions = {},
  ): Contact {
    const identities = collectUpsertIdentities(partial);
    const target = this.resolveUpsertTarget(partial, identities);
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

  setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options: TrustMutationOptions = {},
  ): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === trustLevel) return true;

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

  updateLastSeen(id: string): void {
    updateContactLastSeen(this.db, id);
  }

  updateIdentityProfile(contactId: string, displayName: string, nickname?: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;

    const updated = updateContactIdentityProfile(
      this.db,
      contactId,
      contact.displayName,
      contact.nickname,
      displayName,
      nickname,
    );
    if (updated) {
      this.syncContactExports();
    }
    return updated;
  }

  recordChannelActivity(contactId: string, channel: ContactChannel, channelId: string): void {
    recordContactChannelActivity(this.db, contactId, channel, channelId);
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
    updateContactEmotionalBaseline(this.db, id, updatedBaseline);
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

  updateRelationshipType(id: string, relationshipType: RelationshipType): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      log.warn('Attempted to change primary user relationship type', { id, relationshipType });
      return false;
    }

    updateContactRelationshipType(this.db, id, relationshipType);
    this.syncContactExports();
    return true;
  }

  setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
  ): boolean {
    if (!isValidChannelPrivacyLevel(privacyLevel)) return false;
    const updated = updateContactChannelPrivacy(this.db, contactId, channel, channelUserId, privacyLevel);
    if (updated) {
      this.syncContactExports();
    }
    return updated;
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
  ): ContactIdentityLinkResult {
    const result = linkChannelIdentity(
      this.buildUpsertResolveContext(),
      contactId,
      channel,
      channelUserId,
      options,
    );
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
    this.syncContactExports();
    return contact;
  }

  resolveUserId(discordUserId: string): Contact {
    const contact = resolveUserId(this.buildUpsertResolveContext(), discordUserId);
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

  unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;
    const unlinked = unlinkChannelIdentityOperation(this.db, contactId, channel, channelUserId);
    if (unlinked) {
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
