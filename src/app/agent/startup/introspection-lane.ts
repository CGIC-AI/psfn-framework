// ── Introspection audit runtime (Laws 28–30) ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
// Blinded divergence audit + values-consistency evaluation, registered as one
// scheduler task. The companion never interacts with the auditor directly;
// consent boundaries are companion-drawn (Law 29).

import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { SessionManager } from '../../../core/session/manager.js';
import type { SessionStore } from '../../../persistence/sessions/store.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import type { IntrospectionConsentStore } from '../../../faculties/introspection/consent-store.js';
import { IntrospectionAuditRuntime } from '../../../faculties/introspection/runtime.js';
import { registerIntrospectionAuditTask } from '../../../faculties/introspection/scheduler-lane.js';
import { createTurnRecordIntrospectionSource } from '../../../faculties/introspection/source.js';
import {
  createLLMIntrospectionAuditor,
  createLLMCompanionLandmarkReflector,
} from '../../../faculties/introspection/model-runtime.js';
import {
  createLLMValuesConsistencyEvaluator,
  IntrospectionValuesConsistencyRuntime,
  ValuesConsistencyFindingStore,
} from '../../../faculties/introspection/values-consistency.js';
import {
  DEFAULT_INTROSPECTION_AUDIT_CONFIG,
  type IntrospectionAuditConfig,
} from '../../../system/config/scheduler-config.js';
import { ValuesJournalStore } from '../../../faculties/values/store.js';
import {
  resolveIntrospectionValuesFindingsPath,
  resolveLegacyValuesJournalPath,
  resolveValuesJournalPath,
} from '../../../persistence/layout.js';
import type { createAgentPersistenceRuntime } from '../../../persistence/runtime-factory.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';

export interface IntrospectionLaneDeps {
  scheduler: Scheduler;
  schedulerConfig: SchedulerConfig;
  sessionManager: SessionManager;
  sessionStore: SessionStore;
  llmProvider: LLMProviderPort;
  systemPrompt: string;
  introspectionConsentStore: IntrospectionConsentStore;
  persistenceRuntime: Awaited<ReturnType<typeof createAgentPersistenceRuntime>>;
  companionDataDir: string;
}

export function registerIntrospectionLane(deps: IntrospectionLaneDeps): void {
  const {
    scheduler,
    schedulerConfig,
    sessionManager,
    sessionStore,
    llmProvider,
    systemPrompt,
    introspectionConsentStore,
    persistenceRuntime,
    companionDataDir,
  } = deps;

  const introspectionAuditConfig: IntrospectionAuditConfig = schedulerConfig.introspectionAudit
    ?? DEFAULT_INTROSPECTION_AUDIT_CONFIG;
  const introspectionAuditRuntime = new IntrospectionAuditRuntime({
    config: introspectionAuditConfig,
    consentStore: introspectionConsentStore,
    source: createTurnRecordIntrospectionSource({
      listRecentSessions: (limit, offset) => sessionManager.listRecentSessions(limit, offset).map((session) => ({
        sessionId: session.sessionId,
        sourceChannelId: sessionManager.getSessionRouteForLogicalSession(session.sessionId)?.sourceChannelId
          ?? session.channelId,
      })),
      readSourceTurnRecordPage: (sourceChannelId, limit, cursor) => (
        sessionStore.readSourceTurnRecordPage(sourceChannelId, limit, cursor)
      ),
      isSessionRetiredOrQuarantined: sessionId => (
        sessionManager.isSessionRetiredOrQuarantined(sessionId)
      ),
      isSourceTurnRecordEligible: (sourceChannelId, ownerSessionId, turnId) => (
        sessionStore.isSourceTurnRecordEligible(sourceChannelId, ownerSessionId, turnId)
      ),
    }),
    auditor: createLLMIntrospectionAuditor(llmProvider, introspectionAuditConfig),
    reflector: createLLMCompanionLandmarkReflector(
      llmProvider,
      systemPrompt,
      introspectionAuditConfig,
    ),
    persistence: persistenceRuntime.introspectionLandmarkStore,
  });
  const introspectionValuesConsistencyRuntime = new IntrospectionValuesConsistencyRuntime({
    landmarks: persistenceRuntime.introspectionLandmarkStore,
    consentStore: introspectionConsentStore,
    claimedValues: new ValuesJournalStore(
      resolveValuesJournalPath(companionDataDir),
      { legacyFilePaths: [resolveLegacyValuesJournalPath(companionDataDir)] },
    ),
    findings: new ValuesConsistencyFindingStore(
      resolveIntrospectionValuesFindingsPath(companionDataDir),
    ),
    evaluator: createLLMValuesConsistencyEvaluator({
      llmProvider,
      companionSystemPrompt: systemPrompt,
      maxTokens: introspectionAuditConfig.reflectionMaxTokens,
    }),
  });
  registerIntrospectionAuditTask({
    scheduler,
    runtime: introspectionAuditRuntime,
    valuesConsistencyRuntime: introspectionValuesConsistencyRuntime,
    config: introspectionAuditConfig,
  });
}
