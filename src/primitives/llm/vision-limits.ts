export const VISION_COMPLETION_MAX_TOKENS = 1024;

export function clampVisionCompletionMaxTokens(maxTokens: number): number {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return VISION_COMPLETION_MAX_TOKENS;
  }
  return Math.min(Math.floor(maxTokens), VISION_COMPLETION_MAX_TOKENS);
}
