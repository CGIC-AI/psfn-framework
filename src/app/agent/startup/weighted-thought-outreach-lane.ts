// ── Weighted-thought outreach lane (E?/1xb.2) + Law 27 contradiction dampening ──
// Extracted from agent/main.ts (charter 12.1 god-file split, emh3p.1).
// Internal-state-driven outreach: a weighted thought crossing threshold
// produces an LLM nudge the companion accepts or declines; accepted nudges
// ride the existing durable-outbox delivery path. Disabled by default
// (scheduler.json weightedThoughtOutreach.enabled) and fail-closed on channel
// resolution — primary heartbeat DM only until a group-continuation policy
// approver is wired.

import type { Scheduler } from '../../../core/scheduler/scheduler.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { createLlmNudgeEvaluator } from '../../../core/intention/weighted-thought-nudge-evaluator.js';
import {
  createWeightedThoughtContradictionDamper,
  type WeightedThoughtContradictionDamperDeps,
} from '../../../core/intention/weighted-thought-contradiction.js';
import type { WeightedThoughtStorePort } from '../../../core/intention/weighted-thought-store-port.js';
import { registerWeightedThoughtOutreachTask } from '../../../core/scheduler/weighted-thought-outreach-lane.js';
import type { EventBus } from '../../../shared/event-bus.js';
import type { SchedulerRuntimeConfig as SchedulerConfig } from '../../../system/config/scheduler-config.js';
import type { wireIcpInitiationSources } from '../icp-initiation-source-wiring.js';

export interface WeightedThoughtOutreachLaneDeps {
  scheduler: Scheduler;
  schedulerConfig: Pick<SchedulerConfig, 'weightedThoughtOutreach' | 'episodicProcessing'>;
  eventBus: EventBus;
  weightedThoughtStore: WeightedThoughtStorePort | null | undefined;
  llmProvider: LLMProviderPort;
  companionName: string;
  heartbeatChannelId: string | undefined;
  contactStore: ContactStorePort;
  concernStore: WeightedThoughtContradictionDamperDeps['concernStore'];
  icpWeightedThoughtCandidateAdapter: ReturnType<typeof wireIcpInitiationSources>['weightedThoughtCandidateAdapter'];
}

export function registerWeightedThoughtOutreachLane(deps: WeightedThoughtOutreachLaneDeps): void {
  const {
    scheduler,
    schedulerConfig,
    eventBus,
    weightedThoughtStore,
    llmProvider,
    companionName,
    heartbeatChannelId,
    contactStore,
    concernStore,
    icpWeightedThoughtCandidateAdapter,
  } = deps;

  if (weightedThoughtStore) {
    registerWeightedThoughtOutreachTask({
      scheduler,
      eventBus,
      config: schedulerConfig.weightedThoughtOutreach,
      quietHours: schedulerConfig.episodicProcessing,
      store: weightedThoughtStore,
      nudgeEvaluator: createLlmNudgeEvaluator({
        llmProvider,
        characterName: companionName,
      }),
      ...(icpWeightedThoughtCandidateAdapter
        ? { icpCandidateAdapter: icpWeightedThoughtCandidateAdapter }
        : {}),
      channelPolicy: {
        ...(heartbeatChannelId ? { primaryChannelId: heartbeatChannelId } : {}),
        primaryChannelType: 'discord',
      },
      // Evaluate the quiet-hours gate in the recipient's timezone (2tli).
      resolveContactTimeZone: async contactId => (
        (await contactStore.getById(contactId))?.timezone ?? null
      ),
    });
    // ── Charter Law 27 contradiction dampening (g1v99) ──
    // "Said fine but context suggests otherwise should reduce weight rather than
    // zero it out." When a care concern resolves while its resolution VAD still
    // signals non-positive affect with no genuine relief, the surface closure and
    // the affective signals disagree; the resolving contact's active weighted
    // thoughts are dampened (reduced, never zeroed) so they defer yet persist.
    // Subscribes to the same resolution-appraisal event the arc recorder uses.
    eventBus.on(
      'intention.concern.resolution_appraisal',
      createWeightedThoughtContradictionDamper({
        concernStore,
        thoughtStore: weightedThoughtStore,
        lifecycleConfig: schedulerConfig.weightedThoughtOutreach.lifecycle,
      }),
    );
  } else if (schedulerConfig.weightedThoughtOutreach.enabled) {
    throw new Error(
      'scheduler.json weightedThoughtOutreach.enabled is true but no weighted-thought store is composed; '
      + 'refusing to boot an outreach lane whose durable source state is unavailable',
    );
  }
}
