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

export interface ThreadAssignmentEvent {
  outcome: 'merged' | 'noop' | 'merge_skipped_oversize';
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

type ThreadUnionStore = Pick<EpisodicStorePort, 'searchByThread' | 'updateEpisode'>;

/**
 * Union the topic threads of two arc-linked episodes. The higher-id thread's
 * live episodes are re-pointed onto the lexicographically-smaller thread id.
 * The passed `source`/`target` objects are mutated in place so a caller
 * chaining several arcs in one pass observes the converged thread id.
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

  // One extra so we can detect (and refuse) an oversize merge without a count query.
  const members = await store.searchByThread(losingThreadId, {
    limit: options.maxThreadEpisodes + 1,
  });
  if (members.length > options.maxThreadEpisodes) {
    options.onEvent?.({
      outcome: 'merge_skipped_oversize',
      winningThreadId,
      losingThreadId,
      updatedEpisodeCount: 0,
      timestamp: now().getTime(),
    });
    return { threadId: winningThreadId, updatedEpisodeIds: [], skippedOversize: true };
  }

  const updatedEpisodeIds: string[] = [];
  for (const member of members) {
    await store.updateEpisode({ ...member, threadId: winningThreadId });
    member.threadId = winningThreadId;
    updatedEpisodeIds.push(member.id);
  }
  // The endpoints handed to us may be distinct object instances from the rows
  // just fetched; converge them too so a chained caller sees the final id.
  source.threadId = winningThreadId;
  target.threadId = winningThreadId;

  options.onEvent?.({
    outcome: 'merged',
    winningThreadId,
    losingThreadId,
    updatedEpisodeCount: updatedEpisodeIds.length,
    timestamp: now().getTime(),
  });
  return { threadId: winningThreadId, updatedEpisodeIds, skippedOversize: false };
}
