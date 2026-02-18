// ── Token Estimation ──
// Simple heuristic for context budgeting. Not billing-accurate.

/**
 * Estimate token count from text length.
 * ~4 chars per token is a reasonable heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Human-readable token display.
 * Examples: 980 -> "980", 1_200 -> "1.2k", 2_300_000 -> "2.3M".
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
