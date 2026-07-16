// mmo9.7.1 — pure derivation of the runtime lane class for an autonomous model
// call. Law 12.4: there is exactly ONE lane resolver
// (`resolveRuntimeLaneClassForModelCall`). This module only adapts a raw
// completion purpose + correlation into that resolver's inputs, mirroring the
// exact construction the LLMClient gate uses, so a declared `LLMWorkSpec.lane`
// can be reconciled byte-identically. It adds no second resolver, admission
// path, or budget system.

import {
  COMPANION_PRIVATE_BACKGROUND_PURPOSE,
  type CompletionPurpose,
  type CorrelationMetadata,
  type ObservabilityCallType,
} from '../../shared/contracts/runtime.js';
import {
  resolveRuntimeLaneClassForModelCall,
  type ModelCallRuntimePurpose,
} from '../../core/agent/worker-lanes.js';
import type { RuntimeLaneClass } from '../../shared/contracts/runtime-lanes.js';
import {
  inferCallType,
  normalizeCorrelationValue,
} from './correlation.js';
import { isObservabilityCallType } from '../../shared/contracts/observability-call-types.js';

/**
 * Mirror of `LLMClient.toRoutingPurpose` for lane derivation. Kept a pure
 * function so both the client's gate path and the work-spec builder agree; the
 * parity test asserts every current call site derives the same lane the gate
 * resolves, so any drift fails closed.
 */
export function toModelCallRoutingPurpose(purpose: CompletionPurpose): ModelCallRuntimePurpose {
  switch (purpose) {
    case 'reasoning':
      return 'reasoning';
    case 'import_processing':
      return 'import_processing';
    case 'memory':
      return 'memory';
    case 'context':
      return 'context';
    case 'extraction':
      return 'extraction';
    case 'summary':
      return 'summary';
    case 'vision':
      return 'vision';
    case 'chat':
    case 'background':
    default:
      return 'background';
  }
}

/**
 * Derive the runtime lane for an autonomous model call from its completion
 * purpose and RAW correlation. This reproduces the lane-relevant fields
 * (callType, channelId, originStage, companion-private collapse) that the
 * client's `resolveCorrelationMetadata` produces, but deliberately does NOT run
 * ICP field-agreement validation or ICP channel substitution: that validation is
 * the CLIENT's job at call time and must happen exactly once (running it here
 * would double it and reject lane derivation before the real call). For every
 * VALID correlation this is byte-identical to the client's gate lane (the client
 * requires `channelId` to match the ICP channel, so the resolved and raw
 * channelIds agree); the client's runtime parity assertion fails closed on any
 * residual disagreement. This is what {@link buildLLMWorkSpec} declares as
 * `LLMWorkSpec.lane`.
 */
export function resolveAutonomousModelCallLane(
  purpose: CompletionPurpose,
  correlation: Partial<CorrelationMetadata> | undefined,
): RuntimeLaneClass {
  const routingPurpose = toModelCallRoutingPurpose(purpose);
  // Companion-private work collapses to a background lane, mirroring the client's
  // resolveCorrelationMetadata short-circuit.
  if (correlation?.telemetryVisibility === 'companion_private') {
    return resolveRuntimeLaneClassForModelCall({
      purpose: routingPurpose,
      callType: 'background',
      originStage: COMPANION_PRIVATE_BACKGROUND_PURPOSE,
    });
  }
  const channelId = normalizeCorrelationValue(correlation?.channelId);
  const validCallType = correlation && isObservabilityCallType(correlation.callType)
    ? correlation.callType
    : undefined;
  const validOriginType = correlation && isObservabilityCallType(correlation.originType)
    ? correlation.originType
    : undefined;
  const callType: ObservabilityCallType = validCallType
    ?? validOriginType
    ?? inferCallType(purpose, channelId);
  const originStage = normalizeCorrelationValue(correlation?.originStage)
    ?? normalizeCorrelationValue(correlation?.purpose)
    ?? String(purpose);
  return resolveRuntimeLaneClassForModelCall({
    purpose: routingPurpose,
    callType,
    ...(channelId ? { channelId } : {}),
    ...(originStage ? { originStage } : {}),
  });
}
