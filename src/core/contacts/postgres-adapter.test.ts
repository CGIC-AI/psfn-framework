import { describe, expect, it } from 'vitest';
import type { Pool, PoolClient, QueryResult } from 'pg';
import { createPostgresContactStore } from './postgres-adapter.js';
import type {
  ContactChannelActivityRow,
  ContactIdentityRow,
  ContactIdentityVerificationRow,
  ContactMutationAuditRow,
  ContactRow,
  SocialGraphEntityRow,
} from './postgres-adapter.js';

function result(rows: unknown[] = []): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } as QueryResult;
}

class FakePostgresPool {
  contacts = new Map<string, ContactRow>();
  contactChannelIds = new Map<string, ContactIdentityRow>();
  contactChannelActivity = new Map<string, ContactChannelActivityRow>();
  contactIdentityLinkVerifications = new Map<string, ContactIdentityVerificationRow>();
  contactMutationAudit: ContactMutationAuditRow[] = [];
  socialGraphEntities = new Map<string, SocialGraphEntityRow>();
  failNextWriteForChannel: string | null = null;

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values?: readonly unknown[]) => await this.query(text, values),
      release: () => undefined,
    } as PoolClient;
  }

  private contactKey(channel: string, channelUserId: string): string {
    return `${channel}::${channelUserId}`;
  }

  private normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private findContactByChannelIdentity(channel: string, channelUserId: string): ContactRow | undefined {
    const identity = this.contactChannelIds.get(this.contactKey(channel, channelUserId));
    if (!identity) return undefined;
    return this.contacts.get(identity.contact_id);
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    const normalized = this.normalize(text);
    if (
      normalized === 'begin'
      || normalized === 'commit'
      || normalized === 'rollback'
      || normalized.startsWith('create table')
      || normalized.startsWith('create index')
      || normalized.startsWith('alter table')
    ) {
      return result();
    }

    if (normalized.startsWith('select to_regclass')) {
      return result([{ exists: true }]);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes from contacts where discord_user_id = $1 limit 1')) {
      const needle = String(values[0] ?? '');
      const row = [...this.contacts.values()].find(contact => contact.discord_user_id === needle);
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select c.id, c.discord_user_id, c.display_name, c.nickname, c.trust_level, c.relationship_type, c.emotional_baseline, c.first_seen, c.last_seen, c.notes from contacts c inner join contact_channel_ids i on i.contact_id = c.id where i.channel = $1 and i.channel_user_id = $2 limit 1')) {
      const row = this.findContactByChannelIdentity(String(values[0] ?? ''), String(values[1] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select emotional_time_series from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [{ emotional_time_series: row.emotional_time_series ?? [] }] : []);
    }

    if (normalized.startsWith('select contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen from contact_channel_ids where contact_id = $1 order by channel asc, channel_user_id asc')) {
      const contactId = String(values[0] ?? '');
      const rows = [...this.contactChannelIds.values()].filter(row => row.contact_id === contactId);
      rows.sort((left, right) => left.channel.localeCompare(right.channel) || left.channel_user_id.localeCompare(right.channel_user_id));
      return result(rows);
    }

    if (normalized.startsWith('select contact_id, channel, channel_id, privacy_level, first_seen, last_seen from contact_channel_activity where contact_id = $1 order by last_seen desc, channel asc, channel_id asc')) {
      const contactId = String(values[0] ?? '');
      const rows = [...this.contactChannelActivity.values()].filter(row => row.contact_id === contactId);
      rows.sort((left, right) => right.last_seen.localeCompare(left.last_seen) || left.channel.localeCompare(right.channel) || left.channel_id.localeCompare(right.channel_id));
      return result(rows);
    }

    if (normalized.startsWith('insert into contacts (')) {
      const row: ContactRow = {
        id: String(values[0] ?? ''),
        discord_user_id: values[1] == null ? null : String(values[1]),
        display_name: String(values[2] ?? ''),
        nickname: values[3] == null ? null : String(values[3]),
        trust_level: String(values[4] ?? 'regular'),
        relationship_type: String(values[5] ?? 'stranger'),
        emotional_baseline: values[6] ?? {},
        emotional_time_series: [],
        first_seen: String(values[7] ?? ''),
        last_seen: String(values[8] ?? ''),
        notes: values[9] == null ? null : String(values[9]),
      };
      this.contacts.set(row.id, row);
      return result();
    }

    if (normalized.startsWith('update contacts set discord_user_id = coalesce(discord_user_id, $1), display_name = $2, nickname = $3, trust_level = $4, relationship_type = $5, emotional_baseline = $6, last_seen = $7, notes = coalesce($8, notes) where id = $9')) {
      const id = String(values[8] ?? '');
      const row = this.contacts.get(id);
      if (!row) return result();
      row.discord_user_id = row.discord_user_id ?? (values[0] == null ? null : String(values[0]));
      row.display_name = String(values[1] ?? row.display_name);
      row.nickname = values[2] == null ? null : String(values[2]);
      row.trust_level = String(values[3] ?? row.trust_level);
      row.relationship_type = String(values[4] ?? row.relationship_type);
      row.emotional_baseline = values[5] ?? row.emotional_baseline;
      row.last_seen = String(values[6] ?? row.last_seen);
      if (values[7] !== undefined) {
        row.notes = values[7] == null ? null : String(values[7]);
      }
      return result();
    }

    if (normalized.startsWith('update contacts set trust_level = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.trust_level = String(values[0] ?? row.trust_level);
      return result();
    }

    if (normalized.startsWith('update contacts set emotional_baseline = $1, emotional_time_series = $2, last_seen = $3 where id = $4')) {
      const row = this.contacts.get(String(values[3] ?? ''));
      if (!row) return result();
      row.emotional_baseline = values[0] ?? row.emotional_baseline;
      row.emotional_time_series = values[1] ?? row.emotional_time_series ?? [];
      row.last_seen = String(values[2] ?? row.last_seen);
      return result();
    }

    if (normalized.startsWith('update contacts set display_name = $1, nickname = $2 where id = $3')) {
      const row = this.contacts.get(String(values[2] ?? ''));
      if (row) {
        row.display_name = String(values[0] ?? row.display_name);
        row.nickname = values[1] == null ? null : String(values[1]);
      }
      return result();
    }

    if (normalized.startsWith('update contacts set display_name = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.display_name = String(values[0] ?? row.display_name);
      return result();
    }

    if (normalized.startsWith('update contacts set last_seen = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.last_seen = String(values[0] ?? row.last_seen);
      return result();
    }

    if (normalized.startsWith('update contact_channel_ids set last_seen = $1 where contact_id = $2')) {
      for (const row of this.contactChannelIds.values()) {
        if (row.contact_id === String(values[1] ?? '')) {
          row.last_seen = String(values[0] ?? row.last_seen);
        }
      }
      return result();
    }

    if (normalized.startsWith('update contact_channel_activity set last_seen = $1 where contact_id = $2')) {
      for (const row of this.contactChannelActivity.values()) {
        if (row.contact_id === String(values[1] ?? '')) {
          row.last_seen = String(values[0] ?? row.last_seen);
        }
      }
      return result();
    }

    if (normalized.startsWith('select contact_id from contact_channel_ids where channel = $1 and channel_user_id = $2 limit 1')) {
      const row = this.contactChannelIds.get(this.contactKey(String(values[0] ?? ''), String(values[1] ?? '')));
      return result(row ? [{ contact_id: row.contact_id }] : []);
    }

    if (normalized.startsWith('insert into contact_channel_ids (')) {
      if (this.failNextWriteForChannel === String(values[1] ?? '')) {
        this.failNextWriteForChannel = null;
        throw new Error(`forced write failure for ${String(values[1])}`);
      }
      const row: ContactIdentityRow = {
        contact_id: String(values[0] ?? ''),
        channel: String(values[1] ?? ''),
        channel_user_id: String(values[2] ?? ''),
        privacy_level: values[3] == null ? null : String(values[3]),
        first_seen: String(values[4] ?? ''),
        last_seen: String(values[5] ?? ''),
      };
      this.contactChannelIds.set(this.contactKey(row.channel, row.channel_user_id), row);
      return result();
    }

    if (normalized.startsWith('update contact_channel_ids set last_seen = $1, privacy_level = coalesce($2, privacy_level) where contact_id = $3 and channel = $4 and channel_user_id = $5')) {
      const row = this.contactChannelIds.get(this.contactKey(String(values[3] ?? ''), String(values[4] ?? '')));
      if (row && row.contact_id === String(values[2] ?? '')) {
        row.last_seen = String(values[0] ?? row.last_seen);
        row.privacy_level = values[1] == null ? row.privacy_level : String(values[1]);
      }
      return result();
    }

    if (normalized.startsWith('update contacts set discord_user_id = coalesce(discord_user_id, $1) where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row && row.discord_user_id == null) {
        row.discord_user_id = String(values[0] ?? '');
      }
      return result();
    }

    if (normalized.startsWith('insert into contact_channel_activity (')) {
      const row: ContactChannelActivityRow = {
        contact_id: String(values[0] ?? ''),
        channel: String(values[1] ?? ''),
        channel_id: String(values[2] ?? ''),
        privacy_level: values[3] == null ? null : String(values[3]),
        first_seen: String(values[4] ?? ''),
        last_seen: String(values[5] ?? ''),
      };
      this.contactChannelActivity.set(this.contactKey(row.contact_id, `${row.channel}:${row.channel_id}`), row);
      return result();
    }

    if (normalized.startsWith('insert into contact_mutation_audit')) {
      const row: ContactMutationAuditRow = {
        id: this.contactMutationAudit.length + 1,
        contact_id: String(values[0] ?? ''),
        actor: String(values[1] ?? ''),
        field: String(values[2] ?? ''),
        old_value: values[3] == null ? null : String(values[3]),
        new_value: values[4] == null ? null : String(values[4]),
        timestamp: String(values[5] ?? ''),
      };
      this.contactMutationAudit.push(row);
      return result();
    }

    if (normalized.startsWith('select id, entity_kind, display_name, contact_id, sensitivity, provenance_refs, confidence, source, created_at, updated_at from social_graph_entities where contact_id = $1 limit 1')) {
      const row = [...this.socialGraphEntities.values()].find(entity => entity.contact_id === String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, entity_kind, display_name, contact_id, sensitivity, provenance_refs, confidence, source, created_at, updated_at from social_graph_entities where id = $1 limit 1')) {
      const row = this.socialGraphEntities.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('insert into social_graph_entities (')) {
      const row: SocialGraphEntityRow = {
        id: String(values[0] ?? ''),
        entity_kind: String(values[1] ?? 'person'),
        display_name: String(values[2] ?? ''),
        contact_id: values[3] == null ? null : String(values[3]),
        sensitivity: String(values[4] ?? 'personal'),
        provenance_refs: values[5] ?? [],
        confidence: Number(values[6] ?? 1),
        source: String(values[7] ?? 'manual'),
        created_at: String(values[8] ?? ''),
        updated_at: String(values[9] ?? ''),
      };
      this.socialGraphEntities.set(row.id, row);
      return result();
    }

    if (normalized.startsWith('update social_graph_entities set entity_kind = $1, display_name = $2, contact_id = $3, sensitivity = $4, provenance_refs = $5, confidence = $6, source = $7, updated_at = $8 where id = $9')) {
      const row = this.socialGraphEntities.get(String(values[8] ?? ''));
      if (row) {
        row.entity_kind = String(values[0] ?? row.entity_kind);
        row.display_name = String(values[1] ?? row.display_name);
        row.contact_id = values[2] == null ? null : String(values[2]);
        row.sensitivity = String(values[3] ?? row.sensitivity);
        row.provenance_refs = values[4] ?? row.provenance_refs;
        row.confidence = Number(values[5] ?? row.confidence);
        row.source = String(values[6] ?? row.source);
        row.updated_at = String(values[7] ?? row.updated_at);
      }
      return result();
    }

    if (normalized.startsWith('delete from contact_channel_ids where contact_id = $1 and channel = $2 and channel_user_id = $3')) {
      const key = this.contactKey(String(values[1] ?? ''), String(values[2] ?? ''));
      const row = this.contactChannelIds.get(key);
      if (row && row.contact_id === String(values[0] ?? '')) {
        this.contactChannelIds.delete(key);
        return result([]);
      }
      return result([]);
    }

    if (normalized.startsWith('delete from contact_channel_activity where contact_id = $1 and channel = $2 and channel_id = $3')) {
      const key = this.contactKey(String(values[0] ?? ''), `${String(values[1] ?? '')}:${String(values[2] ?? '')}`);
      return this.contactChannelActivity.delete(key) ? result([]) : result([]);
    }

    if (normalized.startsWith('select * from contact_identity_link_verifications where contact_id = $1 and source_channel = $2 and source_user_id = $3 and target_channel = $4 and target_user_id = $5 and status = \'pending\' order by created_at desc limit 1')) {
      const row = [...this.contactIdentityLinkVerifications.values()].find(verification => (
        verification.contact_id === String(values[0] ?? '')
        && verification.source_channel === String(values[1] ?? '')
        && verification.source_user_id === String(values[2] ?? '')
        && verification.target_channel === String(values[3] ?? '')
        && verification.target_user_id === String(values[4] ?? '')
        && verification.status === 'pending'
      ));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('insert into contact_identity_link_verifications (')) {
      const row: ContactIdentityVerificationRow = {
        id: String(values[0] ?? ''),
        contact_id: String(values[1] ?? ''),
        source_channel: String(values[2] ?? ''),
        source_user_id: String(values[3] ?? ''),
        target_channel: String(values[4] ?? ''),
        target_user_id: String(values[5] ?? ''),
        nonce: String(values[6] ?? ''),
        expires_at: String(values[7] ?? ''),
        signature: String(values[8] ?? ''),
        status: String(values[9] ?? 'pending'),
        created_at: String(values[10] ?? ''),
        updated_at: String(values[11] ?? ''),
        verified_at: null,
        failure_reason: null,
      };
      this.contactIdentityLinkVerifications.set(row.id, row);
      return result();
    }

    if (normalized.startsWith('select * from contact_identity_link_verifications where id = $1 limit 1')) {
      const row = this.contactIdentityLinkVerifications.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('update contact_identity_link_verifications set status = $1, updated_at = $2, verified_at = coalesce($3, verified_at), failure_reason = $4 where id = $5')) {
      const row = this.contactIdentityLinkVerifications.get(String(values[4] ?? ''));
      if (row) {
        row.status = String(values[0] ?? row.status);
        row.updated_at = String(values[1] ?? row.updated_at);
        row.verified_at = values[2] == null ? row.verified_at : String(values[2]);
        row.failure_reason = values[3] == null ? null : String(values[3]);
      }
      return result();
    }

    if (normalized.startsWith('select * from contact_identity_link_verifications where contact_id = $1 and source_channel = $2 and source_user_id = $3 and target_channel = $4 and target_user_id = $5 and nonce = $6 order by created_at desc limit 1')) {
      const row = [...this.contactIdentityLinkVerifications.values()].find(verification => (
        verification.contact_id === String(values[0] ?? '')
        && verification.source_channel === String(values[1] ?? '')
        && verification.source_user_id === String(values[2] ?? '')
        && verification.target_channel === String(values[3] ?? '')
        && verification.target_user_id === String(values[4] ?? '')
        && verification.nonce === String(values[5] ?? '')
      ));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('update contact_channel_ids set privacy_level = $1, last_seen = $2 where contact_id = $3 and channel = $4 and channel_user_id = $5')) {
      const row = this.contactChannelIds.get(this.contactKey(String(values[3] ?? ''), String(values[4] ?? '')));
      if (row && row.contact_id === String(values[2] ?? '')) {
        row.privacy_level = values[0] == null ? row.privacy_level : String(values[0]);
        row.last_seen = String(values[1] ?? row.last_seen);
      }
      return result();
    }

    if (normalized.startsWith('update contact_channel_activity set privacy_level = $1, last_seen = $2 where contact_id = $3 and channel = $4 and channel_id = $5')) {
      const key = this.contactKey(String(values[2] ?? ''), `${String(values[3] ?? '')}:${String(values[4] ?? '')}`);
      const row = this.contactChannelActivity.get(key);
      if (row) {
        row.privacy_level = values[0] == null ? row.privacy_level : String(values[0]);
        row.last_seen = String(values[1] ?? row.last_seen);
      }
      return result();
    }

    if (normalized.startsWith('delete from contact_mutation_audit where contact_id = $1')) {
      this.contactMutationAudit = this.contactMutationAudit.filter(row => row.contact_id !== String(values[0] ?? ''));
      return result();
    }

    if (normalized.startsWith('delete from contact_identity_link_verifications where contact_id = $1')) {
      for (const [id, row] of [...this.contactIdentityLinkVerifications.entries()]) {
        if (row.contact_id === String(values[0] ?? '')) {
          this.contactIdentityLinkVerifications.delete(id);
        }
      }
      return result();
    }

    if (normalized.startsWith('delete from contacts where id = $1')) {
      const existed = this.contacts.delete(String(values[0] ?? ''));
      return { ...result(), rowCount: existed ? 1 : 0 };
    }

    if (normalized.startsWith('update contacts set trust_level = \'primary\', relationship_type = \'partner\' where id = $1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      if (row) {
        row.trust_level = 'primary';
        row.relationship_type = 'partner';
      }
      return result();
    }

    if (normalized.startsWith('select id from contacts where id <> $1 and trust_level = \'primary\' order by first_seen asc')) {
      const rows = [...this.contacts.values()]
        .filter(contact => contact.id !== String(values[0] ?? '') && contact.trust_level === 'primary')
        .map(contact => ({ id: contact.id }));
      return result(rows);
    }

    if (normalized.startsWith('select id, entity_kind, display_name, contact_id, sensitivity, provenance_refs, confidence, source, created_at, updated_at from social_graph_entities where contact_id = $1 limit 1')) {
      const row = [...this.socialGraphEntities.values()].find(entity => entity.contact_id === String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, entity_kind, display_name, contact_id, sensitivity, provenance_refs, confidence, source, created_at, updated_at from social_graph_entities where id = $1 limit 1')) {
      const row = this.socialGraphEntities.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, source_entity_id, target_entity_id, relationship_type, directional, sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at, source.sensitivity as source_sensitivity, target.sensitivity as target_sensitivity from social_relationship_edges e inner join social_graph_entities source on source.id = e.source_entity_id inner join social_graph_entities target on target.id = e.target_entity_id')) {
      const rows = [...this.socialRelationshipEdges.values()].map(edge => ({
        ...edge,
        source_sensitivity: this.socialGraphEntities.get(edge.source_entity_id)?.sensitivity ?? 'personal',
        target_sensitivity: this.socialGraphEntities.get(edge.target_entity_id)?.sensitivity ?? 'personal',
      }));
      return result(rows);
    }

    if (normalized.startsWith('insert into social_relationship_edges (')) {
      const row = {
        id: String(values[0] ?? ''),
        source_entity_id: String(values[1] ?? ''),
        target_entity_id: String(values[2] ?? ''),
        relationship_type: String(values[3] ?? 'other'),
        directional: Boolean(values[4]),
        sensitivity: String(values[5] ?? 'personal'),
        provenance_refs: values[6] ?? [],
        evidence_memory_ids: values[7] ?? [],
        confidence: Number(values[8] ?? 0.7),
        created_at: String(values[9] ?? ''),
        updated_at: String(values[10] ?? ''),
      };
      this.socialRelationshipEdges.set(row.id, row);
      return result();
    }

    if (normalized.startsWith('select id, source_entity_id, target_entity_id, relationship_type, directional, sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at from social_relationship_edges where id = $1 limit 1')) {
      const row = this.socialRelationshipEdges.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('update social_relationship_edges set sensitivity = $1, provenance_refs = $2, evidence_memory_ids = $3, confidence = $4, updated_at = $5 where id = $6')) {
      const row = this.socialRelationshipEdges.get(String(values[5] ?? ''));
      if (row) {
        row.sensitivity = String(values[0] ?? row.sensitivity);
        row.provenance_refs = values[1] ?? row.provenance_refs;
        row.evidence_memory_ids = values[2] ?? row.evidence_memory_ids;
        row.confidence = Number(values[3] ?? row.confidence);
        row.updated_at = String(values[4] ?? row.updated_at);
      }
      return result();
    }

    if (normalized.startsWith('delete from social_relationship_edges where id = $1')) {
      const existed = this.socialRelationshipEdges.delete(String(values[0] ?? ''));
      return { ...result(), rowCount: existed ? 1 : 0 };
    }

    if (normalized.startsWith('update social_relationship_edges set source_entity_id = $1, target_entity_id = $2, updated_at = $3 where id = $4')) {
      const row = this.socialRelationshipEdges.get(String(values[3] ?? ''));
      if (row) {
        row.source_entity_id = String(values[0] ?? row.source_entity_id);
        row.target_entity_id = String(values[1] ?? row.target_entity_id);
        row.updated_at = String(values[2] ?? row.updated_at);
      }
      return result();
    }

    throw new Error(`Unhandled SQL in FakePostgresPool: ${text}`);
  }
}

describe('PostgresContactStore', () => {
  it('round-trips contact identity and social graph data', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-discord',
      channels: [{
        channel: 'telegram',
        userId: 'alice-telegram',
        privacyLevel: 'private',
        firstSeen: '2026-03-28T00:00:00.000Z',
        lastSeen: '2026-03-28T00:00:00.000Z',
      }],
    });

    expect(contact.displayName).toBe('Alice');
    expect(contact.discordUserId).toBe('alice-discord');
    expect(await store.getByChannelIdentity('telegram', 'alice-telegram')).toMatchObject({
      id: contact.id,
      displayName: 'Alice',
    });
    expect(await store.getByDiscordUserId('alice-discord')).toMatchObject({
      id: contact.id,
      displayName: 'Alice',
    });
    expect(await store.getSocialGraphEntityByContactId(contact.id)).toMatchObject({
      id: `contact:${contact.id}`,
      contactId: contact.id,
      source: 'contact',
    });
  });

  it('creates and verifies a contact identity link challenge', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Alice',
      discordUserId: 'alice-discord',
    });

    const challenge = await store.createIdentityLinkChallenge({
      contactId: contact.id,
      sourceChannel: 'discord',
      sourceUserId: 'alice-discord',
      targetChannel: 'api',
      targetUserId: 'alice-api',
      ttlMs: 5 * 60_000,
    });

    expect(challenge.status).toBe('challenge_created');
    expect(challenge.verification.status).toBe('pending');

    const verified = await store.verifyIdentityLinkChallenge({
      contactId: contact.id,
      sourceChannel: 'discord',
      sourceUserId: 'alice-discord',
      targetChannel: 'api',
      targetUserId: 'alice-api',
      nonce: challenge.verification.nonce,
      expiresAt: challenge.verification.expiresAt,
      signature: challenge.verification.signature,
      privacyLevel: 'private',
    });

    expect(verified.status).toBe('linked');
    expect(verified.verification.status).toBe('verified');
    expect(await store.getByChannelIdentity('api', 'alice-api')).toMatchObject({
      id: contact.id,
    });
  });

  it('records and returns a bounded emotional time series per contact', async () => {
    const pool = new FakePostgresPool();
    const store = await createPostgresContactStore('postgres://unused', 'primary-user-123', {
      pool: pool as unknown as Pool,
    });

    const contact = await store.upsert({
      displayName: 'Ari',
      discordUserId: 'ari-discord',
    });

    expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([]);

    await store.updateEmotionalBaseline(contact.id, {
      valence: 0.15,
      confidence: 0.75,
      observedAtMs: 1_000,
    });
    await store.updateEmotionalBaseline(contact.id, {
      valence: -0.55,
      confidence: 0.65,
      observedAtMs: 2_000,
    });

    expect(await store.getEmotionalTimeSeries(contact.id)).toEqual([
      { valence: 0.15, confidence: 0.75, observedAtMs: 1_000 },
      { valence: -0.55, confidence: 0.65, observedAtMs: 2_000 },
    ]);
    expect(await store.getEmotionalTimeSeries(contact.id, 1)).toEqual([
      { valence: -0.55, confidence: 0.65, observedAtMs: 2_000 },
    ]);
  });
});
