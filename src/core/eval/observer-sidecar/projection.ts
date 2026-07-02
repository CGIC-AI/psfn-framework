import type { EmotionStateSnapshot } from '../../emotion/state.js';
import { isRecord } from '../../../shared/utils/types.js';
import type {
  EmoSimAdapterInput,
  EmoSimAppraisalDimension,
  EmoSimAppraisalVector,
  EmoSimProjectedStimulus,
  EmoSimSubject,
  EmoSimTimestepPolicy,
} from './emosim-adapter.js';
import {
  EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
  EMOSIM_APPRAISAL_DIMS,
  EMOSIM_SNAPSHOT_FORMAT,
  EMOSIM_TIMESTEP_POLICY,
} from './emosim-adapter.js';
import {
  sanitizeObserverEvalInput,
  type ObserverEvalPrivacyClass,
  type ObserverEvalPrivacyDecision,
  type ObserverEvalSanitizedInputPayload,
} from './privacy.js';
import type { ObserverEvalInputPayload } from './types.js';

export const OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION = 1 as const;
export const OBSERVER_APPRAISAL_PROJECTION_VERSION =
  'psfn.observer-sidecar.appraisal-projection.v1' as const;
export const OBSERVER_APPRAISAL_PROJECTION_CAVEAT =
  'Projection is observer-derived eval telemetry, not ground truth and not live companion state.' as const;

export type ObserverAppraisalProjectionSource = 'observer-derived' | 'direct-fixture-appraisal';

export type ObserverProjectionFeatureSource =
  | 'observer-emotion-snapshot'
  | 'observer-turn-metadata'
  | 'observer-source-metadata'
  | 'observer-privacy-decision'
  | 'direct-fixture-appraisal';

export type ObserverProjectionMissingFeatureReason =
  | 'emotion_snapshot_missing'
  | 'emotion_snapshot_redacted'
  | 'emotion_confidence_missing'
  | 'emotion_discrete_empty'
  | 'appraisal_chain_empty'
  | 'content_length_empty'
  | 'contact_unresolved'
  | 'channel_privacy_missing'
  | 'sensitivity_missing'
  | 'derived_telemetry_not_permitted';

export type ObserverProjectionMissingFeatureSeverity = 'info' | 'warning' | 'blocking';

export interface ObserverProjectionMissingFeature {
  feature: string;
  reason: ObserverProjectionMissingFeatureReason;
  severity: ObserverProjectionMissingFeatureSeverity;
  detail: string;
}

export interface ObserverProjectionFeatureProvenance {
  feature: string;
  source: ObserverProjectionFeatureSource;
  path: string;
  confidence: number;
  privacyClass: ObserverEvalPrivacyClass;
  sensitivity: ObserverEvalPrivacyDecision['sensitivity'];
  caveat?: string;
}

export interface ObserverProjectedAppraisalDimension {
  dimension: EmoSimAppraisalDimension;
  value: number;
  confidence: number;
  provenance: readonly ObserverProjectionFeatureProvenance[];
  caveats: readonly string[];
}

export interface ObserverProjectedAppraisalInput {
  schemaVersion: typeof OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION;
  projectionVersion: typeof OBSERVER_APPRAISAL_PROJECTION_VERSION;
  source: ObserverAppraisalProjectionSource;
  dimensions: EmoSimAppraisalVector;
  dimensionProvenance: Record<EmoSimAppraisalDimension, ObserverProjectedAppraisalDimension>;
  confidence: number;
  missingInputs: readonly ObserverProjectionMissingFeature[];
  sensitivity: ObserverEvalPrivacyDecision['sensitivity'];
  privacyClass: ObserverEvalPrivacyClass;
  caveats: readonly string[];
}

export type ObserverAppraisalProjectionErrorReason =
  | 'privacy-derived-telemetry-unavailable'
  | 'invalid-direct-fixture-appraisal';

export interface ObserverAppraisalProjectionError {
  code: 'projection-unavailable' | 'invalid-direct-fixture-appraisal';
  reason: ObserverAppraisalProjectionErrorReason;
  message: string;
  recoverable: true;
  details?: Record<string, boolean | number | string | null>;
}

export interface ObserverDirectFixtureAppraisalInput {
  appraisal: EmoSimAppraisalVector;
  confidence?: number;
  label?: string;
}

export interface ObserverAppraisalProjectionOptions {
  runId?: string;
  subject?: EmoSimSubject;
  directFixtureAppraisal?: ObserverDirectFixtureAppraisalInput;
  includeWorldState?: boolean;
}

export interface ObserverAppraisalProjectionBase {
  schemaVersion: typeof OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION;
  projectionVersion: typeof OBSERVER_APPRAISAL_PROJECTION_VERSION;
  source: ObserverAppraisalProjectionSource;
  sanitizedInput: ObserverEvalSanitizedInputPayload;
  privacy: ObserverEvalPrivacyDecision;
  confidence: number;
  missingInputs: readonly ObserverProjectionMissingFeature[];
  caveats: readonly string[];
}

export interface ObserverAppraisalProjectionSuccess extends ObserverAppraisalProjectionBase {
  ok: true;
  projectedAppraisal: ObserverProjectedAppraisalInput;
  projectedStimulus: EmoSimProjectedStimulus;
  adapterInput: EmoSimAdapterInput;
}

export interface ObserverAppraisalProjectionFailure extends ObserverAppraisalProjectionBase {
  ok: false;
  error: ObserverAppraisalProjectionError;
}

export type ObserverAppraisalProjectionResult =
  | ObserverAppraisalProjectionSuccess
  | ObserverAppraisalProjectionFailure;

interface ProjectionSignals {
  snapshot: EmotionStateSnapshot | null;
  hasSnapshot: boolean;
  vad: EmotionStateSnapshot['vad'];
  mood: EmotionStateSnapshot['mood'];
  emotionConfidence: number;
  positiveDiscrete: number;
  negativeDiscrete: number;
  fearDiscrete: number;
  sadnessDiscrete: number;
  concernDiscrete: number;
  angerDiscrete: number;
  loveDiscrete: number;
  noveltyDiscrete: number;
  aestheticDiscrete: number;
  trustScore: number;
  contactScore: number;
  directScore: number;
  privateChannelScore: number;
  contentScale: number;
  attachmentScale: number;
  visionScore: number;
  appraisalChainScore: number;
  metadataCompleteness: number;
  privacyConfidence: number;
}

interface DerivedAppraisal {
  vector: EmoSimAppraisalVector;
  dimensionProvenance: Record<EmoSimAppraisalDimension, ObserverProjectedAppraisalDimension>;
  confidence: number;
}

const SIGNED_APPRAISAL_DIMS = new Set<EmoSimAppraisalDimension>([
  'valence',
  'goal_congruence',
  'certainty',
  'control',
  'fairness',
  'self_norm',
]);

const NEUTRAL_VAD: EmotionStateSnapshot['vad'] = Object.freeze({
  valence: 0,
  arousal: 0,
  dominance: 0,
});

const DEFAULT_SUBJECT: EmoSimSubject = Object.freeze({
  name: 'observer-sidecar',
  uid: 'observer-sidecar-projection',
  personality: Object.freeze({
    O: 0.6,
    C: 0.62,
    E: 0.48,
    A: 0.68,
    N: 0.34,
  }),
});

const DEFAULT_TIMESTEP: EmoSimTimestepPolicy = Object.freeze({
  policy: EMOSIM_TIMESTEP_POLICY,
  tickSeconds: 0.25,
  steps: 4,
});

export function projectObserverEvalToEmoSim(
  input: ObserverEvalInputPayload | ObserverEvalSanitizedInputPayload,
  options: ObserverAppraisalProjectionOptions = {},
): ObserverAppraisalProjectionResult {
  return projectSanitizedObserverEvalToEmoSim(normalizeProjectionInput(input), options);
}

export function projectSanitizedObserverEvalToEmoSim(
  sanitizedInput: ObserverEvalSanitizedInputPayload,
  options: ObserverAppraisalProjectionOptions = {},
): ObserverAppraisalProjectionResult {
  const input = structuredClone(sanitizedInput);
  const source: ObserverAppraisalProjectionSource = options.directFixtureAppraisal
    ? 'direct-fixture-appraisal'
    : 'observer-derived';
  const missingInputs = collectMissingInputs(input);
  const caveats = buildProjectionCaveats(source, input.privacy);

  if (!input.privacy.derivedTelemetryPermitted) {
    return projectionFailure({
      input,
      source,
      confidence: 0,
      missingInputs,
      caveats,
      error: {
        code: 'projection-unavailable',
        reason: 'privacy-derived-telemetry-unavailable',
        message: 'Projection stopped before EmoSim because privacy policy did not permit derived telemetry.',
        recoverable: true,
        details: {
          redactionReason: input.privacy.redactionReason,
          privacyClass: input.privacy.privacyClass,
        },
      },
    });
  }

  const signals = collectProjectionSignals(input);
  const projected = options.directFixtureAppraisal
    ? projectDirectFixtureAppraisal(input, signals, options.directFixtureAppraisal)
    : projectObserverDerivedAppraisal(input, signals);

  if (!projected.ok) {
    return projectionFailure({
      input,
      source,
      confidence: 0,
      missingInputs,
      caveats,
      error: projected.error,
    });
  }

  const projectedAppraisal: ObserverProjectedAppraisalInput = {
    schemaVersion: OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION,
    projectionVersion: OBSERVER_APPRAISAL_PROJECTION_VERSION,
    source,
    dimensions: projected.value.vector,
    dimensionProvenance: projected.value.dimensionProvenance,
    confidence: projected.value.confidence,
    missingInputs,
    sensitivity: input.privacy.sensitivity,
    privacyClass: input.privacy.privacyClass,
    caveats,
  };
  const projectedStimulus = buildProjectedStimulus(
    input,
    signals,
    projectedAppraisal,
    options.directFixtureAppraisal?.label,
  );
  const adapterInput = buildAdapterInput(input, projectedStimulus, options);

  return {
    ok: true,
    schemaVersion: OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION,
    projectionVersion: OBSERVER_APPRAISAL_PROJECTION_VERSION,
    source,
    sanitizedInput: input,
    privacy: input.privacy,
    confidence: projectedAppraisal.confidence,
    missingInputs,
    caveats,
    projectedAppraisal,
    projectedStimulus,
    adapterInput,
  };
}

function normalizeProjectionInput(
  input: ObserverEvalInputPayload | ObserverEvalSanitizedInputPayload,
): ObserverEvalSanitizedInputPayload {
  if (isSanitizedObserverEvalInput(input)) {
    return structuredClone(input);
  }
  return sanitizeObserverEvalInput(input);
}

function isSanitizedObserverEvalInput(
  input: ObserverEvalInputPayload | ObserverEvalSanitizedInputPayload,
): input is ObserverEvalSanitizedInputPayload {
  return isRecord(input) && isRecord(input.privacy);
}

function collectMissingInputs(input: ObserverEvalSanitizedInputPayload): ObserverProjectionMissingFeature[] {
  const missing: ObserverProjectionMissingFeature[] = [];

  if (!input.privacy.derivedTelemetryPermitted) {
    missing.push({
      feature: 'privacy.derivedTelemetryPermitted',
      reason: 'derived_telemetry_not_permitted',
      severity: 'blocking',
      detail: `Privacy decision ${input.privacy.redactionReason} does not permit derived projection telemetry.`,
    });
  }

  if (!input.emotion.snapshot) {
    missing.push({
      feature: 'emotion.snapshot',
      reason: input.emotion.snapshotRedacted ? 'emotion_snapshot_redacted' : 'emotion_snapshot_missing',
      severity: input.privacy.derivedTelemetryPermitted ? 'warning' : 'blocking',
      detail: input.emotion.snapshotRedacted
        ? 'Emotion snapshot was removed by the privacy boundary.'
        : 'No current EmotionState snapshot was available at the observer seam.',
    });
  } else if (input.emotion.snapshot.confidence <= 0) {
    missing.push({
      feature: 'emotion.snapshot.confidence',
      reason: 'emotion_confidence_missing',
      severity: 'warning',
      detail: 'EmotionState snapshot confidence was zero, so appraisal confidence is reduced.',
    });
  }

  if (!input.emotion.snapshot || Object.keys(input.emotion.snapshot.discrete).length === 0) {
    missing.push({
      feature: 'emotion.snapshot.discrete',
      reason: 'emotion_discrete_empty',
      severity: 'info',
      detail: 'No discrete emotion labels were available; projection uses VAD and metadata only.',
    });
  }

  if (input.emotion.appraisalEntryCount <= 0) {
    missing.push({
      feature: 'emotion.appraisalEntryCount',
      reason: 'appraisal_chain_empty',
      severity: 'info',
      detail: 'No upstream appraisal-chain entries were present for this turn.',
    });
  }

  if (input.metadata.contentLength <= 0) {
    missing.push({
      feature: 'metadata.contentLength',
      reason: 'content_length_empty',
      severity: 'info',
      detail: 'Content length was zero, so effort and intensity omit text-size contribution.',
    });
  }

  if (!input.metadata.contactResolved) {
    missing.push({
      feature: 'metadata.contactResolved',
      reason: 'contact_unresolved',
      severity: 'info',
      detail: 'Contact was not resolved; attachment and certainty contributions are lower.',
    });
  }

  if (input.source.channelPrivacy === null) {
    missing.push({
      feature: 'source.channelPrivacy',
      reason: 'channel_privacy_missing',
      severity: 'warning',
      detail: 'Channel privacy was unavailable after sanitization.',
    });
  }

  if (input.privacy.sensitivity === null) {
    missing.push({
      feature: 'privacy.sensitivity',
      reason: 'sensitivity_missing',
      severity: 'warning',
      detail: 'Sensitivity classification was unavailable after sanitization.',
    });
  }

  return missing;
}

function collectProjectionSignals(input: ObserverEvalSanitizedInputPayload): ProjectionSignals {
  const snapshot = input.emotion.snapshot;
  const vad = snapshot?.vad ?? NEUTRAL_VAD;
  const mood = snapshot?.mood ?? NEUTRAL_VAD;
  const emotionConfidence = clampUnit(snapshot?.confidence ?? 0.15);
  const trustScore = trustLevelScore(input.metadata.trustLevel);
  const contactScore = input.metadata.contactResolved ? 1 : 0;
  const directScore = input.source.isDirectMessage ? 1 : 0;
  const privateChannelScore = input.source.channelPrivacy === 'private'
    ? 1
    : input.source.channelPrivacy === 'invite_only'
      ? 0.6
      : 0;

  return {
    snapshot,
    hasSnapshot: Boolean(snapshot),
    vad,
    mood,
    emotionConfidence,
    positiveDiscrete: maxDiscrete(snapshot, ['joy', 'optimism', 'trust', 'satisfaction', 'contentment']),
    negativeDiscrete: maxDiscrete(snapshot, ['sadness', 'anger', 'fear', 'pessimism', 'disgust']),
    fearDiscrete: maxDiscrete(snapshot, ['fear', 'anxiety', 'concern', 'pessimism']),
    sadnessDiscrete: maxDiscrete(snapshot, ['sadness', 'grief', 'disappointment', 'distress']),
    concernDiscrete: maxDiscrete(snapshot, ['concern', 'sympathy', 'empathic pain']),
    angerDiscrete: maxDiscrete(snapshot, ['anger', 'disgust', 'contempt']),
    loveDiscrete: maxDiscrete(snapshot, ['love', 'trust', 'admiration', 'adoration']),
    noveltyDiscrete: maxDiscrete(snapshot, ['surprise', 'curiosity', 'confusion', 'interest']),
    aestheticDiscrete: maxDiscrete(snapshot, ['awe', 'beauty', 'admiration', 'aesthetic appreciation']),
    trustScore,
    contactScore,
    directScore,
    privateChannelScore,
    contentScale: clampUnit(input.metadata.contentLength / 1_200),
    attachmentScale: clampUnit(input.metadata.attachmentCount / 3),
    visionScore: input.metadata.hasVisionInput ? 1 : 0,
    appraisalChainScore: clampUnit(input.emotion.appraisalEntryCount / 3),
    metadataCompleteness: metadataCompleteness(input),
    privacyConfidence: privacyClassConfidence(input.privacy.privacyClass),
  };
}

function projectObserverDerivedAppraisal(
  input: ObserverEvalSanitizedInputPayload,
  signals: ProjectionSignals,
): { ok: true; value: DerivedAppraisal } {
  const confidence = observerDerivedConfidence(signals);
  const valence = clampSigned(
    (signals.vad.valence * 0.65)
      + (signals.mood.valence * 0.2)
      + ((signals.positiveDiscrete - signals.negativeDiscrete) * 0.15),
  );
  const arousalMagnitude = clampUnit(Math.abs(signals.vad.arousal));
  const novelty = clampUnit(
    0.08
      + (arousalMagnitude * 0.28)
      + (signals.noveltyDiscrete * 0.28)
      + (signals.visionScore * 0.14)
      + (signals.attachmentScale * 0.08),
  );
  const threat = clampUnit(
    (Math.max(0, -valence) * 0.38)
      + (signals.fearDiscrete * 0.3)
      + (signals.angerDiscrete * 0.12)
      + ((1 - signals.contactScore) * 0.08)
      + ((1 - signals.trustScore) * 0.06),
  );
  const gain = clampUnit(
    (Math.max(0, valence) * 0.45)
      + (signals.positiveDiscrete * 0.28)
      + (signals.contactScore * 0.06)
      + (signals.trustScore * 0.08),
  );
  const loss = clampUnit(
    (Math.max(0, -signals.vad.valence) * 0.36)
      + (signals.sadnessDiscrete * 0.34)
      + (signals.fearDiscrete * 0.12),
  );

  return {
    ok: true,
    value: buildDerivedAppraisal(input, confidence, {
      valence,
      novelty,
      goal_congruence: clampSigned(
        (valence * 0.62)
          + (signals.vad.dominance * 0.18)
          + (gain * 0.14)
          - (loss * 0.14),
      ),
      certainty: clampSigned(
        ((signals.emotionConfidence * 2 - 1) * 0.62)
          + (signals.appraisalChainScore * 0.18)
          + (signals.contactScore * 0.1)
          - ((signals.hasSnapshot ? 0 : 1) * 0.16),
      ),
      control: clampSigned(
        (signals.vad.dominance * 0.56)
          + (signals.contactScore * 0.12)
          + (input.metadata.speakerRole === 'system' ? 0.08 : 0)
          - (threat * 0.14),
      ),
      agency_self: clampUnit(
        (input.metadata.speakerRole === 'system' ? 0.62 : 0.12)
          + (Math.max(0, signals.vad.dominance) * 0.2),
      ),
      agency_other: clampUnit(
        (input.metadata.speakerRole === 'user' ? 0.68 : 0.18)
          + (signals.contactScore * 0.12)
          + (signals.directScore * 0.05),
      ),
      fairness: clampSigned(
        ((signals.trustScore - 0.5) * 0.42)
          + (valence * 0.28)
          + (signals.contactScore * 0.08)
          - (threat * 0.1),
      ),
      self_norm: clampSigned(
        (input.metadata.speakerRole === 'system' ? 0.28 : 0.04)
          + (Math.max(0, signals.mood.valence) * 0.1)
          - (Math.max(0, -signals.mood.valence) * 0.1),
      ),
      threat,
      loss,
      gain,
      other_suffering: clampUnit(
        (signals.sadnessDiscrete * 0.34)
          + (signals.fearDiscrete * 0.22)
          + (signals.concernDiscrete * 0.34),
      ),
      attachment: clampUnit(
        (signals.directScore * 0.2)
          + (signals.privateChannelScore * 0.1)
          + (signals.trustScore * 0.24)
          + (signals.contactScore * 0.12)
          + (signals.loveDiscrete * 0.28),
      ),
      beauty: clampUnit(
        (signals.visionScore * 0.24)
          + (Math.max(0, valence) * 0.18)
          + (signals.aestheticDiscrete * 0.38),
      ),
      effort: clampUnit(
        (signals.contentScale * 0.34)
          + (signals.attachmentScale * 0.2)
          + (signals.visionScore * 0.14)
          + (arousalMagnitude * 0.2)
          + (signals.appraisalChainScore * 0.08),
      ),
      safety: clampUnit(
        0.34
          + (signals.trustScore * 0.24)
          + (Math.max(signals.directScore, signals.privateChannelScore) * 0.12)
          + (Math.max(0, valence) * 0.18)
          - (threat * 0.3),
      ),
    }, 'observer-derived'),
  };
}

function projectDirectFixtureAppraisal(
  input: ObserverEvalSanitizedInputPayload,
  signals: ProjectionSignals,
  directFixture: ObserverDirectFixtureAppraisalInput,
):
  | { ok: true; value: DerivedAppraisal }
  | { ok: false; error: ObserverAppraisalProjectionError } {
  const normalized = normalizeDirectFixtureAppraisal(directFixture.appraisal);
  if (!normalized.ok) {
    return {
      ok: false,
      error: {
        code: 'invalid-direct-fixture-appraisal',
        reason: 'invalid-direct-fixture-appraisal',
        message: normalized.message,
        recoverable: true,
      },
    };
  }

  const fixtureConfidence = clampUnit(directFixture.confidence ?? 1);
  const confidence = clampUnit(
    (fixtureConfidence * 0.86)
      + (signals.metadataCompleteness * 0.08)
      + (signals.privacyConfidence * 0.06),
  );

  return {
    ok: true,
    value: buildDerivedAppraisal(input, confidence, normalized.appraisal, 'direct-fixture-appraisal'),
  };
}

function buildDerivedAppraisal(
  input: ObserverEvalSanitizedInputPayload,
  confidence: number,
  vector: EmoSimAppraisalVector,
  source: ObserverAppraisalProjectionSource,
): DerivedAppraisal {
  const dimensionProvenance = {} as Record<EmoSimAppraisalDimension, ObserverProjectedAppraisalDimension>;
  for (const dimension of EMOSIM_APPRAISAL_DIMS) {
    dimensionProvenance[dimension] = {
      dimension,
      value: vector[dimension],
      confidence,
      provenance: source === 'direct-fixture-appraisal'
        ? [
            provenance(input, {
              feature: `appraisal.${dimension}`,
              source: 'direct-fixture-appraisal',
              path: 'options.directFixtureAppraisal.appraisal',
              confidence,
              caveat: 'Direct fixture appraisal is explicit eval input and bypasses observer-derived heuristics.',
            }),
          ]
        : provenanceForDimension(input, dimension, confidence),
      caveats: source === 'direct-fixture-appraisal'
        ? [
            OBSERVER_APPRAISAL_PROJECTION_CAVEAT,
            'Direct fixture appraisal is only for tests and eval fixtures.',
          ]
        : [OBSERVER_APPRAISAL_PROJECTION_CAVEAT],
    };
  }
  return { vector, dimensionProvenance, confidence };
}

function provenanceForDimension(
  input: ObserverEvalSanitizedInputPayload,
  dimension: EmoSimAppraisalDimension,
  confidence: number,
): readonly ObserverProjectionFeatureProvenance[] {
  const snapshotFeature = provenance(input, {
    feature: 'current EmotionState snapshot',
    source: 'observer-emotion-snapshot',
    path: 'emotion.snapshot',
    confidence,
  });
  const metadataFeature = provenance(input, {
    feature: 'safe turn metadata',
    source: 'observer-turn-metadata',
    path: 'metadata',
    confidence,
  });
  const sourceFeature = provenance(input, {
    feature: 'channel and direct-message metadata',
    source: 'observer-source-metadata',
    path: 'source',
    confidence,
  });
  const privacyFeature = provenance(input, {
    feature: 'privacy decision',
    source: 'observer-privacy-decision',
    path: 'privacy',
    confidence,
    caveat: 'Privacy class is used only to gate and qualify projection confidence.',
  });

  switch (dimension) {
    case 'valence':
    case 'goal_congruence':
    case 'loss':
    case 'gain':
    case 'threat':
    case 'other_suffering':
      return [snapshotFeature, metadataFeature, privacyFeature];
    case 'novelty':
    case 'beauty':
    case 'effort':
      return [snapshotFeature, metadataFeature, sourceFeature, privacyFeature];
    case 'certainty':
    case 'control':
    case 'fairness':
    case 'agency_self':
    case 'agency_other':
    case 'self_norm':
    case 'attachment':
    case 'safety':
      return [snapshotFeature, metadataFeature, sourceFeature, privacyFeature];
  }
}

function provenance(
  input: ObserverEvalSanitizedInputPayload,
  fields: Omit<ObserverProjectionFeatureProvenance, 'privacyClass' | 'sensitivity'>,
): ObserverProjectionFeatureProvenance {
  return {
    ...fields,
    privacyClass: input.privacy.privacyClass,
    sensitivity: input.privacy.sensitivity,
  };
}

function buildProjectedStimulus(
  input: ObserverEvalSanitizedInputPayload,
  signals: ProjectionSignals,
  appraisal: ObserverProjectedAppraisalInput,
  fixtureLabel: string | undefined,
): EmoSimProjectedStimulus {
  const label = fixtureLabel?.trim()
    || `observer ${input.metadata.speakerRole} turn via ${input.turn.channelType}`;
  const emotionMagnitude = signals.hasSnapshot ? vadMagnitude(signals.vad) : 0;
  const metadataMagnitude = Math.max(signals.contentScale, signals.attachmentScale, signals.visionScore);
  return {
    label,
    intensity: clamp(0.18 + (emotionMagnitude * 0.9) + (metadataMagnitude * 0.45), 0, 2),
    importance: clampUnit(
      0.18
        + (appraisal.confidence * 0.22)
        + (signals.trustScore * 0.18)
        + (signals.contactScore * 0.1)
        + (signals.directScore * 0.1)
        + (signals.attachmentScale * 0.1)
        + (Math.abs(appraisal.dimensions.valence) * 0.12),
    ),
    projection: {
      schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
      source: OBSERVER_APPRAISAL_PROJECTION_VERSION,
      traceId: input.turn.turnId,
    },
    appraisal: appraisal.dimensions,
  };
}

function buildAdapterInput(
  input: ObserverEvalSanitizedInputPayload,
  stimulus: EmoSimProjectedStimulus,
  options: ObserverAppraisalProjectionOptions,
): EmoSimAdapterInput {
  const observedAt = new Date(safeTimestamp(input.provenance.capturedAt)).toISOString();
  return {
    schemaVersion: EMOSIM_ADAPTER_INPUT_SCHEMA_VERSION,
    runId: options.runId?.trim() || `observer-sidecar:${input.turn.turnId}`,
    subject: options.subject ? structuredClone(options.subject) : structuredClone(DEFAULT_SUBJECT),
    stimulus,
    timestep: DEFAULT_TIMESTEP,
    deterministic: {
      seed: `observer-sidecar:${input.turn.turnId}:${input.provenance.capturedAt}`,
      clock0Seconds: secondsSinceUtcMidnight(input.provenance.capturedAt),
      observedAt,
      disableDrives: true,
    },
    snapshot: {
      format: EMOSIM_SNAPSHOT_FORMAT,
      fullEmotionVector: true,
      includeWorldState: options.includeWorldState ?? true,
      precision: 6,
    },
  };
}

function projectionFailure(input: {
  input: ObserverEvalSanitizedInputPayload;
  source: ObserverAppraisalProjectionSource;
  confidence: number;
  missingInputs: readonly ObserverProjectionMissingFeature[];
  caveats: readonly string[];
  error: ObserverAppraisalProjectionError;
}): ObserverAppraisalProjectionFailure {
  return {
    ok: false,
    schemaVersion: OBSERVER_APPRAISAL_PROJECTION_SCHEMA_VERSION,
    projectionVersion: OBSERVER_APPRAISAL_PROJECTION_VERSION,
    source: input.source,
    sanitizedInput: input.input,
    privacy: input.input.privacy,
    confidence: input.confidence,
    missingInputs: input.missingInputs,
    caveats: input.caveats,
    error: input.error,
  };
}

function buildProjectionCaveats(
  source: ObserverAppraisalProjectionSource,
  privacy: ObserverEvalPrivacyDecision,
): readonly string[] {
  const caveats = [
    OBSERVER_APPRAISAL_PROJECTION_CAVEAT,
    'Raw text, raw message identifiers, and raw channel identifiers are excluded from projection inputs.',
    `Sensitivity=${privacy.sensitivity ?? 'unknown'} privacyClass=${privacy.privacyClass}.`,
  ];
  if (source === 'direct-fixture-appraisal') {
    caveats.push('Direct fixture appraisal is explicit eval input, not inferred live appraisal.');
  }
  return caveats;
}

function observerDerivedConfidence(signals: ProjectionSignals): number {
  return clampUnit(
    (signals.emotionConfidence * 0.45)
      + ((signals.hasSnapshot ? 1 : 0) * 0.25)
      + (signals.metadataCompleteness * 0.2)
      + (signals.privacyConfidence * 0.1),
  );
}

function metadataCompleteness(input: ObserverEvalSanitizedInputPayload): number {
  let score = 0;
  score += input.source.channelPrivacy ? 0.2 : 0;
  score += input.privacy.sensitivity ? 0.2 : 0;
  score += input.metadata.contactResolved ? 0.15 : 0;
  score += input.metadata.contentLength > 0 ? 0.15 : 0;
  score += input.emotion.appraisalEntryCount > 0 ? 0.15 : 0;
  score += 0.15;
  return clampUnit(score);
}

function privacyClassConfidence(privacyClass: ObserverEvalPrivacyClass): number {
  switch (privacyClass) {
    case 'public':
      return 1;
    case 'restricted':
      return 0.86;
    case 'private':
      return 0.82;
    case 'closed':
      return 0.72;
    case 'fail_closed':
      return 0;
  }
}

function trustLevelScore(trustLevel: ObserverEvalSanitizedInputPayload['metadata']['trustLevel']): number {
  switch (trustLevel) {
    case 'primary':
      return 1;
    case 'trusted':
      return 0.76;
    case 'regular':
      return 0.48;
    case 'public':
      return 0.24;
  }
}

function normalizeDirectFixtureAppraisal(value: unknown):
  | { ok: true; appraisal: EmoSimAppraisalVector }
  | { ok: false; message: string } {
  if (!isRecord(value)) {
    return { ok: false, message: 'Direct fixture appraisal must be an object.' };
  }

  const expected = new Set<string>(EMOSIM_APPRAISAL_DIMS);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      return { ok: false, message: `Direct fixture appraisal dimension ${key} is not supported.` };
    }
  }

  const appraisal = {} as Partial<EmoSimAppraisalVector>;
  for (const dimension of EMOSIM_APPRAISAL_DIMS) {
    if (!Object.prototype.hasOwnProperty.call(value, dimension)) {
      return { ok: false, message: `Direct fixture appraisal dimension ${dimension} is required.` };
    }
    const raw = value[dimension];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { ok: false, message: `Direct fixture appraisal dimension ${dimension} must be a finite number.` };
    }
    const min = SIGNED_APPRAISAL_DIMS.has(dimension) ? -1 : 0;
    if (raw < min || raw > 1) {
      return {
        ok: false,
        message: `Direct fixture appraisal dimension ${dimension} must be between ${min} and 1.`,
      };
    }
    appraisal[dimension] = raw;
  }

  return { ok: true, appraisal: appraisal as EmoSimAppraisalVector };
}

function maxDiscrete(snapshot: EmotionStateSnapshot | null, labels: readonly string[]): number {
  if (!snapshot) {
    return 0;
  }
  let max = 0;
  for (const label of labels) {
    max = Math.max(max, clampUnit(snapshot.discrete[label] ?? 0));
  }
  return max;
}

function vadMagnitude(vad: EmotionStateSnapshot['vad']): number {
  return Math.hypot(vad.valence, vad.arousal, vad.dominance) / Math.sqrt(3);
}

function secondsSinceUtcMidnight(timestampMs: number): number {
  const date = new Date(safeTimestamp(timestampMs));
  return (date.getUTCHours() * 3_600)
    + (date.getUTCMinutes() * 60)
    + date.getUTCSeconds()
    + (date.getUTCMilliseconds() / 1_000);
}

function safeTimestamp(timestampMs: number): number {
  return Number.isFinite(timestampMs) && timestampMs >= 0 ? timestampMs : 0;
}

function clampSigned(value: number): number {
  return clamp(value, -1, 1);
}

function clampUnit(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
