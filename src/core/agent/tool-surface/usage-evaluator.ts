// Periodic tool-usage evaluator (psfn-framework-b0yl.5).
//
// Closes the LOD feedback loop: it reads DURABLE per-tool usage back out of the
// turn-record stream (`_turn_records/*.jsonl`, per-companion, survives restart)
// via ToolUsageAggregateSource, turns it into a deterministic ordering signal,
// and surfaces operator-visible pin SUGGESTIONS. Turn records capture EVERY tool
// call in a turn (`toolCalls[]`), so the aggregate reflects actual invocations of
// all catalog tools — deterministic tools (repo, shell, fs, memory, …) included,
// not just the handful of tool-internal LLM calls the old `model_usage_events`
// source saw. It never gates callability, never revives activation state, and
// never applies a pin silently — suggestions are recorded through the existing
// autonomous-action memory path exactly like companion-initiated pins.

import type { ModelUsageRange } from '../../../shared/telemetry/model-usage.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import { buildAutonomousActionMemoryContext } from '../../../faculties/memory/types.js';
import type { ToolUsageAggregate, ToolUsageAggregateSource } from './turn-record-usage-source.js';
import {
  buildToolUsageRanking,
  computeToolPinSuggestions,
  type ToolPinSuggestion,
  type ToolUsageRanking,
} from './usage-ranking.js';

export interface ToolUsageEvaluatorDeps {
  /**
   * Lazy handle to the durable turn-record usage aggregate source; null when the
   * session store is unavailable (fail-closed skip).
   */
  getUsageAggregateSource: () => ToolUsageAggregateSource | null;
  /** Currently-registered extended tool names (pin candidates). */
  getExtendedToolNames: () => readonly string[];
  /** Total catalog tool count (core + extended) for coverage telemetry. */
  getCatalogToolCount: () => number;
  /** Currently-pinned extended tools. */
  getPromotedExtendedTools: () => readonly string[];
  /** Maximum pinned slots. */
  getPromotedExtendedToolsLimit: () => number;
  /** Apply the freshly-built ranking to the live presentation path. */
  applyRanking: (ranking: ToolUsageRanking) => void;
  /** Memory writer for operator-visible suggestion records; absent => no suggestions surfaced. */
  getMemoryWriter?: () => Pick<MemoryWriter, 'write'> | undefined;
  /** Durable window the ranking is computed over (for suggestion provenance text). */
  usageWindow: ModelUsageRange;
  /** Minimum successful invocations before a tool is worth suggesting to pin. */
  minPinSuggestionInvocations: number;
  now?: () => number;
  onEvent?: (event: ToolUsageEvaluatorEvent) => void;
}

export type ToolUsageEvaluatorEvent =
  | { outcome: 'skipped'; reason: 'usage_source_unavailable' }
  | {
      outcome: 'evaluated';
      /** Durable source the aggregate came from (coverage honesty). */
      dataSource: 'turn_records';
      rankedToolCount: number;
      /** Distinct tools that had durable usage data in the window. */
      toolsWithData: number;
      /** Catalog size (core + extended) so a sparse aggregate is visibly sparse. */
      catalogToolCount: number;
      channelsScanned: number;
      turnRecordsScanned: number;
      toolCallsCounted: number;
      /** True when a scan cap truncated the window (aggregate under-counts). */
      truncated: boolean;
      suggestionCount: number;
      newlySuggested: readonly string[];
    };

export interface ToolUsageEvaluationResult {
  status: 'skipped' | 'evaluated';
  reason?: 'usage_source_unavailable';
  ranking?: ToolUsageRanking;
  aggregate?: ToolUsageAggregate;
  suggestions: ToolPinSuggestion[];
  newlySuggested: string[];
}

export interface ToolUsageEvaluator {
  evaluate(): Promise<ToolUsageEvaluationResult>;
}

function buildSuggestionMemoryText(
  suggestion: ToolPinSuggestion,
  usageWindow: ModelUsageRange,
): string {
  return (
    `Tool-usage evaluator suggests pinning extended tool "${suggestion.toolName}" for presentation `
    + `ordering (successful uses: ${suggestion.successes}, failures: ${suggestion.failures} over `
    + `the last ${usageWindow}). Suggestion only — not applied. Pin it yourself with toolset `
    + `action="pin" if you agree; ordering-only, it never changes what is callable.`
  );
}

async function recordSuggestionMemory(input: {
  memoryWriter: Pick<MemoryWriter, 'write'>;
  suggestion: ToolPinSuggestion;
  usageWindow: ModelUsageRange;
  timestampMs: number;
}): Promise<void> {
  const provenance = buildAutonomousActionMemoryContext({
    toolName: 'toolset',
    action: 'suggest_pin',
    reason: `durable_usage successes=${input.suggestion.successes} failures=${input.suggestion.failures}`,
    timestampMs: input.timestampMs,
  });
  await input.memoryWriter.write({
    text: buildSuggestionMemoryText(input.suggestion, input.usageWindow),
    type: 'episodic',
    importance: 0.7,
    salience: 0.68,
    confidence: 0.85,
    emotionalValence: 0,
    retentionClass: 'durable',
    tags: [...provenance.tags, 'toolset', 'tool_usage_evaluator', 'pin_suggestion'],
    sourceRef: provenance.sourceRef,
    provenanceRefs: provenance.provenanceRefs,
    scopeRef: provenance.scopeRef,
    scopeTags: [...provenance.scopeTags, 'toolset', 'tool_usage_evaluator', 'pin_suggestion'],
  });
}

export function createToolUsageEvaluator(deps: ToolUsageEvaluatorDeps): ToolUsageEvaluator {
  const now = deps.now ?? Date.now;
  // Throttle: only surface a suggestion memory the first time a tool appears as
  // a suggestion. It re-fires if the tool later drops out of the suggestion set
  // and returns, so a recurring pattern is not silently suppressed forever.
  let previouslySuggested = new Set<string>();

  return {
    async evaluate(): Promise<ToolUsageEvaluationResult> {
      const source = deps.getUsageAggregateSource();
      if (!source) {
        deps.onEvent?.({ outcome: 'skipped', reason: 'usage_source_unavailable' });
        return { status: 'skipped', reason: 'usage_source_unavailable', suggestions: [], newlySuggested: [] };
      }

      // Durable aggregate over the turn-record stream: actual per-tool
      // invocations for ALL catalog tools (the source already filters to
      // canonical first-party tools and windows by turn start time).
      const aggregate = source.aggregate(now());

      const ranking = buildToolUsageRanking(aggregate.stats, now());
      deps.applyRanking(ranking);

      const suggestions = computeToolPinSuggestions({
        ranking,
        extendedToolNames: deps.getExtendedToolNames(),
        alreadyPinned: deps.getPromotedExtendedTools(),
        slotLimit: deps.getPromotedExtendedToolsLimit(),
        minInvocations: deps.minPinSuggestionInvocations,
      });

      const currentNames = new Set(suggestions.map(s => s.toolName));
      const memoryWriter = deps.getMemoryWriter?.();
      const newlySuggested: string[] = [];
      if (memoryWriter) {
        // Surface each newly-appearing suggestion. Fail fast on a write error so
        // it is not swallowed; the throttle set only records tools whose memory
        // write succeeded, so the next run retries the unrecorded ones.
        for (const suggestion of suggestions) {
          if (previouslySuggested.has(suggestion.toolName)) continue;
          await recordSuggestionMemory({
            memoryWriter,
            suggestion,
            usageWindow: deps.usageWindow,
            timestampMs: now(),
          });
          newlySuggested.push(suggestion.toolName);
        }
      }
      previouslySuggested = currentNames;

      deps.onEvent?.({
        outcome: 'evaluated',
        dataSource: aggregate.sourceId,
        rankedToolCount: ranking.rankedToolNames.length,
        toolsWithData: aggregate.toolsWithData,
        catalogToolCount: deps.getCatalogToolCount(),
        channelsScanned: aggregate.channelsScanned,
        turnRecordsScanned: aggregate.turnRecordsScanned,
        toolCallsCounted: aggregate.toolCallsCounted,
        truncated: aggregate.truncated,
        suggestionCount: suggestions.length,
        newlySuggested,
      });

      return { status: 'evaluated', ranking, aggregate, suggestions, newlySuggested };
    },
  };
}
