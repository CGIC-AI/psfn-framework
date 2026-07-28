import type { PoolClient, QueryResult } from 'pg';
import type {
  ContactChannelActivityRow,
  ContactIdentityRow,
  ContactIdentityVerificationRow,
  ContactMutationAuditRow,
  ContactRow,
  SocialGraphEntityRow,
  SocialRelationshipEdgeRow,
} from '../core/contacts/postgres-adapter.js';

function result(rows: unknown[] = []): QueryResult {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } as QueryResult;
}

export class FakePostgresPool {
  contacts = new Map<string, ContactRow>();
  contactChannelIds = new Map<string, ContactIdentityRow>();
  contactChannelActivity = new Map<string, ContactChannelActivityRow>();
  contactIdentityLinkVerifications = new Map<string, ContactIdentityVerificationRow>();
  contactMutationAudit: ContactMutationAuditRow[] = [];
  socialGraphEntities = new Map<string, SocialGraphEntityRow>();
  socialRelationshipEdges = new Map<string, SocialRelationshipEdgeRow>();
  l2MemoryContacts = new Map<string, string>();
  contactProfiles = new Map<string, unknown>();
  contactMaintenanceWatermarks = new Map<string, string>();
  failNextWriteForChannel: string | null = null;
  failNextMutationAudit = false;
  beforeNextContactProfileUpdate: ((row: ContactRow) => void | Promise<void>) | null = null;
  beforeNextContactTrustUpdate: ((row: ContactRow) => void | Promise<void>) | null = null;
  afterNextChannelIdentityLookup: (() => void) | null = null;
  private transactionSnapshot?: {
    contacts: Map<string, ContactRow>;
    contactMutationAudit: ContactMutationAuditRow[];
  };

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
    if (normalized === 'begin') {
      this.transactionSnapshot = {
        contacts: new Map([...this.contacts].map(([id, row]) => [id, { ...row }])),
        contactMutationAudit: this.contactMutationAudit.map(row => ({ ...row })),
      };
      return result();
    }
    if (normalized === 'commit') {
      this.transactionSnapshot = undefined;
      return result();
    }
    if (normalized === 'rollback') {
      if (this.transactionSnapshot) {
        this.contacts = this.transactionSnapshot.contacts;
        this.contactMutationAudit = this.transactionSnapshot.contactMutationAudit;
        this.transactionSnapshot = undefined;
      }
      return result();
    }
    if (
      normalized.startsWith('create table')
      || normalized.startsWith('create index')
      || normalized.startsWith('create unique index')
      || normalized.startsWith('alter table')
      || normalized.startsWith('create or replace function')
      || normalized.startsWith('drop trigger')
      || normalized.startsWith('create trigger')
    ) {
      return result();
    }

    if (normalized.startsWith('select * from contact_lifecycle_intents order by created_at, intent_id')
      || normalized.startsWith('select result.intent_id, result.gateway_phase')
      || normalized.startsWith('select lock.intent_id, lock.target_kind, lock.target_id')
      || normalized.startsWith('select ownership.contact_id, ownership.channel')) {
      return result();
    }

    if (normalized.startsWith('select to_regclass')) {
      const tableName = String(values[0] ?? '');
      const exists = tableName === 'l2_memories'
        ? this.l2MemoryContacts.size > 0
        : tableName === 'contact_profiles'
          ? this.contactProfiles.size > 0
          : true;
      return result([{ exists }]);
    }

    if (normalized.startsWith('select trust_level from contacts where id = $1 for update')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [{ trust_level: row.trust_level }] : []);
    }

    if (normalized.startsWith('update l2_memories set contact_id = $1 where contact_id = $2')) {
      const targetId = String(values[0] ?? '');
      const sourceId = String(values[1] ?? '');
      for (const [memoryId, contactId] of this.l2MemoryContacts) {
        if (contactId === sourceId) this.l2MemoryContacts.set(memoryId, targetId);
      }
      return result();
    }

    if (normalized.startsWith('select 1 as exists_flag from contact_profiles where contact_id = $1 limit 1')) {
      return result(this.contactProfiles.has(String(values[0] ?? '')) ? [{ exists_flag: 1 }] : []);
    }

    if (normalized.startsWith('delete from contact_profiles where contact_id = $1')) {
      this.contactProfiles.delete(String(values[0] ?? ''));
      return result();
    }

    if (normalized.startsWith('update contact_profiles set contact_id = $1 where contact_id = $2')) {
      const targetId = String(values[0] ?? '');
      const sourceId = String(values[1] ?? '');
      const profile = this.contactProfiles.get(sourceId);
      if (profile !== undefined) {
        this.contactProfiles.delete(sourceId);
        this.contactProfiles.set(targetId, profile);
      }
      return result();
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes, timezone, gender, pronouns, age, archived_at, channel_identities from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, emotional_time_series, first_seen, last_seen, notes, timezone from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, emotional_time_series, first_seen, last_seen, notes, timezone, gender, pronouns, age from contacts where id = $1 for update')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes, timezone, gender, pronouns, age from contacts where discord_user_id = $1 limit 1')) {
      const needle = String(values[0] ?? '');
      const row = [...this.contacts.values()].find(contact => contact.discord_user_id === needle);
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes, timezone, gender, pronouns, age from contacts where trust_level = $1 order by last_seen desc')) {
      const trustLevel = String(values[0] ?? '');
      return result([...this.contacts.values()]
        .filter(row => row.trust_level === trustLevel)
        .sort((left, right) => right.last_seen.localeCompare(left.last_seen)));
    }

    if (normalized.startsWith('select c.id, c.discord_user_id, c.display_name, c.nickname, c.trust_level, c.relationship_type, c.is_machine_intelligence, c.emotional_baseline, c.first_seen, c.last_seen, c.notes, c.timezone, c.gender, c.pronouns, c.age from contacts c inner join contact_channel_ids i on i.contact_id = c.id where i.channel = $1 and i.channel_user_id = $2 limit 1')) {
      const row = this.findContactByChannelIdentity(String(values[0] ?? ''), String(values[1] ?? ''));
      const afterLookup = this.afterNextChannelIdentityLookup;
      this.afterNextChannelIdentityLookup = null;
      afterLookup?.();
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select emotional_time_series from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [{ emotional_time_series: row.emotional_time_series ?? [] }] : []);
    }

    if (normalized.startsWith('select trust_level, trust_version::text as trust_version from contacts where id = $1 limit 1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [{ trust_level: row.trust_level, trust_version: row.trust_version ?? '0' }] : []);
    }

    if (normalized.startsWith('select contact_id, channel, channel_user_id, privacy_level, bonded, first_seen, last_seen from contact_channel_ids where contact_id = $1 order by channel asc, channel_user_id asc')) {
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

    if (normalized.startsWith('select privacy_level from contact_channel_activity where contact_id = $1 and channel = $2 and channel_id = $3 limit 1')) {
      const row = [...this.contactChannelActivity.values()].find(activity => (
        activity.contact_id === String(values[0] ?? '')
        && activity.channel === String(values[1] ?? '')
        && activity.channel_id === String(values[2] ?? '')
      ));
      return result(row ? [{ privacy_level: row.privacy_level }] : []);
    }

    if (normalized.startsWith('insert into contacts (')) {
      const row: ContactRow = {
        id: String(values[0] ?? ''),
        discord_user_id: values[1] == null ? null : String(values[1]),
        display_name: String(values[2] ?? ''),
        nickname: values[3] == null ? null : String(values[3]),
        trust_level: String(values[4] ?? 'regular'),
        trust_version: '0',
        relationship_type: String(values[5] ?? 'stranger'),
        is_machine_intelligence: false,
        emotional_baseline: values[6] ?? {},
        emotional_time_series: [],
        first_seen: String(values[7] ?? ''),
        last_seen: String(values[8] ?? ''),
        notes: values[9] == null ? null : String(values[9]),
        timezone: values[10] == null ? null : String(values[10]),
        gender: null,
        pronouns: null,
        age: null,
      };
      this.contacts.set(row.id, row);
      return result();
    }

    if (normalized.startsWith('update contacts set gender = $1, pronouns = $2, age = $3 where id = $4')) {
      const row = this.contacts.get(String(values[3] ?? ''));
      if (row) {
        row.gender = values[0] == null ? null : String(values[0]);
        row.pronouns = values[1] == null ? null : String(values[1]);
        row.age = values[2] == null ? null : Number(values[2]);
      }
      return result();
    }

    if (normalized.startsWith('select id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence, emotional_baseline, first_seen, last_seen, notes, timezone, gender, pronouns, age, archived_at, channel_identities from contacts order by last_seen desc')) {
      return result([...this.contacts.values()]
        .sort((left, right) => right.last_seen.localeCompare(left.last_seen)));
    }

    if (normalized.startsWith('select is_machine_intelligence from contacts where id = $1 for update')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      return result(row ? [{ is_machine_intelligence: row.is_machine_intelligence ?? false }] : []);
    }

    if (normalized.startsWith('update contacts set is_machine_intelligence = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.is_machine_intelligence = Boolean(values[0]);
      return result();
    }

    if (normalized.startsWith('update contacts set is_machine_intelligence = true where id = $1')) {
      const row = this.contacts.get(String(values[0] ?? ''));
      if (row) row.is_machine_intelligence = true;
      return result();
    }

    if (normalized.startsWith("select actor from contact_mutation_audit where contact_id = $1 and field = 'is_machine_intelligence'")) {
      const row = this.contactMutationAudit
        .filter(entry => entry.contact_id === String(values[0] ?? '') && entry.field === 'is_machine_intelligence')
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id - left.id)
        .at(0);
      return result(row ? [{ actor: row.actor }] : []);
    }

    if (normalized.startsWith('update contacts set discord_user_id = coalesce(discord_user_id, $1), display_name = $2, nickname = $3, relationship_type = $4, emotional_baseline = $5, last_seen = $6, notes = coalesce($7, notes), timezone = $8 where id = $9')) {
      const id = String(values[8] ?? '');
      const row = this.contacts.get(id);
      if (!row) return result();
      const beforeUpdate = this.beforeNextContactProfileUpdate;
      this.beforeNextContactProfileUpdate = null;
      await beforeUpdate?.(row);
      if (
        normalized.includes('and relationship_type = $10')
        && row.relationship_type !== String(values[9] ?? '')
      ) {
        return result();
      }
      row.discord_user_id = row.discord_user_id ?? (values[0] == null ? null : String(values[0]));
      row.display_name = String(values[1] ?? row.display_name);
      row.nickname = values[2] == null ? null : String(values[2]);
      row.relationship_type = String(values[3] ?? row.relationship_type);
      row.emotional_baseline = values[4] ?? row.emotional_baseline;
      row.last_seen = String(values[5] ?? row.last_seen);
      if (values[6] !== null && values[6] !== undefined) {
        row.notes = String(values[6]);
      }
      row.timezone = values[7] == null ? null : String(values[7]);
      return normalized.endsWith('returning id') ? result([{ id: row.id }]) : result();
    }

    if (normalized.startsWith('update contacts set discord_user_id = coalesce(discord_user_id, $1), display_name = $2, nickname = $3, emotional_baseline = $4, last_seen = $5, notes = coalesce($6, notes), timezone = $7 where id = $8')) {
      const id = String(values[7] ?? '');
      const row = this.contacts.get(id);
      if (!row) return result();
      const beforeUpdate = this.beforeNextContactProfileUpdate;
      this.beforeNextContactProfileUpdate = null;
      await beforeUpdate?.(row);
      row.discord_user_id = row.discord_user_id ?? (values[0] == null ? null : String(values[0]));
      row.display_name = String(values[1] ?? row.display_name);
      row.nickname = values[2] == null ? null : String(values[2]);
      row.emotional_baseline = values[3] ?? row.emotional_baseline;
      row.last_seen = String(values[4] ?? row.last_seen);
      if (values[5] !== null && values[5] !== undefined) row.notes = String(values[5]);
      row.timezone = values[6] == null ? null : String(values[6]);
      return result();
    }

    if (normalized.startsWith('update contacts set trust_level = $1')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (!row) return result();
      const beforeUpdate = this.beforeNextContactTrustUpdate;
      this.beforeNextContactTrustUpdate = null;
      await beforeUpdate?.(row);
      if (
        normalized.includes('and trust_level = $3')
        && row.trust_level !== String(values[2] ?? '')
      ) {
        return result();
      }
      if (
        normalized.includes('and trust_version = $4')
        && (row.trust_version ?? '0') !== String(values[3] ?? '')
      ) {
        return result();
      }
      if (
        normalized.includes("and trust_level not in ('primary', 'trusted')")
        && (row.trust_level === 'primary' || row.trust_level === 'trusted')
      ) {
        return result();
      }
      row.trust_level = String(values[0] ?? row.trust_level);
      if (normalized.includes('trust_version = trust_version + 1')) {
        row.trust_version = String(BigInt(row.trust_version ?? '0') + 1n);
      }
      return normalized.endsWith('returning id') ? result([{ id: row.id }]) : result();
    }

    if (normalized.startsWith('update contacts set relationship_type = $1 where id = $2 and relationship_type = $3 returning id')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (!row || row.relationship_type !== String(values[2] ?? '')) return result();
      row.relationship_type = String(values[0] ?? row.relationship_type);
      return result([{ id: row.id }]);
    }

    if (normalized.startsWith('update contacts set relationship_type = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.relationship_type = String(values[0] ?? row.relationship_type);
      return result(row ? [{ id: row.id }] : []);
    }

    if (normalized.startsWith('update contacts set emotional_baseline = $1, emotional_time_series = $2, last_seen = $3 where id = $4')) {
      const row = this.contacts.get(String(values[3] ?? ''));
      if (!row) return result();
      row.emotional_baseline = values[0] ?? row.emotional_baseline;
      // Faithful to real Postgres: a jsonb parameter must arrive as JSON text.
      // node-pg encodes raw JS arrays as Postgres array literals, which real
      // Postgres rejects with 22P02 — exactly the crash-loop bug of 2026-06-11.
      if (Array.isArray(values[1])) {
        throw new Error('invalid input syntax for type json (22P02): array literal passed to jsonb column');
      }
      row.emotional_time_series = typeof values[1] === 'string'
        ? JSON.parse(values[1])
        : values[1] ?? row.emotional_time_series ?? [];
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

    if (normalized.startsWith('update contacts set notes = $1 where id = $2')) {
      const row = this.contacts.get(String(values[1] ?? ''));
      if (row) row.notes = values[0] == null ? null : String(values[0]);
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

    if (normalized.startsWith('update contact_channel_ids set contact_id = $1 where contact_id = $2')) {
      const targetId = String(values[0] ?? '');
      const sourceId = String(values[1] ?? '');
      for (const [key, row] of [...this.contactChannelIds.entries()]) {
        if (row.contact_id !== sourceId) continue;
        this.contactChannelIds.delete(key);
        row.contact_id = targetId;
        this.contactChannelIds.set(this.contactKey(row.channel, row.channel_user_id), row);
      }
      return result();
    }

    if (normalized.startsWith('update contact_channel_activity set contact_id = $1 where contact_id = $2')) {
      const targetId = String(values[0] ?? '');
      const sourceId = String(values[1] ?? '');
      for (const [key, row] of [...this.contactChannelActivity.entries()]) {
        if (row.contact_id !== sourceId) continue;
        this.contactChannelActivity.delete(key);
        row.contact_id = targetId;
        this.contactChannelActivity.set(this.contactKey(row.contact_id, `${row.channel}:${row.channel_id}`), row);
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
      if (this.failNextMutationAudit) {
        this.failNextMutationAudit = false;
        throw new Error('forced mutation audit failure');
      }
      const observationWrite = normalized.includes("'is_machine_intelligence', 'false', 'true'");
      const row: ContactMutationAuditRow = {
        id: this.contactMutationAudit.length + 1,
        contact_id: String(values[0] ?? ''),
        actor: String(values[1] ?? ''),
        field: observationWrite ? 'is_machine_intelligence' : String(values[2] ?? ''),
        old_value: observationWrite ? 'false' : (values[3] == null ? null : String(values[3])),
        new_value: observationWrite ? 'true' : (values[4] == null ? null : String(values[4])),
        timestamp: String(values[observationWrite ? 2 : 5] ?? ''),
      };
      this.contactMutationAudit.push(row);
      return result();
    }

    if (normalized.startsWith('select id, contact_id, actor, field, old_value, new_value, timestamp from contact_mutation_audit')) {
      let cursor = 0;
      let rows = [...this.contactMutationAudit];
      if (normalized.includes('contact_id =')) {
        const contactId = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.contact_id === contactId);
      }
      if (normalized.includes('actor =')) {
        const actor = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.actor === actor);
      }
      if (normalized.includes('field =')) {
        const field = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.field === field);
      }
      const limit = Number(values[cursor] ?? rows.length);
      return result(rows
        .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id - left.id)
        .slice(0, limit));
    }

    if (normalized.startsWith('select channel, channel_id, count(*) as member_count')) {
      const rooms = new Map<string, {
        channel: string;
        channel_id: string;
        member_count: number;
        first_activity: string;
        last_activity: string;
      }>();
      for (const activity of this.contactChannelActivity.values()) {
        const key = `${activity.channel}::${activity.channel_id}`;
        const current = rooms.get(key);
        if (!current) {
          rooms.set(key, {
            channel: activity.channel,
            channel_id: activity.channel_id,
            member_count: 1,
            first_activity: activity.first_seen,
            last_activity: activity.last_seen,
          });
          continue;
        }
        current.member_count += 1;
        if (activity.first_seen < current.first_activity) current.first_activity = activity.first_seen;
        if (activity.last_seen > current.last_activity) current.last_activity = activity.last_seen;
      }
      const limit = Number(values[0] ?? rooms.size);
      const offset = Number(values[1] ?? 0);
      return result([...rooms.values()]
        .sort((left, right) => right.last_activity.localeCompare(left.last_activity)
          || left.channel.localeCompare(right.channel)
          || left.channel_id.localeCompare(right.channel_id))
        .slice(offset, offset + limit));
    }

    if (normalized.startsWith('select count(*) as total from ( select 1 from contact_channel_activity group by channel, channel_id')) {
      const rooms = new Set([...this.contactChannelActivity.values()]
        .map(row => `${row.channel}::${row.channel_id}`));
      return result([{ total: rooms.size }]);
    }

    if (normalized.startsWith('select c.id as contact_id, c.display_name, c.trust_level, c.relationship_type, a.channel,')) {
      let cursor = 0;
      const channelId = String(values[cursor++] ?? '');
      const channel = normalized.includes('and a.channel =')
        ? String(values[cursor++] ?? '')
        : undefined;
      const limit = Number(values[cursor++] ?? this.contactChannelActivity.size);
      const offset = Number(values[cursor] ?? 0);
      const rows = [...this.contactChannelActivity.values()]
        .filter(activity => activity.channel_id === channelId)
        .filter(activity => channel === undefined || activity.channel === channel)
        .flatMap((activity) => {
          const contact = this.contacts.get(activity.contact_id);
          return contact ? [{
            contact_id: contact.id,
            display_name: contact.display_name,
            trust_level: contact.trust_level,
            relationship_type: contact.relationship_type,
            channel: activity.channel,
            channel_id: activity.channel_id,
            privacy_level: activity.privacy_level,
            first_seen: activity.first_seen,
            last_seen: activity.last_seen,
          }] : [];
        })
        .sort((left, right) => right.last_seen.localeCompare(left.last_seen)
          || left.display_name.localeCompare(right.display_name)
          || left.contact_id.localeCompare(right.contact_id));
      return result(rows.slice(offset, offset + limit));
    }

    if (normalized.startsWith('select count(*) as total from contact_channel_activity where channel_id = $1')) {
      const channelId = String(values[0] ?? '');
      const channel = normalized.includes('and channel =') ? String(values[1] ?? '') : undefined;
      const total = [...this.contactChannelActivity.values()]
        .filter(row => row.channel_id === channelId)
        .filter(row => channel === undefined || row.channel === channel)
        .length;
      return result([{ total }]);
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
        return { ...result(), rowCount: 1 };
      }
      return result([]);
    }

    if (normalized.startsWith('delete from contact_channel_activity where contact_id = $1 and channel = $2 and channel_id = $3')) {
      const key = this.contactKey(String(values[0] ?? ''), `${String(values[1] ?? '')}:${String(values[2] ?? '')}`);
      const existed = this.contactChannelActivity.delete(key);
      return { ...result(), rowCount: existed ? 1 : 0 };
    }

    if (normalized.startsWith('select * from contact_identity_link_verifications order by created_at desc limit $1')) {
      const limit = Number(values[0] ?? 25);
      return result([...this.contactIdentityLinkVerifications.values()]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit));
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

    if (normalized.startsWith('select * from contact_identity_link_verifications order by created_at desc limit $1')) {
      const limit = Number(values[0] ?? this.contactIdentityLinkVerifications.size);
      return result([...this.contactIdentityLinkVerifications.values()]
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(0, limit));
    }

    if (normalized.startsWith("select count(*) as count from contact_identity_link_verifications where contact_id = $1 and status = 'verified'")) {
      const contactId = String(values[0] ?? '');
      const count = [...this.contactIdentityLinkVerifications.values()]
        .filter(row => row.contact_id === contactId && row.status === 'verified')
        .length;
      return result([{ count }]);
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

    if (normalized.startsWith("select count(*) as count from contact_identity_link_verifications where contact_id = $1 and status = 'verified'")) {
      const contactId = String(values[0] ?? '');
      const count = [...this.contactIdentityLinkVerifications.values()]
        .filter(row => row.contact_id === contactId && row.status === 'verified').length;
      return result([{ count }]);
    }

    if (normalized.startsWith('select last_run_at from contact_maintenance_watermarks where processor = $1')) {
      const lastRunAt = this.contactMaintenanceWatermarks.get(String(values[0] ?? ''));
      return result(lastRunAt ? [{ last_run_at: lastRunAt }] : []);
    }

    if (normalized.startsWith('insert into contact_maintenance_watermarks (processor, last_run_at)')) {
      this.contactMaintenanceWatermarks.set(String(values[0] ?? ''), String(values[1] ?? ''));
      return result();
    }

    if (normalized.startsWith('update contact_channel_ids set bonded = $1, last_seen = $2 where contact_id = $3 and channel = $4 and channel_user_id = $5')) {
      const row = this.contactChannelIds.get(this.contactKey(String(values[3] ?? ''), String(values[4] ?? '')));
      if (row && row.contact_id === String(values[2] ?? '')) {
        row.bonded = Boolean(values[0]);
        row.last_seen = String(values[1] ?? row.last_seen);
      }
      return result();
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

    if (normalized.startsWith('delete from contact_channel_ids where contact_id = $1')) {
      const contactId = String(values[0] ?? '');
      for (const [key, row] of [...this.contactChannelIds.entries()]) {
        if (row.contact_id === contactId) this.contactChannelIds.delete(key);
      }
      return result();
    }

    if (normalized.startsWith('delete from contact_channel_activity where contact_id = $1')) {
      const contactId = String(values[0] ?? '');
      for (const [key, row] of [...this.contactChannelActivity.entries()]) {
        if (row.contact_id === contactId) this.contactChannelActivity.delete(key);
      }
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

    if (normalized.startsWith("update contacts set trust_level = 'primary', trust_version = trust_version + 1 where id = $1 and trust_level <> 'primary'")) {
      const row = this.contacts.get(String(values[0] ?? ''));
      if (row && row.trust_level !== 'primary') {
        row.trust_level = 'primary';
        row.trust_version = String(BigInt(row.trust_version ?? '0') + 1n);
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

    if (normalized.startsWith('select id, entity_kind, display_name, contact_id, sensitivity, provenance_refs, confidence, source, created_at, updated_at from social_graph_entities order by updated_at desc limit $1')) {
      const limit = Number(values[0] ?? this.socialGraphEntities.size);
      return result([...this.socialGraphEntities.values()]
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, limit));
    }

    if (normalized.startsWith('select id, source_entity_id, target_entity_id, relationship_type, directional, sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at, source.sensitivity as source_sensitivity, target.sensitivity as target_sensitivity from social_relationship_edges e inner join social_graph_entities source on source.id = e.source_entity_id inner join social_graph_entities target on target.id = e.target_entity_id')) {
      const rows = [...this.socialRelationshipEdges.values()].map(edge => ({
        ...edge,
        source_sensitivity: this.socialGraphEntities.get(edge.source_entity_id)?.sensitivity ?? 'personal',
        target_sensitivity: this.socialGraphEntities.get(edge.target_entity_id)?.sensitivity ?? 'personal',
      }));
      return result(rows);
    }

    if (normalized.startsWith('select e.id, e.source_entity_id, e.target_entity_id, e.relationship_type, e.directional,')) {
      let cursor = 0;
      let rows = [...this.socialRelationshipEdges.values()];
      if (normalized.includes('(e.source_entity_id =')) {
        const entityId = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.source_entity_id === entityId || row.target_entity_id === entityId);
      }
      if (normalized.includes('e.source_entity_id =') && !normalized.includes('(e.source_entity_id =')) {
        const sourceId = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.source_entity_id === sourceId);
      }
      if (normalized.includes('e.target_entity_id =') && !normalized.includes('(e.source_entity_id =')) {
        const targetId = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.target_entity_id === targetId);
      }
      if (normalized.includes('e.relationship_type =')) {
        const relationshipType = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.relationship_type === relationshipType);
      }
      if (normalized.includes('e.confidence >=')) {
        const minimum = Number(values[cursor++] ?? 0);
        rows = rows.filter(row => row.confidence >= minimum);
      }
      const limit = Number(values[cursor] ?? rows.length);
      return result(rows
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at)
          || right.created_at.localeCompare(left.created_at))
        .slice(0, limit)
        .map(row => ({
          ...row,
          source_sensitivity: this.socialGraphEntities.get(row.source_entity_id)?.sensitivity ?? 'personal',
          target_sensitivity: this.socialGraphEntities.get(row.target_entity_id)?.sensitivity ?? 'personal',
        })));
    }

    if (normalized.startsWith('select id, source_entity_id, target_entity_id, relationship_type, directional, sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at from social_relationship_edges where source_entity_id = $1 and target_entity_id = $2 and relationship_type = $3 and directional = $4')) {
      const excludedId = normalized.includes('and id !=') ? String(values[4] ?? '') : undefined;
      const row = [...this.socialRelationshipEdges.values()].find(edge => (
        edge.source_entity_id === String(values[0] ?? '')
        && edge.target_entity_id === String(values[1] ?? '')
        && edge.relationship_type === String(values[2] ?? '')
        && edge.directional === Boolean(values[3])
        && edge.id !== excludedId
      ));
      return result(row ? [row] : []);
    }

    if (normalized.startsWith('select id, source_entity_id, target_entity_id, relationship_type, directional, sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at from social_relationship_edges where source_entity_id = $1 or target_entity_id = $1')) {
      const entityId = String(values[0] ?? '');
      return result([...this.socialRelationshipEdges.values()]
        .filter(row => row.source_entity_id === entityId || row.target_entity_id === entityId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)));
    }

    if (normalized.startsWith('insert into social_relationship_edges (')) {
      const row: SocialRelationshipEdgeRow = {
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

    if (normalized.startsWith('update social_graph_entities set sensitivity = $1, provenance_refs = $2, confidence = $3, updated_at = $4 where id = $5')) {
      const row = this.socialGraphEntities.get(String(values[4] ?? ''));
      if (row) {
        row.sensitivity = String(values[0] ?? row.sensitivity);
        row.provenance_refs = values[1] ?? row.provenance_refs;
        row.confidence = Number(values[2] ?? row.confidence);
        row.updated_at = String(values[3] ?? row.updated_at);
      }
      return result();
    }

    if (normalized.startsWith('delete from social_graph_entities where id = $1')) {
      this.socialGraphEntities.delete(String(values[0] ?? ''));
      return result();
    }

    if (normalized.startsWith('update contacts set discord_user_id = $1, display_name = $2, nickname = $3, trust_level = $4, trust_version = case when trust_level is distinct from $4 then trust_version + 1 else trust_version end, relationship_type = $5')) {
      const row = this.contacts.get(String(values[11] ?? ''));
      if (row) {
        row.discord_user_id = values[0] == null ? null : String(values[0]);
        row.display_name = String(values[1] ?? row.display_name);
        row.nickname = values[2] == null ? null : String(values[2]);
        const mergedTrustLevel = String(values[3] ?? row.trust_level);
        if (row.trust_level !== mergedTrustLevel) {
          row.trust_version = String(BigInt(row.trust_version ?? '0') + 1n);
        }
        row.trust_level = mergedTrustLevel;
        row.relationship_type = String(values[4] ?? row.relationship_type);
        row.emotional_baseline = values[5] ?? row.emotional_baseline;
        row.emotional_time_series = typeof values[6] === 'string' ? JSON.parse(values[6]) : values[6];
        row.first_seen = String(values[7] ?? row.first_seen);
        row.last_seen = String(values[8] ?? row.last_seen);
        row.notes = values[9] == null ? null : String(values[9]);
        row.timezone = values[10] == null ? null : String(values[10]);
      }
      return result();
    }

    throw new Error(`Unhandled SQL in FakePostgresPool: ${text}`);
  }
}
