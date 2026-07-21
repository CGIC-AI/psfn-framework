import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  RelationshipType,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import { isHighTierTrustLevel } from '../../../system/trust/types.js';
import { isManualHighTierTrustMutationAuthorized, resolveTrustMutationSource } from '../../../system/trust/policy.js';
import {
  isManualRelationshipMutationAuthorized,
  requiresManualRelationshipMutation,
} from '../relationship-progression.js';
import type { ContactUpsertMutationOptions, MachineIntelligenceObservationMarkResult } from '../contact-store-port.js';
import { isDeliberateMachineIntelligenceCorrection } from '../observed-machine-intelligence.js';
import type { EmotionalSnapshot, EmotionalTimeSeriesPoint } from '../store/emotional-baseline.js';
import {
  appendEmotionalObservationToTimeSeries,
  computeUpdatedEmotionalBaseline,
  hasLearnedMoodSnapshot,
  MAX_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
  mergeEmotionalTimeSeries,
  parseMoodSnapshot,
} from '../store/emotional-baseline.js';
import {
  defaultPrivacyForChannel,
  earliestTimestamp,
  isPrimaryIdentity,
  looksLikeOpaqueIdentifier,
  latestTimestamp,
  normalizeIdentity,
  normalizeNicknameValue,
  normalizePrivacyLevel,
  pickMostTrustedLevel,
  pickPreferredDisplayName,
} from '../store/identity-utils.js';
import { collectUpsertIdentities } from '../store/upsert.js';
import type { ContactIdentityVerificationRow, ContactMutationAuditRow, ContactRow, SocialGraphEntityRow, SocialRelationshipEdgeRow } from './rows.js';
import {
  chooseMoreRestrictiveSensitivity,
  contactMutationAuditRowToEntry,
  normalizeAuditActor,
  normalizeJsonObject,
  normalizeLimit,
  socialGraphEdgeRowToEdge,
  socialGraphEntityRowToEntity,
} from './mapping.js';
import { invalidateMemorySubjectsForContact } from './memory-subject-lifecycle.js';
import { queryOne, queryRows, withPostgresClient } from './connection.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';
import { compareAndSetGenericUpsertTrust, loadContactTrustSnapshot } from './trust-concurrency.js';
import { markVerifiedContactOwnership } from './contact-lifecycle-snapshot.js';
import { timingSafeStringEqual } from '../../../shared/utils/secret-compare.js';
import {
  beginContactLifecycleMutationCommit,
  completeContactLifecycleMutationCommit,
} from './contact-lifecycle-mutation-commit.js';

function hasOwnTimezone(partial: Partial<Contact>): boolean {
  return Object.prototype.hasOwnProperty.call(partial, 'timezone');
}

function normalizeTimezoneValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const postgresContactCrudOperations: PostgresContactOperationMap = {
  async upsert(
    partial: Partial<Contact> & { displayName: string },
    options: ContactUpsertMutationOptions = {},
  ): Promise<Contact> {
    const identities = collectUpsertIdentities(partial);
    let target = partial.id ? await this.getById(partial.id) : undefined;
    if (!target && partial.discordUserId) {
      target = await this.getByDiscordUserId(partial.discordUserId);
    }
    if (!target) {
      for (const identity of identities) {
        target = await this.getByChannelIdentity(identity.channel, identity.userId);
        if (target) break;
      }
    }

    const mutationSource = resolveTrustMutationSource(options.actor, options.mutationSource);

    if (
      partial.trustLevel !== undefined
      && isHighTierTrustLevel(partial.trustLevel)
      && !isManualHighTierTrustMutationAuthorized(options.actor, mutationSource)
    ) {
      throw new Error('High-tier trust assignment denied: manual operator authorization required');
    }

    if (
      partial.relationshipType !== undefined
      && partial.relationshipType !== target?.relationshipType
      && requiresManualRelationshipMutation(target?.relationshipType, partial.relationshipType)
      && !isManualRelationshipMutationAuthorized(options.actor)
    ) {
      throw new Error('Approval-gated relationship assignment denied: manual operator authorization required');
    }

    if (
      partial.trustLevel === 'primary'
      && target?.trustLevel !== 'primary'
      && !this.isPrimaryTrustAssignmentAuthorized(target, identities, partial.discordUserId, options)
    ) {
      await this.appendPrimaryTrustAudit(target?.id, target?.trustLevel ?? null, 'upsert', 'denied', options.actor, {
        requestedTrustLevel: partial.trustLevel,
        hasConfiguredPrimaryUserId: Boolean(this.primaryUserId?.trim()),
      });
      throw new Error('Primary trust assignment denied: identity does not match configured owner mapping');
    }

    const now = new Date().toISOString();
    if (target) {
      const trustSnapshot = await loadContactTrustSnapshot(this.pool, target.id);
      if (!trustSnapshot) {
        throw new Error(`Concurrent contact deletion detected during contact upsert: ${target.id}`);
      }
      const previousTrustLevel = trustSnapshot.trustLevel;
      const nextDisplayName = partial.displayName.trim() || target.displayName;
      const requestedNickname = normalizeNicknameValue(partial.nickname);
      const nextNickname = requestedNickname === undefined ? (target.nickname ?? undefined) : requestedNickname;
      // Generic upserts merge profile and identity data. Once a contact has
      // entered a high trust tier, only the explicit setTrustLevel path may
      // move it out again; otherwise a resolver miss followed by an upsert
      // race can replace trusted with the public new-speaker floor.
      const nextTrustLevel = isHighTierTrustLevel(previousTrustLevel)
        ? previousTrustLevel
        : (partial.trustLevel ?? previousTrustLevel);
      const relationshipMutationRequested = partial.relationshipType !== undefined;
      const nextRelationshipType = partial.relationshipType ?? target.relationshipType;
      const nextEmotion = partial.emotionalBaseline ?? target.emotionalBaseline ?? {};
      const nextDiscordUserId = partial.discordUserId ?? target.discordUserId ?? undefined;
      const nextTimezone = hasOwnTimezone(partial)
        ? normalizeTimezoneValue(partial.timezone)
        : (target.timezone ?? null);
      const commonValues = [
        nextDiscordUserId ?? null,
        nextDisplayName,
        nextNickname ?? null,
      ];
      const trailingValues = [
        nextEmotion,
        now,
        partial.notes ?? null,
        nextTimezone,
        target.id,
      ];
      if (relationshipMutationRequested) {
        await withPostgresClient(this.pool, async (client) => {
          const updated = await client.query(
            `
              UPDATE contacts
              SET discord_user_id = COALESCE(discord_user_id, $1),
                  display_name = $2,
                  nickname = $3,
                  relationship_type = $4,
                  emotional_baseline = $5,
                  last_seen = $6,
                  notes = COALESCE($7, notes),
                  timezone = $8
              WHERE id = $9 AND relationship_type = $10
              RETURNING id
            `,
            [...commonValues, nextRelationshipType, ...trailingValues, target.relationshipType],
          );
          if (updated.rowCount !== 1) {
            throw new Error('Concurrent relationship change detected during contact upsert');
          }
          if (nextRelationshipType !== target.relationshipType) {
            await client.query(
              `
                INSERT INTO contact_mutation_audit (
                  contact_id, actor, field, old_value, new_value, timestamp
                )
                VALUES ($1, $2, $3, $4, $5, $6)
              `,
              [
                target.id,
                normalizeAuditActor(options.actor),
                'relationship_type',
                target.relationshipType,
                nextRelationshipType,
                new Date().toISOString(),
              ],
            );
          }
        });
      } else {
        await this.pool.query(
          `
            UPDATE contacts
            SET discord_user_id = COALESCE(discord_user_id, $1),
                display_name = $2,
                nickname = $3,
                emotional_baseline = $4,
                last_seen = $5,
                notes = COALESCE($6, notes),
                timezone = $7
            WHERE id = $8
          `,
          [...commonValues, ...trailingValues],
        );
      }

      await withPostgresClient(this.pool, async (client) => {
        const changed = await compareAndSetGenericUpsertTrust(
          client,
          target.id,
          trustSnapshot,
          nextTrustLevel,
        );
        if (!changed) return;
        if (nextTrustLevel === 'primary') {
          await this.appendPrimaryTrustAudit(
            target.id,
            previousTrustLevel,
            'upsert',
            'allowed',
            options.actor,
            undefined,
            client,
          );
        } else {
          await this.appendMutationAuditEntry(
            target.id,
            'trust_level',
            previousTrustLevel,
            nextTrustLevel,
            options.actor,
            client,
          );
        }
      });

      for (const identity of identities) {
        await this.upsertIdentityLinkRecord(
          target.id,
          identity.channel,
          identity.userId,
          target.firstSeen,
          now,
          identity.privacyLevel,
        );
      }

      if (target.displayName !== nextDisplayName) {
        await this.appendMutationAuditEntry(target.id, 'display_name', target.displayName, nextDisplayName, options.actor);
      }
      if ((target.nickname ?? null) !== (nextNickname ?? null)) {
        await this.appendMutationAuditEntry(target.id, 'nickname', target.nickname ?? null, nextNickname ?? null, options.actor);
      }
      if ((target.notes ?? null) !== (partial.notes ?? target.notes ?? null) && partial.notes !== undefined) {
        await this.appendMutationAuditEntry(target.id, 'notes', target.notes ?? null, partial.notes ?? null, options.actor);
      }
      if (hasOwnTimezone(partial) && (target.timezone ?? null) !== nextTimezone) {
        await this.appendMutationAuditEntry(target.id, 'timezone', target.timezone ?? null, nextTimezone, options.actor);
      }

      const hydrated = await this.loadContactById(target.id);
      if (!hydrated) {
        throw new Error(`Failed to reload updated contact ${target.id}`);
      }
      await this.upsertSocialGraphEntityForContact({
        id: hydrated.id,
        displayName: hydrated.displayName,
        firstSeen: hydrated.firstSeen,
        lastSeen: hydrated.lastSeen,
      });
      await this.syncContactExports();
      return hydrated;
    }

    const legacyDiscordUserId = partial.discordUserId?.trim() || undefined;
    const shouldForcePrimary = identities.some(identity => isPrimaryIdentity(identity, this.primaryUserId))
      || (legacyDiscordUserId ? isPrimaryIdentity({ channel: 'discord', userId: legacyDiscordUserId }, this.primaryUserId) : false);
    const contact: Contact = {
      id: partial.id?.trim() || uuidv7(),
      ...(legacyDiscordUserId ? { discordUserId: legacyDiscordUserId } : {}),
      displayName: partial.displayName.trim(),
      ...(normalizeNicknameValue(partial.nickname) !== undefined ? { nickname: normalizeNicknameValue(partial.nickname) ?? undefined } : {}),
      trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
      relationshipType: partial.relationshipType ?? 'stranger',
      emotionalBaseline: partial.emotionalBaseline ?? {},
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      ...(partial.notes ? { notes: partial.notes } : {}),
      ...(normalizeTimezoneValue(partial.timezone) ? { timezone: normalizeTimezoneValue(partial.timezone) ?? undefined } : {}),
    };

    await this.pool.query(
      `
        INSERT INTO contacts (
          id,
          discord_user_id,
          display_name,
          nickname,
          trust_level,
          relationship_type,
          emotional_baseline,
          first_seen,
          last_seen,
          notes,
          timezone
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        contact.id,
        contact.discordUserId ?? null,
        contact.displayName,
        contact.nickname ?? null,
        contact.trustLevel,
        contact.relationshipType,
        contact.emotionalBaseline ?? {},
        contact.firstSeen,
        contact.lastSeen,
        contact.notes ?? null,
        contact.timezone ?? null,
      ],
    );

    for (const identity of identities) {
      await this.upsertIdentityLinkRecord(
        contact.id,
        identity.channel,
        identity.userId,
        contact.firstSeen,
        contact.lastSeen,
        identity.privacyLevel,
      );
    }

    if (contact.trustLevel === 'primary') {
      await this.appendPrimaryTrustAudit(contact.id, null, 'upsert', 'allowed', options.actor);
    }
    await this.upsertSocialGraphEntityForContact(contact);
    await this.syncContactExports();
    return contact;
  },

  async getById(id: string): Promise<Contact | undefined> {
    const row = await this.loadContactRow(id);
    if (!row) return undefined;
    return await this.loadContactByRow(row);
  },

  async getByDiscordUserId(discordUserId: string): Promise<Contact | undefined> {
    const trimmed = discordUserId.trim();
    if (!trimmed) return undefined;
    const row = await queryOne<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
               emotional_baseline, first_seen, last_seen, notes, timezone
        FROM contacts
        WHERE discord_user_id = $1
        LIMIT 1
      `,
      [trimmed],
    );
    if (row) return await this.loadContactByRow(row);
    return await this.loadContactByChannelIdentity('discord', trimmed);
  },

  async getByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined> {
    return await this.loadContactByChannelIdentity(channel, channelUserId);
  },

  async getByTrustLevel(trustLevel: TrustLevel): Promise<Contact[]> {
    const rows = await queryRows<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
               emotional_baseline, first_seen, last_seen, notes, timezone
        FROM contacts
        WHERE trust_level = $1
        ORDER BY last_seen DESC
      `,
      [trustLevel],
    );
    const contacts: Contact[] = [];
    for (const row of rows) {
      const contact = await this.loadContactByRow(row);
      contacts.push(contact);
    }
    return contacts;
  },

  async updateLastSeen(id: string): Promise<void> {
    await this.touchContactLastSeen(id);
  },

  async setMachineIntelligence(id: string, isMachineIntelligence: boolean, actor?: string): Promise<boolean> {
    const contact = await this.loadContactById(id);
    if (!contact) return false;
    const current = contact.isMachineIntelligence === true;
    if (current === isMachineIntelligence) return true;
    await this.pool.query(
      'UPDATE contacts SET is_machine_intelligence = $1 WHERE id = $2',
      [isMachineIntelligence, id],
    );
    await this.appendMutationAuditEntry(
      id,
      'is_machine_intelligence',
      String(current),
      String(isMachineIntelligence),
      actor,
    );
    await this.syncContactExports();
    return true;
  },

  async markMachineIntelligenceFromObservation(
    id: string,
    actor: string,
  ): Promise<MachineIntelligenceObservationMarkResult> {
    // Row-lock + audit check + write in one transaction: a concurrent deliberate
    // correction either commits first (and the audit check preserves it) or
    // blocks on the row lock and lands after this observation (correction wins).
    const result = await withPostgresClient(this.pool, async (client): Promise<MachineIntelligenceObservationMarkResult> => {
      const contact = await client.query<{ is_machine_intelligence: boolean | null }>(
        'SELECT is_machine_intelligence FROM contacts WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (contact.rows.length === 0) return 'not_found';
      const latest = await client.query<{ actor: string }>(
        `
          SELECT actor
          FROM contact_mutation_audit
          WHERE contact_id = $1 AND field = 'is_machine_intelligence'
          ORDER BY timestamp DESC, id DESC
          LIMIT 1
        `,
        [id],
      );
      if (isDeliberateMachineIntelligenceCorrection(latest.rows[0]?.actor)) {
        return 'override_preserved';
      }
      if (contact.rows[0]?.is_machine_intelligence === true) return 'already_marked';
      await client.query('UPDATE contacts SET is_machine_intelligence = TRUE WHERE id = $1', [id]);
      await client.query(
        `
          INSERT INTO contact_mutation_audit (
            contact_id,
            actor,
            field,
            old_value,
            new_value,
            timestamp
          )
          VALUES ($1, $2, 'is_machine_intelligence', 'false', 'true', $3)
        `,
        [id, normalizeAuditActor(actor), new Date().toISOString()],
      );
      return 'marked';
    });
    if (result === 'marked') {
      await this.syncContactExports();
    }
    return result;
  },

  async updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const nextDisplayName = displayName.trim() || contact.displayName;
    const requestedNickname = normalizeNicknameValue(nickname);
    const nextNickname = requestedNickname === undefined ? (contact.nickname ?? null) : requestedNickname;
    if (contact.displayName === nextDisplayName && (contact.nickname ?? null) === nextNickname) {
      return true;
    }
    await this.pool.query(
      `
        UPDATE contacts
        SET display_name = $1,
            nickname = $2
        WHERE id = $3
      `,
      [nextDisplayName, nextNickname, contactId],
    );
    if (contact.displayName !== nextDisplayName) {
      await this.appendMutationAuditEntry(contactId, 'display_name', contact.displayName, nextDisplayName, actor);
    }
    if ((contact.nickname ?? null) !== nextNickname) {
      await this.appendMutationAuditEntry(contactId, 'nickname', contact.nickname ?? null, nextNickname, actor);
    }
    await this.upsertSocialGraphEntityForContact({
      id: contactId,
      displayName: nextDisplayName,
      firstSeen: contact.firstSeen,
      lastSeen: contact.lastSeen,
    });
    await this.syncContactExports();
    return true;
  },

  async recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<void> {
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return;
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const now = new Date().toISOString();
    const normalizedPrivacy = privacyLevel !== undefined
      ? normalizePrivacyLevel(privacyLevel, normalizedChannel)
      : undefined;
    await this.pool.query(
      `
        INSERT INTO contact_channel_activity (
          contact_id,
          channel,
          channel_id,
          privacy_level,
          first_seen,
          last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(contact_id, channel, channel_id)
        DO UPDATE SET
          privacy_level = EXCLUDED.privacy_level,
          last_seen = EXCLUDED.last_seen
      `,
      [contactId, normalizedChannel, trimmedChannelId, normalizedPrivacy ?? null, now, now],
    );
    await this.syncContactExports();
  },

  async mergeContactsDirect(
    sourceContactId: string,
    targetContactId: string,
    lifecycleIntentId?: string,
    recoveryLeaseOwner?: string,
  ): Promise<boolean> {
    if (sourceContactId === targetContactId) return true;
    const merged = await withPostgresClient(this.pool, async (client) => {
      if (lifecycleIntentId) {
        await beginContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          'contact.merge',
          recoveryLeaseOwner,
        );
      }
      // SAFETY: Lock both contacts in deterministic ID order and derive the
      // merged trust from those locked rows. This prevents a stale merge from
      // overwriting an explicit trust mutation and avoids AB-BA deadlocks.
      const lockedRows = new Map<string, ContactRow>();
      for (const contactId of [sourceContactId, targetContactId].sort()) {
        const result = await client.query<ContactRow>(
          `
            SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
                   emotional_baseline, emotional_time_series, first_seen, last_seen, notes, timezone
            FROM contacts
            WHERE id = $1
            FOR UPDATE
          `,
          [contactId],
        );
        if (result.rowCount !== 1) return false;
        lockedRows.set(contactId, result.rows[0]);
      }
      const sourceRow = lockedRows.get(sourceContactId);
      const targetRow = lockedRows.get(targetContactId);
      if (!sourceRow || !targetRow) return false;

      await client.query('UPDATE contact_channel_ids SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      await client.query('UPDATE contact_channel_activity SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);

      const l2Memories = await client.query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        ['l2_memories'],
      );
      if (l2Memories.rows.at(0)?.exists === true) {
        await client.query('UPDATE l2_memories SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      }
      await invalidateMemorySubjectsForContact(client, sourceContactId);
      const contactProfiles = await client.query<{ exists: boolean }>(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        ['contact_profiles'],
      );
      if (contactProfiles.rows.at(0)?.exists === true) {
        const targetProfileExists = await client.query<{ exists_flag: number }>(
          'SELECT 1 AS exists_flag FROM contact_profiles WHERE contact_id = $1 LIMIT 1',
          [targetContactId],
        );
        if ((targetProfileExists.rowCount ?? 0) > 0) {
          await client.query('DELETE FROM contact_profiles WHERE contact_id = $1', [sourceContactId]);
        } else {
          await client.query('UPDATE contact_profiles SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
        }
      }

      const mergedTrustLevel = pickMostTrustedLevel(sourceRow.trust_level, targetRow.trust_level);
      const mergedRelationshipType = mergedTrustLevel === 'primary'
        ? 'partner'
        : targetRow.relationship_type;
      const mergedDisplayName = pickPreferredDisplayName(
        targetRow.display_name,
        sourceRow.display_name,
        targetRow.discord_user_id,
        sourceRow.discord_user_id,
      );
      const mergedNickname = targetRow.nickname ?? sourceRow.nickname;
      const mergedDiscordUserId = targetRow.discord_user_id ?? sourceRow.discord_user_id;
      const mergedBaseline = Object.keys(normalizeJsonObject(targetRow.emotional_baseline)).length > 0
        ? targetRow.emotional_baseline
        : sourceRow.emotional_baseline;
      const mergedEmotionalTimeSeries = mergeEmotionalTimeSeries(
        sourceRow.emotional_time_series,
        targetRow.emotional_time_series,
      );
      const mergedFirstSeen = earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
      const mergedLastSeen = latestTimestamp(sourceRow.last_seen, targetRow.last_seen);
      const mergedNotes = targetRow.notes ?? sourceRow.notes;
      const mergedTimezone = targetRow.timezone ?? sourceRow.timezone;

      const loadLockedEntity = async (contactId: string): Promise<SocialGraphEntityRow | undefined> => {
        const result = await client.query<SocialGraphEntityRow>(`
          SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
                 confidence, source, created_at, updated_at
          FROM social_graph_entities
          WHERE contact_id = $1
          LIMIT 1
          FOR UPDATE
        `, [contactId]);
        return result.rows.at(0);
      };
      const sourceEntityRow = await loadLockedEntity(sourceContactId);
      const targetEntityRow = await loadLockedEntity(targetContactId);
      const sourceEntity = sourceEntityRow ? socialGraphEntityRowToEntity(sourceEntityRow) : undefined;
      const targetEntity = targetEntityRow ? socialGraphEntityRowToEntity(targetEntityRow) : undefined;
      if (sourceEntity && targetEntity) {
        const mergedSensitivity = chooseMoreRestrictiveSensitivity(
          targetEntity.sensitivity,
          sourceEntity.sensitivity,
        );
        const mergedProvenanceRefs = [...new Set([...targetEntity.provenanceRefs, ...sourceEntity.provenanceRefs])];
        const mergedConfidence = Math.max(targetEntity.confidence, sourceEntity.confidence);
        await client.query(
          `
            UPDATE social_graph_entities
            SET sensitivity = $1,
                provenance_refs = $2,
                confidence = $3,
                updated_at = $4
            WHERE id = $5
          `,
          [mergedSensitivity, mergedProvenanceRefs, mergedConfidence, mergedLastSeen, targetEntity.id],
        );

        const sourceEdges = await client.query<SocialRelationshipEdgeRow>(
          `
            SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                   sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
            FROM social_relationship_edges
            WHERE source_entity_id = $1 OR target_entity_id = $1
            ORDER BY created_at ASC, id ASC
          `,
          [sourceEntity.id],
        );
        for (const row of sourceEdges.rows) {
          const edge = socialGraphEdgeRowToEdge(row);
          const rewrittenSource = edge.sourceEntityId === sourceEntity.id ? targetEntity.id : edge.sourceEntityId;
          const rewrittenTarget = edge.targetEntityId === sourceEntity.id ? targetEntity.id : edge.targetEntityId;
          if (rewrittenSource === rewrittenTarget) {
            await client.query('DELETE FROM social_relationship_edges WHERE id = $1', [edge.id]);
            continue;
          }
          const duplicateResult = await client.query<SocialRelationshipEdgeRow>(
            `
              SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                     sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
              FROM social_relationship_edges
              WHERE source_entity_id = $1
                AND target_entity_id = $2
                AND relationship_type = $3
                AND directional = $4
                AND id != $5
              LIMIT 1
            `,
            [rewrittenSource, rewrittenTarget, edge.relationshipType, edge.directional, edge.id],
          );
          const duplicate = duplicateResult.rows.at(0);
          if (duplicate) {
            const duplicateEdge = socialGraphEdgeRowToEdge(duplicate);
            await client.query(
              `
                UPDATE social_relationship_edges
                SET sensitivity = $1,
                    provenance_refs = $2,
                    evidence_memory_ids = $3,
                    confidence = $4,
                    updated_at = $5
                WHERE id = $6
              `,
              [
                duplicateEdge.sensitivity >= edge.sensitivity ? duplicateEdge.sensitivity : edge.sensitivity,
                [...new Set([...duplicateEdge.provenanceRefs, ...edge.provenanceRefs])],
                [...new Set([...duplicateEdge.evidenceMemoryIds, ...edge.evidenceMemoryIds])],
                Math.max(duplicateEdge.confidence, edge.confidence),
                duplicateEdge.updatedAt >= edge.updatedAt ? duplicateEdge.updatedAt : edge.updatedAt,
                duplicateEdge.id,
              ],
            );
            await client.query('DELETE FROM social_relationship_edges WHERE id = $1', [edge.id]);
            continue;
          }
          await client.query(
            `
              UPDATE social_relationship_edges
              SET source_entity_id = $1,
                  target_entity_id = $2,
                  updated_at = $3
              WHERE id = $4
            `,
            [rewrittenSource, rewrittenTarget, mergedLastSeen, edge.id],
          );
        }
        await client.query('DELETE FROM social_graph_entities WHERE id = $1', [sourceEntity.id]);
      }

      await client.query('DELETE FROM contacts WHERE id = $1', [sourceContactId]);
      await client.query(
        `
          UPDATE contacts
          SET discord_user_id = $1,
              display_name = $2,
              nickname = $3,
              trust_level = $4,
              trust_version = CASE
                WHEN trust_level IS DISTINCT FROM $4 THEN trust_version + 1
                ELSE trust_version
              END,
              relationship_type = $5,
              emotional_baseline = $6,
              emotional_time_series = $7,
              first_seen = $8,
              last_seen = $9,
              notes = $10,
              timezone = $11
          WHERE id = $12
        `,
        [
          mergedDiscordUserId,
          mergedDisplayName,
          mergedNickname ?? null,
          mergedTrustLevel,
          mergedRelationshipType,
          mergedBaseline,
          JSON.stringify(mergedEmotionalTimeSeries),
          mergedFirstSeen,
          mergedLastSeen,
          mergedNotes ?? null,
          mergedTimezone ?? null,
          targetContactId,
        ],
      );

      if (lifecycleIntentId) {
        const version = await client.query<{ contact_authority_version: string }>(`
          SELECT contact_authority_version FROM contacts WHERE id = $1
        `, [targetContactId]);
        const contactVersion = Number(version.rows.at(0)?.contact_authority_version);
        await completeContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          contactVersion,
          recoveryLeaseOwner,
        );
      }
      return true;
    });
    if (merged) await this.syncContactExports();
    return merged;
  },

  async updateNotes(id: string, notes: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    const previousNotes = contact.notes ?? null;
    if (previousNotes === notes) return true;
    await this.pool.query('UPDATE contacts SET notes = $1 WHERE id = $2', [notes, id]);
    await this.appendMutationAuditEntry(id, 'notes', previousNotes, notes, actor);
    await this.syncContactExports();
    return true;
  },

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
    const updatedTimeSeries = appendEmotionalObservationToTimeSeries(
      await this.loadContactEmotionalTimeSeries(id, MAX_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT),
      observation,
      MAX_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
    );
    await this.pool.query(
      `
        UPDATE contacts
        SET emotional_baseline = $1,
            emotional_time_series = $2,
            last_seen = $3
        WHERE id = $4
      `,
      // node-pg encodes JS arrays as Postgres array literals, which are not
      // valid JSON for a jsonb column — serialize explicitly.
      [updatedBaseline, JSON.stringify(updatedTimeSeries), new Date().toISOString(), id],
    );
    await this.syncContactExports();
    return await this.getById(id);
  },

  async getEmotionalSnapshot(id: string): Promise<EmotionalSnapshot | undefined> {
    const contact = await this.getById(id);
    if (!contact) return undefined;
    const snapshot = parseMoodSnapshot(contact.emotionalBaseline);
    return hasLearnedMoodSnapshot(snapshot) ? snapshot : undefined;
  },

  async getEmotionalTimeSeries(id: string, limit?: number): Promise<EmotionalTimeSeriesPoint[]> {
    return await this.loadContactEmotionalTimeSeries(id, limit);
  },

  async updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.relationshipType === relationshipType) return true;
    return await this.compareAndSetRelationshipType(
      id,
      contact.relationshipType,
      relationshipType,
      actor,
    );
  },

  async compareAndSetRelationshipType(
    id: string,
    expectedRelationshipType: RelationshipType,
    relationshipType: RelationshipType,
    actor?: string,
  ): Promise<boolean> {
    if (
      requiresManualRelationshipMutation(expectedRelationshipType, relationshipType)
      && !isManualRelationshipMutationAuthorized(actor)
    ) {
      return false;
    }
    if (expectedRelationshipType === relationshipType) {
      return (await this.getById(id))?.relationshipType === expectedRelationshipType;
    }

    const applied = await withPostgresClient(this.pool, async (client) => {
      const updated = await client.query(
        `
          UPDATE contacts
          SET relationship_type = $1
          WHERE id = $2 AND relationship_type = $3
          RETURNING id
        `,
        [relationshipType, id, expectedRelationshipType],
      );
      if (updated.rowCount !== 1) return false;
      await client.query(
        `
          INSERT INTO contact_mutation_audit (
            contact_id, actor, field, old_value, new_value, timestamp
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          id,
          normalizeAuditActor(actor),
          'relationship_type',
          expectedRelationshipType,
          relationshipType,
          new Date().toISOString(),
        ],
      );
      return true;
    });
    if (applied) await this.syncContactExports();
    return applied;
  },

  async setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    if (existingLink.privacyLevel === privacyLevel) return true;
    await this.pool.query(
      `
        UPDATE contact_channel_ids
        SET privacy_level = $1,
            last_seen = $2
        WHERE contact_id = $3 AND channel = $4 AND channel_user_id = $5
      `,
      [privacyLevel, new Date().toISOString(), contactId, normalizedIdentity.channel, normalizedIdentity.userId],
    );
    await this.appendMutationAuditEntry(
      contactId,
      'channel_privacy',
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        privacyLevel: existingLink.privacyLevel,
      }),
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        privacyLevel,
      }),
      actor,
    );
    await this.syncContactExports();
    return true;
  },

  async setChannelBonding(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    bonded: boolean,
    actor?: string,
  ): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    if ((existingLink.bonded === true) === bonded) return true;
    await this.pool.query(
      `
        UPDATE contact_channel_ids
        SET bonded = $1,
            last_seen = $2
        WHERE contact_id = $3 AND channel = $4 AND channel_user_id = $5
      `,
      [bonded, new Date().toISOString(), contactId, normalizedIdentity.channel, normalizedIdentity.userId],
    );
    await this.appendMutationAuditEntry(
      contactId,
      'channel_bond',
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        bonded: existingLink.bonded === true,
      }),
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        bonded,
      }),
      actor,
    );
    await this.syncContactExports();
    return true;
  },

  async setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
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
    await this.pool.query(
      `
        INSERT INTO contact_channel_activity (
          contact_id,
          channel,
          channel_id,
          privacy_level,
          first_seen,
          last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(contact_id, channel, channel_id)
        DO UPDATE SET
          privacy_level = EXCLUDED.privacy_level,
          last_seen = EXCLUDED.last_seen
      `,
      [contactId, normalizedChannel, trimmedChannelId, normalizedPrivacyLevel, new Date().toISOString(), new Date().toISOString()],
    );
    await this.appendMutationAuditEntry(
      contactId,
      'channel_privacy',
      previousPrivacyLevel
        ? JSON.stringify({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          privacyLevel: previousPrivacyLevel,
        })
        : null,
      JSON.stringify({
        channel: normalizedChannel,
        channelId: trimmedChannelId,
        privacyLevel: normalizedPrivacyLevel,
      }),
      actor,
    );
    await this.syncContactExports();
    return true;
  },

  async getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): Promise<ChannelPrivacyLevel | undefined> {
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return undefined;
    const row = await queryOne<{ privacy_level: string | null }>(
      this.pool,
      `
        SELECT privacy_level
        FROM contact_channel_activity
        WHERE contact_id = $1 AND channel = $2 AND channel_id = $3
        LIMIT 1
      `,
      [contactId, normalizedChannel, trimmedChannelId],
    );
    if (!row?.privacy_level) return undefined;
    return normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, normalizedChannel);
  },

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
    const result = await this.pool.query(
      `
        DELETE FROM contact_channel_activity
        WHERE contact_id = $1 AND channel = $2 AND channel_id = $3
      `,
      [contactId, normalizedChannel, trimmedChannelId],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.appendMutationAuditEntry(
        contactId,
        'conversation_channel',
        JSON.stringify({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          ...(existingChannel.privacyLevel ? { privacyLevel: existingChannel.privacyLevel } : {}),
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  },

  async createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): Promise<ContactIdentityLinkChallengeResult> {
    const contact = await this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);
    const sourceOwner = await this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== contact.id) {
      return { status: 'source_identity_not_linked' };
    }

    const targetOwner = await this.getByChannelIdentity(targetIdentity.channel, targetIdentity.userId);
    if (targetOwner && targetOwner.id !== contact.id) {
      return { status: 'identity_conflict' };
    }
    if (targetOwner && targetOwner.id === contact.id) {
      return { status: 'already_linked' };
    }

    const existingPending = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE contact_id = $1
          AND source_channel = $2
          AND source_user_id = $3
          AND target_channel = $4
          AND target_user_id = $5
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [contact.id, sourceIdentity.channel, sourceIdentity.userId, targetIdentity.channel, targetIdentity.userId],
    );
    if (existingPending) {
      const expiresAtMs = Date.parse(existingPending.expires_at);
      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        return {
          status: 'pending_exists',
          verification: this.toVerification(existingPending),
        };
      }
      await this.markIdentityLinkVerification(existingPending.id, 'expired', 'expired');
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + Math.min(Math.max(Math.floor(input.ttlMs ?? 5 * 60_000), 1), 60 * 60_000)).toISOString();
    const verification: ContactIdentityLinkVerification = {
      // Contact lifecycle intent IDs are protocol-visible RFC-4122 UUIDs. Keep
      // verification proof IDs in that same domain so the proof itself is the
      // durable, replay-stable lifecycle intent key.
      id: randomUUID(),
      contactId: contact.id,
      sourceChannel: sourceIdentity.channel,
      sourceUserId: sourceIdentity.userId,
      targetChannel: targetIdentity.channel,
      targetUserId: targetIdentity.userId,
      nonce: randomUUID().replace(/-/g, ''),
      expiresAt,
      signature: randomUUID().replace(/-/g, ''),
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    };
    await this.pool.query(
      `
        INSERT INTO contact_identity_link_verifications (
          id,
          contact_id,
          source_channel,
          source_user_id,
          target_channel,
          target_user_id,
          nonce,
          expires_at,
          signature,
          status,
          created_at,
          updated_at,
          verified_at,
          failure_reason
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL)
      `,
      [
        verification.id,
        verification.contactId,
        verification.sourceChannel,
        verification.sourceUserId,
        verification.targetChannel,
        verification.targetUserId,
        verification.nonce,
        verification.expiresAt,
        verification.signature,
        verification.status,
        verification.createdAt,
        verification.updatedAt,
      ],
    );
    return { status: 'challenge_created', verification };
  },

  toVerification(row: ContactIdentityVerificationRow): ContactIdentityLinkVerification {
    return {
      id: row.id,
      contactId: row.contact_id,
      sourceChannel: row.source_channel,
      sourceUserId: row.source_user_id,
      targetChannel: row.target_channel,
      targetUserId: row.target_user_id,
      nonce: row.nonce,
      expiresAt: row.expires_at,
      signature: row.signature,
      status: row.status as ContactIdentityLinkVerification['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    };
  },

  async markIdentityLinkVerification(
    verificationId: string,
    status: ContactIdentityLinkVerification['status'],
    failureReason?: string,
    verifiedAt?: string,
  ): Promise<ContactIdentityLinkVerification | undefined> {
    const row = await markVerifiedContactOwnership(
      this.pool,
      verificationId,
      status,
      failureReason,
      verifiedAt,
    );
    return row ? this.toVerification(row) : undefined;
  },

  async verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): Promise<ContactIdentityLinkVerificationResult> {
    const contact = await this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);
    const row = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE contact_id = $1
          AND source_channel = $2
          AND source_user_id = $3
          AND target_channel = $4
          AND target_user_id = $5
          AND nonce = $6
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.contactId, sourceIdentity.channel, sourceIdentity.userId, targetIdentity.channel, targetIdentity.userId, input.nonce.trim()],
    );
    if (!row) {
      return { status: 'verification_not_found' };
    }

    const verification = this.toVerification(row);
    if (verification.status !== 'pending') {
      if (verification.status === 'verified'
        && row.target_channel === 'discord'
        && this.contactLifecycleGateway) {
        const outcome = await this.resumeContactLifecycleIntent({
          schemaVersion: 1,
          intentId: row.id,
          phase: 'prepare',
          action: 'contact.verify',
          contactId: row.contact_id,
          providerSubjectId: row.target_user_id,
        });
        if (outcome.status !== 'completed') {
          throw new Error(`Contact verification lifecycle remains ${outcome.status}: ${outcome.reason}`);
        }
      }
      return { status: 'verification_replayed', verification };
    }
    if (row.expires_at !== input.expiresAt.trim()) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'claim_mismatch');
      return { status: 'claim_mismatch', verification: failed ?? verification };
    }
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
      const expired = await this.markIdentityLinkVerification(row.id, 'expired', 'expired');
      return { status: 'verification_expired', verification: expired ?? verification };
    }
    if (!timingSafeStringEqual(row.signature, input.signature.trim())) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'invalid_signature');
      return { status: 'invalid_signature', verification: failed ?? verification };
    }

    const sourceOwner = await this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== input.contactId) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'source_identity_not_linked');
      return { status: 'source_identity_not_linked', verification: failed ?? verification };
    }

    if (targetIdentity.channel === 'discord' && this.contactLifecycleGateway) {
      return await this.verifyDiscordIdentityLifecycle(row, input.privacyLevel);
    }

    const linkResult = await this.linkChannelIdentity(
      input.contactId,
      targetIdentity.channel,
      targetIdentity.userId,
      { privacyLevel: input.privacyLevel },
    );
    if (linkResult === 'identity_conflict') {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'identity_conflict');
      return { status: 'identity_conflict', verification: failed ?? verification };
    }
    if (linkResult === 'contact_not_found') {
      return { status: 'contact_not_found' };
    }

    const linked = await this.markIdentityLinkVerification(row.id, 'verified', undefined, new Date().toISOString());
    const finalVerification = linked ?? verification;
    return {
      status: linkResult === 'linked' ? 'linked' : 'already_linked',
      verification: finalVerification,
    };
  },

  async linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    _actor?: string,
  ): Promise<ContactIdentityLinkResult> {
    const contact = await this.getById(contactId);
    if (!contact) return 'contact_not_found';

    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const result = await this.upsertIdentityLinkRecord(
      contactId,
      normalizedIdentity.channel,
      normalizedIdentity.userId,
      contact.firstSeen,
      new Date().toISOString(),
      options?.privacyLevel,
    );
    if (result === 'identity_conflict') {
      if (normalizedIdentity.channel === 'discord' && this.contactLifecycleGateway) {
        const owner = await this.pool.query<{
          contact_id: string;
          identity_version: string;
          ownership_state: string;
          restore_state: string;
        }>(`
          SELECT contact_id, identity_version, ownership_state, restore_state
          FROM contact_channel_ids
          WHERE channel = 'discord' AND channel_user_id = $1
        `, [normalizedIdentity.userId]);
        const current = owner.rows.at(0);
        if (current
          && current.contact_id !== contactId
          && current.ownership_state === 'verified'
          && current.restore_state === 'live') {
          await this.suspendVerifiedDiscordIdentityConflict(
            current.contact_id,
            normalizedIdentity.userId,
            `link:${contactId}:identity-version:${current.identity_version}`,
          );
        }
      }
      return result;
    }

    if (normalizedIdentity.channel === 'discord') {
      await this.pool.query(
        `
          UPDATE contacts
          SET discord_user_id = COALESCE(discord_user_id, $1)
          WHERE id = $2
        `,
        [normalizedIdentity.userId, contactId],
      );
    }

    if (isPrimaryIdentity(normalizedIdentity, this.primaryUserId)) {
      await this.pool.query(
        `
          UPDATE contacts
          SET trust_level = 'primary',
              trust_version = trust_version + 1
          WHERE id = $1 AND trust_level <> 'primary'
        `,
        [contactId],
      );
      const duplicatePrimaryRows = await queryRows<{ id: string }>(
        this.pool,
        `
          SELECT id
          FROM contacts
          WHERE id <> $1 AND trust_level = 'primary'
          ORDER BY first_seen ASC
        `,
        [contactId],
      );
      for (const duplicate of duplicatePrimaryRows) {
        await this.mergeContacts(duplicate.id, contactId);
      }
    }

    await this.upsertSocialGraphEntityForContact({
      id: contact.id,
      displayName: contact.displayName,
      firstSeen: contact.firstSeen,
      lastSeen: contact.lastSeen,
    });
    await this.syncContactExports();
    return result;
  },

  async listAll(): Promise<Contact[]> {
    const rows = await queryRows<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
               emotional_baseline, first_seen, last_seen, notes, timezone
        FROM contacts
        ORDER BY last_seen DESC
      `,
    );
    const contacts: Contact[] = [];
    for (const row of rows) {
      contacts.push(await this.loadContactByRow(row));
    }
    return contacts;
  },

  async listIdentityLinkVerifications(limit = 25): Promise<ContactIdentityLinkVerification[]> {
    const normalizedLimit = normalizeLimit(limit, 25, 1, 200);
    const rows = await queryRows<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [normalizedLimit],
    );
    return rows.map(row => this.toVerification(row));
  },

  async countVerifiedIdentityLinks(contactId: string): Promise<number> {
    const rows = await queryRows<{ count: string | number }>(
      this.pool,
      `
        SELECT COUNT(*) AS count
        FROM contact_identity_link_verifications
        WHERE contact_id = $1 AND status = 'verified'
      `,
      [contactId],
    );
    const raw = rows[0]?.count ?? 0;
    const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Verified identity link count for contact ${contactId} is not numeric`);
    }
    return parsed;
  },

  async getContactMaintenanceWatermark(processor: string): Promise<string | undefined> {
    const rows = await queryRows<{ last_run_at: string }>(
      this.pool,
      'SELECT last_run_at FROM contact_maintenance_watermarks WHERE processor = $1',
      [processor],
    );
    return rows[0]?.last_run_at;
  },

  async setContactMaintenanceWatermark(processor: string, lastRunAt: string): Promise<void> {
    const trimmedProcessor = processor.trim();
    if (!trimmedProcessor) {
      throw new Error('Contact maintenance watermark processor must be a non-empty string');
    }
    if (!Number.isFinite(Date.parse(lastRunAt))) {
      throw new Error(`Contact maintenance watermark lastRunAt "${lastRunAt}" is not a valid timestamp`);
    }
    await this.pool.query(
      `
        INSERT INTO contact_maintenance_watermarks (processor, last_run_at)
        VALUES ($1, $2)
        ON CONFLICT (processor) DO UPDATE SET last_run_at = EXCLUDED.last_run_at
      `,
      [trimmedProcessor, lastRunAt],
    );
  },

  async listMutationAuditEntries(query: ContactMutationAuditQuery = {}): Promise<ContactMutationAuditEntry[]> {
    const normalizedLimit = normalizeLimit(query.limit, 25, 1, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.contactId) {
      clauses.push(`contact_id = $${params.length + 1}`);
      params.push(query.contactId.trim());
    }
    if (query.actor) {
      clauses.push(`actor = $${params.length + 1}`);
      params.push(query.actor.trim());
    }
    if (query.field) {
      clauses.push(`field = $${params.length + 1}`);
      params.push(query.field);
    }
    const rows = await queryRows<ContactMutationAuditRow>(
      this.pool,
      `
        SELECT id, contact_id, actor, field, old_value, new_value, timestamp
        FROM contact_mutation_audit
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY timestamp DESC, id DESC
        LIMIT $${params.length + 1}
      `,
      [...params, normalizedLimit],
    );
    return rows.flatMap((row) => {
      const mapped = contactMutationAuditRowToEntry(row);
      return mapped ? [mapped] : [];
    });
  },

  async resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Promise<Contact> {
    const identity = normalizeIdentity(channel, channelUserId);
    const existing = await this.getByChannelIdentity(identity.channel, identity.userId);
    if (existing) {
      await this.touchContactLastSeen(existing.id);
      if (displayName?.trim() && looksLikeOpaqueIdentifier(existing.displayName)) {
        await this.pool.query('UPDATE contacts SET display_name = $1 WHERE id = $2', [displayName.trim(), existing.id]);
      }
      await this.upsertIdentityLinkRecord(existing.id, identity.channel, identity.userId, existing.firstSeen, new Date().toISOString(), defaultPrivacyForChannel(identity.channel));
      const updated = await this.getById(existing.id);
      if (!updated) throw new Error(`Failed to reload resolved contact ${existing.id}`);
      await this.upsertSocialGraphEntityForContact({
        id: updated.id,
        displayName: updated.displayName,
        firstSeen: updated.firstSeen,
        lastSeen: updated.lastSeen,
      });
      await this.syncContactExports();
      return updated;
    }

    return await this.upsert({
      displayName: displayName?.trim() || identity.userId,
      trustLevel: 'public',
      // bead hr1q: a first message on the gateway-validated 'companion' lane
      // comes from a same-cluster fleet peer — the gateway already checked the
      // peer against fleetCompanionIds before delivery. Recognize such peers
      // above 'stranger' at mint. This bumps relationshipType only; the trust
      // floor stays 'public' per the fail-closed charter (cross-cluster peers
      // arrive on other channels and are unaffected).
      ...(identity.channel === 'companion' ? { relationshipType: 'acquaintance' as const } : {}),
      channels: [{
        channel: identity.channel,
        userId: identity.userId,
        privacyLevel: defaultPrivacyForChannel(identity.channel),
        firstSeen: '',
        lastSeen: '',
      }],
      ...(identity.channel === 'discord' ? { discordUserId: identity.userId } : {}),
    });
  },

  async resolveUserId(discordUserId: string): Promise<Contact> {
    const contact = await this.getByDiscordUserId(discordUserId);
    if (contact) {
      await this.touchContactLastSeen(contact.id);
      const updated = await this.getById(contact.id);
      if (!updated) throw new Error(`Failed to reload resolved contact ${contact.id}`);
      return updated;
    }
    return await this.upsert({
      displayName: discordUserId.trim() || discordUserId,
      discordUserId,
      trustLevel: 'public',
    });
  },

  async getCanonicalContactKey(channel: ContactChannel, channelUserId: string): Promise<string | undefined> {
    return (await this.getByChannelIdentity(channel, channelUserId))?.id;
  },

  async deleteContactDirect(
    id: string,
    lifecycleIntentId?: string,
    recoveryLeaseOwner?: string,
  ): Promise<boolean> {
    const deleted = await withPostgresClient(this.pool, async (client) => {
      if (lifecycleIntentId) {
        await beginContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          'contact.delete',
          recoveryLeaseOwner,
        );
      }
      const contact = await client.query<{ trust_level: TrustLevel }>(`
        SELECT trust_level FROM contacts WHERE id = $1 FOR UPDATE
      `, [id]);
      if (contact.rowCount !== 1 || contact.rows[0]?.trust_level === 'primary') return false;
      await client.query('DELETE FROM contact_channel_ids WHERE contact_id = $1', [id]);
      await client.query('DELETE FROM contact_channel_activity WHERE contact_id = $1', [id]);
      await client.query('DELETE FROM contact_identity_link_verifications WHERE contact_id = $1', [id]);
      await client.query('DELETE FROM contact_mutation_audit WHERE contact_id = $1', [id]);
      await invalidateMemorySubjectsForContact(client, id);
      const memoryTable = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('l2_memories')::text AS table_name",
      );
      if (memoryTable.rows[0]?.table_name) {
        await client.query('UPDATE l2_memories SET contact_id = NULL WHERE contact_id = $1', [id]);
      }
      const profileTable = await client.query<{ table_name: string | null }>(
        "SELECT to_regclass('contact_profiles')::text AS table_name",
      );
      if (profileTable.rows[0]?.table_name) {
        await client.query('DELETE FROM contact_profiles WHERE contact_id = $1', [id]);
      }
      let contactVersion: number | undefined;
      if (lifecycleIntentId) {
        const version = await client.query<{ contact_authority_version: string }>(`
          SELECT contact_authority_version FROM contacts WHERE id = $1
        `, [id]);
        contactVersion = Number(version.rows.at(0)?.contact_authority_version);
      }
      const result = await client.query('DELETE FROM contacts WHERE id = $1', [id]);
      if ((result.rowCount ?? 0) > 0 && lifecycleIntentId) {
        if (contactVersion === undefined) {
          throw new Error('Contact lifecycle delete version is missing');
        }
        await completeContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          contactVersion,
          recoveryLeaseOwner,
        );
      }
      return (result.rowCount ?? 0) > 0;
    });
    if (deleted) await this.syncContactExports();
    return deleted;
  },

  async unlinkChannelIdentityDirect(
    contactId: string,
    channel: string,
    channelUserId: string,
    actor?: string,
    lifecycleIntentId?: string,
    recoveryLeaseOwner?: string,
  ): Promise<boolean> {
    if (lifecycleIntentId) {
      const normalizedIdentity = normalizeIdentity(channel, channelUserId);
      const unlinked = await withPostgresClient(this.pool, async (client) => {
        await beginContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          'contact.discord_unlink',
          recoveryLeaseOwner,
        );
        const existing = await client.query<{ privacy_level: string }>(`
          SELECT privacy_level FROM contact_channel_ids
          WHERE contact_id = $1 AND channel = $2 AND channel_user_id = $3
          FOR UPDATE
        `, [contactId, normalizedIdentity.channel, normalizedIdentity.userId]);
        const row = existing.rows.at(0);
        if (!row) return false;
        const result = await client.query(`
          DELETE FROM contact_channel_ids
          WHERE contact_id = $1 AND channel = $2 AND channel_user_id = $3
        `, [contactId, normalizedIdentity.channel, normalizedIdentity.userId]);
        await client.query(`
          UPDATE contacts SET discord_user_id = NULL
          WHERE id = $1 AND discord_user_id = $2
        `, [contactId, normalizedIdentity.userId]);
        await this.appendMutationAuditEntry(
          contactId,
          'channel_link',
          JSON.stringify({
            channel: normalizedIdentity.channel,
            userId: normalizedIdentity.userId,
            privacyLevel: row.privacy_level,
          }),
          null,
          actor,
          client,
        );
        const version = await client.query<{ contact_authority_version: string }>(`
          SELECT contact_authority_version FROM contacts WHERE id = $1
        `, [contactId]);
        await completeContactLifecycleMutationCommit(
          client,
          lifecycleIntentId,
          Number(version.rows.at(0)?.contact_authority_version),
          recoveryLeaseOwner,
        );
        return (result.rowCount ?? 0) > 0;
      });
      if (unlinked) await this.syncContactExports();
      return unlinked;
    }
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    const result = await this.pool.query(
      `
        DELETE FROM contact_channel_ids
        WHERE contact_id = $1 AND channel = $2 AND channel_user_id = $3
      `,
      [contactId, normalizedIdentity.channel, normalizedIdentity.userId],
    );
    if ((result.rowCount ?? 0) > 0) {
      if (normalizedIdentity.channel === 'discord') {
        await this.pool.query(`
          UPDATE contacts SET discord_user_id = NULL
          WHERE id = $1 AND discord_user_id = $2
        `, [contactId, normalizedIdentity.userId]);
      }
      await this.appendMutationAuditEntry(
        contactId,
        'channel_link',
        JSON.stringify({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel: existingLink.privacyLevel,
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  },
};

export function installPostgresContactCrudOperations(store: PostgresContactStoreClass): void {
  Object.assign(store.prototype, postgresContactCrudOperations);
}
