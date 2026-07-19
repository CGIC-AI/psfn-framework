export const MAX_LIST_LIMIT = 200;

export function clampListLimit(
  limit: number | undefined,
  fallback: number,
  maximum = MAX_LIST_LIMIT,
): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, maximum);
}
