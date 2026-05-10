import type Database from 'better-sqlite3';
import { ActiveConcernStore } from './concerns.js';
import {
  createConcernStorePort,
  type ActiveConcernContextProvider,
  type ConcernStorePort,
} from './concern-store-port.js';
import {
  PendingFollowUpStore,
  type PendingFollowUpContextProvider,
} from './pending-follow-ups.js';
import {
  createPendingFollowUpStorePort,
  type PendingFollowUpStorePort,
} from './pending-follow-up-store-port.js';
import {
  BehavioralPatternTracker,
  createBehavioralPatternStorePort,
  type BehavioralPatternContextProvider,
  type BehavioralPatternStorePort,
} from './patterns.js';

export interface SQLiteIntentionRuntimeStores {
  concernProvider: ActiveConcernContextProvider;
  pendingFollowUpProvider: PendingFollowUpContextProvider;
  behavioralPatternProvider: BehavioralPatternContextProvider;
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternStorePort;
}

export function createSQLiteIntentionRuntimeStores(
  db: Database.Database,
): SQLiteIntentionRuntimeStores {
  const concernProvider = new ActiveConcernStore(db);
  const pendingFollowUpProvider = new PendingFollowUpStore(db);
  const behavioralPatternProvider = new BehavioralPatternTracker(db);
  return {
    concernProvider,
    pendingFollowUpProvider,
    behavioralPatternProvider,
    concernStore: createConcernStorePort(concernProvider),
    pendingFollowUpStore: createPendingFollowUpStorePort(pendingFollowUpProvider),
    behavioralPatternTracker: createBehavioralPatternStorePort(behavioralPatternProvider),
  };
}
