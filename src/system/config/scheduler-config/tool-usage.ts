import { isRecord } from '../../../shared/utils/types.js';
import { MODEL_USAGE_RANGES, type ModelUsageRange } from '../../../shared/telemetry/model-usage.js';
import {
  toBoolean,
  toInterval,
  toPositiveInteger,
} from './primitives.js';

/** Durable-usage windows the tool-usage evaluator may aggregate over. */
export type ToolUsageEvaluatorWindow = Exclude<ModelUsageRange, 'custom'>;

/**
 * Tool-usage evaluator cadence + thresholds (psfn-framework-b0yl.5). The
 * evaluator aggregates ACTUAL per-tool invocations from the durable turn-record
 * stream (every catalog tool, per-companion) and feeds presentation ordering
 * plus operator-visible pin suggestions. It never gates callability. Opt-in
 * (fail-closed default) and registered only when enabled, mirroring the
 * introspection-audit lane. `usageWindow` bounds which turn records count.
 */
export interface ToolUsageEvaluatorConfig {
  enabled: boolean;
  intervalMs: number;
  usageWindow: ToolUsageEvaluatorWindow;
  minPinSuggestionInvocations: number;
}

export const DEFAULT_TOOL_USAGE_EVALUATOR_CONFIG: ToolUsageEvaluatorConfig = {
  enabled: false,
  intervalMs: 21_600_000, // 6h — durable rollup, cheap, no LLM cost
  usageWindow: 'month',
  minPinSuggestionInvocations: 25,
};

function toToolUsageEvaluatorWindow(value: unknown, field: string): ToolUsageEvaluatorWindow {
  if (typeof value !== 'string' || value === 'custom' || !MODEL_USAGE_RANGES.includes(value as ModelUsageRange)) {
    throw new Error(
      `Invalid scheduler config: ${field} must be one of `
      + `${MODEL_USAGE_RANGES.filter(range => range !== 'custom').join(', ')}`,
    );
  }
  return value as ToolUsageEvaluatorWindow;
}

export function validateToolUsageEvaluatorConfig(
  value: unknown,
  sourcePath: string,
): ToolUsageEvaluatorConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid scheduler config at ${sourcePath}: toolUsageEvaluator must be an object`);
  }
  return {
    enabled: toBoolean(value.enabled, 'toolUsageEvaluator.enabled'),
    intervalMs: toInterval(value.intervalMs, 'toolUsageEvaluator.intervalMs'),
    usageWindow: toToolUsageEvaluatorWindow(value.usageWindow, 'toolUsageEvaluator.usageWindow'),
    minPinSuggestionInvocations: toPositiveInteger(
      value.minPinSuggestionInvocations,
      'toolUsageEvaluator.minPinSuggestionInvocations',
      1,
    ),
  };
}
