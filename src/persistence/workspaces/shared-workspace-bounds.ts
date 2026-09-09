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
 * A cursor that is well-formed but names an entry the listing no longer holds:
 * the artifact was renamed, removed, or superseded between pages. The listing
 * is intact and the caller's answer is to start it again — which is a different
 * thing from a malformed cursor and a very different thing from a broken store,
 * and each of the three used to reach the operator as the same opaque 500
 * (bead psfn-framework-2xt9c).
 */
export class SharedWorkspaceListingCursorStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedWorkspaceListingCursorStaleError';
  }
}

/**
 * A cursor that is not a shape this listing ever emits. A page cursor is always
 * one artifact path, so anything else was constructed by the caller rather than
 * echoed back from a response, and is refused as such rather than being
 * resolved against the corpus.
 */
export class SharedWorkspaceListingCursorInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharedWorkspaceListingCursorInvalidError';
  }
}

const LISTING_CURSOR_EXTENSIONS = new Set(['.md', '.txt', '.json']);
const MAX_LISTING_CURSOR_LENGTH = 4_096;

/**
 * Structural check on a cursor, with no filesystem access at all: the same
 * containment rules an artifact path itself must satisfy. Purely syntactic on
 * purpose, so a tampered cursor is refused before it can be used to probe which
 * paths exist by watching stale-versus-invalid answers come back.
 */
export function assertSharedWorkspaceListingCursor(cursor: string): string {
  const invalid = (reason: string): never => {
    throw new SharedWorkspaceListingCursorInvalidError(
      `Shared Companion Workspace listing cursor is not a listing cursor: ${reason}`,
    );
  };
  if (cursor.length === 0) invalid('it is empty');
  if (cursor.length > MAX_LISTING_CURSOR_LENGTH) invalid('it exceeds the maximum length');
  if (cursor !== cursor.trim()) invalid('it is padded with whitespace');
  const normalized = cursor.replace(/\\/gu, '/');
  if (normalized.startsWith('/')) invalid('it is not a relative path');
  const segments = normalized.split('/');
  if (segments.some(segment => segment.length === 0)) invalid('it has an empty path segment');
  if (segments.some(segment => segment.startsWith('.'))) {
    invalid('it uses a hidden or traversing path segment');
  }
  const extension = normalized.slice(normalized.lastIndexOf('.')).toLowerCase();
  if (!normalized.includes('.') || !LISTING_CURSOR_EXTENSIONS.has(extension)) {
    invalid('it does not name a listable artifact');
  }
  return normalized;
}

/**
 * The one total order both listing surfaces page in. Declared once so the
 * Garden store and the governed reader cannot drift into two orders that share
 * a cursor namespace, and tie-broken by code unit so it stays a strict order
 * even where `localeCompare` calls two distinct paths equal.
 */
export function compareSharedWorkspaceArtifactPaths(left: string, right: string): number {
  const collated = left.localeCompare(right);
  if (collated !== 0) return collated;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Bounded top-K window over an enumeration that arrives in no useful order
 * (bead psfn-framework-2xt9c).
 *
 * Both listing surfaces used to materialize the ENTIRE corpus — every path,
 * plus a `stat` per file — sort it, and only then take a page from the front.
 * The page was bounded; the work behind it was not, so a Garden list of a large
 * reviewed workspace held the request loop for the whole corpus on every page,
 * and paging multiplied that rather than dividing it.
 *
 * This retains at most `keep` entries in listing order while the caller streams
 * the directory, exactly as the JSONL ledgers' `retainTop` does for a journal
 * scan (psfn-framework-z3e2x): entries at or before the cursor are dropped as
 * they arrive, and an entry past the window is never materialized at all — so a
 * `stat` is spent only on entries a page could actually serve.
 */
export class SharedWorkspaceListingWindow<T> {
  private readonly retained: Array<{ key: string; value: T }> = [];
  private truncatedListing = false;
  private cursorSeen = false;

  constructor(
    private readonly keep: number,
    private readonly cursor: string | undefined,
  ) {
    if (!Number.isInteger(keep) || keep < 1) {
      throw new Error('Shared Companion Workspace listing window requires a positive page size');
    }
  }

  /**
   * Offer one enumerated entry. `materialize` runs only for an entry the window
   * retains, so any per-entry cost the caller pays there follows the page.
   */
  offer(key: string, materialize: () => T): void {
    if (this.cursor !== undefined) {
      const placement = compareSharedWorkspaceArtifactPaths(key, this.cursor);
      if (placement === 0) {
        this.cursorSeen = true;
        return;
      }
      if (placement < 0) return;
    }
    const last = this.retained.at(-1);
    if (last !== undefined
      && this.retained.length >= this.keep
      && compareSharedWorkspaceArtifactPaths(key, last.key) >= 0) {
      this.truncatedListing = true;
      return;
    }
    const entry = { key, value: materialize() };
    let index = this.retained.length;
    this.retained.push(entry);
    while (index > 0
      && compareSharedWorkspaceArtifactPaths(this.retained[index - 1]!.key, key) > 0) {
      const previous = this.retained[index - 1]!;
      this.retained[index - 1] = this.retained[index]!;
      this.retained[index] = previous;
      index -= 1;
    }
    if (this.retained.length > this.keep) {
      this.retained.pop();
      this.truncatedListing = true;
    }
  }

  /** True once the enumeration has proved the cursor still names a listed entry. */
  get cursorResolved(): boolean {
    return this.cursor === undefined || this.cursorSeen;
  }

  /** True when entries past the window exist, so the page cannot be the last. */
  get truncated(): boolean {
    return this.truncatedListing;
  }

  /** The retained candidates, in listing order. */
  entries(): T[] {
    return this.retained.map(entry => entry.value);
  }

  /**
   * Fail closed on a cursor the enumeration never saw. Silently restarting or
   * skipping would hand the caller a page that is neither the continuation they
   * asked for nor a complete listing.
   */
  requireResolvedCursor(): void {
    if (this.cursorResolved) return;
    throw new SharedWorkspaceListingCursorStaleError(
      'Shared Companion Workspace listing cursor no longer matches the reviewed corpus; '
      + 'restart the listing',
    );
  }
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
    throw new SharedWorkspaceListingCursorStaleError(
      'Shared Companion Workspace listing cursor no longer matches the reviewed corpus; '
      + 'restart the listing',
    );
  }
  return ordered.slice(index + 1);
}
