import { POSTGRES_CONTACT_LIFECYCLE_MIGRATIONS } from './contact-lifecycle-migrations.js';

export const POSTGRES_CONTACT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    discord_user_id TEXT UNIQUE,
    display_name TEXT NOT NULL,
    nickname TEXT,
    trust_level TEXT NOT NULL DEFAULT 'regular',
    trust_version BIGINT NOT NULL DEFAULT 0,
    relationship_type TEXT NOT NULL DEFAULT 'stranger',
    emotional_baseline JSONB NOT NULL DEFAULT '{}'::jsonb,
    emotional_time_series JSONB NOT NULL DEFAULT '[]'::jsonb,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    notes TEXT,
    timezone TEXT,
    channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb,
    conversation_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    is_machine_intelligence BOOLEAN NOT NULL DEFAULT FALSE
  );
  `,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS emotional_time_series JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS nickname TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS timezone TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel_identities JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS conversation_channels JSONB NOT NULL DEFAULT '[]'::jsonb;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_machine_intelligence BOOLEAN NOT NULL DEFAULT FALSE;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS trust_version BIGINT NOT NULL DEFAULT 0;`,
  // bead fnyb: structured demographic attributes. Provenance is carried by the
  // per-field contact_mutation_audit actor (operator/tool = specified,
  // system:* = inferred), mirroring is_machine_intelligence — no separate
  // provenance column needed.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gender TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS pronouns TEXT;`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS age INTEGER;`,
  // bead psfn-framework-qgqw.1: contacts are archived, never deleted
  // (adjudication R10.3). An archived contact's row, memories, audit, and
  // snapshotted privacy links persist as grayed-out history; its live channel
  // identities are released so a recreated/reused platform id mints a NEW
  // contact rather than resurrecting the archived person. `archived_at` NULL =
  // live; ISO timestamp = archived. Additive, nullable, backward-safe.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS archived_at TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_archived_at ON contacts(archived_at);`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);`,
  `CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);`,
  `
  CREATE TABLE IF NOT EXISTS contact_channel_ids (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    channel_user_id TEXT NOT NULL,
    privacy_level TEXT NOT NULL DEFAULT 'invite_only',
    bonded BOOLEAN NOT NULL DEFAULT FALSE,
    introduced_at_place_id TEXT,
    introduced_at_world TEXT,
    introduced_via TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (channel, channel_user_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_contact ON contact_channel_ids(contact_id);`,
  // Channel bonding opt-in flag per contact channel identity.
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS bonded BOOLEAN NOT NULL DEFAULT FALSE;`,
  // Optional first-introduction evidence. Nullable additions preserve the
  // serialized shape of every existing identity link until context is known.
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS introduced_at_place_id TEXT;`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS introduced_at_world TEXT;`,
  `ALTER TABLE contact_channel_ids ADD COLUMN IF NOT EXISTS introduced_via TEXT;`,
  `
  CREATE TABLE IF NOT EXISTS contact_channel_activity (
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    privacy_level TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (contact_id, channel, channel_id)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_contact ON contact_channel_activity(contact_id, last_seen DESC);`,
  `
  CREATE TABLE IF NOT EXISTS contact_identity_link_verifications (
    id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
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
    failure_reason TEXT
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_contact ON contact_identity_link_verifications(contact_id, created_at DESC);`,
  `
  CREATE TABLE IF NOT EXISTS contact_maintenance_watermarks (
    processor TEXT PRIMARY KEY,
    last_run_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS contact_mutation_audit (
    id BIGSERIAL PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TEXT NOT NULL
  );
  `,
  `ALTER TABLE contact_mutation_audit ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`,
  `CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_contact ON contact_mutation_audit(contact_id, timestamp DESC);`,
  `
  CREATE TABLE IF NOT EXISTS social_graph_entities (
    id TEXT PRIMARY KEY,
    entity_kind TEXT NOT NULL DEFAULT 'person',
    display_name TEXT NOT NULL,
    contact_id TEXT UNIQUE,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'contact',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS social_relationship_edges (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT NOT NULL REFERENCES social_graph_entities(id) ON DELETE CASCADE,
    target_entity_id TEXT NOT NULL REFERENCES social_graph_entities(id) ON DELETE CASCADE,
    relationship_type TEXT NOT NULL,
    directional BOOLEAN NOT NULL DEFAULT TRUE,
    sensitivity TEXT NOT NULL DEFAULT 'personal',
    provenance_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    evidence_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    confidence DOUBLE PRECISION NOT NULL DEFAULT 0.7,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source_entity_id, target_entity_id, relationship_type, directional)
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_source ON social_relationship_edges(source_entity_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_target ON social_relationship_edges(target_entity_id, updated_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_social_relationship_edges_type ON social_relationship_edges(relationship_type, updated_at DESC);`,
  ...POSTGRES_CONTACT_LIFECYCLE_MIGRATIONS,
];

// Sprint 10 D2a — hub identity ↔ contact enrollment. Biometrics stay at the
// Satellite Hub; core stores only the opaque handle → contact binding plus an
// audit trail. Semantically separate from the conversational contact_channel_*
// tables.
export const POSTGRES_ENROLLMENT_MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS hub_identity_enrollments (
    hub_identity_id TEXT PRIMARY KEY,
    contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'enrolled',
    satellite_id TEXT,
    endpoint_id TEXT,
    enrolled_by TEXT NOT NULL DEFAULT 'system:unknown',
    enrolled_at TEXT NOT NULL,
    revoked_by TEXT,
    revoked_at TEXT
  );
  `,
  `ALTER TABLE hub_identity_enrollments ADD COLUMN IF NOT EXISTS satellite_id TEXT;`,
  `ALTER TABLE hub_identity_enrollments ADD COLUMN IF NOT EXISTS endpoint_id TEXT;`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_contact ON hub_identity_enrollments(contact_id);`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollments_status ON hub_identity_enrollments(status);`,
  `
  CREATE TABLE IF NOT EXISTS hub_identity_enrollment_audit (
    id BIGSERIAL PRIMARY KEY,
    hub_identity_id TEXT NOT NULL,
    contact_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    satellite_id TEXT,
    endpoint_id TEXT,
    timestamp TEXT NOT NULL
  );
  `,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_handle ON hub_identity_enrollment_audit(hub_identity_id, timestamp DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_hub_identity_enrollment_audit_contact ON hub_identity_enrollment_audit(contact_id, timestamp DESC);`,
];
