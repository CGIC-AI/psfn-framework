import type { Episode } from '../../../shared/contracts/episodic-memory.js';
import type { EpisodicStorePort } from './store-port.js';

/**
 * Topic-thread identity for episodic memory (apq0).
 *
 * Historically an episode's `threadId` was set verbatim to its session id
 * (`buildEpisodeInput`), so a long-lived companion's single persistent
 * per-channel session accreted one unbounded "thread" (the 141-episode
 * mega-thread the operator found). Threads were meant to track long-term
 * progression per TOPIC, not per channel.
 *
 * Thread identity is now the connected component of the episode ARC graph —
 * the only cross-time semantic weaving in the system (arcs are explicitly
 * "threads about ONE subject across time"). Each new episode starts as its own
 * singleton thread (`threadId = episode.id`); whenever an arc links two
 * episodes their threads are unioned. The component representative is the
 * lexicographically-smallest episode id in the component, which makes the
 * assignment DETERMINISTIC and order-independent: incremental min-merge and a
 * global union-find over the same arc set converge on the same representative,
 * so a later full recompute (historical repair, bead h4fp.7) reproduces the
 * live result exactly.
 *
 * The identity is MATERIALIZED into the existing `l01_episodes.thread_id`
 * column (no schema change): every consumer that groups by `thread_id`
 * (Garden `searchByThread`/`getThreadDetail`, retrieval drill-down siblings)
 * keeps working and now sees bounded topic threads. The processing-watermark
 * scope stays session-keyed — it is a per-session cursor, decoupled from
 * thread identity.
 *
 * LEGACY DATA: pre-apq0 episodes carry `threadId = sessionId` verbatim — the
 * per-channel mega-thread. Such a session-keyed thread is NOT a topic thread
 * and must never participate in a union as one: unioning against it would
 * either absorb the new episode into the channel bucket (re-creating the bug)
 * or mass-relabel the whole bucket as one topic. When an arc touches a legacy
 * endpoint, that single episode is first EXTRACTED out of its session bucket
 * into its own singleton topic thread (`threadId = episode.id`) and only then
 * unioned — so arc formation incrementally decomposes the mega-thread while a
 * global recompute over episode ids (`computeThreadComponents`) still
 * reproduces the same assignment.
 */

/** The component representative is the lexicographically-smaller thread id. */
export function chooseThreadRepresentative(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * Pure union-find over an arc edge set. Returns a map from every referenced
 * episode id to its component representative (the component's minimum id).
 * Deterministic and independent of edge order. Used by tests and by any
 * global recompute (e.g. historical repair) that needs the same assignment
 * the incremental live path produces.
 */
export function computeThreadComponents(
  episodeIds: readonly string[],
  edges: readonly (readonly [string, string])[],
): Map<string, string> {
  const parent = new Map<string, string>();
  const ensure = (id: string): void => {
    if (!parent.has(id)) parent.set(id, id);
  };
  const find = (id: string): string => {
    ensure(id);
    let root = id;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    // Path compression keeps repeated lookups cheap without changing the root.
    let cursor = id;
    while (cursor !== root) {
      const next = parent.get(cursor) as string;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const representative = chooseThreadRepresentative(rootA, rootB);
    const other = representative === rootA ? rootB : rootA;
    parent.set(other, representative);
  };

  for (const id of episodeIds) ensure(id);
  for (const [a, b] of edges) union(a, b);

  const assignments = new Map<string, string>();
  for (const id of parent.keys()) {
    assignments.set(id, find(id));
  }
  return assignments;
}

/**
 * True when the episode still carries a pre-apq0 session-keyed threadId (the
 * legacy per-channel mega-thread): the threadId is not the episode's own id
 * and matches one of its span refs' session ids. A post-apq0 topic-thread id
 * is always some episode's id, which can never collide with a session id.
 */
export function hasLegacySessionThreadId(
  episode: Pick<Episode, 'id' | 'threadId' | 'spanRefs'>,
): boolean {
  const threadId = episode.threadId;
  if (threadId === undefined || threadId === episode.id) return false;
  return episode.spanRefs.some(ref => ref.sessionId === threadId);
}

export interface ThreadAssignmentEvent {
  outcome: 'merged' | 'noop' | 'merge_skipped_oversize' | 'legacy_session_thread_extracted';
  winningThreadId: string;
  losingThreadId: string;
  /** Live episodes re-pointed onto the winning thread (0 for noop/skip). */
  updatedEpisodeCount: number;
  timestamp: number;
}

export interface ThreadUnionOptions {
  /**
   * Safety bound on a single merge's write amplification. When the losing
   * thread already carries more than this many live episodes the merge is
   * skipped fail-safe (the two threads stay distinct) and an oversize event is
   * emitted — never silently mis-threaded, never an unbounded rewrite.
   */
  maxThreadEpisodes: number;
  now?: () => Date;
  onEvent?: (event: ThreadAssignmentEvent) => void;
}

export interface ThreadUnionResult {
  threadId: string;
  updatedEpisodeIds: string[];
  skippedOversize: boolean;
}

type ThreadUnionStore = Pick<EpisodicStorePort, 'repointThreadMembers'>;

/**
 * Extract a legacy session-keyed endpoint out of its per-channel bucket into
 * its own singleton topic thread before it participates in a union. Only THIS
 * episode moves — the rest of the legacy bucket stays where it is (bounded,
 * incremental decomposition; bead h4fp.7 owns the full historical repair).
 */
async function normalizeLegacyEndpoint(
  store: ThreadUnionStore,
  episode: Episode,
  onEvent: ((event: ThreadAssignmentEvent) => void) | undefined,
  now: () => Date,
): Promise<void> {
  if (!hasLegacySessionThreadId(episode)) return;
  const legacyThreadId = episode.threadId as string;
  const outcome = await store.repointThreadMembers({
    fromThreadId: legacyThreadId,
    toThreadId: episode.id,
    maxEpisodes: 1,
    memberEpisodeIds: [episode.id],
  });
  episode.threadId = episode.id;
  onEvent?.({
    outcome: 'legacy_session_thread_extracted',
    winningThreadId: episode.id,
    losingThreadId: legacyThreadId,
    updatedEpisodeCount: outcome.updatedEpisodeIds.length,
    timestamp: now().getTime(),
  });
}

/**
 * Union the topic threads of two arc-linked episodes. The higher-id thread's
 * live episodes are re-pointed onto the lexicographically-smaller thread id.
 * The passed `source`/`target` objects are mutated in place so a caller
 * chaining several arcs in one pass observes the converged thread id.
 *
 * A legacy session-keyed endpoint (pre-apq0 `threadId = sessionId`) is first
 * extracted into its own singleton topic thread so the per-channel mega-thread
 * is never treated as a topic thread — neither absorbed nor mass-relabeled.
 *
 * The re-point is delegated to the store's single atomic `repointThreadMembers`
 * statement — there is no per-member update loop, so a crash mid-union can
 * never leave a thread permanently split.
 */
export async function applyThreadUnionForArc(
  store: ThreadUnionStore,
  source: Episode,
  target: Episode,
  options: ThreadUnionOptions,
): Promise<ThreadUnionResult> {
  if (!Number.isInteger(options.maxThreadEpisodes) || options.maxThreadEpisodes < 1) {
    throw new Error('applyThreadUnionForArc requires a positive integer maxThreadEpisodes');
  }
  const now = options.now ?? (() => new Date());
  await normalizeLegacyEndpoint(store, source, options.onEvent, now);
  await normalizeLegacyEndpoint(store, target, options.onEvent, now);
  const sourceThread = source.threadId ?? source.id;
  const targetThread = target.threadId ?? target.id;
  const winningThreadId = chooseThreadRepresentative(sourceThread, targetThread);
  const losingThreadId = winningThreadId === sourceThread ? targetThread : sourceThread;

  if (winningThreadId === losingThreadId) {
    options.onEvent?.({
      outcome: 'noop',
      winningThreadId,
      losingThreadId,
      updatedEpisodeCount: 0,
      timestamp: now().getTime(),
    });
    return { threadId: winningThreadId, updatedEpisodeIds: [], skippedOversize: false };
  }

  const outcome = await store.repointThreadMembers({
    fromThreadId: losingThreadId,
    toThreadId: winningThreadId,
    maxEpisodes: options.maxThreadEpisodes,
  });

  if (outcome.skippedOversize) {
    options.onEvent?.({
      outcome: 'merge_skipped_oversize',
      winningThreadId,
      losingThreadId,
      updatedEpisodeCount: 0,
      timestamp: now().getTime(),
    });
    return { threadId: winningThreadId, updatedEpisodeIds: [], skippedOversize: true };
  }

  // The endpoints handed to us may be distinct object instances from the rows
  // the store re-pointed; converge them too so a chained caller sees the final
  // id.
  source.threadId = winningThreadId;
  target.threadId = winningThreadId;

  options.onEvent?.({
    outcome: 'merged',
    winningThreadId,
    losingThreadId,
    updatedEpisodeCount: outcome.updatedEpisodeIds.length,
    timestamp: now().getTime(),
  });
  return {
    threadId: winningThreadId,
    updatedEpisodeIds: outcome.updatedEpisodeIds,
    skippedOversize: false,
  };
}
