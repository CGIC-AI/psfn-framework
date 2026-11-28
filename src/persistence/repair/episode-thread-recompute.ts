import type { Pool } from 'pg';

import { ACTIVE_CANONICAL_ARC_FILTER, ACTIVE_CANONICAL_EPISODE_FILTER } from '../../faculties/memory/episodic/postgres-store/rows.js';
import {
  THREAD_FORMING_ARC_KINDS,
  computeThreadComponents,
  hasLegacySessionThreadId,
} from '../../faculties/memory/episodic/thread-assignment.js';
import type { EpisodeSpanRef } from '../../shared/contracts/episodic-memory.js';
import { isRecord } from '../../shared/utils/types.js';
import { withPostgresClient } from '../postgres.js';

/**
 * Recompute topic-thread identity for one companion schema (d5e0p.1).
 *
 * Live threads were unioned by every arc, including same_theme, so a
 * companion's recurring conversation collapsed into one unbounded thread.
 * This repair rebuilds `l01_episodes.thread_id` from scratch: every live
 * episode starts as its own singleton, and only thread-forming arcs union
 * threads, in arc creation order, refusing any union that would exceed the
 * cap. The result is deterministic for a given arc set, so a re-run plans
 * no updates.
 *
 * Pre-apq0 session-keyed threads (`threadId = sessionId`) are left exactly as
 * they are and arcs touching them are skipped: their historical repair is
 * psfn-framework-h4fp.7.
 *
 * Arcs are never modified. The whole recompute runs in one transaction that
 * row-locks every live episode, so it commits atomically and live unions wait
 * for it; run it while the companion's episodic lanes are idle anyway.
 */

export interface EpisodeThreadRecomputeOptions {
  dryRun: boolean;
  maxThreadEpisodes: number;
  now?: () => Date;
}

interface ThreadShape {
  threadCount: number;
  largestThreadSize: number;
}

export interface EpisodeThreadRecomputeReport {
  dryRun: boolean;
  maxThreadEpisodes: number;
  /** Every live episode in the schema, legacy session-keyed ones included. */
  liveEpisodeCount: number;
  /** Live episodes still on a pre-apq0 session-keyed thread; untouched. */
  legacySessionThreadEpisodeCount: number;
  /** Thread-forming arcs between two recomputed episodes. */
  threadFormingArcCount: number;
  /** Thread-forming arcs whose union the cap refused. */
  refusedArcCount: number;
  /** Thread shape of the recomputed (non-legacy) episodes. */
  before: ThreadShape;
  after: ThreadShape;
  plannedEpisodeUpdates: number;
  updatedEpisodes: number;
}

interface LiveEpisodeRow {
  id: string;
  thread_id: string | null;
  span_refs: unknown;
}

interface ThreadFormingArcRow {
  source_episode_id: string;
  target_episode_id: string;
}

function parseSpanRefs(value: unknown): EpisodeSpanRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref): EpisodeSpanRef[] => {
    if (!isRecord(ref)) return [];
    const spanId = typeof ref.spanId === 'string' ? ref.spanId : '';
    return [typeof ref.sessionId === 'string' ? { spanId, sessionId: ref.sessionId } : { spanId }];
  });
}

function threadShape(threadIds: Iterable<string>): ThreadShape {
  const sizes = new Map<string, number>();
  for (const threadId of threadIds) sizes.set(threadId, (sizes.get(threadId) ?? 0) + 1);
  return {
    threadCount: sizes.size,
    largestThreadSize: Math.max(0, ...sizes.values()),
  };
}

export async function recomputePostgresEpisodeThreads(
  pool: Pool,
  options: EpisodeThreadRecomputeOptions,
): Promise<EpisodeThreadRecomputeReport> {
  if (!Number.isInteger(options.maxThreadEpisodes) || options.maxThreadEpisodes < 1) {
    throw new Error('Episode thread recompute requires a positive integer maxThreadEpisodes');
  }
  const nowIso = (options.now ?? (() => new Date()))().toISOString();

  return withPostgresClient(pool, async (client) => {
    const episodes = (await client.query<LiveEpisodeRow>(`
      SELECT id, thread_id, episode_json->'spanRefs' AS span_refs
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
      ORDER BY id ASC
      FOR UPDATE
    `)).rows;

    const currentThreadById = new Map<string, string>();
    let legacySessionThreadEpisodeCount = 0;
    for (const row of episodes) {
      const legacy = hasLegacySessionThreadId({
        id: row.id,
        ...(row.thread_id !== null ? { threadId: row.thread_id } : {}),
        spanRefs: parseSpanRefs(row.span_refs),
      });
      if (legacy) {
        legacySessionThreadEpisodeCount += 1;
        continue;
      }
      currentThreadById.set(row.id, row.thread_id ?? row.id);
    }

    const arcs = (await client.query<ThreadFormingArcRow>(`
      SELECT source_episode_id, target_episode_id
      FROM l01_episode_arcs
      WHERE ${ACTIVE_CANONICAL_ARC_FILTER}
        AND arc_kind = ANY($1::text[])
      ORDER BY created_at ASC, id ASC
    `, [[...THREAD_FORMING_ARC_KINDS]])).rows;
    const edges = arcs
      .filter(arc => currentThreadById.has(arc.source_episode_id) && currentThreadById.has(arc.target_episode_id))
      .map(arc => [arc.source_episode_id, arc.target_episode_id] as const);

    let refusedArcCount = 0;
    const assignments = computeThreadComponents([...currentThreadById.keys()], edges, {
      maxThreadEpisodes: options.maxThreadEpisodes,
      onRefusedEdge: () => {
        refusedArcCount += 1;
      },
    });
    const changed = [...assignments].filter(([id, threadId]) => currentThreadById.get(id) !== threadId);

    if (!options.dryRun && changed.length > 0) {
      await client.query(`
        UPDATE l01_episodes AS episodes
        SET thread_id = planned.thread_id,
            episode_json = jsonb_set(
              jsonb_set(episodes.episode_json, '{threadId}', to_jsonb(planned.thread_id), true),
              '{updatedAt}', to_jsonb($3::text), true
            ),
            updated_at = $3::timestamptz
        FROM unnest($1::text[], $2::text[]) AS planned(id, thread_id)
        WHERE episodes.id = planned.id
      `, [changed.map(([id]) => id), changed.map(([, threadId]) => threadId), nowIso]);
    }

    return {
      dryRun: options.dryRun,
      maxThreadEpisodes: options.maxThreadEpisodes,
      liveEpisodeCount: episodes.length,
      legacySessionThreadEpisodeCount,
      threadFormingArcCount: edges.length,
      refusedArcCount,
      before: threadShape(currentThreadById.values()),
      after: threadShape(assignments.values()),
      plannedEpisodeUpdates: changed.length,
      updatedEpisodes: options.dryRun ? 0 : changed.length,
    };
  });
}
