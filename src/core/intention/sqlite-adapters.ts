import type Database from 'better-sqlite3';
import { ActiveConcernStore } from './sqlite-stores/active-concern-store.js';
import {
  createConcernStorePort,
  type ActiveConcernContextProvider,
  type ConcernStorePort,
} from './concern-store-port.js';
import { PendingFollowUpStore } from './sqlite-stores/pending-follow-up-store.js';
import type { PendingFollowUpContextProvider } from './pending-follow-ups.js';
import {
  createPendingFollowUpStorePort,
  type PendingFollowUpStorePort,
} from './pending-follow-up-store-port.js';
import {
  createBehavioralPatternStorePort,
  type BehavioralPatternStorePort,
} from './behavioral-pattern-store-port.js';
import { BehavioralPatternTracker } from './sqlite-stores/behavioral-pattern-tracker.js';
import type { BehavioralPatternContextProvider } from './patterns.js';

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
