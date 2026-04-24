import type {
  ChannelPrivacyLevel,
  Contact,
  ContactMutationAuditEntry,
  RelationshipType,
  SocialGraphEntity,
  SocialRelationshipEdge,
  SocialRelationshipEdgeQuery,
} from '../types.js';
import { CONTACT_MUTATION_AUDIT_FIELDS } from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import {
  type ChannelVisibility,
  type SensitivityLevel,
  SENSITIVITY_LEVELS,
  sensitivityOrd,
} from '../../../system/trust/types.js';
import { getAllowedSensitivities } from '../../../system/trust/policy.js';
import {
  defaultPrivacyForChannel,
  normalizePrivacyLevel,
} from '../store/identity-utils.js';
import type {
  ContactChannelActivityRow,
  ContactIdentityRow,
  ContactMutationAuditRow,
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from './rows.js';

export function normalizeTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return normalizeJsonArray(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

export function normalizeJsonObject(value: unknown): Record<string, number> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        out[key] = raw;
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    try {
      return normalizeJsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeTrustLevel(value: string): TrustLevel {
  switch (value) {
    case 'primary':
    case 'trusted':
    case 'regular':
    case 'public':
      return value;
    default:
      return 'regular';
  }
}

export function normalizeRelationshipType(value: string): RelationshipType {
  switch (value) {
    case 'partner':
    case 'family':
    case 'friend':
    case 'acquaintance':
    case 'stranger':
    case 'ai_companion':
      return value;
    default:
      return 'stranger';
  }
}

export function normalizeSocialEntityKind(value: string): SocialGraphEntity['entityKind'] {
  return value.trim().toLowerCase() === 'person' ? 'person' : 'person';
}

export function normalizeSocialEntitySource(value: string): SocialGraphEntity['source'] {
  switch (value) {
    case 'contact':
    case 'memory':
    case 'manual':
    case 'system':
      return value;
    default:
      return 'manual';
  }
}

export function normalizeSocialRelationshipKind(value: string): SocialRelationshipEdge['relationshipType'] {
  const allowed = [
    'partner',
    'family',
    'friend',
    'acquaintance',
    'colleague',
    'parent',
    'child',
    'sibling',
    'caregiver',
    'household',
    'manager',
    'direct_report',
    'other',
  ] as const;
  return allowed.includes(value as typeof allowed[number]) ? value as SocialRelationshipEdge['relationshipType'] : 'other';
}

export function normalizeSensitivity(value: string): SensitivityLevel {
  const normalized = value.trim().toLowerCase() as SensitivityLevel;
  return SENSITIVITY_LEVELS.includes(normalized) ? normalized : 'personal';
}

export function normalizeViewerTrustLevel(value: TrustLevel | undefined): TrustLevel {
  return value ?? 'public';
}

export function normalizeViewerVisibility(value: ChannelVisibility | undefined): ChannelVisibility {
  return value ?? 'public';
}

export function chooseMoreRestrictiveSensitivity(left: SensitivityLevel, right: SensitivityLevel): SensitivityLevel {
  return sensitivityOrd(left) >= sensitivityOrd(right) ? left : right;
}

export function edgeVisible(
  edgeSensitivity: SensitivityLevel,
  sourceSensitivity: SensitivityLevel,
  targetSensitivity: SensitivityLevel,
  query: SocialRelationshipEdgeQuery,
): boolean {
  const allowed = getAllowedSensitivities(
    normalizeViewerTrustLevel(query.viewerTrustLevel),
    normalizeViewerVisibility(query.viewerChannelVisibility),
  );
  return allowed.includes(edgeSensitivity)
    && allowed.includes(sourceSensitivity)
    && allowed.includes(targetSensitivity);
}

export function normalizeLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

export function normalizeAuditActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed) return 'system:unknown';
  return trimmed.slice(0, 120);
}

export function rowToContact(row: ContactRow, identities: ContactIdentityRow[], conversationChannels: ContactChannelActivityRow[]): Contact {
  const emotionalBaseline = normalizeJsonObject(row.emotional_baseline);
  const contact: Contact = {
    id: row.id,
    ...(row.discord_user_id ? { discordUserId: row.discord_user_id } : {}),
    displayName: row.display_name,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    trustLevel: normalizeTrustLevel(row.trust_level),
    relationshipType: normalizeRelationshipType(row.relationship_type),
    emotionalBaseline,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    ...(row.notes ? { notes: row.notes } : {}),
  };

  if (identities.length > 0) {
    contact.channels = identities.map(identity => ({
      channel: identity.channel,
      userId: identity.channel_user_id,
      privacyLevel: normalizePrivacyLevel(identity.privacy_level as ChannelPrivacyLevel | undefined, identity.channel),
      firstSeen: identity.first_seen,
      lastSeen: identity.last_seen,
    }));
    contact.channelIdentities = contact.channels.map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
    }));
  }

  if (row.discord_user_id && !contact.channels?.some(identity => identity.channel === 'discord' && identity.userId === row.discord_user_id)) {
    const discordIdentity = {
      channel: 'discord',
      userId: row.discord_user_id,
      privacyLevel: defaultPrivacyForChannel('discord'),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
    contact.channels = [discordIdentity, ...(contact.channels ?? [])];
    contact.channelIdentities = [discordIdentity, ...(contact.channelIdentities ?? [])].map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
    }));
  }

  if (conversationChannels.length > 0) {
    contact.conversationChannels = conversationChannels.map(channel => ({
      channel: channel.channel,
      channelId: channel.channel_id,
      firstSeen: channel.first_seen,
      lastSeen: channel.last_seen,
      ...(channel.privacy_level ? { privacyLevel: normalizePrivacyLevel(channel.privacy_level as ChannelPrivacyLevel, channel.channel) } : {}),
    }));
  }

  return contact;
}

export function contactMutationAuditRowToEntry(row: ContactMutationAuditRow): ContactMutationAuditEntry | undefined {
  if (!(CONTACT_MUTATION_AUDIT_FIELDS as readonly string[]).includes(row.field)) {
    return undefined;
  }

  return {
    id: row.id,
    contactId: row.contact_id,
    actor: row.actor,
    field: row.field as ContactMutationAuditEntry['field'],
    oldValue: row.old_value,
    newValue: row.new_value,
    timestamp: row.timestamp,
  };
}

export function socialGraphEntityRowToEntity(row: SocialGraphEntityRow): SocialGraphEntity {
  return {
    id: row.id,
    entityKind: normalizeSocialEntityKind(row.entity_kind),
    displayName: row.display_name,
    ...(row.contact_id ? { contactId: row.contact_id } : {}),
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs: normalizeJsonArray(row.provenance_refs),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 1,
    source: normalizeSocialEntitySource(row.source),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function socialGraphEdgeRowToEdge(row: SocialRelationshipEdgeRow): SocialRelationshipEdge {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: normalizeSocialRelationshipKind(row.relationship_type),
    directional: Boolean(row.directional),
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs: normalizeJsonArray(row.provenance_refs),
    evidenceMemoryIds: normalizeJsonArray(row.evidence_memory_ids),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0.7,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


