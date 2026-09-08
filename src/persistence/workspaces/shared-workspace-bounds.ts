/**
 * Operator-declared bounds on a governed Shared Workspace listing.
 *
 * Individual proposals are capped at 1 MiB, but the aggregate list and read
 * paths re-read and re-hash every reviewed artifact on every call so an
 * out-of-band mutation is detected at serve time. That verification is the
 * point and must not be cached away, so the cost is bounded by paging instead:
 * one call reads at most `pageSize` artifacts and at most `pageBytes` of
 * artifact content, and returns a cursor for the rest (psfn-framework-9jld5).
 */
export interface SharedWorkspaceListBounds {
  /** Artifacts served by one page. */
  pageSize: number;
  /**
   * Artifact bytes read and hashed for one page. A page always serves at least
   * one artifact, so a single artifact larger than the budget still makes
   * progress instead of stalling the listing forever.
   */
  pageBytes: number;
}

/**
 * Structural view of the settings a shared workspace listing needs. Kept as a
 * shape rather than an import so the persistence layer never depends on the
 * config loader.
 */
export interface SharedWorkspaceListBoundsSettings {
  sharedWorkspaceListPageSize?: number;
  sharedWorkspaceListPageBytes?: number;
}

function requirePositiveInteger(value: number | undefined, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `Shared Companion Workspace listing requires settings.json ${key} `
      + 'to be a positive integer',
    );
  }
  return value;
}

/**
 * Resolve the listing bounds at composition time so a runtime that exposes a
 * shared workspace without declaring them refuses to start, rather than
 * discovering the missing bound on the first operator request.
 */
export function requireSharedWorkspaceListBounds(
  settings: SharedWorkspaceListBoundsSettings,
): SharedWorkspaceListBounds {
  return {
    pageSize: requirePositiveInteger(
      settings.sharedWorkspaceListPageSize,
      'sharedWorkspaceListPageSize',
    ),
    pageBytes: requirePositiveInteger(
      settings.sharedWorkspaceListPageBytes,
      'sharedWorkspaceListPageBytes',
    ),
  };
}

/**
 * One bounded page of artifacts plus the cursor that resumes the listing.
 * Shared by the governed reader (approved artifacts) and the Garden store
 * (published artifacts) so both surfaces page identically.
 */
export interface SharedWorkspaceArtifactPage {
  artifacts: Array<{ artifactPath: string; revision: string }>;
  /** `null` once the listing is exhausted; otherwise pass back as `cursor`. */
  nextCursor: string | null;
}

/**
 * Select the slice of an ordered listing one page may serve. `sizeOf` is the
 * cheap (stat-based) byte cost of an entry; nothing is read or hashed until the
 * page membership is decided.
 */
export function selectSharedWorkspacePage<T>(
  ordered: readonly T[],
  bounds: SharedWorkspaceListBounds,
  sizeOf: (entry: T) => number,
): { entries: T[]; exhausted: boolean } {
  const entries: T[] = [];
  let bytes = 0;
  for (const entry of ordered) {
    if (entries.length >= bounds.pageSize) return { entries, exhausted: false };
    const size = sizeOf(entry);
    if (entries.length > 0 && bytes + size > bounds.pageBytes) {
      return { entries, exhausted: false };
    }
    entries.push(entry);
    bytes += size;
  }
  return { entries, exhausted: true };
}

/**
 * Resume an ordered listing after the entry the previous page ended on. A
 * cursor whose entry has since left the listing fails closed: silently
 * restarting or skipping would hand the caller a page that is neither the
 * continuation they asked for nor a complete listing.
 */
export function resumeSharedWorkspaceListing<T>(
  ordered: readonly T[],
  cursor: string | undefined,
  keyOf: (entry: T) => string,
): readonly T[] {
  if (cursor === undefined) return ordered;
  const index = ordered.findIndex(entry => keyOf(entry) === cursor);
  if (index < 0) {
    throw new Error(
      'Shared Companion Workspace listing cursor no longer matches the reviewed corpus; '
      + 'restart the listing',
    );
  }
  return ordered.slice(index + 1);
}
