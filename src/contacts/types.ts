import type { TrustLevel } from '../trust/types.js';

export type RelationshipType = 'partner' | 'family' | 'friend' | 'acquaintance' | 'stranger' | 'ai_companion';

export const VALID_RELATIONSHIP_TYPES: RelationshipType[] = [
  'partner', 'family', 'friend', 'acquaintance', 'stranger', 'ai_companion',
];

export interface Contact {
  id: string;
  discordUserId?: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: RelationshipType;
  emotionalBaseline?: Record<string, number>;  // e.g. { warmth: 0.7, formality: 0.3 }
  firstSeen: string;  // ISO timestamp
  lastSeen: string;   // ISO timestamp
  notes?: string;
}
