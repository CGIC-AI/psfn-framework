// Durable per-tool usage aggregation from turn records (psfn-framework-b0yl.5).
//
// This is the CORRECT signal source for the tool-usage evaluator. Turn records
// (`_turn_records/*.jsonl`, durable, per-companion, rotated segments) capture
// EVERY tool call executed in a turn — `toolCalls[].toolName` plus `isError` —
// for all catalog tools (repo, shell, fs, memory, contact, notify, orient,
// schedule, vault, beads, web, …), not just tool-internal LLM calls. It replaces
// the earlier `model_usage_events` source, which only recorded LLM API calls and
// therefore attributed a `toolName` on a handful of tool-internal planner calls
// (web search, analysis-workbench, generated-media) while every deterministic
// tool and the main chat loop produced zero rows — inverting real usage.
//
// The aggregate is a pure read: it never writes, never gates callability, and
// never revives activation state. It is bounded per run (per-channel and total
// record caps) and reports coverage so a sparse window is visibly sparse rather
// than a confident wrong ranking.

import type { ModelUsageRange } from '../../../shared/telemetry/model-usage.js';
import { resolveModelUsageRange } from '../../../shared/telemetry/model-usage-range.js';
import type { TurnRecordUsageRecord } from '../../../persistence/sessions/turn-record-store-port.js';
import { isCanonicalFirstPartyToolName } from './registry.js';
import type { ToolUsageStat } from './usage-ranking.js';
import { resolveToolCallOutcome } from '../../../shared/contracts/tool-call-outcome.js';

/** Window the evaluator aggregates over. `custom` is excluded (no explicit bounds). */
export type ToolUsageWindow = Exclude<ModelUsageRange, 'custom'>;

/**
 * Per-run aggregate over durable turn records, plus the coverage numbers that
 * make the data source and its sparseness explicit to telemetry.
 */
export interface ToolUsageAggregate {
  /** Identifies which durable source produced these stats (coverage honesty). */
  readonly sourceId: 'turn_records';
  /** Per-tool durable stats for canonical first-party tools seen in the window. */
  readonly stats: ToolUsageStat[];
  /** Distinct canonical tools that had at least one invocation in the window. */
  readonly toolsWithData: number;
  /** Channels (logical sessions) whose turn-record stream was scanned. */
  readonly channelsScanned: number;
  /** Total turn records read across all channels this run. */
  readonly turnRecordsScanned: number;
  /** Canonical tool calls counted inside the window across all channels. */
  readonly toolCallsCounted: number;
  /** Inclusive lower window bound (ms) used to filter records. */
  readonly windowSinceMs: number;
  /** Exclusive upper window bound (ms) used to filter records. */
  readonly windowUntilMs: number;
  /**
   * True when a scan cap was reached before a channel's in-window history was
   * exhausted, so the aggregate under-counts. Surfaced in telemetry so an
   * incomplete window is never mistaken for a complete one.
   */
  readonly truncated: boolean;
}

export interface ToolUsageAggregateSource {
  readonly sourceId: 'turn_records';
  aggregate(nowMs: number): ToolUsageAggregate;
}

export interface TurnRecordToolUsageSourceDeps {
  /** Logical-session/channel keys to aggregate over (per-companion scope). */
  listChannelKeys: () => readonly string[];
  /**
   * Read the most recent `limit` turn records for a channel, oldest-first.
   * Tombstone-aware reads are preferred (deleted turns excluded). The source
   * only reads — it never mutates the stream.
   */
  readRecentTurnRecords: (channelKey: string, limit: number) => readonly TurnRecordUsageRecord[];
  /** Durable window the ranking is computed over. */
  usageWindow: ToolUsageWindow;
  /** IANA timezone for calendar-range resolution; defaults to UTC. */
  timezone?: string;
  /** Max turn records read from any single channel per run (bounds fs work). */
  maxTurnRecordsPerChannel?: number;
  /** Max turn records read across all channels per run (bounds fs work). */
  maxTurnRecordsTotal?: number;
}

/** Newest-N records read from one channel before the per-channel cap trips. */
const DEFAULT_MAX_TURN_RECORDS_PER_CHANNEL = 32;
/** Newest-N records read across all channels before the total cap trips. */
const DEFAULT_MAX_TURN_RECORDS_TOTAL = 128;

function normalizeCap(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

interface MutableToolCounts {
  invocations: number;
  successes: number;
  failures: number;
}

/**
 * Build a durable tool-usage aggregate from turn records. One bounded read per
 * channel (newest-first), filtered to the resolved window, counting each
 * canonical tool call by its stable outcome. Only executed successes and
 * execution failures feed the success/failure ranking; rejections and skips
 * remain invocations without inflating runtime-failure counts.
 */
export function createTurnRecordToolUsageSource(
  deps: TurnRecordToolUsageSourceDeps,
): ToolUsageAggregateSource {
  const maxPerChannel = normalizeCap(deps.maxTurnRecordsPerChannel, DEFAULT_MAX_TURN_RECORDS_PER_CHANNEL);
  const maxTotal = normalizeCap(deps.maxTurnRecordsTotal, DEFAULT_MAX_TURN_RECORDS_TOTAL);

  return {
    sourceId: 'turn_records',
    aggregate(nowMs: number): ToolUsageAggregate {
      const resolved = resolveModelUsageRange(
        {
          range: deps.usageWindow,
          ...(deps.timezone ? { timezone: deps.timezone } : {}),
        },
        // allSinceMs:0 makes the `all` window reach back to the epoch instead of
        // collapsing to `now` (which would report an empty aggregate).
        { nowMs, allSinceMs: 0 },
      );
      const sinceMs = resolved.sinceMs;
      const untilMs = resolved.untilMs;

      const perTool = new Map<string, MutableToolCounts>();
      let channelsScanned = 0;
      let turnRecordsScanned = 0;
      let toolCallsCounted = 0;
      let truncated = false;
      let remainingBudget = maxTotal;

      for (const channelKey of deps.listChannelKeys()) {
        if (remainingBudget <= 0) {
          truncated = true;
          break;
        }
        channelsScanned += 1;
        const limit = Math.min(maxPerChannel, remainingBudget);
        const page = deps.readRecentTurnRecords(channelKey, limit);
        turnRecordsScanned += page.length;
        remainingBudget -= page.length;

        // The read is capped at `limit` newest records. If it returned exactly
        // that many and the OLDEST record it returned is still inside the
        // window, there may be older in-window records we did not read → the
        // aggregate under-counts this channel. `page` is oldest-first, so
        // `page[0]` is the oldest record read.
        if (page.length >= limit && page.length > 0) {
          const oldestRead = page[0];
          if (oldestRead && oldestRead.startedAt >= sinceMs) truncated = true;
        }

        for (const record of page) {
          if (record.startedAt < sinceMs || record.startedAt >= untilMs) continue;
          for (const toolCall of record.toolCalls) {
            const toolName = toolCall.toolName.trim();
            if (!toolName || !isCanonicalFirstPartyToolName(toolName)) continue;
            toolCallsCounted += 1;
            const counts = perTool.get(toolName) ?? { invocations: 0, successes: 0, failures: 0 };
            counts.invocations += 1;
            const outcome = resolveToolCallOutcome(toolCall)
              ?? (toolCall.isError === true ? 'execution_failure' : 'success');
            if (outcome === 'execution_failure') counts.failures += 1;
            if (outcome === 'success') counts.successes += 1;
            perTool.set(toolName, counts);
          }
        }
      }

      const stats: ToolUsageStat[] = [...perTool.entries()].map(([toolName, counts]) => ({
        toolName,
        invocations: counts.invocations,
        successes: counts.successes,
        failures: counts.failures,
      }));

      return {
        sourceId: 'turn_records',
        stats,
        toolsWithData: stats.length,
        channelsScanned,
        turnRecordsScanned,
        toolCallsCounted,
        windowSinceMs: sinceMs,
        windowUntilMs: untilMs,
        truncated,
      };
    },
  };
}
