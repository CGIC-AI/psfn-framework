// ── Token Estimation ──
// Simple heuristic for context budgeting. Not billing-accurate.

/**
 * Estimate token count from text length.
 * ~4 chars per token is a reasonable heuristic for English text.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
