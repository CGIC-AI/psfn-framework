import type Database from 'better-sqlite3';
import { hasColumn } from '../../../persistence/sqlite-utils.js';
import { LEGACY_DISCORD_CHANNEL, defaultPrivacyForChannel } from './identity-utils.js';

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName) as { name: string } | undefined;
  return row?.name === tableName;
}

function ensureChannelPrivacyColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contact_channel_ids', 'privacy_level')) {
    db.exec("ALTER TABLE contact_channel_ids ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'invite_only'");
  }
}

function ensureConversationChannelPrivacyColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contact_channel_activity', 'privacy_level')) {
    db.exec('ALTER TABLE contact_channel_activity ADD COLUMN privacy_level TEXT');
  }
}

function ensureMachineIntelligenceColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contacts', 'is_machine_intelligence')) {
    db.exec('ALTER TABLE contacts ADD COLUMN is_machine_intelligence INTEGER NOT NULL DEFAULT 0');
  }
}

function ensureNicknameColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contacts', 'nickname')) {
    db.exec('ALTER TABLE contacts ADD COLUMN nickname TEXT');
  }
}

function ensureTimezoneColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contacts', 'timezone')) {
    db.exec('ALTER TABLE contacts ADD COLUMN timezone TEXT');
  }
}

function ensureEmotionalTimeSeriesColumn(db: Database.Database): void {
  if (!hasColumn(db, 'contacts', 'emotional_time_series')) {
    db.exec("ALTER TABLE contacts ADD COLUMN emotional_time_series TEXT NOT NULL DEFAULT '[]'");
  }
}

function migrateLegacyDiscordIdentities(db: Database.Database): void {
  db.prepare(`
    INSERT INTO contact_channel_ids (contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen)
    SELECT id, ?, discord_user_id, ?, first_seen, last_seen
    FROM contacts
    WHERE discord_user_id IS NOT NULL
      AND TRIM(discord_user_id) <> ''
    ON CONFLICT(channel, channel_user_id) DO NOTHING
  `).run(LEGACY_DISCORD_CHANNEL, defaultPrivacyForChannel(LEGACY_DISCORD_CHANNEL));
}

export function initializeContactStoreSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      discord_user_id TEXT UNIQUE,
      display_name TEXT NOT NULL,
      nickname TEXT,
      trust_level TEXT NOT NULL DEFAULT 'regular',
      relationship_type TEXT NOT NULL DEFAULT 'stranger',
      emotional_baseline TEXT DEFAULT '{}',
      emotional_time_series TEXT NOT NULL DEFAULT '[]',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      notes TEXT,
      timezone TEXT,
      is_machine_intelligence INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS contact_channel_ids (
      contact_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_user_id TEXT NOT NULL,
      privacy_level TEXT NOT NULL DEFAULT 'invite_only',
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (channel, channel_user_id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_channel_activity (
      contact_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      privacy_level TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (contact_id, channel, channel_id),
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_identity_link_verifications (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      source_channel TEXT NOT NULL,
      source_user_id TEXT NOT NULL,
      target_channel TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      signature TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      verified_at TEXT,
      failure_reason TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_mutation_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS social_graph_entities (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL DEFAULT 'person',
      display_name TEXT NOT NULL,
      contact_id TEXT UNIQUE,
      sensitivity TEXT NOT NULL DEFAULT 'personal',
      provenance_refs TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'contact',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS social_relationship_edges (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL,
      target_entity_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      directional INTEGER NOT NULL DEFAULT 1,
      sensitivity TEXT NOT NULL DEFAULT 'personal',
      provenance_refs TEXT NOT NULL DEFAULT '[]',
      evidence_memory_ids TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.7,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (source_entity_id, target_entity_id, relationship_type, directional),
      FOREIGN KEY (source_entity_id) REFERENCES social_graph_entities(id) ON DELETE CASCADE,
      FOREIGN KEY (target_entity_id) REFERENCES social_graph_entities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS contact_maintenance_watermarks (
      processor TEXT PRIMARY KEY,
      last_run_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);
    CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);
    CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_contact ON contact_channel_ids(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_channel ON contact_channel_ids(channel);
    CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_contact
      ON contact_channel_activity(contact_id, last_seen);
    CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_channel
      ON contact_channel_activity(channel, channel_id);
    CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_contact
      ON contact_identity_link_verifications(contact_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_lookup
      ON contact_identity_link_verifications(
        contact_id,
        source_channel,
        source_user_id,
        target_channel,
        target_user_id,
        nonce
      );
    CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_contact
      ON contact_mutation_audit(contact_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_field
      ON contact_mutation_audit(field, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_actor
      ON contact_mutation_audit(actor, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_social_graph_entities_contact
      ON social_graph_entities(contact_id);
    CREATE INDEX IF NOT EXISTS idx_social_graph_entities_updated_at
      ON social_graph_entities(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_source
      ON social_relationship_edges(source_entity_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_target
      ON social_relationship_edges(target_entity_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_type
      ON social_relationship_edges(relationship_type, updated_at DESC);
  `);

  ensureNicknameColumn(db);
  ensureTimezoneColumn(db);
  ensureMachineIntelligenceColumn(db);
  ensureEmotionalTimeSeriesColumn(db);
  ensureChannelPrivacyColumn(db);
  ensureConversationChannelPrivacyColumn(db);
  migrateLegacyDiscordIdentities(db);
  db.exec(`
    INSERT INTO social_graph_entities (
      id,
      entity_kind,
      display_name,
      contact_id,
      sensitivity,
      provenance_refs,
      confidence,
      source,
      created_at,
      updated_at
    )
    SELECT
      'contact:' || c.id,
      'person',
      c.display_name,
      c.id,
      'personal',
      '[]',
      1,
      'contact',
      c.first_seen,
      c.last_seen
    FROM contacts c
    WHERE NOT EXISTS (
      SELECT 1
      FROM social_graph_entities e
      WHERE e.contact_id = c.id
    )
  `);
}

export function maybeHasContactLinkedTable(db: Database.Database, tableName: string, columnName: string): boolean {
  return hasTable(db, tableName) && hasColumn(db, tableName, columnName);
}
