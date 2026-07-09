// ── Session-entry intake screening metadata (htm9.2) ──
//
// Persists the intake-firewall screening outcome on the session entries whose
// CONTENT was screened (tool observations today; further surfaces as the
// wiring epic grows). Follows the established metadata-envelope sub-key
// pattern (`toolObservation`, `sessionLane`, `turn`): the entry's `metadata`
// string is a JSON object bag and this module owns the `intakeScreening` key.
//
// WHY IT MATTERS (bead htm9.2 surface 7 — the critical one): emotion appraisal
// and memory extraction read PERSISTED session entries independent of prompt
// assembly. Because screened surfaces persist the screening's `effectiveText`
// as entry content, an enforce-mode quarantine means the hostile text itself
// never lands in the entry — and this metadata carries the envelope snapshot
// (labels, state, decision context) so downstream consumers and sink gates
// (htm9.3) can read WHAT was decided without re-screening.

import { isRecord } from '../../shared/utils/types.js';
import {
  isIntakeEnvelopeState,
  isIntakeRiskLabel,
  isIntakeSourceClass,
  isIntakeSourceRiskTier,
  type IntakeEnvelopeSnapshot,
} from '../../shared/contracts/intake-envelope.js';
import {
  isIntakeMarkingIntensity,
  type IntakeMarkingPlan,
} from '../cogsec/intake/marking.js';

export const INTAKE_SCREENING_METADATA_KEY = 'intakeScreening';
const INTAKE_SCREENING_METADATA_SCHEMA_VERSION = 1;

export interface IntakeScreeningSessionMetadata {
  schemaVersion: 1;
  /** Firewall rollout mode at screening time. */
  mode: 'shadow' | 'enforce';
  /** True when enforce-mode quarantine replaced the entry content. */
  withheld: boolean;
  envelopes: IntakeEnvelopeSnapshot[];
  /**
   * Data-marking plan for the entry body (htm9.13), computed at screening
   * time. The prompt-assembly sink gate applies it at read time in enforce
   * mode; shadow mode audits it only.
   */
  marking?: IntakeMarkingPlan;
}

interface SessionMetadataEnvelope {
  [key: string]: unknown;
}

function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing intake screening parsing');
  }
  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for intake screening parsing');
  }
  return parsed;
}

export function buildSessionMetadataWithIntakeScreening(
  existingMetadata: string | undefined,
  screening: {
    mode: 'shadow' | 'enforce';
    withheld: boolean;
    envelopes: readonly IntakeEnvelopeSnapshot[];
    marking?: IntakeMarkingPlan;
  },
): string {
  if (screening.envelopes.length === 0) {
    throw new Error('Intake screening session metadata requires at least one envelope snapshot');
  }
  const base = parseMetadataEnvelope(existingMetadata);
  const payload: IntakeScreeningSessionMetadata = {
    schemaVersion: INTAKE_SCREENING_METADATA_SCHEMA_VERSION,
    mode: screening.mode,
    withheld: screening.withheld,
    envelopes: [...screening.envelopes],
    ...(screening.marking ? { marking: { ...screening.marking } } : {}),
  };
  return JSON.stringify({
    ...base,
    [INTAKE_SCREENING_METADATA_KEY]: payload,
  });
}

function parseSnapshot(value: unknown, index: number): IntakeEnvelopeSnapshot {
  if (!isRecord(value)) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}] must be an object`);
  }
  const { envelopeId, sourceClass, sourceRiskTier, state, riskLabels, subject } = value;
  if (typeof envelopeId !== 'string' || !envelopeId.trim()) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].envelopeId must be a non-empty string`);
  }
  if (!isIntakeSourceClass(sourceClass)) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].sourceClass is not a known source class`);
  }
  if (!isIntakeSourceRiskTier(sourceRiskTier)) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].sourceRiskTier is not a known risk tier`);
  }
  if (!isIntakeEnvelopeState(state)) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].state is not a known envelope state`);
  }
  if (!Array.isArray(riskLabels) || riskLabels.some((label) => !isIntakeRiskLabel(label))) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].riskLabels contains unknown labels`);
  }
  if (!isRecord(subject) || (subject.kind !== 'body' && subject.kind !== 'attachment')) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].subject is malformed`);
  }
  if (subject.kind === 'attachment'
    && (typeof subject.index !== 'number' || !Number.isInteger(subject.index) || subject.index < 0)) {
    throw new Error(`Intake screening metadata envelopes[${String(index)}].subject.index must be a non-negative integer`);
  }
  return {
    envelopeId: envelopeId.trim(),
    sourceClass,
    sourceRiskTier,
    state,
    riskLabels,
    subject: subject.kind === 'body'
      ? { kind: 'body' }
      : { kind: 'attachment', index: subject.index as number },
  };
}

export function parseIntakeScreeningMetadata(
  metadata: string | undefined,
): IntakeScreeningSessionMetadata | null {
  const envelope = parseMetadataEnvelope(metadata);
  const raw = envelope[INTAKE_SCREENING_METADATA_KEY];
  if (raw === undefined) return null;
  if (!isRecord(raw)) {
    throw new Error('Session metadata intakeScreening field must be an object');
  }
  if (raw.schemaVersion !== INTAKE_SCREENING_METADATA_SCHEMA_VERSION) {
    throw new Error(`Unsupported intake screening metadata schemaVersion "${String(raw.schemaVersion)}"`);
  }
  if (raw.mode !== 'shadow' && raw.mode !== 'enforce') {
    throw new Error('Intake screening metadata mode must be "shadow" or "enforce"');
  }
  if (typeof raw.withheld !== 'boolean') {
    throw new Error('Intake screening metadata withheld must be a boolean');
  }
  if (!Array.isArray(raw.envelopes) || raw.envelopes.length === 0) {
    throw new Error('Intake screening metadata envelopes must be a non-empty array');
  }
  let marking: IntakeMarkingPlan | undefined;
  if (raw.marking !== undefined) {
    if (!isRecord(raw.marking)) {
      throw new Error('Intake screening metadata marking must be an object');
    }
    if (!isIntakeMarkingIntensity(raw.marking.intensity)) {
      throw new Error('Intake screening metadata marking.intensity is not a known intensity');
    }
    if (typeof raw.marking.provenanceNote !== 'string') {
      throw new Error('Intake screening metadata marking.provenanceNote must be a string');
    }
    marking = {
      intensity: raw.marking.intensity,
      provenanceNote: raw.marking.provenanceNote,
    };
  }
  return {
    schemaVersion: INTAKE_SCREENING_METADATA_SCHEMA_VERSION,
    mode: raw.mode,
    withheld: raw.withheld,
    envelopes: raw.envelopes.map((snapshot, index) => parseSnapshot(snapshot, index)),
    ...(marking ? { marking } : {}),
  };
}
