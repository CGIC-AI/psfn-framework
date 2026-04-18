export interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  nickname: string | null;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: string;
  emotional_time_series: string;
  first_seen: string;
  last_seen: string;
  notes: string | null;
}

export interface ContactIdentityRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
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
  timestamp: string;
}

export interface SocialGraphEntityRow {
  id: string;
  entity_kind: string;
  display_name: string;
  contact_id: string | null;
  sensitivity: string;
  provenance_refs: string;
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
  directional: number;
  sensitivity: string;
  provenance_refs: string;
  evidence_memory_ids: string;
  confidence: number;
  created_at: string;
  updated_at: string;
}
