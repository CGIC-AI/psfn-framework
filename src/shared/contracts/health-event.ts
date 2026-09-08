// ── Runtime health-event envelope (bead psfn-framework-7qeo1.24.1) ──
//
// S12B builds a first-party causal observability plane. The runtime already
// emits plenty of operational signal — EventBus telemetry, subsystem lane
// health rings, background-work counters, operator-alert sink state — but each
// carries its own shape, so nothing downstream can join a Postgres connection
// storm, a stalled scheduler task, and a repeated background-work failure into
// one incident.
//
// This module owns THE shape every operational signal is projected into before
// it reaches the persisted health stream or a detector. Its defining property
// is that it is CONTENT-FREE by construction, not by convention:
//
//   * Every string-typed field is drawn from a closed vocabulary declared here
//     (`code`, `severity`, `component`, `process`, `owner.kind`) or is a
//     structurally constrained identifier (RFC-4122 UUID, or lowercase SHA-256
//     hex). There is no free-text field at all — no message, no error text, no
//     detail, no path, no label.
//   * Structured evidence is a bounded map from an ENUMERATED key to a finite
//     number or a boolean. A string can never be an evidence value, so no
//     caller can smuggle a rendered error through it.
//   * A specific runtime subject (a task id, a job kind, a session id) is
//     carried only as `provenance.subjectHash` — a SHA-256 digest produced by
//     {@link hashHealthEventSubject}. Detectors can still group by subject; the
//     stream never learns the identifier.
//
// Ownership is explicit: an event belongs to the system as a whole or to
// exactly one companion, so a fleet deployment never mixes tenancy in an
// incident.
//
// Two entry points, deliberately split:
//   * {@link createHealthEvent} is the emitter seam. The compiler enforces the
//     closed vocabularies, so an emitter inside a catch block cannot mask the
//     original failure with a validation throw for a field the type system
//     already proved.
//   * {@link validateHealthEvent} is the untrusted-boundary seam (persistence
//     read-back, RPC, a future detector fed from another process). It fails
//     closed on unknown keys, unknown vocabulary members, and malformed ids.
//
// Non-goals: raw application logs, conversation content, alert delivery, and
// detection policy. Detectors (children .2-.4) consume this envelope; alert
// delivery (child .5) consumes their output.

import { createHash, randomUUID } from 'node:crypto';
import { isRecord } from '../utils/types.js';
import { createCompanionId, parseCompanionId, type CompanionId } from '../routing/companion-id.js';
import type { CorrelationMetadata } from './runtime-base.js';

/** Which runtime process observed the condition. */
const HEALTH_EVENT_PROCESSES = [
  'gateway',
  'agent',
  'operator',
] as const;

type HealthEventProcess = typeof HEALTH_EVENT_PROCESSES[number];

function isHealthEventProcess(value: unknown): value is HealthEventProcess {
  return typeof value === 'string'
    && (HEALTH_EVENT_PROCESSES as readonly string[]).includes(value);
}

/**
 * Which subsystem the condition belongs to. Closed on purpose: a detector
 * groups by component, and an open string would be the first place free text
 * leaked into the stream.
 *
 * This and the sibling vocabularies below stay module-local until a consumer
 * outside this contract actually needs them: the dead-export gate is
 * reduction-only, so a detector child exports what it imports rather than the
 * envelope publishing names nothing reads.
 */
const HEALTH_EVENT_COMPONENTS = [
  'operator_alerting',
  'background_work',
  'scheduler',
  'persistence',
] as const;

export type HealthEventComponent = typeof HEALTH_EVENT_COMPONENTS[number];

function isHealthEventComponent(value: unknown): value is HealthEventComponent {
  return typeof value === 'string'
    && (HEALTH_EVENT_COMPONENTS as readonly string[]).includes(value);
}

/**
 * The enumerated condition. This is the ONLY carrier of "what happened"; an
 * emitter that needs to say something new adds a code here rather than a
 * sentence anywhere.
 */
const HEALTH_EVENT_CODES = [
  /** Operator alerting resolved zero configured sinks; alerts cannot leave. */
  'operator_alert_sinks_unconfigured',
  /** A background-work job reached its terminal failed state. */
  'background_work_job_failed',
  /** A registered scheduler task threw out of its handler. */
  'scheduler_task_failed',
  /**
   * One bounded observation of a PostgreSQL pool authority above its
   * owner-file pressure thresholds. Emitted only while the sample is
   * unhealthy: a healthy pool contributes nothing to the stream, so a
   * detector counting these is counting real pressure, not traffic.
   */
  'postgres_pool_pressure_sampled',
  /** Sustained PostgreSQL pool saturation/queueing became one open incident. */
  'postgres_pool_pressure_opened',
  /** That incident's pool authority returned to healthy samples. */
  'postgres_pool_pressure_closed',
] as const;

export type HealthEventCode = typeof HEALTH_EVENT_CODES[number];

function isHealthEventCode(value: unknown): value is HealthEventCode {
  return typeof value === 'string'
    && (HEALTH_EVENT_CODES as readonly string[]).includes(value);
}

/**
 * Incident families (beads psfn-framework-7qeo1.24.2-.4).
 *
 * A detector never emits a lone "something is wrong" row. It opens an EPISODE:
 * one `opened` event carrying a fresh `correlationId`, further `opened` events
 * on the same `correlationId` with a rising `occurrenceCount` while the
 * condition persists, and exactly one `closed` event when it recovers. This
 * table is the only place that pairing is declared, so the ledger that rebuilds
 * open episodes from the persisted stream, the detector that opens them, and
 * the alert delivery that consumes them (child .5) cannot drift apart.
 *
 * The `opened` code is deliberately reused for the occurrence updates rather
 * than a third "still open" code: an incident is identified by its
 * `correlationId`, so a consumer deduplicates on that and never has to know
 * whether a row was the first observation or the fortieth.
 */
const HEALTH_INCIDENT_FAMILY_CODES = {
  postgres_pool_pressure: {
    opened: 'postgres_pool_pressure_opened',
    closed: 'postgres_pool_pressure_closed',
  },
} as const satisfies Readonly<Record<string, { opened: HealthEventCode; closed: HealthEventCode }>>;

/** The condition an episode is about. One detector owns one family. */
export type HealthIncidentFamily = keyof typeof HEALTH_INCIDENT_FAMILY_CODES;

/** Whether an episode row opened (or extended) an incident, or closed it. */
export type HealthIncidentPhase = 'opened' | 'closed';

/** The `opened`/`closed` code pair a detector emits for its family. */
export function healthIncidentCodes(
  family: HealthIncidentFamily,
): { opened: HealthEventCode; closed: HealthEventCode } {
  return HEALTH_INCIDENT_FAMILY_CODES[family];
}

/**
 * Read seam for every consumer of the persisted stream: classify a stored code
 * back into its family and phase. A code that is an ordinary observation rather
 * than an episode boundary returns null, which is how the ledger tells a
 * `postgres_pool_pressure_sampled` row from the incident it contributed to.
 */
export function resolveHealthIncidentPhase(
  code: HealthEventCode,
): { family: HealthIncidentFamily; phase: HealthIncidentPhase } | null {
  for (const [family, codes] of Object.entries(HEALTH_INCIDENT_FAMILY_CODES)) {
    if (codes.opened === code) {
      return { family: family as HealthIncidentFamily, phase: 'opened' };
    }
    if (codes.closed === code) {
      return { family: family as HealthIncidentFamily, phase: 'closed' };
    }
  }
  return null;
}

/** Ordered least to most severe, so a detector can take a maximum. */
const HEALTH_EVENT_SEVERITIES = [
  'info',
  'warning',
  'degraded',
  'critical',
] as const;

export type HealthEventSeverity = typeof HEALTH_EVENT_SEVERITIES[number];

function isHealthEventSeverity(value: unknown): value is HealthEventSeverity {
  return typeof value === 'string'
    && (HEALTH_EVENT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Who the condition belongs to. `system` is the whole runtime (a shared pool, a
 * missing operator sink); `companion` binds the event to exactly one tenant so
 * a fleet incident never mixes companions.
 */
export type HealthEventOwner =
  | { kind: 'system' }
  | { kind: 'companion'; companionId: CompanionId };

/**
 * Enumerated structured-evidence keys. Values are numbers or booleans only —
 * see the module header. Detector children extend this list; they do not
 * extend the value type.
 */
const HEALTH_EVENT_EVIDENCE_KEYS = [
  'activeConnections',
  'attemptCount',
  'configuredSinkCount',
  'durationMs',
  'jobAgeMs',
  'poolCapacity',
  'queueDepth',
  'sampleCount',
  'saturationPercent',
  'terminal',
  'waitingRequests',
] as const;

type HealthEventEvidenceKey = typeof HEALTH_EVENT_EVIDENCE_KEYS[number];

function isHealthEventEvidenceKey(value: unknown): value is HealthEventEvidenceKey {
  return typeof value === 'string'
    && (HEALTH_EVENT_EVIDENCE_KEYS as readonly string[]).includes(value);
}

export type HealthEventEvidence = Partial<Record<HealthEventEvidenceKey, number | boolean>>;

/**
 * Where the observation came from. `observerId` identifies the emitting process
 * instance, so a detector can tell "one process failing repeatedly" from "every
 * process failing once". `subjectHash` is the opaque per-subject grouping key
 * described in the module header.
 */
interface HealthEventProvenance {
  process: HealthEventProcess;
  component: HealthEventComponent;
  observerId: string;
  subjectHash?: string;
}

/**
 * One content-free operational observation.
 *
 * `correlationId` groups every event belonging to one incident; `causationId`
 * names the exact `eventId` this observation was caused by, so a detector can
 * rebuild a causal chain rather than a flat list. `occurrenceCount` lets an
 * emitter coalesce a burst into one row: `firstObservedAtMs` and
 * `lastObservedAtMs` then bound the burst, and `recordedAtMs` is when the
 * envelope itself was minted.
 */
export interface HealthEvent {
  schemaVersion: 1;
  eventId: string;
  correlationId: string;
  causationId?: string;
  owner: HealthEventOwner;
  severity: HealthEventSeverity;
  code: HealthEventCode;
  provenance: HealthEventProvenance;
  occurrenceCount: number;
  firstObservedAtMs: number;
  lastObservedAtMs: number;
  recordedAtMs: number;
  evidence: HealthEventEvidence;
}

// ── Structural bounds ──
//
// Schema-shape limits that keep an untrusted row from becoming unbounded. They
// are not operator-tunable policy: changing one changes the wire contract, so
// they stay code-owned next to the schema they define. The operator-owned
// bound on this subsystem is the stream's row cap, in settings.json.

const HEALTH_EVENT_SCHEMA_VERSION = 1;
const MAX_EVIDENCE_ENTRIES = 16;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Identity of THIS process instance, minted once per boot. Every emitter in the
 * process stamps the same value, which is what lets a detector separate one
 * sick process from a fleet-wide fault. It is a bare UUID: content-free, and it
 * deliberately does not survive a restart.
 */
const PROCESS_OBSERVER_ID = randomUUID();

export function processObserverId(): string {
  return PROCESS_OBSERVER_ID;
}

const HEALTH_EVENT_KEYS: readonly string[] = [
  'schemaVersion',
  'eventId',
  'correlationId',
  'causationId',
  'owner',
  'severity',
  'code',
  'provenance',
  'occurrenceCount',
  'firstObservedAtMs',
  'lastObservedAtMs',
  'recordedAtMs',
  'evidence',
];

const HEALTH_EVENT_PROVENANCE_KEYS: readonly string[] = [
  'process',
  'component',
  'observerId',
  'subjectHash',
];

const HEALTH_EVENT_OWNER_KEYS: readonly string[] = ['kind', 'companionId'];

function invalid(field: string, detail: string): Error {
  return new Error(`Invalid health event: ${field} ${detail}`);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  field: string,
): void {
  const unknownKeys = Object.keys(value).filter((key) => !known.includes(key));
  if (unknownKeys.length > 0) {
    throw invalid(field, `has unsupported keys: ${unknownKeys.sort().join(', ')}`);
  }
}

function normalizeUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalid(field, 'must be a lowercase RFC-4122 UUID');
  }
  return value;
}

function normalizeTimestampMs(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(field, 'must be a non-negative safe-integer epoch-milliseconds number');
  }
  return value;
}

function normalizeOccurrenceCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw invalid(field, 'must be a positive safe integer');
  }
  return value;
}

/**
 * Hash a runtime subject identifier (task id, job kind, session id) into the
 * opaque grouping key the envelope carries. Emitters MUST route every
 * unbounded identifier through this: it is what keeps `provenance.subjectHash`
 * correlatable without the stream learning the identifier itself.
 *
 * Choose the granularity the detector needs — hashing a job KIND groups every
 * failure of that kind together, hashing a job ID makes each failure its own
 * group and defeats repeat detection.
 */
export function hashHealthEventSubject(subject: string): string {
  const normalized = subject.trim();
  if (!normalized) {
    throw new Error('Invalid health event: subject must be a non-empty string');
  }
  return createHash('sha256').update(normalized).digest('hex');
}

function normalizeOwner(value: unknown): HealthEventOwner {
  if (!isRecord(value)) {
    throw invalid('owner', 'must be an object');
  }
  rejectUnknownKeys(value, HEALTH_EVENT_OWNER_KEYS, 'owner');
  if (value.kind === 'system') {
    if (value.companionId !== undefined) {
      throw invalid('owner.companionId', 'must be absent for system-owned events');
    }
    return { kind: 'system' };
  }
  if (value.kind !== 'companion') {
    throw invalid('owner.kind', "must be 'system' or 'companion'");
  }
  return {
    kind: 'companion',
    companionId: createCompanionId(value.companionId, 'owner.companionId'),
  };
}

/**
 * Resolve envelope ownership from a runtime identity. A core companion routing
 * identity binds the event to that tenant.
 *
 * Anything else — an absent identity, or one the routing contract does not
 * recognize — has no core tenancy to attribute the observation to, so it is
 * recorded as system-owned rather than guessed onto a companion that did not
 * produce it. `loadConfig` already validates `COMPANION_ID` through
 * `createCompanionId` for both the agent and gateway processes, so in a real
 * runtime that branch is a defensive floor rather than an expected path.
 */
export function resolveHealthEventOwner(companionId: string | undefined): HealthEventOwner {
  const parsed = parseCompanionId(companionId);
  return parsed === null ? { kind: 'system' } : { kind: 'companion', companionId: parsed };
}

function normalizeProvenance(value: unknown): HealthEventProvenance {
  if (!isRecord(value)) {
    throw invalid('provenance', 'must be an object');
  }
  rejectUnknownKeys(value, HEALTH_EVENT_PROVENANCE_KEYS, 'provenance');
  if (!isHealthEventProcess(value.process)) {
    throw invalid('provenance.process', `must be one of: ${HEALTH_EVENT_PROCESSES.join(', ')}`);
  }
  if (!isHealthEventComponent(value.component)) {
    throw invalid('provenance.component', `must be one of: ${HEALTH_EVENT_COMPONENTS.join(', ')}`);
  }
  const provenance: HealthEventProvenance = {
    process: value.process,
    component: value.component,
    observerId: normalizeUuid(value.observerId, 'provenance.observerId'),
  };
  if (value.subjectHash !== undefined) {
    if (typeof value.subjectHash !== 'string' || !SHA256_HEX_PATTERN.test(value.subjectHash)) {
      throw invalid('provenance.subjectHash', 'must be 64 lowercase hex characters');
    }
    provenance.subjectHash = value.subjectHash;
  }
  return provenance;
}

function normalizeEvidence(value: unknown): HealthEventEvidence {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw invalid('evidence', 'must be an object');
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_EVIDENCE_ENTRIES) {
    throw invalid('evidence', `exceeds ${String(MAX_EVIDENCE_ENTRIES)} entries`);
  }
  const evidence: HealthEventEvidence = {};
  for (const [key, entry] of entries) {
    if (!isHealthEventEvidenceKey(key)) {
      throw invalid('evidence', `has unsupported key: ${key}`);
    }
    if (typeof entry === 'boolean') {
      evidence[key] = entry;
      continue;
    }
    // The content-free guarantee lives here: strings, objects, arrays, and
    // non-finite numbers are all refused, so nothing narrative can ride along.
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      throw invalid(`evidence.${key}`, 'must be a finite number or a boolean');
    }
    evidence[key] = entry;
  }
  return evidence;
}

function freezeHealthEvent(event: HealthEvent): HealthEvent {
  Object.freeze(event.owner);
  Object.freeze(event.provenance);
  Object.freeze(event.evidence);
  return Object.freeze(event);
}

/**
 * Emitter input. Omitting `correlationId` starts a new incident; passing one
 * joins an existing incident. Omitting `occurrenceCount` records a single
 * occurrence, in which case `lastObservedAtMs` defaults to `observedAtMs`.
 */
export interface HealthEventInput {
  owner: HealthEventOwner;
  severity: HealthEventSeverity;
  code: HealthEventCode;
  provenance: HealthEventProvenance;
  observedAtMs: number;
  eventId?: string;
  correlationId?: string;
  causationId?: string;
  occurrenceCount?: number;
  lastObservedAtMs?: number;
  recordedAtMs?: number;
  evidence?: HealthEventEvidence;
}

/**
 * Emitter seam. The compiler enforces every closed vocabulary, so this only has
 * to fill in identity/timestamp defaults and re-check what TypeScript cannot:
 * identifier shape, ordering, and the evidence value domain.
 */
export function createHealthEvent(input: HealthEventInput): HealthEvent {
  const firstObservedAtMs = normalizeTimestampMs(input.observedAtMs, 'observedAtMs');
  const lastObservedAtMs = input.lastObservedAtMs === undefined
    ? firstObservedAtMs
    : normalizeTimestampMs(input.lastObservedAtMs, 'lastObservedAtMs');
  if (lastObservedAtMs < firstObservedAtMs) {
    throw invalid('lastObservedAtMs', 'must be greater than or equal to firstObservedAtMs');
  }
  const event: HealthEvent = {
    schemaVersion: HEALTH_EVENT_SCHEMA_VERSION,
    eventId: input.eventId === undefined ? randomUUID() : normalizeUuid(input.eventId, 'eventId'),
    correlationId: input.correlationId === undefined
      ? randomUUID()
      : normalizeUuid(input.correlationId, 'correlationId'),
    owner: normalizeOwner(input.owner),
    severity: input.severity,
    code: input.code,
    provenance: normalizeProvenance(input.provenance),
    occurrenceCount: normalizeOccurrenceCount(input.occurrenceCount ?? 1, 'occurrenceCount'),
    firstObservedAtMs,
    lastObservedAtMs,
    recordedAtMs: input.recordedAtMs === undefined
      ? lastObservedAtMs
      : normalizeTimestampMs(input.recordedAtMs, 'recordedAtMs'),
    evidence: normalizeEvidence(input.evidence),
  };
  if (input.causationId !== undefined) {
    event.causationId = normalizeUuid(input.causationId, 'causationId');
  }
  return freezeHealthEvent(event);
}

/**
 * Untrusted-boundary seam: persistence read-back, RPC, or any producer the
 * compiler did not check. Fails closed on unknown keys at every level, unknown
 * vocabulary members, malformed identifiers, and any evidence value that is not
 * a finite number or a boolean.
 */
export function validateHealthEvent(value: unknown): HealthEvent {
  if (!isRecord(value)) {
    throw invalid('event', 'must be an object');
  }
  rejectUnknownKeys(value, HEALTH_EVENT_KEYS, 'event');
  if (value.schemaVersion !== HEALTH_EVENT_SCHEMA_VERSION) {
    throw invalid('schemaVersion', `must be ${String(HEALTH_EVENT_SCHEMA_VERSION)}`);
  }
  if (!isHealthEventSeverity(value.severity)) {
    throw invalid('severity', `must be one of: ${HEALTH_EVENT_SEVERITIES.join(', ')}`);
  }
  if (!isHealthEventCode(value.code)) {
    throw invalid('code', `must be one of: ${HEALTH_EVENT_CODES.join(', ')}`);
  }
  return createHealthEvent({
    owner: normalizeOwner(value.owner),
    severity: value.severity,
    code: value.code,
    provenance: normalizeProvenance(value.provenance),
    observedAtMs: normalizeTimestampMs(value.firstObservedAtMs, 'firstObservedAtMs'),
    eventId: normalizeUuid(value.eventId, 'eventId'),
    correlationId: normalizeUuid(value.correlationId, 'correlationId'),
    ...(value.causationId === undefined
      ? {}
      : { causationId: normalizeUuid(value.causationId, 'causationId') }),
    occurrenceCount: normalizeOccurrenceCount(value.occurrenceCount, 'occurrenceCount'),
    lastObservedAtMs: normalizeTimestampMs(value.lastObservedAtMs, 'lastObservedAtMs'),
    recordedAtMs: normalizeTimestampMs(value.recordedAtMs, 'recordedAtMs'),
    evidence: normalizeEvidence(value.evidence),
  });
}

/**
 * The identity an emitter stamps on every event it publishes: whose runtime the
 * observation belongs to, and which process saw it. A component that runs in
 * more than one process (the scheduler, the detector cycle) knows neither, so
 * the entrypoint constructing it declares this once.
 */
export interface HealthEventSource {
  owner: HealthEventOwner;
  process: HealthEventProcess;
}

/**
 * Structural emitter port, mirroring `TurnPerformanceEventEmitter`. Taking the
 * narrow shape rather than the concrete `EventBus` keeps emitters testable and
 * keeps this contract free of a dependency on the bus module that registers it.
 */
export interface HealthEventPublisher {
  emit(
    event: 'runtime.health.event',
    data: { event: HealthEvent } & Partial<CorrelationMetadata>,
  ): Promise<void>;
}

/**
 * The single typed emit seam every producer uses. Correlation metadata rides
 * beside the envelope exactly as it does for every other bus event: it is
 * in-process routing context, and the persisting sink drops it — only `event`
 * reaches the stream.
 *
 * Async so a construction failure surfaces as a rejection rather than a throw
 * inside a caller's catch block; emitters in error paths attach a logged catch
 * instead of letting a telemetry fault mask the fault being reported.
 */
export async function emitHealthEvent(
  publisher: HealthEventPublisher,
  input: HealthEventInput,
  correlation: Partial<CorrelationMetadata> = {},
): Promise<void> {
  await publisher.emit('runtime.health.event', {
    ...correlation,
    event: createHealthEvent(input),
  });
}
