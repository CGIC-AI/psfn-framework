import type { TrustLevel, ChannelVisibility } from '../trust/types.js';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';
export type ContactChannel = string;
export type ChannelPrivacyLevel = ChannelVisibility;

export interface ContactChannelIdentity {
  channel: ContactChannel;
  userId: string;
}

export interface ContactChannelLink extends ContactChannelIdentity {
  privacyLevel: ChannelPrivacyLevel;
  firstSeen?: string;
  lastSeen?: string;
}

export interface ContactIdentityLinkOptions {
  privacyLevel?: ChannelPrivacyLevel;
}

export type ContactIdentityLinkResult =
  | 'linked'
  | 'already_linked'
  | 'contact_not_found'
  | 'identity_conflict';

export const CHANNEL_PRIVACY_LEVELS: ChannelPrivacyLevel[] = [
  'private',
  'semi_private',
  'public',
  'broadcast',
];

export const VALID_RELATIONSHIP_TYPES: RelationshipType[] = [
  'partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion',
];

export interface Contact {
  id: string;
  discordUserId?: string;
  channelIdentities?: ContactChannelIdentity[];
  channels?: ContactChannelLink[];
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  emotionalBaseline?: Record<string, number>;  // e.g. { warmth: 0.7, formality: 0.3 }
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  notes?: string;
}
