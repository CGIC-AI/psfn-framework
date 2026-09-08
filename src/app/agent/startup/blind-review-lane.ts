// ── Blind Reviewer lane wiring (bead psfn-framework-yxz0z.3) ──
//
// Composes the continuous passive CogSec Blind Reviewer and hands the agent
// scheduler runtime a single `runOnce`. The lane runs as a background
// maintenance operation: it shares the housekeeping cadence, keeps its own
// owner-file interval as a due-gate on top of it, and — like every other
// operation there — cannot delay, cancel or alter a turn, because nothing on
// the turn path ever calls it.
//
// The Postgres window is connected LAZILY, on the first due run. A disabled
// reviewer therefore costs one config read and nothing else, and a database
// that is briefly unavailable at startup does not turn an observability lane
// into a boot failure.

import type { Logger } from 'winston';

import { BlindReviewLane } from '../../../core/cogsec/blind-review/lane.js';
import { createLLMBlindReviewer } from '../../../core/cogsec/blind-review/model-runtime.js';
import { createTurnRecordBlindReviewEvidenceSource } from '../../../core/cogsec/blind-review/evidence-source.js';
import { CogSecEventStore } from '../../../core/cogsec/events.js';
import { PostgresCogSecBlindReviewStore } from '../../../persistence/postgres/cogsec-blind-review-store.js';
import { resolveConfigTenantPoolScope } from '../../../persistence/postgres/tenant-pool-scope.js';
import { resolveCogSecEventsPath } from '../../../persistence/layout.js';
import { DEFAULT_BLIND_REVIEWER_CONFIG } from '../../../system/config/scheduler-config/blind-review.js';
import type { BlindReviewStorePort } from '../../../core/cogsec/blind-review/contracts.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { IntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import type { SchedulerRuntimeConfig } from '../../../system/config/scheduler-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';

export interface BlindReviewLaneDeps {
  schedulerConfig: SchedulerRuntimeConfig;
  /** Read for the live CogSec mode only; all three modes feed the same lane. */
  intakePolicy: IntakePolicyConfig;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  llmProvider: LLMProviderPort;
  postgresDatabaseUrl: string;
  config: SubstrateConfig;
  companionDataDir: string;
  log: Logger;
}

/** What the scheduler runtime needs: one due-gated pass. */
export interface BlindReviewLaneRuntime {
  /** Runs one pass when the owner-file interval has elapsed; otherwise a no-op. */
  runIfDue(nowMs?: number): Promise<boolean>;
}

/**
 * Compose the lane, or return null with a loud reason.
 *
 * Disabled is `info` — it is the default and the operator chose it. A missing
 * database URL while the reviewer is ENABLED is `error`: the operator asked for
 * a durable review window and cannot have one, and silence there would look
 * exactly like a working reviewer that never finds anything.
 */
export function wireBlindReviewLane(deps: BlindReviewLaneDeps): BlindReviewLaneRuntime | null {
  const config = deps.schedulerConfig.blindReviewer ?? DEFAULT_BLIND_REVIEWER_CONFIG;
  if (!config.enabled) {
    deps.log.info('CogSec Blind Reviewer disabled by scheduler.json blindReviewer.enabled');
    return null;
  }
  const databaseUrl = deps.postgresDatabaseUrl.trim();
  if (!databaseUrl) {
    deps.log.error(
      'CogSec Blind Reviewer NOT wired: blindReviewer.enabled is true but no PostgreSQL database '
      + 'URL is configured; the rolling review window and its restart recovery both require one',
    );
    return null;
  }

  const tenantScope = resolveConfigTenantPoolScope(deps.config);
  const cogSecEventsPath = resolveCogSecEventsPath(deps.companionDataDir);
  const source = createTurnRecordBlindReviewEvidenceSource({
    recentSessionLimit: config.recentSessionLimit,
    maxToolNamesPerItem: config.batch.maxToolNamesPerItem,
    reader: {
      listRecentSessions: limit => deps.sessionManager.listRecentSessions(limit).map(session => ({
        sessionId: session.sessionId,
        sourceChannelId: deps.sessionManager
          .getSessionRouteForLogicalSession(session.sessionId)?.sourceChannelId
          ?? session.channelId,
      })),
      getRecentSourceTurnRecords: (sourceChannelId, limit) => (
        deps.sessionStore.getRecentSourceTurnRecords(sourceChannelId, limit)
      ),
      isSessionRetiredOrQuarantined: sessionId => (
        deps.sessionManager.isSessionRetiredOrQuarantined(sessionId)
      ),
    },
  });

  let store: BlindReviewStorePort | null = null;
  let connecting: Promise<BlindReviewStorePort> | null = null;
  const openStore = async (): Promise<BlindReviewStorePort> => {
    if (store) return store;
    connecting ??= PostgresCogSecBlindReviewStore.connect(databaseUrl, {
      ...(tenantScope ? { schema: tenantScope.schema, role: tenantScope.role } : {}),
    }).then((connected) => {
      store = connected;
      return connected;
    });
    return connecting;
  };

  let lane: BlindReviewLane | null = null;
  let lastRunAtMs = 0;
  return {
    runIfDue: async (nowMs = Date.now()): Promise<boolean> => {
      if (lastRunAtMs !== 0 && nowMs - lastRunAtMs < config.intervalMs) return false;
      lane ??= new BlindReviewLane({
        config,
        store: await openStore(),
        source,
        reviewer: createLLMBlindReviewer(deps.llmProvider),
        readMode: () => deps.intakePolicy.mode,
        cogSecEvents: () => new CogSecEventStore(cogSecEventsPath),
      });
      const result = await lane.runOnce();
      lastRunAtMs = nowMs;
      deps.log.info('CogSec Blind Reviewer pass complete', {
        mode: result.mode,
        ingested: result.ingested,
        modelCalls: result.modelCalls,
        expired: result.expired,
        evicted: result.evicted,
        windowRows: result.window.total,
        pinnedRows: result.window.pinned,
      });
      return true;
    },
  };
}
