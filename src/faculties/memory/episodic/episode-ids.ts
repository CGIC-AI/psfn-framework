const EPISODE_ID_PREFIX = 'episode:';

/**
 * Resolve an LLM-referenced episode id against the known set. Models
 * routinely drop or add the "episode:" prefix when echoing ids back;
 * accept only the exact id or its unambiguous prefixed/bare variant —
 * never a fuzzier guess.
 */
export function resolveKnownEpisodeId(
  candidate: string,
  knownEpisodeIds: ReadonlySet<string>,
): string | null {
  if (knownEpisodeIds.has(candidate)) return candidate;
  const prefixed = `${EPISODE_ID_PREFIX}${candidate}`;
  if (knownEpisodeIds.has(prefixed)) return prefixed;
  if (candidate.startsWith(EPISODE_ID_PREFIX)) {
    const bare = candidate.slice(EPISODE_ID_PREFIX.length);
    if (knownEpisodeIds.has(bare)) return bare;
  }
  return null;
}
