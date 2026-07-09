import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createBehavioralPatternStorePort } from './behavioral-pattern-store-port.js';
import { createConcernStorePort } from './concern-store-port.js';
import { createPendingFollowUpStorePort } from './pending-follow-up-store-port.js';
import { PostgresPendingFollowUpStore } from './postgres-adapters/appraisal-trace-adapter.js';
import { PostgresActiveConcernStore } from './postgres-adapters/concerns-adapter.js';
import { createIntentionPostgresPool, ensureIntentionPostgresSchema } from './postgres-adapters/connection.js';
import { PostgresBehavioralPatternTracker } from './postgres-adapters/intention-record-adapter.js';
import { PostgresWeightedThoughtStore } from './postgres-adapters/weighted-thoughts-adapter.js';
import { createWeightedThoughtStorePort } from './weighted-thought-store-port.js';
import type { PostgresIntentionPortOptions, PostgresIntentionPorts } from './postgres-adapters/types.js';

export type { PostgresIntentionPortOptions, PostgresIntentionPorts } from './postgres-adapters/types.js';

function createPostgresIntentionRuntimeState(
  pool: Pool,
  options: PostgresIntentionPortOptions = {},
): {
  concernBackend: PostgresActiveConcernStore;
  pendingFollowUpBackend: PostgresPendingFollowUpStore;
  behavioralBackend: PostgresBehavioralPatternTracker;
  weightedThoughtBackend: PostgresWeightedThoughtStore;
  ports: PostgresIntentionPorts;
} {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const concernBackend = new PostgresActiveConcernStore(pool, now, idFactory);
  const pendingFollowUpBackend = new PostgresPendingFollowUpStore(pool, now, idFactory);
  const behavioralBackend = new PostgresBehavioralPatternTracker(pool, now, idFactory, {
    promotionHook: options.promotionHook ?? null,
    minimumSamplesForPromotion: options.minimumSamplesForPromotion,
    minimumAverageOutcomeForPromotion: options.minimumAverageOutcomeForPromotion,
  });
  const weightedThoughtBackend = new PostgresWeightedThoughtStore(pool);
  const concernStore = createConcernStorePort(concernBackend);
  const pendingFollowUpStore = createPendingFollowUpStorePort(pendingFollowUpBackend);
  const behavioralPatternTracker = createBehavioralPatternStorePort(behavioralBackend);
  const weightedThoughtStore = createWeightedThoughtStorePort(weightedThoughtBackend);

  return {
    concernBackend,
    pendingFollowUpBackend,
    behavioralBackend,
    weightedThoughtBackend,
    ports: {
      concernProvider: {
        getActiveConcerns: (contactId?: string) => concernBackend.snapshotActiveConcerns(contactId),
      },
      pendingFollowUpProvider: {
        getPendingFollowUps: (contactId?: string) => pendingFollowUpBackend.snapshotPendingFollowUps(contactId),
      },
      behavioralPatternProvider: {
        getBehavioralNotes: (contactId?: string, limit?: number) => (
          behavioralBackend.snapshotBehavioralNotes(contactId, limit)
        ),
      },
      concernStore,
      pendingFollowUpStore,
      behavioralPatternTracker,
      weightedThoughtStore,
    },
  };
}

export function createPostgresIntentionPortsFromPool(
  pool: Pool,
  options: PostgresIntentionPortOptions = {},
): PostgresIntentionPorts {
  return createPostgresIntentionRuntimeState(pool, options).ports;
}

export async function createPostgresIntentionPorts(
  databaseUrl: string,
  options: PostgresIntentionPortOptions = {},
): Promise<PostgresIntentionPorts> {
  const pool = options.pool ?? createIntentionPostgresPool(databaseUrl, {
    applicationName: options.applicationName,
    schema: options.schema,
  });
  await ensureIntentionPostgresSchema(pool);
  const state = createPostgresIntentionRuntimeState(pool, options);
  await Promise.all([
    state.concernBackend.hydrateCache(),
    state.pendingFollowUpBackend.hydrateCache(),
    state.behavioralBackend.hydrateCache(),
    state.weightedThoughtBackend.hydrateCache(),
  ]);
  return state.ports;
}
