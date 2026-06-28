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
import type { ContactUpsertMutationOptions } from '../contact-store-port.js';
import type { EmotionalSnapshot, EmotionalTimeSeriesPoint } from '../store/emotional-baseline.js';
import {
  appendEmotionalObservationToTimeSeries,
  computeUpdatedEmotionalBaseline,
  hasLearnedMoodSnapshot,
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
import type { ContactIdentityVerificationRow, ContactMutationAuditRow, ContactRow, SocialRelationshipEdgeRow } from './rows.js';
import {
  chooseMoreRestrictiveSensitivity,
  contactMutationAuditRowToEntry,
  normalizeJsonObject,
  normalizeLimit,
  socialGraphEdgeRowToEdge,
} from './mapping.js';
import { queryOne, queryRows, withPostgresClient } from './connection.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';

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
      partial.trustLevel === 'primary'
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
      const previousTrustLevel = target.trustLevel;
      const nextDisplayName = partial.displayName.trim() || target.displayName;
      const requestedNickname = normalizeNicknameValue(partial.nickname);
      const nextNickname = requestedNickname === undefined ? (target.nickname ?? undefined) : requestedNickname;
      const nextTrustLevel = partial.trustLevel ?? target.trustLevel;
      const nextRelationshipType = nextTrustLevel === 'primary'
        ? 'partner'
        : (partial.relationshipType ?? target.relationshipType);
      const nextEmotion = partial.emotionalBaseline ?? target.emotionalBaseline ?? {};
      const nextDiscordUserId = partial.discordUserId ?? target.discordUserId ?? undefined;
      await this.pool.query(
        `
          UPDATE contacts
          SET discord_user_id = COALESCE(discord_user_id, $1),
              display_name = $2,
              nickname = $3,
              trust_level = $4,
              relationship_type = $5,
              emotional_baseline = $6,
              last_seen = $7,
              notes = COALESCE($8, notes)
          WHERE id = $9
        `,
        [
          nextDiscordUserId ?? null,
          nextDisplayName,
          nextNickname ?? null,
          nextTrustLevel,
          nextRelationshipType,
          nextEmotion,
          now,
          partial.notes ?? null,
          target.id,
        ],
      );

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

      if (nextTrustLevel === 'primary' && previousTrustLevel !== 'primary') {
        await this.appendPrimaryTrustAudit(target.id, previousTrustLevel, 'upsert', 'allowed', options.actor);
      } else if (previousTrustLevel !== nextTrustLevel) {
        await this.appendMutationAuditEntry(target.id, 'trust_level', previousTrustLevel, nextTrustLevel, options.actor);
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
      relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
      emotionalBaseline: partial.emotionalBaseline ?? {},
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      ...(partial.notes ? { notes: partial.notes } : {}),
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
          notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
               emotional_baseline, first_seen, last_seen, notes
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
               emotional_baseline, first_seen, last_seen, notes
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

  async mergeContacts(sourceContactId: string, targetContactId: string): Promise<boolean> {
    if (sourceContactId === targetContactId) return true;
    return await withPostgresClient(this.pool, async (client) => {
      const sourceRow = await queryOne<ContactRow>(
        this.pool,
        `
          SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
                 emotional_baseline, emotional_time_series, first_seen, last_seen, notes
          FROM contacts
          WHERE id = $1
          LIMIT 1
        `,
        [sourceContactId],
      );
      const targetRow = await queryOne<ContactRow>(
        this.pool,
        `
          SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
                 emotional_baseline, emotional_time_series, first_seen, last_seen, notes
          FROM contacts
          WHERE id = $1
          LIMIT 1
        `,
        [targetContactId],
      );
      if (!sourceRow || !targetRow) return false;

      await client.query('UPDATE contact_channel_ids SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      await client.query('UPDATE contact_channel_activity SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);

      if (await this.tableExists('l2_memories')) {
        await client.query('UPDATE l2_memories SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      }
      if (await this.tableExists('contact_profiles')) {
        const targetProfileExists = await queryOne<{ exists_flag: number }>(
          this.pool,
          'SELECT 1 AS exists_flag FROM contact_profiles WHERE contact_id = $1 LIMIT 1',
          [targetContactId],
        );
        if (targetProfileExists) {
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

      const sourceEntity = await this.loadSocialGraphEntityByContactId(sourceContactId);
      const targetEntity = await this.loadSocialGraphEntityByContactId(targetContactId);
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

        const sourceEdges = await queryRows<SocialRelationshipEdgeRow>(
          this.pool,
          `
            SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                   sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
            FROM social_relationship_edges
            WHERE source_entity_id = $1 OR target_entity_id = $1
            ORDER BY created_at ASC, id ASC
          `,
          [sourceEntity.id],
        );
        for (const row of sourceEdges) {
          const edge = socialGraphEdgeRowToEdge(row);
          const rewrittenSource = edge.sourceEntityId === sourceEntity.id ? targetEntity.id : edge.sourceEntityId;
          const rewrittenTarget = edge.targetEntityId === sourceEntity.id ? targetEntity.id : edge.targetEntityId;
          if (rewrittenSource === rewrittenTarget) {
            await client.query('DELETE FROM social_relationship_edges WHERE id = $1', [edge.id]);
            continue;
          }
          const duplicate = await queryOne<SocialRelationshipEdgeRow>(
            this.pool,
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
              relationship_type = $5,
              emotional_baseline = $6,
              emotional_time_series = $7,
              first_seen = $8,
              last_seen = $9,
              notes = $10
          WHERE id = $11
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
          targetContactId,
        ],
      );

      await this.syncContactExports();
      return true;
    });
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
      await this.loadContactEmotionalTimeSeries(id),
      observation,
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
    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      return false;
    }
    await this.pool.query('UPDATE contacts SET relationship_type = $1 WHERE id = $2', [relationshipType, id]);
    await this.appendMutationAuditEntry(id, 'relationship_type', contact.relationshipType, relationshipType, actor);
    await this.syncContactExports();
    return true;
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
      id: uuidv7(),
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
    const now = new Date().toISOString();
    await this.pool.query(
      `
        UPDATE contact_identity_link_verifications
        SET status = $1,
            updated_at = $2,
            verified_at = COALESCE($3, verified_at),
            failure_reason = $4
        WHERE id = $5
      `,
      [status, now, verifiedAt ?? null, failureReason ?? null, verificationId],
    );
    const row = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE id = $1
        LIMIT 1
      `,
      [verificationId],
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
    if (row.signature !== input.signature.trim()) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'invalid_signature');
      return { status: 'invalid_signature', verification: failed ?? verification };
    }

    const sourceOwner = await this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== input.contactId) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'source_identity_not_linked');
      return { status: 'source_identity_not_linked', verification: failed ?? verification };
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
              relationship_type = 'partner'
          WHERE id = $1
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
               emotional_baseline, first_seen, last_seen, notes
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
    });
  },

  async getCanonicalContactKey(channel: ContactChannel, channelUserId: string): Promise<string | undefined> {
    return (await this.getByChannelIdentity(channel, channelUserId))?.id;
  },

  async deleteContact(id: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.trustLevel === 'primary') {
      return false;
    }
    await this.pool.query('DELETE FROM contact_channel_ids WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_channel_activity WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_identity_link_verifications WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_mutation_audit WHERE contact_id = $1', [id]);
    if (await this.tableExists('l2_memories')) {
      await this.pool.query('UPDATE l2_memories SET contact_id = NULL WHERE contact_id = $1', [id]);
    }
    if (await this.tableExists('contact_profiles')) {
      await this.pool.query('DELETE FROM contact_profiles WHERE contact_id = $1', [id]);
    }
    const result = await this.pool.query('DELETE FROM contacts WHERE id = $1', [id]);
    if ((result.rowCount ?? 0) > 0) {
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  },

  async unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): Promise<boolean> {
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
