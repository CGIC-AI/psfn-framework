import type {
  AcacSnapshot,
  EmotionTelemetryValidation,
  VADVector,
} from './emotion-contracts.js';
import type {
  ActiveConcern,
  CareReminder,
  PendingFollowUp,
} from './intention-contracts.js';
import type { PlaceKind } from './places-registry.js';
import type { TrustLevel } from './trust-contracts.js';

export const INTERNAL_STATE_PROCESSING_QUALITIES = ['fluent', 'deliberate', 'struggling'] as const;
export type InternalStateProcessingQuality = typeof INTERNAL_STATE_PROCESSING_QUALITIES[number];

export const INTERNAL_STATE_CONVERSATION_TRAJECTORIES = ['deepening', 'shifting', 'wrapping-up', 'casual'] as const;
export type InternalStateConversationTrajectory = typeof INTERNAL_STATE_CONVERSATION_TRAJECTORIES[number];

/**
 * A durable, last-known situated location (S10 B3). Carried across turns and
 * continuity gaps so the companion remembers where it is even when a turn
 * arrives with no fresh routing signal. `updatedAt` is the last time this
 * location was CONFIRMED by a routing signal, not the current turn time — so a
 * carried-forward location honestly ages and is never presented as a fresh
 * reading.
 */
export interface SituatedLocation {
  /** Resolved place id when a satellite→place binding exists; null otherwise. */
  placeId: string | null;
  /** Site the place belongs to (or presence-derived siteId); null when unknown. */
  siteId: string | null;
  /** Human-readable location label. Always non-empty for a resolved location. */
  label: string;
  /** Physical vs virtual place; null when only a presence label is known. */
  kind: PlaceKind | null;
  /** ISO timestamp of when this location was last confirmed by a routing signal. */
  updatedAt: string;
}

export interface InternalState {
  emotional: {
    vad: VADVector;
    mood: VADVector;
    discreteEmotions: Record<string, number>;
    confidence: number;
    telemetry: EmotionTelemetryValidation;
    acac?: AcacSnapshot;
  };
  cognitive: {
    certaintyLevel: number;
    topicEngagement: number;
    processingQuality: InternalStateProcessingQuality;
  };
  attention: {
    activeConcerns: ActiveConcern[];
    pendingFollowUps?: PendingFollowUp[];
    careReminders?: CareReminder[];
    salientEntities: string[];
    conversationTrajectory: InternalStateConversationTrajectory;
  };
  relational: {
    contactId: string | null;
    trustLevel: TrustLevel;
    baselineValence: number;
    moodDrift: number;
    recentInteractionFrequency: number;
    lastSeenDeltaSeconds: number | null;
  };
  situated: {
    /** Last-known durable location; null when the companion has no known place. */
    location: SituatedLocation | null;
  };
}

export const METACOGNITIVE_FLAG_NAMES = [
  'uncertainty',
  'avoidance',
  'high_engagement',
  'repetition',
  'confabulation_risk',
] as const;

export type MetacognitiveFlagName = typeof METACOGNITIVE_FLAG_NAMES[number];

export interface MetacognitiveFlag {
  flag: MetacognitiveFlagName;
  confidence: number;
  evidence: string;
}
