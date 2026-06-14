import {
  getVisibilityDisclosureCeiling,
} from '../../../system/trust/policy.js';
import {
  isHighIntimacySensitivityLevel,
  normalizeChannelVisibility,
  SENSITIVITY_LEVELS,
  sensitivityOrd,
  type ChannelVisibility,
  type SensitivityLevel,
} from '../../../system/trust/types.js';
import type {
  ObserverEvalEmotionSnapshot,
  ObserverEvalInputPayload,
  ObserverEvalLifecycleStatePayload,
  ObserverEvalProvenance,
  ObserverEvalRoutingSource,
  ObserverEvalTurnIdentity,
  ObserverEvalTurnMetadata,
} from './types.js';

export type ObserverEvalPrivacyClass =
  | 'public'
  | 'private'
  | 'restricted'
  | 'closed'
  | 'fail_closed';

export type ObserverEvalRedactionReason =
  | 'public_metadata_only'
  | 'direct_message_metadata_only'
  | 'private_channel_metadata_only'
  | 'semi_private_channel_metadata_only'
  | 'personal_sensitivity_metadata_only'
  | 'closed_sensitivity_metadata_only'
  | 'channel_visibility_restricted_metadata_only'
  | 'missing_sensitivity_metadata'
  | 'ambiguous_sensitivity_metadata'
  | 'missing_channel_privacy_metadata'
  | 'ambiguous_channel_privacy_metadata'
  | 'raw_error_redacted'
  | 'lifecycle_reason_redacted';

export interface ObserverEvalPrivacyDecision {
  privacyClass: ObserverEvalPrivacyClass;
  sensitivity: SensitivityLevel | null;
  channelVisibility: ChannelVisibility | null;
  rawContentRedacted: true;
  sensitiveIdentifiersRedacted: true;
  derivedTelemetryPermitted: boolean;
  redactionReason: ObserverEvalRedactionReason;
}

export interface ObserverEvalSanitizedTurnIdentity {
  turnId: ObserverEvalTurnIdentity['turnId'];
  channelType: ObserverEvalTurnIdentity['channelType'];
  messageTimestampMs: number;
  taskKind?: string;
  redactedIdentifiers: readonly ['requestId', 'sourceMessageId', 'channelId'];
}

export interface ObserverEvalSanitizedSourceMetadata {
  routingSource: ObserverEvalRoutingSource;
  isDirectMessage: boolean;
  channelPrivacy: ChannelVisibility | null;
}

export interface ObserverEvalSanitizedEmotionSnapshot {
  snapshot: ObserverEvalEmotionSnapshot['snapshot'];
  appraisalEntryCount: number;
  snapshotRedacted: boolean;
}

export interface ObserverEvalSanitizedTurnMetadata {
  trustLevel: ObserverEvalTurnMetadata['trustLevel'];
  speakerRole: ObserverEvalTurnMetadata['speakerRole'];
  contactResolved: boolean;
  contentLength: number;
  attachmentCount: number;
  hasVisionInput: boolean;
  sensitivity: SensitivityLevel | null;
}

export interface ObserverEvalSanitizedProvenance {
  seam: ObserverEvalProvenance['seam'];
  capturedAt: number;
  emotionSnapshotSource: ObserverEvalProvenance['emotionSnapshotSource'];
  correlation: {
    callType: ObserverEvalProvenance['correlation']['callType'];
    purposeRedacted: true;
  };
  redactedIdentifiers: readonly ['emotionSessionId'];
}

export interface ObserverEvalSanitizedInputPayload {
  schemaVersion: 1;
  privacy: ObserverEvalPrivacyDecision;
  turn: ObserverEvalSanitizedTurnIdentity;
  source: ObserverEvalSanitizedSourceMetadata;
  emotion: ObserverEvalSanitizedEmotionSnapshot;
  metadata: ObserverEvalSanitizedTurnMetadata;
  provenance: ObserverEvalSanitizedProvenance;
}

export interface ObserverEvalSanitizedError {
  message: 'Observer eval sidecar error redacted';
  redacted: true;
  redactionReason: Extract<ObserverEvalRedactionReason, 'raw_error_redacted'>;
  rawMessageLength: number;
  errorKind: 'error' | 'non_error';
}

export interface ObserverEvalSanitizedLifecycleStatePayload
  extends Omit<ObserverEvalLifecycleStatePayload, 'error' | 'reason'> {
  reason?: string;
  error?: ObserverEvalSanitizedError;
  redaction?: {
    lifecycleReasonRedacted: boolean;
    errorRedacted: boolean;
  };
}

const REDACTED_TURN_IDENTIFIERS = ['requestId', 'sourceMessageId', 'channelId'] as const;
const REDACTED_PROVENANCE_IDENTIFIERS = ['emotionSessionId'] as const;

const SAFE_LIFECYCLE_REASONS = new Set([
  'config_disabled',
  'runtime_not_configured',
  'observer_not_configured',
  'observer_failed',
]);

export function classifyObserverEvalPrivacy(
  input: ObserverEvalInputPayload,
): ObserverEvalPrivacyDecision {
  const sensitivityResult = normalizeObserverEvalSensitivity(input.metadata.sensitivity);
  if (sensitivityResult.status !== 'ok') {
    return failClosedDecision(
      sensitivityResult.status === 'missing'
        ? 'missing_sensitivity_metadata'
        : 'ambiguous_sensitivity_metadata',
    );
  }

  const channelVisibilityResult = resolveObserverEvalChannelVisibility(input);
  if (channelVisibilityResult.status !== 'ok') {
    return failClosedDecision(
      channelVisibilityResult.status === 'missing'
        ? 'missing_channel_privacy_metadata'
        : 'ambiguous_channel_privacy_metadata',
      sensitivityResult.sensitivity,
    );
  }

  const sensitivity = sensitivityResult.sensitivity;
  const channelVisibility = channelVisibilityResult.channelVisibility;
  const visibilityCeiling = getVisibilityDisclosureCeiling(channelVisibility);

  if (sensitivityOrd(sensitivity) > sensitivityOrd(visibilityCeiling)) {
    return privacyDecision({
      privacyClass: 'closed',
      sensitivity,
      channelVisibility,
      redactionReason: 'channel_visibility_restricted_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  if (isHighIntimacySensitivityLevel(sensitivity)) {
    return privacyDecision({
      privacyClass: 'closed',
      sensitivity,
      channelVisibility,
      redactionReason: 'closed_sensitivity_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  if (input.source.isDirectMessage) {
    return privacyDecision({
      privacyClass: 'private',
      sensitivity,
      channelVisibility,
      redactionReason: 'direct_message_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  if (channelVisibility === 'private') {
    return privacyDecision({
      privacyClass: 'private',
      sensitivity,
      channelVisibility,
      redactionReason: 'private_channel_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  if (channelVisibility === 'semi_private') {
    return privacyDecision({
      privacyClass: 'restricted',
      sensitivity,
      channelVisibility,
      redactionReason: 'semi_private_channel_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  if (sensitivity === 'personal') {
    return privacyDecision({
      privacyClass: 'restricted',
      sensitivity,
      channelVisibility,
      redactionReason: 'personal_sensitivity_metadata_only',
      derivedTelemetryPermitted: true,
    });
  }

  return privacyDecision({
    privacyClass: 'public',
    sensitivity,
    channelVisibility,
    redactionReason: 'public_metadata_only',
    derivedTelemetryPermitted: true,
  });
}

export function sanitizeObserverEvalInput(
  input: ObserverEvalInputPayload,
): ObserverEvalSanitizedInputPayload {
  const privacy = classifyObserverEvalPrivacy(input);
  const snapshot = privacy.derivedTelemetryPermitted ? cloneEmotionSnapshot(input.emotion.snapshot) : null;

  return {
    schemaVersion: input.schemaVersion,
    privacy,
    turn: {
      turnId: input.turn.turnId,
      channelType: input.turn.channelType,
      messageTimestampMs: input.turn.messageTimestampMs,
      ...(input.turn.taskKind ? { taskKind: input.turn.taskKind } : {}),
      redactedIdentifiers: REDACTED_TURN_IDENTIFIERS,
    },
    source: {
      routingSource: input.source.routingSource,
      isDirectMessage: input.source.isDirectMessage,
      channelPrivacy: privacy.channelVisibility,
    },
    emotion: {
      snapshot,
      appraisalEntryCount: input.emotion.appraisalEntryCount,
      snapshotRedacted: !privacy.derivedTelemetryPermitted,
    },
    metadata: {
      trustLevel: input.metadata.trustLevel,
      speakerRole: input.metadata.speakerRole,
      contactResolved: input.metadata.contactResolved,
      contentLength: input.metadata.contentLength,
      attachmentCount: input.metadata.attachmentCount,
      hasVisionInput: input.metadata.hasVisionInput,
      sensitivity: privacy.sensitivity,
    },
    provenance: {
      seam: input.provenance.seam,
      capturedAt: input.provenance.capturedAt,
      emotionSnapshotSource: input.provenance.emotionSnapshotSource,
      correlation: {
        callType: input.provenance.correlation.callType,
        purposeRedacted: true,
      },
      redactedIdentifiers: REDACTED_PROVENANCE_IDENTIFIERS,
    },
  };
}

export function createObserverEvalLogSafeInput(
  input: ObserverEvalInputPayload,
): ObserverEvalSanitizedInputPayload {
  return sanitizeObserverEvalInput(input);
}

export function sanitizeObserverEvalError(error: unknown): ObserverEvalSanitizedError {
  return {
    message: 'Observer eval sidecar error redacted',
    redacted: true,
    redactionReason: 'raw_error_redacted',
    rawMessageLength: extractErrorMessageLength(error),
    errorKind: error instanceof Error ? 'error' : 'non_error',
  };
}

export function sanitizeObserverEvalLifecycleState(
  state: ObserverEvalLifecycleStatePayload,
): ObserverEvalSanitizedLifecycleStatePayload {
  const reason = sanitizeLifecycleReason(state.reason);
  const error = state.error ? sanitizeObserverEvalError(state.error.message) : undefined;
  return {
    status: state.status,
    observedAt: state.observedAt,
    ...(state.sidecarId ? { sidecarId: state.sidecarId } : {}),
    ...(reason.value ? { reason: reason.value } : {}),
    ...(error ? { error } : {}),
    redaction: {
      lifecycleReasonRedacted: reason.redacted,
      errorRedacted: Boolean(error),
    },
  };
}

export function createObserverEvalLogSafeLifecycleState(
  state: ObserverEvalLifecycleStatePayload,
): ObserverEvalSanitizedLifecycleStatePayload {
  return sanitizeObserverEvalLifecycleState(state);
}

function normalizeObserverEvalSensitivity(
  value: unknown,
):
  | { status: 'ok'; sensitivity: SensitivityLevel }
  | { status: 'missing' | 'ambiguous' } {
  if (value === undefined || value === null || value === '') {
    return { status: 'missing' };
  }
  if (typeof value !== 'string') {
    return { status: 'ambiguous' };
  }
  const normalized = value.trim().toLowerCase();
  if ((SENSITIVITY_LEVELS as readonly string[]).includes(normalized)) {
    return { status: 'ok', sensitivity: normalized as SensitivityLevel };
  }
  return { status: 'ambiguous' };
}

function resolveObserverEvalChannelVisibility(
  input: ObserverEvalInputPayload,
):
  | { status: 'ok'; channelVisibility: ChannelVisibility }
  | { status: 'missing' | 'ambiguous' } {
  const explicitVisibility = input.source.channelPrivacy;
  if (explicitVisibility !== undefined) {
    const normalized = normalizeChannelVisibility(explicitVisibility);
    if (normalized) {
      return { status: 'ok', channelVisibility: normalized };
    }
    return { status: 'ambiguous' };
  }

  if (input.source.isDirectMessage) {
    return { status: 'ok', channelVisibility: 'private' };
  }

  return { status: 'missing' };
}

function failClosedDecision(
  redactionReason: Extract<
    ObserverEvalRedactionReason,
    | 'missing_sensitivity_metadata'
    | 'ambiguous_sensitivity_metadata'
    | 'missing_channel_privacy_metadata'
    | 'ambiguous_channel_privacy_metadata'
  >,
  sensitivity: SensitivityLevel | null = null,
): ObserverEvalPrivacyDecision {
  return privacyDecision({
    privacyClass: 'fail_closed',
    sensitivity,
    channelVisibility: null,
    redactionReason,
    derivedTelemetryPermitted: false,
  });
}

function privacyDecision(input: {
  privacyClass: ObserverEvalPrivacyClass;
  sensitivity: SensitivityLevel | null;
  channelVisibility: ChannelVisibility | null;
  redactionReason: ObserverEvalRedactionReason;
  derivedTelemetryPermitted: boolean;
}): ObserverEvalPrivacyDecision {
  return {
    privacyClass: input.privacyClass,
    sensitivity: input.sensitivity,
    channelVisibility: input.channelVisibility,
    rawContentRedacted: true,
    sensitiveIdentifiersRedacted: true,
    derivedTelemetryPermitted: input.derivedTelemetryPermitted,
    redactionReason: input.redactionReason,
  };
}

function cloneEmotionSnapshot(
  snapshot: ObserverEvalEmotionSnapshot['snapshot'],
): ObserverEvalEmotionSnapshot['snapshot'] {
  return snapshot ? structuredClone(snapshot) : null;
}

function extractErrorMessageLength(error: unknown): number {
  if (error instanceof Error) {
    return error.message.length;
  }
  if (typeof error === 'string') {
    return error.length;
  }
  return String(error).length;
}

function sanitizeLifecycleReason(reason: string | undefined): { value?: string; redacted: boolean } {
  if (!reason) {
    return { redacted: false };
  }
  if (SAFE_LIFECYCLE_REASONS.has(reason)) {
    return { value: reason, redacted: false };
  }
  return { value: 'redacted_lifecycle_reason', redacted: true };
}
