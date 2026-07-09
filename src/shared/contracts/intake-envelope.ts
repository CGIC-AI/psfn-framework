// ── Cognition Intake Firewall: IntakeEnvelope contract (htm9.1) ──
//
// Layer 0 of the intake firewall ("mindwall"). Every untrusted inbound item
// (web fetch, document, image OCR, chat by source risk, tool output, subagent
// digest, shard foldback, MCP tool description, ...) is wrapped in a typed
// envelope at the boundary BEFORE it can reach prompt, memory, wiki, persona,
// trust state, or tools. Raw bytes NEVER travel with the envelope — only an
// opaque content ref that a store on the gateway side can resolve.
//
// This module is deliberately structural, not probabilistic: it owns the
// envelope schema, the quarantine/release state machine, and taint
// propagation on derivation (CaMeL rule: a summary/OCR transcript/subagent
// digest of untrusted content stays untrusted). Classifier layers (htm9.4+)
// fill in riskLabels/scores/decision; sink gates (htm9.3) consume them.
//
// Everything here fails closed: malformed input throws, illegal state
// transitions throw, and derived envelopes can never carry a lower risk tier
// than their parent.

import { randomUUID } from 'node:crypto';

// ── Source classes ──

export const INTAKE_SOURCE_CLASSES = [
  'operator',
  'primary_user',
  'trusted_contact',
  'regular_contact',
  'public_contact',
  'web_fetch',
  'web_search',
  'document',
  'image_ocr',
  'audio_transcript',
  'tool_output',
  'subagent_output',
  'shard_foldback',
  'mcp_tool_description',
] as const;

export type IntakeSourceClass = typeof INTAKE_SOURCE_CLASSES[number];

export function isIntakeSourceClass(value: unknown): value is IntakeSourceClass {
  return typeof value === 'string'
    && (INTAKE_SOURCE_CLASSES as readonly string[]).includes(value);
}

// ── Source risk tiers (ordered, least to most risky) ──

/**
 * Ordered risk tiers. Policy (intake-policy.json) maps source classes to
 * tiers; the contract only defines the ordering so taint propagation can take
 * the maximum of parent and child tiers. Screening intensity per tier is
 * htm9.3+ policy, not detection.
 */
export const INTAKE_SOURCE_RISK_TIERS = [
  'trusted',
  'standard',
  'untrusted',
  'hostile',
] as const;

export type IntakeSourceRiskTier = typeof INTAKE_SOURCE_RISK_TIERS[number];

export function isIntakeSourceRiskTier(value: unknown): value is IntakeSourceRiskTier {
  return typeof value === 'string'
    && (INTAKE_SOURCE_RISK_TIERS as readonly string[]).includes(value);
}

/** Negative when `left` is less risky than `right`, zero when equal. */
export function compareIntakeSourceRiskTiers(
  left: IntakeSourceRiskTier,
  right: IntakeSourceRiskTier,
): number {
  return INTAKE_SOURCE_RISK_TIERS.indexOf(left) - INTAKE_SOURCE_RISK_TIERS.indexOf(right);
}

export function maxIntakeSourceRiskTier(
  left: IntakeSourceRiskTier,
  right: IntakeSourceRiskTier,
): IntakeSourceRiskTier {
  return compareIntakeSourceRiskTiers(left, right) >= 0 ? left : right;
}

// ── Risk label taxonomy (seed vocabulary) ──

/**
 * Seed risk-label vocabulary, `category/subcategory` shaped.
 *
 * The `content/*`, `persona/*`, `policy/*`, and `execution/*` labels
 * generalize the memory-write-time `CogSecMemoryRiskClass` A–E vocabulary
 * (src/core/cogsec/memory-candidacy.ts) to intake time:
 *   A_harmless_fact             → content/harmless_fact
 *   B_relationship_state        → content/relationship_state
 *   C_persona_modification      → persona/mutation_attempt
 *   D_policy_security_modification → policy/security_modification
 *   E_executable_instruction    → execution/executable_instruction
 *
 * The remaining categories seed from the prior-art survey
 * (working_docs/COGSEC_INTAKE_FIREWALL_RESEARCH_20260709.md §7). Classifier
 * beads (htm9.4–.8) assign these labels; they must not invent labels outside
 * this closed list — grow the list in the contract instead so sink gates and
 * Garden always share one vocabulary.
 */
export const INTAKE_RISK_LABELS = [
  // Generalized from CogSecMemoryRiskClass A–E
  'content/harmless_fact',
  'content/relationship_state',
  'persona/mutation_attempt',
  'policy/security_modification',
  'execution/executable_instruction',
  // Prompt-injection findings
  'injection/override_attempt',
  'injection/indirect',
  'injection/encoded_smuggling',
  'injection/invisible_text',
  'injection/role_confusion',
  'injection/jailbreak_marker',
  // Exfiltration findings
  'exfil/canary_leak',
  'exfil/unknown_link',
  'exfil/prompt_disclosure',
  // PII findings
  'pii/personal_identifier',
  'pii/financial',
  'pii/credential_adjacent',
  // Secret-material findings
  'secrets/api_key',
  'secrets/credential_material',
  // Slow-poisoning findings
  'poisoning/memory_write_pressure',
  'poisoning/trust_grooming',
  'poisoning/source_drift',
] as const;

export type IntakeRiskLabel = typeof INTAKE_RISK_LABELS[number];

export function isIntakeRiskLabel(value: unknown): value is IntakeRiskLabel {
  return typeof value === 'string'
    && (INTAKE_RISK_LABELS as readonly string[]).includes(value);
}

export const INTAKE_RISK_LABEL_CATEGORIES = [...new Set(
  INTAKE_RISK_LABELS.map((label) => label.slice(0, label.indexOf('/'))),
)] as readonly string[];

// ── Decision ──

export const INTAKE_DECISION_ACTIONS = ['pass', 'sanitize', 'quarantine', 'block'] as const;
export type IntakeDecisionAction = typeof INTAKE_DECISION_ACTIONS[number];

export const INTAKE_DECISION_AUTHORITIES = ['policy', 'screening', 'human'] as const;
export type IntakeDecisionAuthority = typeof INTAKE_DECISION_AUTHORITIES[number];

export interface IntakeDecision {
  action: IntakeDecisionAction;
  /** Human-auditable reason ("rule:invisible_text", "operator release", ...). */
  reason: string;
  decidedBy: IntakeDecisionAuthority;
  decidedAtMs: number;
}

/**
 * Canonical mapping from a screening decision to the post-screening state.
 * `block` maps to `quarantined` (fail-closed hold); an explicit follow-up
 * transition to `discarded` records the destruction as its own audited step.
 */
export function postScreeningStateForDecision(
  action: IntakeDecisionAction,
): Extract<IntakeEnvelopeState, 'released' | 'released_sanitized' | 'quarantined'> {
  switch (action) {
    case 'pass':
      return 'released';
    case 'sanitize':
      return 'released_sanitized';
    case 'quarantine':
    case 'block':
      return 'quarantined';
  }
}

// ── State machine ──

export const INTAKE_ENVELOPE_STATES = [
  'received',
  'screened',
  'released',
  'released_sanitized',
  'quarantined',
  'human_released',
  'human_released_sanitized',
  'discarded',
  'expired',
] as const;

export type IntakeEnvelopeState = typeof INTAKE_ENVELOPE_STATES[number];

export function isIntakeEnvelopeState(value: unknown): value is IntakeEnvelopeState {
  return typeof value === 'string'
    && (INTAKE_ENVELOPE_STATES as readonly string[]).includes(value);
}

/**
 * Legal transitions:
 *   received → screened → {released | released_sanitized | quarantined}
 *   quarantined → {human_released | human_released_sanitized | discarded | expired}
 *   released / released_sanitized → {discarded | expired}   (lifecycle end)
 *
 * `human_*` states are reachable only from `quarantined` — a human release
 * decision presupposes a quarantine hold. `human_released*`, `discarded`, and
 * `expired` are terminal.
 */
export const INTAKE_ENVELOPE_STATE_TRANSITIONS: Record<
  IntakeEnvelopeState,
  readonly IntakeEnvelopeState[]
> = {
  received: ['screened'],
  screened: ['released', 'released_sanitized', 'quarantined'],
  released: ['discarded', 'expired'],
  released_sanitized: ['discarded', 'expired'],
  quarantined: ['human_released', 'human_released_sanitized', 'discarded', 'expired'],
  human_released: [],
  human_released_sanitized: [],
  discarded: [],
  expired: [],
};

export function isIntakeEnvelopeTransitionAllowed(
  from: IntakeEnvelopeState,
  to: IntakeEnvelopeState,
): boolean {
  return INTAKE_ENVELOPE_STATE_TRANSITIONS[from].includes(to);
}

export class IntakeEnvelopeTransitionError extends Error {
  readonly envelopeId: string;
  readonly from: IntakeEnvelopeState;
  readonly to: IntakeEnvelopeState;

  constructor(input: {
    envelopeId: string;
    from: IntakeEnvelopeState;
    to: IntakeEnvelopeState;
    detail?: string;
  }) {
    const allowed = INTAKE_ENVELOPE_STATE_TRANSITIONS[input.from];
    super(
      `Illegal intake envelope transition ${input.from} -> ${input.to} `
      + `(envelope ${input.envelopeId}; allowed from ${input.from}: `
      + `${allowed.length > 0 ? allowed.join(', ') : 'none — terminal state'})`
      + (input.detail ? `: ${input.detail}` : ''),
    );
    this.name = 'IntakeEnvelopeTransitionError';
    this.envelopeId = input.envelopeId;
    this.from = input.from;
    this.to = input.to;
  }
}

// ── Derivation kinds (taint propagation) ──

export const INTAKE_DERIVATION_KINDS = [
  'summary',
  'ocr_transcript',
  'audio_transcript',
  'subagent_digest',
  'translation',
  'extraction',
] as const;

export type IntakeDerivationKind = typeof INTAKE_DERIVATION_KINDS[number];

export function isIntakeDerivationKind(value: unknown): value is IntakeDerivationKind {
  return typeof value === 'string'
    && (INTAKE_DERIVATION_KINDS as readonly string[]).includes(value);
}

// ── Structural pieces ──

/**
 * One hop in the provenance chain. Origin hops carry the source class; every
 * derivation appends a `derivation` hop whose `ref` is the canonical
 * provenance ref of the PARENT envelope, so a poisoned source's whole lineage
 * is walkable in both directions.
 */
export interface IntakeProvenanceHop {
  kind: IntakeSourceClass | 'derivation';
  /** Origin locator (url, channel:message id, tool call id) or parent envelope ref. */
  ref: string;
  atMs: number;
  detail?: string;
}

/**
 * Opaque handle to the raw content. The envelope NEVER carries raw bytes;
 * a store on the gateway side resolves the handle for screening or human
 * review. Validation rejects handles that look like inline content.
 */
export interface IntakeContentRef {
  /** Storage domain that can resolve the handle (e.g. 'gateway-quarantine'). */
  store: string;
  /** Opaque handle within the store. Never raw content, never a data: URL. */
  ref: string;
  sha256?: string;
  sizeBytes?: number;
  mediaType?: string;
}

export interface IntakeEnvelopeTransitionRecord {
  from: IntakeEnvelopeState;
  to: IntakeEnvelopeState;
  atMs: number;
  /** Acting principal, e.g. 'gateway:intake-screening', 'human:operator'. */
  actor: string;
  reason: string;
}

export interface IntakeEnvelope {
  schemaVersion: 1;
  id: string;
  sourceClass: IntakeSourceClass;
  /** Origin-first chain; derivations append hops referencing the parent envelope. */
  provenance: readonly IntakeProvenanceHop[];
  sourceRiskTier: IntakeSourceRiskTier;
  contentRef: IntakeContentRef;
  /** Safe schema-extracted representation produced by screening (htm9.4+). */
  extractedFields: Readonly<Record<string, string>>;
  riskLabels: readonly IntakeRiskLabel[];
  /** Calibrated 0–1 scores keyed by scanner/classifier id. */
  scores: Readonly<Record<string, number>>;
  /** Absent until screening; required to leave `received`. */
  decision?: IntakeDecision;
  state: IntakeEnvelopeState;
  createdAtMs: number;
  /** Append-only transition journal (also mirrored to the gateway audit journal by htm9.2). */
  transitions: readonly IntakeEnvelopeTransitionRecord[];
}

// ── Field validation helpers ──

const INTAKE_ENVELOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/;
const MAX_CONTENT_REF_CHARS = 2048;
const MAX_PROVENANCE_HOPS = 32;
const MAX_EXTRACTED_FIELDS = 64;
const MAX_EXTRACTED_FIELD_KEY_CHARS = 128;
const MAX_EXTRACTED_FIELD_VALUE_CHARS = 4096;
const MAX_REASON_CHARS = 1024;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(field: string, detail: string): Error {
  return new Error(`Invalid intake envelope: ${field} ${detail}`);
}

export function normalizeIntakeEnvelopeId(value: unknown): string {
  if (typeof value !== 'string') {
    throw invalid('id', 'must be a string');
  }
  const normalized = value.trim();
  if (!INTAKE_ENVELOPE_ID_PATTERN.test(normalized)) {
    throw invalid('id', 'must be 8-64 chars of [A-Za-z0-9._-] starting alphanumeric');
  }
  return normalized;
}

function normalizeRequiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') {
    throw invalid(field, 'must be a string');
  }
  const normalized = value.trim();
  if (!normalized) {
    throw invalid(field, 'must be non-empty');
  }
  if (normalized.length > maxChars) {
    throw invalid(field, `exceeds ${String(maxChars)} characters`);
  }
  return normalized;
}

function normalizeTimestampMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw invalid(field, 'must be a positive finite epoch-milliseconds number');
  }
  return value;
}

function normalizeContentRef(value: unknown, field = 'contentRef'): IntakeContentRef {
  if (!isRecordValue(value)) {
    throw invalid(field, 'must be an object');
  }
  const unknownKeys = Object.keys(value)
    .filter((key) => !['store', 'ref', 'sha256', 'sizeBytes', 'mediaType'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(field, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  const store = normalizeRequiredString(value.store, `${field}.store`, 128);
  const ref = normalizeRequiredString(value.ref, `${field}.ref`, MAX_CONTENT_REF_CHARS);
  // Opaque-handle guard: the envelope must never smuggle raw content.
  if (/^data:/iu.test(ref) || /[\r\n]/u.test(ref)) {
    throw invalid(`${field}.ref`, 'must be an opaque handle, not inline content');
  }
  const normalized: IntakeContentRef = { store, ref };
  if (value.sha256 !== undefined) {
    const sha256 = normalizeRequiredString(value.sha256, `${field}.sha256`, 64).toLowerCase();
    if (!SHA256_HEX_PATTERN.test(sha256)) {
      throw invalid(`${field}.sha256`, 'must be 64 lowercase hex characters');
    }
    normalized.sha256 = sha256;
  }
  if (value.sizeBytes !== undefined) {
    if (typeof value.sizeBytes !== 'number' || !Number.isInteger(value.sizeBytes) || value.sizeBytes < 0) {
      throw invalid(`${field}.sizeBytes`, 'must be a non-negative integer');
    }
    normalized.sizeBytes = value.sizeBytes;
  }
  if (value.mediaType !== undefined) {
    normalized.mediaType = normalizeRequiredString(value.mediaType, `${field}.mediaType`, 255);
  }
  return normalized;
}

function normalizeProvenanceHop(value: unknown, field: string): IntakeProvenanceHop {
  if (!isRecordValue(value)) {
    throw invalid(field, 'must be an object');
  }
  const unknownKeys = Object.keys(value)
    .filter((key) => !['kind', 'ref', 'atMs', 'detail'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(field, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  const kind = value.kind;
  if (kind !== 'derivation' && !isIntakeSourceClass(kind)) {
    throw invalid(`${field}.kind`, `must be 'derivation' or one of: ${INTAKE_SOURCE_CLASSES.join(', ')}`);
  }
  const hop: IntakeProvenanceHop = {
    kind,
    ref: normalizeRequiredString(value.ref, `${field}.ref`, MAX_CONTENT_REF_CHARS),
    atMs: normalizeTimestampMs(value.atMs, `${field}.atMs`),
  };
  if (value.detail !== undefined) {
    hop.detail = normalizeRequiredString(value.detail, `${field}.detail`, 512);
  }
  return hop;
}

function normalizeProvenanceChain(value: unknown): IntakeProvenanceHop[] {
  if (!Array.isArray(value)) {
    throw invalid('provenance', 'must be an array');
  }
  if (value.length === 0) {
    throw invalid('provenance', 'must contain at least the origin hop');
  }
  if (value.length > MAX_PROVENANCE_HOPS) {
    throw invalid('provenance', `exceeds ${String(MAX_PROVENANCE_HOPS)} hops`);
  }
  return value.map((hop, index) => normalizeProvenanceHop(hop, `provenance[${String(index)}]`));
}

function normalizeExtractedFields(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecordValue(value)) {
    throw invalid('extractedFields', 'must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_EXTRACTED_FIELDS) {
    throw invalid('extractedFields', `exceeds ${String(MAX_EXTRACTED_FIELDS)} entries`);
  }
  const normalized: Record<string, string> = {};
  for (const [key, fieldValue] of entries) {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > MAX_EXTRACTED_FIELD_KEY_CHARS) {
      throw invalid('extractedFields', `has invalid key '${key}'`);
    }
    if (typeof fieldValue !== 'string' || fieldValue.length > MAX_EXTRACTED_FIELD_VALUE_CHARS) {
      throw invalid(
        `extractedFields.${normalizedKey}`,
        `must be a string of at most ${String(MAX_EXTRACTED_FIELD_VALUE_CHARS)} characters`,
      );
    }
    normalized[normalizedKey] = fieldValue;
  }
  return normalized;
}

function normalizeRiskLabels(value: unknown): IntakeRiskLabel[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw invalid('riskLabels', 'must be an array');
  }
  const labels = new Set<IntakeRiskLabel>();
  for (const label of value) {
    if (!isIntakeRiskLabel(label)) {
      throw invalid('riskLabels', `contains unsupported label '${String(label)}'`);
    }
    labels.add(label);
  }
  return [...labels];
}

function normalizeScores(value: unknown): Record<string, number> {
  if (value === undefined) return {};
  if (!isRecordValue(value)) {
    throw invalid('scores', 'must be an object');
  }
  const normalized: Record<string, number> = {};
  for (const [key, score] of Object.entries(value)) {
    const normalizedKey = key.trim();
    if (!normalizedKey || normalizedKey.length > 128) {
      throw invalid('scores', `has invalid key '${key}'`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw invalid(`scores.${normalizedKey}`, 'must be a finite number in [0, 1]');
    }
    normalized[normalizedKey] = score;
  }
  return normalized;
}

function normalizeDecision(value: unknown, field = 'decision'): IntakeDecision {
  if (!isRecordValue(value)) {
    throw invalid(field, 'must be an object');
  }
  const unknownKeys = Object.keys(value)
    .filter((key) => !['action', 'reason', 'decidedBy', 'decidedAtMs'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(field, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  const action = value.action;
  if (typeof action !== 'string' || !(INTAKE_DECISION_ACTIONS as readonly string[]).includes(action)) {
    throw invalid(`${field}.action`, `must be one of: ${INTAKE_DECISION_ACTIONS.join(', ')}`);
  }
  const decidedBy = value.decidedBy;
  if (typeof decidedBy !== 'string' || !(INTAKE_DECISION_AUTHORITIES as readonly string[]).includes(decidedBy)) {
    throw invalid(`${field}.decidedBy`, `must be one of: ${INTAKE_DECISION_AUTHORITIES.join(', ')}`);
  }
  return {
    action: action as IntakeDecisionAction,
    reason: normalizeRequiredString(value.reason, `${field}.reason`, MAX_REASON_CHARS),
    decidedBy: decidedBy as IntakeDecisionAuthority,
    decidedAtMs: normalizeTimestampMs(value.decidedAtMs, `${field}.decidedAtMs`),
  };
}

function normalizeTransitionRecord(value: unknown, field: string): IntakeEnvelopeTransitionRecord {
  if (!isRecordValue(value)) {
    throw invalid(field, 'must be an object');
  }
  const unknownKeys = Object.keys(value)
    .filter((key) => !['from', 'to', 'atMs', 'actor', 'reason'].includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(field, `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (!isIntakeEnvelopeState(value.from)) {
    throw invalid(`${field}.from`, 'must be a known intake envelope state');
  }
  if (!isIntakeEnvelopeState(value.to)) {
    throw invalid(`${field}.to`, 'must be a known intake envelope state');
  }
  return {
    from: value.from,
    to: value.to,
    atMs: normalizeTimestampMs(value.atMs, `${field}.atMs`),
    actor: normalizeRequiredString(value.actor, `${field}.actor`, 256),
    reason: normalizeRequiredString(value.reason, `${field}.reason`, MAX_REASON_CHARS),
  };
}

function freezeEnvelope(envelope: IntakeEnvelope): IntakeEnvelope {
  Object.freeze(envelope.provenance);
  for (const hop of envelope.provenance) Object.freeze(hop);
  Object.freeze(envelope.contentRef);
  Object.freeze(envelope.extractedFields);
  Object.freeze(envelope.riskLabels);
  Object.freeze(envelope.scores);
  if (envelope.decision) Object.freeze(envelope.decision);
  Object.freeze(envelope.transitions);
  for (const record of envelope.transitions) Object.freeze(record);
  return Object.freeze(envelope);
}

// ── Schema validation (persistence / RPC boundary) ──

/**
 * Fail-closed structural validation for envelopes crossing a persistence or
 * RPC boundary. Checks field shapes, closed vocabularies, decision/state
 * coherence, and that the transition journal actually leads to the recorded
 * state.
 */
export function validateIntakeEnvelope(value: unknown): IntakeEnvelope {
  if (!isRecordValue(value)) {
    throw invalid('envelope', 'must be an object');
  }
  const knownKeys = [
    'schemaVersion', 'id', 'sourceClass', 'provenance', 'sourceRiskTier', 'contentRef',
    'extractedFields', 'riskLabels', 'scores', 'decision', 'state', 'createdAtMs', 'transitions',
  ];
  const unknownKeys = Object.keys(value).filter((key) => !knownKeys.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid('envelope', `has unsupported keys: ${unknownKeys.join(', ')}`);
  }
  if (value.schemaVersion !== 1) {
    throw invalid('schemaVersion', 'must be 1');
  }
  if (!isIntakeSourceClass(value.sourceClass)) {
    throw invalid('sourceClass', `must be one of: ${INTAKE_SOURCE_CLASSES.join(', ')}`);
  }
  if (!isIntakeSourceRiskTier(value.sourceRiskTier)) {
    throw invalid('sourceRiskTier', `must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`);
  }
  if (!isIntakeEnvelopeState(value.state)) {
    throw invalid('state', `must be one of: ${INTAKE_ENVELOPE_STATES.join(', ')}`);
  }
  if (!Array.isArray(value.transitions)) {
    throw invalid('transitions', 'must be an array');
  }

  const transitions = value.transitions.map(
    (record, index) => normalizeTransitionRecord(record, `transitions[${String(index)}]`),
  );
  // The journal must be a connected path from `received` to the current state.
  let cursor: IntakeEnvelopeState = 'received';
  for (const [index, record] of transitions.entries()) {
    if (record.from !== cursor) {
      throw invalid(`transitions[${String(index)}].from`, `breaks the journal chain (expected '${cursor}')`);
    }
    if (!isIntakeEnvelopeTransitionAllowed(record.from, record.to)) {
      throw invalid(`transitions[${String(index)}]`, `records illegal transition ${record.from} -> ${record.to}`);
    }
    cursor = record.to;
  }
  if (cursor !== value.state) {
    throw invalid('state', `'${String(value.state)}' does not match the transition journal (ends at '${cursor}')`);
  }

  const decision = value.decision === undefined ? undefined : normalizeDecision(value.decision);
  if (value.state !== 'received' && !decision) {
    throw invalid('decision', `is required in state '${String(value.state)}'`);
  }
  if (value.state === 'received' && decision) {
    throw invalid('decision', "must be absent in state 'received'");
  }

  const envelope: IntakeEnvelope = {
    schemaVersion: 1,
    id: normalizeIntakeEnvelopeId(value.id),
    sourceClass: value.sourceClass,
    provenance: normalizeProvenanceChain(value.provenance),
    sourceRiskTier: value.sourceRiskTier,
    contentRef: normalizeContentRef(value.contentRef),
    extractedFields: normalizeExtractedFields(value.extractedFields),
    riskLabels: normalizeRiskLabels(value.riskLabels),
    scores: normalizeScores(value.scores),
    ...(decision ? { decision } : {}),
    state: value.state,
    createdAtMs: normalizeTimestampMs(value.createdAtMs, 'createdAtMs'),
    transitions,
  };
  return freezeEnvelope(envelope);
}

// ── Creation ──

export interface CreateIntakeEnvelopeInput {
  sourceClass: IntakeSourceClass;
  /**
   * Risk tier for this source, resolved by the caller from intake-policy.json.
   * Deliberately required: the contract carries no tier defaults, so a caller
   * that skips policy resolution fails loudly instead of silently trusting.
   */
  sourceRiskTier: IntakeSourceRiskTier;
  contentRef: IntakeContentRef;
  /** Origin locator: url, channel:message id, tool call id, ... */
  origin: { ref: string; detail?: string };
  id?: string;
  atMs?: number;
}

export function createIntakeEnvelope(input: CreateIntakeEnvelopeInput): IntakeEnvelope {
  if (!isIntakeSourceClass(input.sourceClass)) {
    throw invalid('sourceClass', `must be one of: ${INTAKE_SOURCE_CLASSES.join(', ')}`);
  }
  if (!isIntakeSourceRiskTier(input.sourceRiskTier)) {
    throw invalid('sourceRiskTier', `must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`);
  }
  const atMs = input.atMs === undefined ? Date.now() : normalizeTimestampMs(input.atMs, 'atMs');
  const originHop: IntakeProvenanceHop = normalizeProvenanceHop({
    kind: input.sourceClass,
    ref: input.origin.ref,
    atMs,
    ...(input.origin.detail !== undefined ? { detail: input.origin.detail } : {}),
  }, 'origin');

  const envelope: IntakeEnvelope = {
    schemaVersion: 1,
    id: input.id === undefined ? randomUUID() : normalizeIntakeEnvelopeId(input.id),
    sourceClass: input.sourceClass,
    provenance: [originHop],
    sourceRiskTier: input.sourceRiskTier,
    contentRef: normalizeContentRef(input.contentRef),
    extractedFields: {},
    riskLabels: [],
    scores: {},
    state: 'received',
    createdAtMs: atMs,
    transitions: [],
  };
  return freezeEnvelope(envelope);
}

// ── Transitions ──

export interface IntakeEnvelopeTransitionInput {
  to: IntakeEnvelopeState;
  /** Acting principal, e.g. 'gateway:intake-screening', 'human:operator'. */
  actor: string;
  reason: string;
  atMs?: number;
  /**
   * Screening output. Required when entering 'screened' (decidedBy must be
   * 'screening' or 'policy') and when entering a 'human_*' state (decidedBy
   * must be 'human'). Rejected on every other transition.
   */
  decision?: IntakeDecision;
  /** Screening findings; only accepted when entering 'screened'. */
  riskLabels?: readonly IntakeRiskLabel[];
  scores?: Readonly<Record<string, number>>;
  extractedFields?: Readonly<Record<string, string>>;
}

/**
 * Applies one state transition and returns a NEW frozen envelope with the
 * transition appended to the journal. Rejects illegal edges and incoherent
 * decision/state combinations (fail closed).
 */
export function transitionIntakeEnvelope(
  envelope: IntakeEnvelope,
  input: IntakeEnvelopeTransitionInput,
): IntakeEnvelope {
  const from = envelope.state;
  const to = input.to;
  if (!isIntakeEnvelopeState(to)) {
    throw invalid('transition.to', `must be one of: ${INTAKE_ENVELOPE_STATES.join(', ')}`);
  }
  if (!isIntakeEnvelopeTransitionAllowed(from, to)) {
    throw new IntakeEnvelopeTransitionError({ envelopeId: envelope.id, from, to });
  }

  const enteringScreened = to === 'screened';
  const enteringHumanState = to === 'human_released' || to === 'human_released_sanitized';

  if ((input.riskLabels !== undefined || input.scores !== undefined || input.extractedFields !== undefined)
    && !enteringScreened) {
    throw new IntakeEnvelopeTransitionError({
      envelopeId: envelope.id,
      from,
      to,
      detail: 'riskLabels/scores/extractedFields may only be recorded when entering screened',
    });
  }

  let decision = envelope.decision;
  if (enteringScreened) {
    if (!input.decision) {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: 'entering screened requires a decision',
      });
    }
    decision = normalizeDecision(input.decision, 'transition.decision');
    if (decision.decidedBy === 'human') {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: "screening decisions must be decidedBy 'screening' or 'policy'",
      });
    }
  } else if (enteringHumanState) {
    if (!input.decision) {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: 'human release requires an explicit human decision',
      });
    }
    decision = normalizeDecision(input.decision, 'transition.decision');
    if (decision.decidedBy !== 'human') {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: "human release decisions must be decidedBy 'human'",
      });
    }
  } else if (input.decision !== undefined) {
    throw new IntakeEnvelopeTransitionError({
      envelopeId: envelope.id,
      from,
      to,
      detail: 'a decision may only accompany screening or human-release transitions',
    });
  }

  // Post-screening routing must match the recorded screening decision.
  if (from === 'screened') {
    if (!decision) {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: 'screened envelope is missing its decision',
      });
    }
    const expected = postScreeningStateForDecision(decision.action);
    if (to !== expected) {
      throw new IntakeEnvelopeTransitionError({
        envelopeId: envelope.id,
        from,
        to,
        detail: `decision '${decision.action}' routes to '${expected}'`,
      });
    }
  }

  const atMs = input.atMs === undefined ? Date.now() : normalizeTimestampMs(input.atMs, 'transition.atMs');
  const record: IntakeEnvelopeTransitionRecord = {
    from,
    to,
    atMs,
    actor: normalizeRequiredString(input.actor, 'transition.actor', 256),
    reason: normalizeRequiredString(input.reason, 'transition.reason', MAX_REASON_CHARS),
  };

  const riskLabels = enteringScreened && input.riskLabels !== undefined
    ? normalizeRiskLabels([...envelope.riskLabels, ...input.riskLabels])
    : envelope.riskLabels;
  const scores = enteringScreened && input.scores !== undefined
    ? normalizeScores({ ...envelope.scores, ...input.scores })
    : envelope.scores;
  const extractedFields = enteringScreened && input.extractedFields !== undefined
    ? normalizeExtractedFields({ ...envelope.extractedFields, ...input.extractedFields })
    : envelope.extractedFields;

  const next: IntakeEnvelope = {
    ...envelope,
    riskLabels,
    scores,
    extractedFields,
    ...(decision ? { decision } : {}),
    state: to,
    transitions: [...envelope.transitions, record],
  };
  return freezeEnvelope(next);
}

// ── Taint propagation (CaMeL rule) ──

export interface DeriveIntakeEnvelopeInput {
  parent: IntakeEnvelope;
  /** What kind of derived artifact this is (summary, OCR transcript, ...). */
  derivation: IntakeDerivationKind;
  /** Source class of the derived artifact (e.g. 'image_ocr' for an OCR transcript). */
  sourceClass: IntakeSourceClass;
  contentRef: IntakeContentRef;
  /**
   * Tier for the derived class, resolved from intake-policy.json. The
   * effective child tier is max(parent tier, this) — derivation can raise
   * risk, never launder it away.
   */
  sourceRiskTier?: IntakeSourceRiskTier;
  id?: string;
  atMs?: number;
}

/**
 * Derives a child envelope from a parent, propagating taint: the child
 * inherits the parent's full provenance chain plus a derivation hop that
 * references the parent envelope, and its risk tier is never lower than the
 * parent's. A summary of untrusted content stays untrusted (CaMeL,
 * arXiv 2503.18813). The child starts unscreened ('received'): derived text
 * must pass screening itself before any sink.
 */
export function deriveChildIntakeEnvelope(input: DeriveIntakeEnvelopeInput): IntakeEnvelope {
  const parent = input.parent;
  if (!isIntakeDerivationKind(input.derivation)) {
    throw invalid('derivation', `must be one of: ${INTAKE_DERIVATION_KINDS.join(', ')}`);
  }
  if (!isIntakeSourceClass(input.sourceClass)) {
    throw invalid('sourceClass', `must be one of: ${INTAKE_SOURCE_CLASSES.join(', ')}`);
  }
  if (input.sourceRiskTier !== undefined && !isIntakeSourceRiskTier(input.sourceRiskTier)) {
    throw invalid('sourceRiskTier', `must be one of: ${INTAKE_SOURCE_RISK_TIERS.join(', ')}`);
  }
  if (parent.provenance.length >= MAX_PROVENANCE_HOPS) {
    throw invalid('provenance', `derivation would exceed ${String(MAX_PROVENANCE_HOPS)} hops`);
  }
  const atMs = input.atMs === undefined ? Date.now() : normalizeTimestampMs(input.atMs, 'atMs');
  const derivationHop: IntakeProvenanceHop = {
    kind: 'derivation',
    ref: intakeEnvelopeProvenanceRef(parent.id),
    atMs,
    detail: input.derivation,
  };
  const effectiveTier = maxIntakeSourceRiskTier(
    parent.sourceRiskTier,
    input.sourceRiskTier ?? parent.sourceRiskTier,
  );

  const envelope: IntakeEnvelope = {
    schemaVersion: 1,
    id: input.id === undefined ? randomUUID() : normalizeIntakeEnvelopeId(input.id),
    sourceClass: input.sourceClass,
    provenance: [...parent.provenance, derivationHop],
    sourceRiskTier: effectiveTier,
    contentRef: normalizeContentRef(input.contentRef),
    extractedFields: {},
    riskLabels: [],
    scores: {},
    state: 'received',
    createdAtMs: atMs,
    transitions: [],
  };
  return freezeEnvelope(envelope);
}

// ── Write stamping (memory / wiki provenance refs) ──

/**
 * Canonical provenance-ref prefix used to stamp memory and wiki writes with
 * the originating envelope id. Stamped refs ride the existing persisted
 * `provenanceRefs` arrays, so a poisoned source's lineage is excisable later
 * through the existing revocation/regeneration machinery
 * (src/core/cogsec/lineage.ts) without any storage schema change.
 */
export const INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX = 'intake-envelope:';

export function intakeEnvelopeProvenanceRef(intakeEnvelopeId: string): string {
  return `${INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX}${normalizeIntakeEnvelopeId(intakeEnvelopeId)}`;
}

export function parseIntakeEnvelopeIdFromProvenanceRef(ref: string): string | null {
  if (!ref.startsWith(INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX)) return null;
  const candidate = ref.slice(INTAKE_ENVELOPE_PROVENANCE_REF_PREFIX.length);
  return INTAKE_ENVELOPE_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Returns `refs` with the canonical envelope ref appended (deduplicated).
 * A malformed envelope id throws instead of being silently dropped.
 */
export function appendIntakeEnvelopeProvenanceRef(
  refs: readonly string[] | undefined,
  intakeEnvelopeId: string | undefined,
): string[] {
  const base = [...(refs ?? [])];
  if (intakeEnvelopeId === undefined) return base;
  const canonical = intakeEnvelopeProvenanceRef(intakeEnvelopeId);
  if (!base.includes(canonical)) base.push(canonical);
  return base;
}

// ── Message routing snapshot ──

export type IntakeEnvelopeSubject =
  | { kind: 'body' }
  | { kind: 'attachment'; index: number };

/**
 * Decision snapshot attached to `MessageRoutingMetadata.intakeEnvelopes`.
 * This is a point-in-time projection for cheap sink-gate reads; the envelope
 * journal (htm9.2) stays authoritative. Optional everywhere so existing
 * message construction sites are untouched until adapters start stamping.
 */
export interface IntakeEnvelopeSnapshot {
  envelopeId: string;
  sourceClass: IntakeSourceClass;
  sourceRiskTier: IntakeSourceRiskTier;
  state: IntakeEnvelopeState;
  riskLabels: readonly IntakeRiskLabel[];
  /** What the envelope covers on this message. */
  subject: IntakeEnvelopeSubject;
}

export function snapshotIntakeEnvelope(
  envelope: IntakeEnvelope,
  subject: IntakeEnvelopeSubject,
): IntakeEnvelopeSnapshot {
  if (subject.kind === 'attachment'
    && (!Number.isInteger(subject.index) || subject.index < 0)) {
    throw invalid('subject.index', 'must be a non-negative integer');
  }
  return {
    envelopeId: envelope.id,
    sourceClass: envelope.sourceClass,
    sourceRiskTier: envelope.sourceRiskTier,
    state: envelope.state,
    riskLabels: [...envelope.riskLabels],
    subject,
  };
}
