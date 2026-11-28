/**
 * Vision completions use their model slot's catalogue output budget (tuning
 * bounded by capability), like every other purpose. The former purpose-wide
 * 1024-token clamp left a thinking vision model no room for its answer
 * (psfn-framework-4k9kv). A missing or invalid budget fails loudly instead of
 * falling back to a fixed size.
 */
export function requireVisionCompletionMaxTokens(maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    throw new Error(
      `Vision completion requires a positive output budget from its model slot; got ${String(maxTokens)}`,
    );
  }
  return Math.floor(maxTokens);
}
