// psfn-framework-d8vq.2 — serializable wire form of an LLMWorkSpec for the
// gateway RPC contract, plus a fail-closed boundary parser.
//
// In the split gateway/agent topology the accountability guard
// (`assertAutonomousCallAccountable`) and lane reconciliation
// (`validateWorkSpecForCall`) run on the GATEWAY-side LLMClient — the process
// that owns the usageRecorder and performs provider I/O. For those to fire, the
// declared LLMWorkSpec must cross the RPC boundary. This module defines the wire
// shape the agent-side gateway client sends and the gateway handler parses.
//
// Law 12.4 (single lane resolver): the wire spec carries the DECLARED `lane`
// only; the serving-side client still reconciles it byte-identically against the
// runtime lane resolver. This module adds no second resolver, admission, or
// budget path — only structural validation of untrusted wire input.

import {
  isCompletionPurpose,
  type LLMWorkCancellation,
  type LLMWorkRetryPolicy,
  type LLMWorkSpec,
} from '../../shared/contracts/runtime.js';
import { isRuntimeLaneClass } from '../../core/agent/worker-lanes.js';

/**
 * The gateway wire form of an {@link LLMWorkSpec}: every structural field EXCEPT
 * the nested `correlation`. The correlation lineage crosses the boundary exactly
 * once, through the flat `GatewayCorrelationParams` (already companion-private
 * stripped by the agent-side client), so it is never duplicated on the spec. The
 * serving-side LLMClient reconciles the declared `lane` against the correlation
 * it rebuilds from those params — a spec.correlation on the wire would be a
 * redundant second channel (and, for companion-private work, a re-identifying
 * leak), so it is deliberately dropped.
 */
export type LLMWorkSpecWireParams = Omit<LLMWorkSpec, 'correlation'>;

const CANCELLATIONS: ReadonlySet<LLMWorkCancellation> = new Set([
  'caller_signal',
  'deadline',
  'none',
]);
const RETRY_POLICIES: ReadonlySet<LLMWorkRetryPolicy> = new Set(['inherit', 'none']);

/**
 * Project a full {@link LLMWorkSpec} to its wire form, dropping the nested
 * correlation (which rides the flat correlation params instead).
 */
export function toWorkSpecWireParams(spec: LLMWorkSpec): LLMWorkSpecWireParams {
  const { correlation: _correlation, ...wire } = spec;
  return wire;
}

/** Thrown for a structurally malformed wire work spec. */
export class MalformedWorkSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedWorkSpecError';
  }
}

function requireFinitePositive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.${field} must be a finite positive number when present`,
    );
  }
  return value;
}

function requireFiniteNonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.${field} must be a finite non-negative number when present`,
    );
  }
  return value;
}

/**
 * Parse and validate an untrusted wire value into an {@link LLMWorkSpecWireParams}.
 * Fails closed (throws {@link MalformedWorkSpecError}) on any missing required
 * field or out-of-domain value, and returns a clean object carrying only the
 * recognized fields (arbitrary extra wire keys are dropped, never forwarded).
 */
export function parseWorkSpecWireParams(value: unknown): LLMWorkSpecWireParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MalformedWorkSpecError('LLMWorkSpec must be an object');
  }
  const raw = value as Record<string, unknown>;

  if (!isCompletionPurpose(raw.purpose)) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.purpose ${JSON.stringify(raw.purpose)} is not a valid completion purpose`,
    );
  }
  if (typeof raw.lane !== 'string' || !isRuntimeLaneClass(raw.lane)) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.lane ${JSON.stringify(raw.lane)} is not a valid runtime lane class`,
    );
  }
  if (typeof raw.durable !== 'boolean') {
    throw new MalformedWorkSpecError('LLMWorkSpec.durable must be a boolean');
  }
  if (raw.preemptionProtected !== undefined && typeof raw.preemptionProtected !== 'boolean') {
    throw new MalformedWorkSpecError('LLMWorkSpec.preemptionProtected must be a boolean when present');
  }
  // fxt1: the welfare grant proof, when present, must be a non-empty string.
  // The gateway re-verifies it against the store before honoring
  // preemptionProtected; a malformed/empty id is rejected here (fail closed)
  // rather than silently reaching the verify step.
  if (raw.welfareGrantJobId !== undefined
    && (typeof raw.welfareGrantJobId !== 'string' || raw.welfareGrantJobId.trim().length === 0)) {
    throw new MalformedWorkSpecError(
      'LLMWorkSpec.welfareGrantJobId must be a non-empty string when present',
    );
  }
  if (raw.cancellation !== undefined
    && !CANCELLATIONS.has(raw.cancellation as LLMWorkCancellation)) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.cancellation ${JSON.stringify(raw.cancellation)} is not a valid cancellation mode`,
    );
  }
  if (raw.retryPolicy !== undefined
    && !RETRY_POLICIES.has(raw.retryPolicy as LLMWorkRetryPolicy)) {
    throw new MalformedWorkSpecError(
      `LLMWorkSpec.retryPolicy ${JSON.stringify(raw.retryPolicy)} is not a valid retry policy`,
    );
  }

  const wire: LLMWorkSpecWireParams = {
    purpose: raw.purpose,
    lane: raw.lane,
    durable: raw.durable,
    ...(raw.maxOutputTokens !== undefined
      ? { maxOutputTokens: requireFinitePositive(raw.maxOutputTokens, 'maxOutputTokens') }
      : {}),
    ...(raw.deadlineMs !== undefined
      ? { deadlineMs: requireFinitePositive(raw.deadlineMs, 'deadlineMs') }
      : {}),
    ...(raw.tokenCeiling !== undefined
      ? { tokenCeiling: requireFinitePositive(raw.tokenCeiling, 'tokenCeiling') }
      : {}),
    ...(raw.costCeilingUsd !== undefined
      ? { costCeilingUsd: requireFiniteNonNegative(raw.costCeilingUsd, 'costCeilingUsd') }
      : {}),
    ...(raw.cancellation !== undefined
      ? { cancellation: raw.cancellation as LLMWorkCancellation }
      : {}),
    ...(raw.retryPolicy !== undefined
      ? { retryPolicy: raw.retryPolicy as LLMWorkRetryPolicy }
      : {}),
    ...(raw.preemptionProtected !== undefined
      ? { preemptionProtected: raw.preemptionProtected }
      : {}),
    ...(raw.welfareGrantJobId !== undefined
      ? { welfareGrantJobId: raw.welfareGrantJobId }
      : {}),
  };
  return wire;
}
