// ── Drift review lanes (htm9.14/htm9.15) + emo_sim dyad advisory (oth4.6) ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
//
// Drift-velocity: deterministic nightly aggregation (zero LLM, zero turn
// latency) over the per-contact valence series, memory-write rows, quarantine
// risk labels, and retrieval recency. Second-arrow: deterministic nightly
// clustering over recent memory writes' STORED embeddings, active concerns,
// and the per-contact affect series. Findings become operator review cards on
// the Garden Cognitive Security tab; the lanes never mutate memories, trust,
// or emotion, and the companion never sees them.
//
// emo_sim dyad advisory: read-only ADVISORY over the observer-sidecar's
// persisted emo_sim affect model, fed into the nightly contact
// trust/relationship review as one more signal the companion weighs. It never
// mutates trust or relationship state.

import type { Logger } from 'winston';
import { createDriftVelocityEvidencePort } from '../../../core/cogsec/drift/drift-evidence-adapters.js';
import { createSecondArrowEvidencePort } from '../../../core/cogsec/drift/second-arrow-evidence-adapters.js';
import { createDriftReviewCardStore } from '../../../core/cogsec/drift/drift-review-card-store.js';
import { createIntakeQuarantineStore } from '../../../core/cogsec/intake/quarantine-store.js';
import {
  resolveDriftReviewCardsPath,
  resolveIntakeQuarantinePath,
} from '../../../persistence/layout.js';
import { createEmoSimDyadRelationshipAdvisoryProvider } from '../../../core/eval/observer-sidecar/dyad-relationship-advisory-provider.js';
import { createPostgresObserverEvalSidecarStore } from '../../../core/eval/observer-sidecar/persistence.js';
import { resolveConfigTenantPoolScope } from '../../../persistence/postgres/tenant-pool-scope.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { MemoryStorePort } from '../../../faculties/memory/memory-store-port.js';
import type { ConcernStorePort } from '../../../core/intention/concern-store-port.js';
import type { IntakePolicyConfig } from '../../../system/config/intake-policy-config.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { RuntimePathSnapshot } from '../../../persistence/layout.js';
import type { ObserverEvalSidecarRuntime } from '../../../core/eval/observer-sidecar/types.js';

export interface DriftReviewLanesDeps {
  intakePolicy: IntakePolicyConfig;
  contactStore: ContactStorePort;
  memoryStore: MemoryStorePort;
  concernStore: ConcernStorePort | null;
  companionDataDir: RuntimePathSnapshot['companionDataDir'];
  observerEvalSidecar: ObserverEvalSidecarRuntime;
  postgresDatabaseUrl: string;
  config: SubstrateConfig;
  log: Logger;
}

export interface DriftReviewLanesResult {
  driftVelocityReview: ReturnType<typeof buildDriftVelocityReview>;
  secondArrowReview: ReturnType<typeof buildSecondArrowReview>;
  dyadRelationshipAdvisoryProvider: ReturnType<typeof createEmoSimDyadRelationshipAdvisoryProvider> | null;
}

function buildDriftVelocityReview(deps: DriftReviewLanesDeps) {
  const { intakePolicy, contactStore, memoryStore, companionDataDir } = deps;
  return intakePolicy.driftDetection.enabled
    ? {
      evidence: createDriftVelocityEvidencePort({
        contactStore,
        memoryStore,
        quarantineStore: intakePolicy.mode !== 'off'
          ? createIntakeQuarantineStore(
            resolveIntakeQuarantinePath(companionDataDir),
            {
              itemTtlHours: intakePolicy.quarantine.itemTtlHours,
              maxHeldItems: intakePolicy.quarantine.maxHeldItems,
            },
          )
          : null,
      }),
      cardStore: createDriftReviewCardStore(
        resolveDriftReviewCardsPath(companionDataDir),
      ),
      config: intakePolicy.driftDetection,
      watermarks: {
        getContactMaintenanceWatermark: (processor: string) =>
          contactStore.getContactMaintenanceWatermark(processor),
        setContactMaintenanceWatermark: (processor: string, lastRunAt: string) =>
          contactStore.setContactMaintenanceWatermark(processor, lastRunAt),
      },
    }
    : null;
}

function buildSecondArrowReview(
  deps: DriftReviewLanesDeps,
  driftVelocityReview: ReturnType<typeof buildDriftVelocityReview>,
) {
  const { intakePolicy, contactStore, memoryStore, concernStore, companionDataDir } = deps;
  const secondArrowEnabled = intakePolicy.driftDetection.enabled
    && intakePolicy.driftDetection.secondArrow.enabled;
  return secondArrowEnabled && memoryStore.listActiveMemoryEmbeddingsSince
    ? {
      evidence: createSecondArrowEvidencePort({
        memoryStore,
        contactStore,
        concernStore,
      }),
      cardStore: driftVelocityReview?.cardStore
        ?? createDriftReviewCardStore(resolveDriftReviewCardsPath(companionDataDir)),
      config: intakePolicy.driftDetection.secondArrow,
      watermarks: {
        getContactMaintenanceWatermark: (processor: string) =>
          contactStore.getContactMaintenanceWatermark(processor),
        setContactMaintenanceWatermark: (processor: string, lastRunAt: string) =>
          contactStore.setContactMaintenanceWatermark(processor, lastRunAt),
      },
    }
    : null;
}

export function wireDriftReviewLanes(deps: DriftReviewLanesDeps): DriftReviewLanesResult {
  const { intakePolicy, observerEvalSidecar, postgresDatabaseUrl, config, log } = deps;

  const driftVelocityReview = buildDriftVelocityReview(deps);
  if (!driftVelocityReview) {
    log.info('Drift-velocity review lane disabled by intake-policy driftDetection.enabled');
  }

  const secondArrowEnabled = intakePolicy.driftDetection.enabled
    && intakePolicy.driftDetection.secondArrow.enabled;
  const secondArrowReview = buildSecondArrowReview(deps, driftVelocityReview);
  if (!secondArrowReview) {
    if (secondArrowEnabled) {
      // Enabled but the store cannot serve stored embeddings: loud, never silent.
      log.error(
        'Second-arrow review lane NOT wired: memory store lacks listActiveMemoryEmbeddingsSince '
        + '(stored-embedding reads); rumination detection is disabled until the store provides it',
      );
    } else {
      log.info('Second-arrow review lane disabled by intake-policy driftDetection.secondArrow.enabled');
    }
  }

  // emo_sim directed-relationship advisory (oth4.6): wired only when the
  // sidecar is active, persists observations, and exposes a companion agent
  // name; otherwise the review simply omits the signal. The Postgres store
  // here is the SAME memoized instance the sidecar writes to.
  const dyadEmosimAgentName = observerEvalSidecar.config?.adapter?.agentName?.trim();
  const dyadRelationshipAdvisoryProvider =
    observerEvalSidecar.observer
    && observerEvalSidecar.config?.persistence?.enabled === true
    && dyadEmosimAgentName
      ? createEmoSimDyadRelationshipAdvisoryProvider({
        getLatestObservation: () =>
          createPostgresObserverEvalSidecarStore(
            postgresDatabaseUrl,
            {},
            resolveConfigTenantPoolScope(config),
          ).getLatestObservation(),
      })
      : null;
  if (!dyadRelationshipAdvisoryProvider) {
    log.info('emo_sim dyad relationship advisory not wired for trust-drift review', {
      sidecarActive: Boolean(observerEvalSidecar.observer),
      persistenceEnabled: observerEvalSidecar.config?.persistence?.enabled === true,
      hasAgentName: Boolean(dyadEmosimAgentName),
    });
  }

  return { driftVelocityReview, secondArrowReview, dyadRelationshipAdvisoryProvider };
}
