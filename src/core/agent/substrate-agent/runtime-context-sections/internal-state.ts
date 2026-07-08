// ── Internal-state section producer (E2.6) ──
// The runtime_internal_state_* variable group plus the label helpers that map
// scalar internal-state readings to prompt-facing words, and the emotion
// snapshot projection used by the affect producer.

import type { EmotionStateSnapshot } from '../../../emotion/state.js';
import type { InternalState } from '../../../self-model/state.js';

function describeValence(value: number): string {
  if (value >= 0.45) return 'positive';
  if (value >= 0.15) return 'warm';
  if (value <= -0.45) return 'heavy';
  if (value <= -0.15) return 'strained';
  return 'steady';
}

function describeArousal(value: number): string {
  if (value >= 0.55) return 'high-energy';
  if (value >= 0.2) return 'engaged';
  if (value <= -0.2) return 'quiet';
  return 'calm';
}

function describeCertainty(value: number): string {
  if (value >= 0.75) return 'confident';
  if (value >= 0.45) return 'steady';
  return 'tentative';
}

function describeInteractionFrequency(value: number): string {
  if (value >= 0.75) return 'very frequent';
  if (value >= 0.4) return 'frequent';
  if (value > 0) return 'occasional';
  return 'new or infrequent';
}

function describeLastSeenRecency(lastSeenDeltaSeconds: number | null | undefined): string {
  if (lastSeenDeltaSeconds == null) return 'unknown recency';
  if (lastSeenDeltaSeconds <= 300) return 'just interacted';
  if (lastSeenDeltaSeconds <= 3_600) return 'recently interacted';
  return 'not recently seen';
}

function resolveTopEmotionNames(
  discrete: Record<string, number>,
  max = 2,
): string[] {
  return Object.entries(discrete)
    .filter(([emotion, score]) => emotion !== 'neutral' && score >= 0.15)
    .sort((left, right) => right[1] - left[1])
    .slice(0, max)
    .map(([emotion]) => emotion);
}

// Bare degraded-telemetry values (E2.5 purity rule): status and reasons are
// data; any cautionary wording belongs in editable layer text.
function resolveEmotionTelemetryPromptValues(internalState: InternalState): {
  status: string;
  reasons: string;
} {
  const telemetry = (internalState.emotional as {
    telemetry?: InternalState['emotional']['telemetry'];
  }).telemetry;
  if (!telemetry || telemetry.status === 'trusted') {
    return { status: '', reasons: '' };
  }
  return {
    status: telemetry.status,
    reasons: telemetry.reasons.length > 0 ? telemetry.reasons.join(', ') : 'uncalibrated',
  };
}

export function buildInternalStatePromptVariables(internalState?: InternalState): Record<string, string> {
  const emptyInternalStateVariables = {
    runtime_internal_state_present: 'false',
    runtime_internal_state_cognitive_processing_quality: '',
    runtime_internal_state_cognitive_certainty_label: '',
    runtime_internal_state_cognitive_topic_engagement_label: '',
    runtime_internal_state_attention_conversation_trajectory: '',
    runtime_internal_state_attention_active_concern_count: '',
    runtime_internal_state_attention_active_concern_plural_suffix: '',
    runtime_internal_state_attention_pending_follow_up_count: '',
    runtime_internal_state_attention_pending_follow_up_plural_suffix: '',
    runtime_internal_state_relational_trust_level: '',
    runtime_internal_state_relational_recent_interaction_frequency_label: '',
    runtime_internal_state_relational_last_seen_label: '',
    runtime_internal_state_emotional_mood_valence_label: '',
    runtime_internal_state_emotional_mood_arousal_label: '',
    runtime_internal_state_emotional_secondary_emotions: '',
    runtime_internal_state_emotional_telemetry_status: '',
    runtime_internal_state_emotional_telemetry_reasons: '',
  } satisfies Record<string, string>;

  if (!internalState) {
    return emptyInternalStateVariables;
  }

  const pendingFollowUps = internalState.attention.pendingFollowUps ?? [];
  const secondaryEmotions = resolveTopEmotionNames(internalState.emotional.discreteEmotions);
  const emotionTelemetry = resolveEmotionTelemetryPromptValues(internalState);
  return {
    runtime_internal_state_present: 'true',
    runtime_internal_state_cognitive_processing_quality: internalState.cognitive.processingQuality,
    runtime_internal_state_cognitive_certainty_label: describeCertainty(internalState.cognitive.certaintyLevel),
    runtime_internal_state_cognitive_topic_engagement_label: describeArousal(internalState.cognitive.topicEngagement),
    runtime_internal_state_attention_conversation_trajectory: internalState.attention.conversationTrajectory,
    runtime_internal_state_attention_active_concern_count: String(internalState.attention.activeConcerns.length),
    runtime_internal_state_attention_active_concern_plural_suffix: internalState.attention.activeConcerns.length === 1 ? '' : 's',
    runtime_internal_state_attention_pending_follow_up_count: String(pendingFollowUps.length),
    runtime_internal_state_attention_pending_follow_up_plural_suffix: pendingFollowUps.length === 1 ? '' : 's',
    runtime_internal_state_relational_trust_level: internalState.relational.trustLevel,
    runtime_internal_state_relational_recent_interaction_frequency_label: describeInteractionFrequency(
      internalState.relational.recentInteractionFrequency,
    ),
    runtime_internal_state_relational_last_seen_label: describeLastSeenRecency(internalState.relational.lastSeenDeltaSeconds),
    runtime_internal_state_emotional_mood_valence_label: describeValence(internalState.emotional.mood.valence),
    runtime_internal_state_emotional_mood_arousal_label: describeArousal(internalState.emotional.mood.arousal),
    runtime_internal_state_emotional_secondary_emotions: secondaryEmotions.join(', '),
    runtime_internal_state_emotional_telemetry_status: emotionTelemetry.status,
    runtime_internal_state_emotional_telemetry_reasons: emotionTelemetry.reasons,
  };
}

export function toEmotionSnapshotFromInternalState(internalState: InternalState): EmotionStateSnapshot {
  return {
    vad: { ...internalState.emotional.vad },
    mood: { ...internalState.emotional.mood },
    discrete: { ...internalState.emotional.discreteEmotions },
    confidence: internalState.emotional.confidence,
  };
}
