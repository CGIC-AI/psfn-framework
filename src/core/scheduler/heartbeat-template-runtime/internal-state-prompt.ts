import type { ReflectionTemplate } from '../heartbeat-policy.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  type InternalState,
} from '../../self-model/state.js';
import {
  describeArousal,
  describeDominance,
  describeElapsed,
  describeMoodDrift,
  describeSignedValence,
  describeUnitBand,
  formatAcacCompanionSummary,
  formatEmotionTelemetryValidationForReflection,
  formatInternalStateInterpretationBoundary,
  formatInternalStateTopEmotions,
  formatMetacognitiveFlagForPrompt,
  truncateForReflectionEvidence,
  type ReflectionInternalStateContext,
  type ReflectionMetacognitiveFlag,
  type ReflectionPromptSectionBundle,
} from './prompt-formatting.js';

export interface ResolveInternalStateContextInput {
  template: ReflectionTemplate;
  currentInternalState: InternalState | null | undefined;
  currentInternalStateSnapshotRef: unknown;
  currentMetacognitiveFlags: unknown;
  latestMetacognitiveFlags: ReflectionMetacognitiveFlag[];
}

export interface ResolveInternalStateContextResult {
  context: ReflectionInternalStateContext | null;
  latestMetacognitiveFlags: ReflectionMetacognitiveFlag[];
}

export function normalizeMetacognitiveFlags(
  value: unknown,
  context: string,
): ReflectionMetacognitiveFlag[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array when provided`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${context}[${String(index)}] must be an object`);
    }
    const flagRaw = (entry as { flag?: unknown }).flag;
    if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
      throw new Error(`${context}[${String(index)}].flag must be a non-empty string`);
    }
    const confidenceRaw = (entry as { confidence?: unknown }).confidence;
    if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
      throw new Error(`${context}[${String(index)}].confidence must be a finite number in [0, 1]`);
    }
    const evidenceRaw = (entry as { evidence?: unknown }).evidence;
    if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
      throw new Error(`${context}[${String(index)}].evidence must be a non-empty string when provided`);
    }
    return {
      flag: flagRaw.trim(),
      confidence: Number(confidenceRaw.toFixed(4)),
      ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
    };
  });
}

export function normalizeSnapshotRef(value: unknown, fieldName: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string when provided`);
  }
  return value.trim();
}

export function resolveInternalStateContext(
  input: ResolveInternalStateContextInput,
): ResolveInternalStateContextResult {
  const { latestMetacognitiveFlags, template } = input;
  if (!template.internalStateInput) {
    return {
      context: null,
      latestMetacognitiveFlags,
    };
  }

  const currentInternalState = input.currentInternalState;
  if (!currentInternalState) {
    throw new Error(`Template "${template.id}" requires InternalState input, but no InternalState snapshot is available`);
  }

  const normalizedState = cloneInternalState(currentInternalState);
  const providedSnapshotRef = normalizeSnapshotRef(
    input.currentInternalStateSnapshotRef,
    'getCurrentInternalStateSnapshotRef result',
  );
  const snapshotRef = providedSnapshotRef ?? buildInternalStateSnapshotRef(normalizedState);
  const rawMetacognitiveFlags = input.currentMetacognitiveFlags;
  const metacognitiveFlags = rawMetacognitiveFlags !== undefined
    ? normalizeMetacognitiveFlags(rawMetacognitiveFlags, 'getCurrentMetacognitiveFlags result')
    : latestMetacognitiveFlags;

  return {
    context: {
      internalState: normalizedState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
      snapshotSource: providedSnapshotRef ? 'runtime' : 'derived_runtime',
    },
    latestMetacognitiveFlags: metacognitiveFlags,
  };
}

export function formatInternalStateContextBlock(
  context: ReflectionInternalStateContext | null,
): string | null {
  if (!context) {
    return null;
  }

  const state = context.internalState;
  const concerns = state.attention.activeConcerns
    .slice(0, 12)
    .map((concern) => {
      const expiresAt = Number.isNaN(Date.parse(concern.expiresAt))
        ? ''
        : `; revisit before ${new Date(concern.expiresAt).toISOString()}`;
      return `- ${concern.priority} priority from ${concern.source}: ${truncateForReflectionEvidence(concern.text)}${expiresAt}`;
    });
  const concernSection = concerns.length > 0
    ? concerns.join('\n')
    : '- no active concerns are exposed right now.';
  const followUps = (state.attention.pendingFollowUps ?? [])
    .slice(0, 6)
    .map((followUp) => {
      const dueAt = followUp.dueAt ? `; due ${new Date(followUp.dueAt).toISOString()}` : '';
      return `- ${followUp.priority}/${followUp.timing}: ${truncateForReflectionEvidence(followUp.content)}${dueAt}`;
    });
  const followUpSection = followUps.length > 0
    ? followUps.join('\n')
    : '- no pending follow-ups are exposed right now.';
  const reminders = (state.attention.careReminders ?? [])
    .slice(0, 4)
    .map((reminder) => `- ${reminder.classification}: ${truncateForReflectionEvidence(reminder.title)} (${reminder.status})`);
  const reminderSection = reminders.length > 0
    ? reminders.join('\n')
    : '- no care reminders are exposed right now.';
  const metacognitiveSection = context.metacognitiveFlags.length > 0
    ? context.metacognitiveFlags.map(formatMetacognitiveFlagForPrompt).join('\n')
    : '- no recent metacognitive flags are exposed right now.';

  const acacSummary = formatAcacCompanionSummary(state);
  const trustedEmotionTelemetry = state.emotional.telemetry.status === 'trusted';
  const emotionalClues = trustedEmotionTelemetry
    ? [
      `Current feel appears ${describeSignedValence(state.emotional.vad.valence)}, ${describeArousal(state.emotional.vad.arousal)}, and ${describeDominance(state.emotional.vad.dominance)}.`,
      `Mood trend appears ${describeSignedValence(state.emotional.mood.valence)} and ${describeArousal(state.emotional.mood.arousal)}.`,
      `Discrete emotion clues: ${formatInternalStateTopEmotions(state)}.`,
      `Overall emotion confidence is ${describeUnitBand(state.emotional.confidence, 'strong', 'moderate', 'thin')}; treat it as a clue, not proof.`,
      formatEmotionTelemetryValidationForReflection(state),
      ...(acacSummary ? [acacSummary] : []),
    ]
    : [
      formatEmotionTelemetryValidationForReflection(state),
      state.emotional.telemetry.status === 'suppressed'
        ? 'VAD, mood, and discrete classifier labels were suppressed before reflection use.'
        : 'VAD and mood were downweighted, and discrete classifier labels were withheld before reflection use.',
      `Effective affect clue after validation is ${describeSignedValence(state.emotional.vad.valence)} and ${describeArousal(state.emotional.vad.arousal)}.`,
      ...(acacSummary ? [acacSummary] : []),
    ];
  const cognitiveClues = [
    `Certainty feels ${describeUnitBand(state.cognitive.certaintyLevel, 'settled', 'partial', 'thin')}.`,
    `Topic engagement feels ${describeUnitBand(state.cognitive.topicEngagement, 'high', 'present', 'low')}.`,
    `Processing quality is ${state.cognitive.processingQuality}.`,
    `Conversation trajectory looks ${state.attention.conversationTrajectory}.`,
  ];
  const relationalClues = [
    `Trust scope is ${state.relational.trustLevel}.`,
    `Mood drift is ${describeMoodDrift(state.relational.moodDrift)}.`,
    `Recent interaction frequency is ${describeUnitBand(state.relational.recentInteractionFrequency, 'busy', 'present', 'quiet')}.`,
    `Last seen is ${describeElapsed(state.relational.lastSeenDeltaSeconds)}.`,
  ];
  const salientEntities = state.attention.salientEntities.length > 0
    ? state.attention.salientEntities.slice(0, 8).join(', ')
    : 'none exposed';

  return [
    '[Reflection Self Evidence]',
    formatInternalStateInterpretationBoundary(),
    '[Wellbeing and Affect Clues]',
    emotionalClues.map(line => `- ${line}`).join('\n'),
    '[Cognitive and Attention Clues]',
    cognitiveClues.map(line => `- ${line}`).join('\n'),
    `[Salient Entities]\n- ${salientEntities}`,
    '[Relational Clues]',
    relationalClues.map(line => `- ${line}`).join('\n'),
    '[Recent Metacognitive Flags]',
    metacognitiveSection,
    '[Active Concerns]',
    concernSection,
    '[Pending Follow-Ups]',
    followUpSection,
    '[Care Reminders]',
    reminderSection,
  ].join('\n');
}

export function buildInternalStatePromptBundle(
  context: ReflectionInternalStateContext | null,
): ReflectionPromptSectionBundle | null {
  const block = formatInternalStateContextBlock(context);
  if (!block) {
    return null;
  }

  return {
    self: block,
    relational: '',
    affect: '',
    provenanceRefs: [`internal_state_snapshot:${context?.internalStateSnapshotRef ?? 'unknown'}`],
  };
}
