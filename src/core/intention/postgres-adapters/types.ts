import type { Pool } from 'pg';
import type { ActiveConcernContextProvider, ConcernStorePort } from '../concern-store-port.js';
import type { PendingFollowUpContextProvider } from '../pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../pending-follow-up-store-port.js';
import type { BehavioralPatternStorePort } from '../behavioral-pattern-store-port.js';
import type { WeightedThoughtStorePort } from '../weighted-thought-store-port.js';
import type {
  BehavioralPatternContextProvider,
  BehavioralPatternPromotionHook,
} from '../patterns.js';

export interface PostgresIntentionPorts {
  concernProvider: ActiveConcernContextProvider;
  pendingFollowUpProvider: PendingFollowUpContextProvider;
  behavioralPatternProvider: BehavioralPatternContextProvider;
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternStorePort;
  weightedThoughtStore: WeightedThoughtStorePort;
}

export interface PostgresIntentionPortOptions {
  pool?: Pool;
  applicationName?: string;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
  now?: () => Date;
  idFactory?: () => string;
  promotionHook?: BehavioralPatternPromotionHook | null;
  minimumSamplesForPromotion?: number;
  minimumAverageOutcomeForPromotion?: number;
}
