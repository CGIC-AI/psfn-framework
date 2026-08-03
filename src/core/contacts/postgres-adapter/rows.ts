export interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  nickname: string | null;
  trust_level: string;
  trust_version?: string;
  contact_authority_version?: string;
  contact_lifecycle_state?: string;
  contact_restore_state?: string;
  relationship_type: string;
  is_machine_intelligence?: boolean | null;
  emotional_baseline: unknown;
  emotional_time_series?: unknown;
  first_seen: string;
  last_seen: string;
  notes: string | null;
  timezone: string | null;
  gender?: string | null;
  pronouns?: string | null;
  age?: number | null;
  archived_at?: string | null;
  /** Snapshot of released channel identities retained for archived history. */
  channel_identities?: unknown;
}

export interface ContactIdentityRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  privacy_level: string | null;
  bonded?: boolean | null;
  first_seen: string;
  last_seen: string;
  identity_version?: string;
  ownership_state?: string;
  verification_id?: string | null;
  verification_digest?: string | null;
  restore_state?: string;
}

export interface ContactChannelActivityRow {
  contact_id: string;
  channel: string;
  channel_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
}

export interface ContactIdentityVerificationRow {
  id: string;
  contact_id: string;
  source_channel: string;
  source_user_id: string;
  target_channel: string;
  target_user_id: string;
  nonce: string;
  expires_at: string;
  signature: string;
  status: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  failure_reason: string | null;
}

export interface ContactMutationAuditRow {
  id: number;
  contact_id: string;
  actor: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  metadata: unknown;
  timestamp: string;
}

export interface SocialGraphEntityRow {
  id: string;
  entity_kind: string;
  display_name: string;
  contact_id: string | null;
  sensitivity: string;
  provenance_refs: unknown;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SocialRelationshipEdgeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  directional: boolean;
  sensitivity: string;
  provenance_refs: unknown;
  evidence_memory_ids: unknown;
  confidence: number;
  created_at: string;
  updated_at: string;
}
