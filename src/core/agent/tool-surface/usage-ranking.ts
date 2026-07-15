// Deterministic per-tool usage ranking derived from durable telemetry.
//
// The source aggregates live in Postgres `model_usage_events` (durable, survives
// restart). This module is a pure transform over those aggregates: it produces a
// stable within-band ordering signal and operator-visible pin suggestions. It
// NEVER gates callability and never revives activation state — usage feeds
// presentation ordering only, and only as a tie-break INSIDE a presentation band
// (after explicit pins and after the social/expressive-first domain rank).

export interface ToolUsageStat {
  readonly toolName: string;
  /** Total durable invocations attributed to the tool (successful + failed). */
  readonly invocations: number;
  /** Durable successful invocations — the primary frequency signal. */
  readonly successes: number;
  /**
   * Durable failed invocations — the explicit correction/error signal. Higher
   * failure counts demote a tool within an otherwise-equal band (folded from
   * psfn-framework-vvf.6: retain a correction signal in per-tool ordering).
   */
  readonly failures: number;
}

export interface ToolUsageRanking {
  /** Wall-clock time this ranking was built, for telemetry/audit only. */
  readonly generatedAtMs: number;
  /** Durable per-tool stats keyed by tool name. */
  readonly stats: ReadonlyMap<string, ToolUsageStat>;
  /** Tool names in deterministic descending usage order (most-used first). */
  readonly rankedToolNames: readonly string[];
  /** Successful-invocation frequency for a tool (0 when unseen). */
  usageScore(toolName: string): number;
  /**
   * Within-band comparator: negative when `a` should present before `b`.
   * Returns 0 for equal standing so the caller falls back to its own
   * deterministic tie-break (alphabetical). Never reorders across bands.
   */
  compareWithinBand(a: string, b: string): number;
}

const EMPTY_STAT: ToolUsageStat = { toolName: '', invocations: 0, successes: 0, failures: 0 };

function normalizeCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Deterministic ordering of two stats: more successful uses first, then fewer
 * failures, then invocations, then tool name. Shared by the ranking comparator
 * and the pin-suggestion selector so both stay consistent.
 */
function compareStats(a: ToolUsageStat, b: ToolUsageStat): number {
  if (a.successes !== b.successes) return b.successes - a.successes;
  if (a.failures !== b.failures) return a.failures - b.failures;
  if (a.invocations !== b.invocations) return b.invocations - a.invocations;
  return a.toolName.localeCompare(b.toolName);
}

export function buildToolUsageRanking(
  rawStats: readonly ToolUsageStat[],
  generatedAtMs: number,
): ToolUsageRanking {
  const stats = new Map<string, ToolUsageStat>();
  for (const raw of rawStats) {
    const toolName = raw.toolName.trim();
    if (!toolName) continue;
    const successes = normalizeCount(raw.successes);
    const failures = normalizeCount(raw.failures);
    // Invocations must cover at least successes + failures; the durable store
    // reports `calls` independently, so clamp up rather than trust it blindly.
    const invocations = Math.max(normalizeCount(raw.invocations), successes + failures);
    const existing = stats.get(toolName);
    if (existing) {
      // Defensive de-duplication if the same tool key appears twice.
      stats.set(toolName, {
        toolName,
        invocations: existing.invocations + invocations,
        successes: existing.successes + successes,
        failures: existing.failures + failures,
      });
    } else {
      stats.set(toolName, { toolName, invocations, successes, failures });
    }
  }

  const rankedToolNames = [...stats.values()].sort(compareStats).map(stat => stat.toolName);

  const statOf = (toolName: string): ToolUsageStat => (
    stats.get(toolName) ?? { ...EMPTY_STAT, toolName }
  );

  return {
    generatedAtMs,
    stats,
    rankedToolNames,
    usageScore: (toolName: string): number => statOf(toolName).successes,
    compareWithinBand: (a: string, b: string): number => {
      const statA = statOf(a);
      const statB = statOf(b);
      if (statA.successes !== statB.successes) return statB.successes - statA.successes;
      if (statA.failures !== statB.failures) return statA.failures - statB.failures;
      return 0;
    },
  };
}

export interface ToolPinSuggestion {
  readonly toolName: string;
  readonly invocations: number;
  readonly successes: number;
  readonly failures: number;
}

export interface ComputeToolPinSuggestionsInput {
  readonly ranking: ToolUsageRanking;
  /** Names of the currently-registered extended tools (pin candidates). */
  readonly extendedToolNames: Iterable<string>;
  /** Names already pinned (excluded — never re-suggest an existing pin). */
  readonly alreadyPinned: Iterable<string>;
  /** Maximum pinned slots (from getPromotedExtendedToolsLimit). */
  readonly slotLimit: number;
  /** Minimum successful invocations before a tool is worth suggesting. */
  readonly minInvocations: number;
}

/**
 * Deterministic pin suggestions: unpinned extended tools whose durable
 * successful-use count meets the threshold, ordered by usage, capped at the
 * number of free slots. Suggestions only — the caller surfaces them
 * operator-visibly and NEVER applies them silently.
 */
export function computeToolPinSuggestions(
  input: ComputeToolPinSuggestionsInput,
): ToolPinSuggestion[] {
  const slotLimit = normalizeCount(input.slotLimit);
  const pinned = new Set<string>();
  for (const name of input.alreadyPinned) {
    const trimmed = name.trim();
    if (trimmed) pinned.add(trimmed);
  }
  const availableSlots = Math.max(0, slotLimit - pinned.size);
  if (availableSlots === 0) return [];

  const minInvocations = Math.max(1, normalizeCount(input.minInvocations));
  const seen = new Set<string>();
  const candidates: ToolUsageStat[] = [];
  for (const name of input.extendedToolNames) {
    const toolName = name.trim();
    if (!toolName || pinned.has(toolName) || seen.has(toolName)) continue;
    seen.add(toolName);
    const stat = input.ranking.stats.get(toolName);
    if (!stat || stat.successes < minInvocations) continue;
    candidates.push(stat);
  }

  return candidates
    .sort(compareStats)
    .slice(0, availableSlots)
    .map(stat => ({
      toolName: stat.toolName,
      invocations: stat.invocations,
      successes: stat.successes,
      failures: stat.failures,
    }));
}
