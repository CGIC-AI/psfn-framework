import type { EpisodeSubjectFilter } from '../store-port.js';

/**
 * SQL form of the subject-authorized episode predicate (psfn-framework-klvoz),
 * applied BEFORE pagination so an unauthorized episode is never materialized
 * and LIMIT/OFFSET pages count only authorized rows. Mirrors
 * `isEpisodeVisibleToSubject`: explicit participant attribution, plus
 * unattributed episodes only when the filter admits them (multi-admin D1).
 *
 * Pushes its parameter onto `params` and returns the predicate text for the
 * episode table aliased `alias` (or unqualified when omitted).
 */
export function episodeSubjectPredicate(
  filter: EpisodeSubjectFilter,
  params: unknown[],
  alias?: string,
): string {
  const viewerContactId = filter.viewerContactId.trim();
  if (!viewerContactId) {
    throw new Error('Episode subject filter requires a trusted viewer contact');
  }
  const column = alias ? `${alias}.participant_contact_ids` : 'participant_contact_ids';
  params.push(JSON.stringify([viewerContactId]));
  const attributed = `${column} @> $${params.length}::jsonb`;
  return filter.includeUnattributed
    ? `(${attributed} OR ${column} = '[]'::jsonb)`
    : `(${attributed})`;
}

/** Both endpoints of the arc (table alias `arcAlias`) must pass the filter. */
export function arcEndpointsSubjectPredicate(
  filter: EpisodeSubjectFilter,
  params: unknown[],
  arcAlias?: string,
): string {
  const prefix = arcAlias ? `${arcAlias}.` : '';
  const source = episodeSubjectPredicate(filter, params, 'subject_source');
  const target = episodeSubjectPredicate(filter, params, 'subject_target');
  return `EXISTS (
    SELECT 1 FROM l01_episodes subject_source
    WHERE subject_source.id = ${prefix}source_episode_id AND ${source}
  ) AND EXISTS (
    SELECT 1 FROM l01_episodes subject_target
    WHERE subject_target.id = ${prefix}target_episode_id AND ${target}
  )`;
}
