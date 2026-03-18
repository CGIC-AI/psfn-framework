export interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  nickname: string | null;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: string;
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
