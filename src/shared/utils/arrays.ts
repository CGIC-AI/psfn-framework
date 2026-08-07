/**
 * Split an array into chunks of at most `size` items.
 *
 * The caller must prove `size` is a positive integer before invoking this
 * helper; the function does not re-validate `size` so that hot loops stay
 * cheap and so that callers own their validation policy.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
