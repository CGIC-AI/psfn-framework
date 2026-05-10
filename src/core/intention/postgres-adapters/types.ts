import type { Pool } from 'pg';
import type { ActiveConcernContextProvider, ConcernStorePort } from '../concern-store-port.js';
import type { PendingFollowUpContextProvider } from '../pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../pending-follow-up-store-port.js';
import type {
  BehavioralPatternContextProvider,
  BehavioralPatternPromotionHook,
  BehavioralPatternStorePort,
} from '../patterns.js';

export interface PostgresIntentionPorts {
  concernProvider: ActiveConcernContextProvider;
  pendingFollowUpProvider: PendingFollowUpContextProvider;
  behavioralPatternProvider: BehavioralPatternContextProvider;
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternStorePort;
}

export interface PostgresIntentionPortOptions {
  pool?: Pool;
  applicationName?: string;
  now?: () => Date;
  idFactory?: () => string;
  promotionHook?: BehavioralPatternPromotionHook | null;
  minimumSamplesForPromotion?: number;
  minimumAverageOutcomeForPromotion?: number;
}
