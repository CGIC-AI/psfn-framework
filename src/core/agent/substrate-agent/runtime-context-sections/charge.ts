// ── Charge-budget section producer (E2.6) ──
// Bare charge-budget values (E2.5 purity rule): the numbers and the costed
// surface lines are data; the sentence framing lives in the editable
// runtime.charge_budget prompt layer. The run-charge snapshot is a declared
// input — the orchestrator reads it from the request context once and passes
// it in.

import { isRecord } from '../../../../shared/utils/types.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  CHARGE_POLICY_SURFACE_VALUES,
  type ChargePolicyConfig,
  type ChargePolicyRuntimeLane,
  type ChargePolicySurface,
} from '../../../../shared/contracts/charge-policy.js';
import type { RunChargeSnapshot } from '../../../../shared/telemetry/run-charge.js';

const CHARGE_SURFACE_PROMPT_LABELS: Record<ChargePolicySurface, string> = {
  ownerFileInspection: 'owner-file inspection',
  localFilesystem: 'local filesystem read',
  memoryRead: 'memory read',
  memoryWrite: 'memory write through direct memory tools',
  localEmbedding: 'local embedding',
  externalEmbedding: 'external embedding',
  localImageGeneration: 'local image generation',
  paidImageGeneration: 'paid image/video generation',
  analysisWorkbenchExtensionBand: 'analysis_workbench extension pass after the first iteration',
  subagentLaunch: 'subagent launch',
  shardLaunch: 'shard launch',
  externalModelConsult: 'external model consult',
  moaRoundBase: 'multi-model deliberation round',
};

const ANALYSIS_WORKBENCH_EXTENSION_SURFACE: ChargePolicySurface = 'analysisWorkbenchExtensionBand';

function isChargePolicyRuntimeLane(value: string): value is ChargePolicyRuntimeLane {
  return (CHARGE_POLICY_RUNTIME_LANE_VALUES as readonly string[]).includes(value);
}

function isChargePolicyConfig(value: unknown): value is ChargePolicyConfig {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== 1) return false;
  return (
    isRecord(value.runChargeQuotaByLane)
    && isRecord(value.surfaceCosts)
    && isRecord(value.moa)
    && isRecord(value.referenceModelClassPricing)
  );
}

export function resolveChargePolicyConfig(config: Record<string, unknown> | undefined): ChargePolicyConfig | null {
  const raw = config?.chargePolicy;
  return isChargePolicyConfig(raw) ? raw : null;
}

function formatChargeAmount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

export function buildChargePromptVariables(input: {
  chargePolicy: ChargePolicyConfig | null;
  chargeSnapshot: RunChargeSnapshot | undefined;
  analysisWorkbenchAvailable?: boolean;
}): Record<string, string> {
  const chargePolicy = input.chargePolicy;
  if (!chargePolicy) {
    return {
      runtime_charge_budget_present: 'false',
      runtime_charge_lane: '',
      runtime_charge_quota: '',
      runtime_charge_remaining: '',
      runtime_charge_cost_lines: '',
    };
  }

  const snapshot = input.chargeSnapshot;
  const lane = snapshot?.lane && isChargePolicyRuntimeLane(snapshot.lane)
    ? snapshot.lane
    : 'interactive';
  const quota = chargePolicy.runChargeQuotaByLane[lane];
  const spent = snapshot?.quotaSpentByLane[lane] ?? 0;
  const remaining = Math.max(0, quota - spent);
  const costedSurfaces = CHARGE_POLICY_SURFACE_VALUES
    .map(surface => ({
      surface,
      amount: chargePolicy.surfaceCosts[surface],
    }))
    .filter(entry => (
      entry.amount > 0
      && (
        entry.surface !== ANALYSIS_WORKBENCH_EXTENSION_SURFACE
        || input.analysisWorkbenchAvailable === true
      )
    ))
    .sort((left, right) => right.amount - left.amount || left.surface.localeCompare(right.surface));

  return {
    runtime_charge_budget_present: 'true',
    runtime_charge_lane: lane,
    runtime_charge_quota: formatChargeAmount(quota),
    runtime_charge_remaining: formatChargeAmount(remaining),
    runtime_charge_cost_lines: costedSurfaces
      .map(entry => `- ${CHARGE_SURFACE_PROMPT_LABELS[entry.surface]}: ${formatChargeAmount(entry.amount)}`)
      .join('\n'),
  };
}
