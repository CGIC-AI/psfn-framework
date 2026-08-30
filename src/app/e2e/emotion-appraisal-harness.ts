import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { InternalState } from '../../core/self-model/state.js';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import type { SessionStore } from '../../persistence/sessions/store.js';
import { EmotionObserver, type TextEmotionClassifierLike } from '../../core/emotion/observer.js';
import { EmotionState, type VADVector } from '../../core/emotion/state.js';
import type { TextEmotionClassification } from '../../core/emotion/text-classifier.js';
import { renderIntakeFirewallNotice } from '../../core/cogsec/intake-firewall-notice-templates.js';
import { RUNTIME_FALLBACK_NOTICE_TEMPLATES } from '../../shared/runtime-fallback-provenance.js';
import { buildSessionMetadataWithRuntimeFallbackProvenance } from '../../core/session/runtime-fallback-provenance.js';
import { selectEmotionAppraisalSourceEntries } from '../../core/agent/substrate-agent/emotion-self-model-runtime.js';

type E2EAssert = (condition: boolean, label: string, detail?: string) => void;

interface MechanicalEmotionAssertionOptions {
  agentLoop: Pick<SubstrateAgent, 'getCurrentInternalState' | 'handleMessage'>;
  assert: E2EAssert;
  channelId: string;
  sessionStore: SessionStore;
}

/**
 * Exact scripted stimuli used by the flagship E2E. The classifier below keys
 * on the whole text so incidental wording in unrelated E2E turns cannot make
 * the emotion assertions drift across runs.
 */
const SCRIPTED_E2E_EMOTION_STIMULI = Object.freeze({
  positive:
    'Emotion check: I am genuinely delighted and hopeful because the difficult repair worked.',
  negative:
    'Emotion check: I am deeply sad and frightened because the repaired system failed again.',
});

const SCRIPTED_CLASSIFICATIONS = Object.freeze({
  positive: Object.freeze([
    Object.freeze({ label: 'joy', score: 0.65 }),
  ]),
  negative: Object.freeze([
    Object.freeze({ label: 'sadness', score: 0.95 }),
  ]),
  neutral: Object.freeze([
    Object.freeze({ label: 'neutral', score: 1 }),
  ]),
} satisfies Record<string, readonly Readonly<TextEmotionClassification>[]>);

function copyClassifications(
  classifications: readonly Readonly<TextEmotionClassification>[],
): TextEmotionClassification[] {
  return classifications.map(classification => ({ ...classification }));
}

function createScriptedE2EEmotionClassifier(): TextEmotionClassifierLike {
  return {
    classify: async (text) => {
      if (text === SCRIPTED_E2E_EMOTION_STIMULI.positive) {
        return copyClassifications(SCRIPTED_CLASSIFICATIONS.positive);
      }
      if (text === SCRIPTED_E2E_EMOTION_STIMULI.negative) {
        return copyClassifications(SCRIPTED_CLASSIFICATIONS.negative);
      }
      return copyClassifications(SCRIPTED_CLASSIFICATIONS.neutral);
    },
  };
}

/**
 * Production EmotionState/EmotionObserver with only their external classifier
 * boundary scripted, mirroring the flagship harness's scripted LLM boundary.
 */
export function createScriptedE2EEmotionRuntime(): {
  state: EmotionState;
  observer: EmotionObserver;
  requireWiring: true;
} {
  return {
    state: new EmotionState(),
    observer: new EmotionObserver({
      textClassifier: createScriptedE2EEmotionClassifier(),
    }),
    requireWiring: true,
  };
}

function makeEmotionMessage(channelId: string, content: string, id: string): SubstrateMessage {
  return {
    id,
    channelId,
    channelType: 'terminal',
    authorId: 'primary-user',
    authorName: 'PrimaryUser',
    content,
    timestamp: new Date(),
  };
}

function assertBoundedVAD(assert: E2EAssert, vad: VADVector, label: string): void {
  for (const [axis, value] of Object.entries(vad)) {
    assert(
      Number.isFinite(value) && value >= -1 && value <= 1,
      `${label} ${axis} stays within [-1, 1]`,
      String(value),
    );
  }
}

function requireLiveInternalState(
  assert: E2EAssert,
  state: InternalState | null,
  label: string,
): InternalState {
  assert(state !== null, label);
  if (!state) throw new Error(label);
  return state;
}

/** Run the mechanical appraisal floor through the real composed agent. */
export async function runMechanicalEmotionAppraisalAssertions(
  options: MechanicalEmotionAssertionOptions,
): Promise<void> {
  const { agentLoop, assert, channelId, sessionStore } = options;
  const baseline = requireLiveInternalState(
    assert,
    agentLoop.getCurrentInternalState(),
    'Baseline live internal emotion state is available',
  ).emotional;

  const positiveResponse = await agentLoop.handleMessage(makeEmotionMessage(
    channelId,
    SCRIPTED_E2E_EMOTION_STIMULI.positive,
    'e2e-emotion-positive',
  ));
  const positive = requireLiveInternalState(
    assert,
    positiveResponse.metadata.internalState ?? null,
    'Positive turn exposes live internal emotion state',
  ).emotional;
  const positiveValenceDelta = positive.vad.valence - baseline.vad.valence;

  assert(
    positiveValenceDelta > 0 && positiveValenceDelta <= 1,
    'Positive scripted turn moves valence upward by a bounded amount',
    String(positiveValenceDelta),
  );
  assert(
    positive.vad.arousal > baseline.vad.arousal,
    'Positive scripted turn moves arousal upward',
    `${String(baseline.vad.arousal)} -> ${String(positive.vad.arousal)}`,
  );
  assertBoundedVAD(assert, positive.vad, 'Positive turn VAD');
  assertBoundedVAD(assert, positive.mood, 'Positive turn mood');

  const negativeResponse = await agentLoop.handleMessage(makeEmotionMessage(
    channelId,
    SCRIPTED_E2E_EMOTION_STIMULI.negative,
    'e2e-emotion-negative',
  ));
  const negative = requireLiveInternalState(
    assert,
    negativeResponse.metadata.internalState ?? null,
    'Negative turn exposes live internal emotion state',
  ).emotional;
  const negativeValenceDelta = negative.vad.valence - positive.vad.valence;

  assert(
    negativeValenceDelta < 0 && negativeValenceDelta >= -2,
    'Negative scripted turn moves valence downward by a bounded amount',
    String(negativeValenceDelta),
  );
  assert(
    negative.vad.valence < baseline.vad.valence,
    'Negative scripted turn crosses below the neutral baseline',
    `${String(baseline.vad.valence)} -> ${String(negative.vad.valence)}`,
  );
  assertBoundedVAD(assert, negative.vad, 'Negative turn VAD');
  assertBoundedVAD(assert, negative.mood, 'Negative turn mood');

  const appraisalBaseline = sessionStore.getRecent(channelId, 4);
  const latestEntryId = appraisalBaseline.reduce(
    (latest, entry) => Math.max(latest, entry.id),
    0,
  );
  const noticeTimestamp = Date.now();
  const appraisalWithNotices = [
    ...appraisalBaseline,
    {
      id: latestEntryId + 1,
      channelId,
      role: 'system' as const,
      content: renderIntakeFirewallNotice(1),
      timestamp: noticeTimestamp,
    },
    {
      id: latestEntryId + 2,
      channelId,
      role: 'assistant' as const,
      content: RUNTIME_FALLBACK_NOTICE_TEMPLATES.visionUnavailableImageOnly,
      timestamp: noticeTimestamp + 1,
      metadata: buildSessionMetadataWithRuntimeFallbackProvenance(undefined, {
        schemaVersion: 1,
        authoredBy: 'runtime',
        model: 'runtime-fallback',
        strategy: 'runtime_nonfabricating_notice',
      }),
    },
  ];
  const baselineAppraisalInput = selectEmotionAppraisalSourceEntries(appraisalBaseline);
  const noticeAppraisalInput = selectEmotionAppraisalSourceEntries(appraisalWithNotices);

  assert(
    JSON.stringify(noticeAppraisalInput) === JSON.stringify(baselineAppraisalInput),
    'Firewall and runtime-fallback notices contribute zero appraisal-input delta',
  );
}
