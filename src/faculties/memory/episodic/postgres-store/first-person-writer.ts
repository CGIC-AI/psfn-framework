import { isDeepStrictEqual } from 'node:util';
import type { Pool } from 'pg';
import { executeQuery, queryOne } from '../../../../persistence/postgres.js';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  serializeEpisode,
  type Episode,
  type EpisodeAffect,
} from '../../../../shared/contracts/episodic-memory.js';
import {
  normalizeEpisodeLifecycleStatus,
  type CompanionAuthoredEpisodeCreateInput,
  type CompanionAuthoredEpisodeUpdateInput,
  type EpisodeCreateInput,
  type EpisodeFieldAuthorship,
  type EpisodeFirstPersonAuthorship,
  type EpisodeFirstPersonFieldSources,
  type EpisodeLifecycleStatus,
  type EpisodeUpdateInput,
} from '../store-port.js';
import { json, mapEpisodeRow, parseRequiredText } from './rows.js';

interface PostgresEpisodeWithAuthorshipRow {
  id: string;
  episode_json: unknown;
  affect_authorship: string | null;
  meaning_authorship: string | null;
}

interface EpisodeAuthorshipSnapshot {
  episode: Episode;
  authorship: EpisodeFirstPersonAuthorship;
}

const EMPTY_EPISODE_AFFECT: EpisodeAffect = { labels: [] };

function parsePersistedFieldAuthorship(
  value: string | null,
  episodeId: string,
  field: 'affect' | 'meaning',
): EpisodeFieldAuthorship {
  if (value === null) return 'legacy_unknown';
  if (value === 'none' || value === 'companion' || value === 'companion_preserved') return value;
  throw new Error(`malformed persisted episode "${episodeId}": unsupported ${field} authorship`);
}

function persistedAuthorshipValue(
  authorship: EpisodeFieldAuthorship,
): 'none' | 'companion' | 'companion_preserved' | null {
  return authorship === 'legacy_unknown' ? null : authorship;
}

/**
 * The only Postgres writer for first-person episode fields. It owns authority
 * validation, persisted authorship metadata, and compare-and-swap updates so a
 * concurrent companion write cannot be silently overwritten by stale machine
 * state.
 */
export class PostgresEpisodeFirstPersonWriter {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
  ) {}

  async createMachineEpisode(
    input: EpisodeCreateInput,
    sources?: EpisodeFirstPersonFieldSources,
  ): Promise<Episode> {
    const episode = this.parseCreateInput(input);
    const authorship = await this.resolveMachineAuthorship(episode, sources);
    await this.insertEpisode(
      episode,
      normalizeEpisodeLifecycleStatus(input.lifecycleStatus),
      authorship,
    );
    return episode;
  }

  async createCompanionEpisode(input: CompanionAuthoredEpisodeCreateInput): Promise<Episode> {
    const episode = this.parseCreateInput(input);
    await this.insertEpisode(
      episode,
      normalizeEpisodeLifecycleStatus(input.lifecycleStatus),
      {
        episodeId: episode.id,
        affect: 'companion',
        meaning: episode.meaning ? 'companion' : 'none',
      },
    );
    return episode;
  }

  async updateMachineEpisode(
    input: EpisodeUpdateInput,
    sources?: EpisodeFirstPersonFieldSources,
  ): Promise<Episode> {
    const current = await this.getSnapshot(input.id);
    if (!current) throw new Error(`episode "${input.id}" does not exist`);

    // A full-row machine update must carry authored meaning forward. Erasure
    // exists only on the companion-authored narrow patch below.
    if (current.episode.meaning && input.meaning === undefined) {
      throw new Error(
        `episode "${input.id}" update would drop companion-authored meaning; `
        + 'carry the existing meaning forward; companion authorship is required to erase it',
      );
    }

    const episode = parseEpisode({
      ...input,
      // Content updates never silently migrate the persisted episode schema.
      schemaVersion: current.episode.schemaVersion,
      createdAt: current.episode.createdAt,
      updatedAt: input.updatedAt ?? this.now().toISOString(),
    });

    let authorship: EpisodeFirstPersonAuthorship;
    if (!sources) {
      if (!isDeepStrictEqual(episode.affect, current.episode.affect)) {
        throw new Error(
          'machine episode write cannot author affect; the general update port must preserve it unchanged',
        );
      }
      if (!isDeepStrictEqual(episode.meaning, current.episode.meaning)) {
        throw new Error(
          'machine episode write cannot author meaning; the general update port must preserve it unchanged',
        );
      }
      authorship = current.authorship;
    } else {
      authorship = await this.resolveMachineAuthorship(episode, sources);
    }

    await this.persistEpisodeUpdate(episode, authorship, current);
    return episode;
  }

  async updateCompanionEpisode(input: CompanionAuthoredEpisodeUpdateInput): Promise<Episode> {
    if (input.clearMeaning && input.meaning !== undefined) {
      throw new Error('companion-authored episode update cannot set and clear meaning together');
    }
    const current = await this.getSnapshot(input.id);
    if (!current) throw new Error(`episode "${input.id}" does not exist`);

    const { meaning: _currentMeaning, ...currentWithoutMeaning } = current.episode;
    const nextMeaning = input.clearMeaning ? undefined : input.meaning ?? current.episode.meaning;
    const episode = parseEpisode({
      ...currentWithoutMeaning,
      affect: input.affect ?? current.episode.affect,
      ...(nextMeaning ? { meaning: nextMeaning } : {}),
      updatedAt: input.updatedAt ?? this.now().toISOString(),
    });
    const authorship: EpisodeFirstPersonAuthorship = {
      episodeId: episode.id,
      affect: input.affect === undefined ? current.authorship.affect : 'companion',
      meaning: input.clearMeaning
        ? 'none'
        : input.meaning === undefined
          ? current.authorship.meaning
          : 'companion',
    };
    await this.persistEpisodeUpdate(episode, authorship, current);
    return episode;
  }

  async getAuthorship(id: string): Promise<EpisodeFirstPersonAuthorship | undefined> {
    return (await this.getSnapshot(id))?.authorship;
  }

  private parseCreateInput(input: EpisodeCreateInput): Episode {
    const now = this.now().toISOString();
    const { lifecycleStatus: _lifecycleStatus, ...episodeFields } = input;
    return parseEpisode({
      ...episodeFields,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });
  }

  private async insertEpisode(
    episode: Episode,
    lifecycleStatus: EpisodeLifecycleStatus,
    authorship: EpisodeFirstPersonAuthorship,
  ): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO l01_episodes (
        id, schema_version, title, landmark, status, canonical_episode_id,
        merged_into_episode_id, superseded_by_episode_id, thread_id, channel_id,
        started_at, ended_at, participant_contact_ids, salience_score,
        salience_json, affect_json, themes, artifact_refs, provenance_refs,
        scope_json, consent_flags, episode_json, created_at, updated_at,
        affect_authorship, meaning_authorship
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,
        $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24,$25,$26
      )
    `, [
      episode.id,
      episode.schemaVersion,
      episode.title,
      episode.landmark,
      lifecycleStatus,
      episode.id,
      null,
      null,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      json(episode.participantContactIds),
      episode.salience.score,
      json(episode.salience),
      json(episode.affect),
      json(episode.themes),
      json(episode.artifactRefs),
      json(episode.provenanceRefs),
      json({}),
      json({}),
      serializeEpisode(episode),
      episode.createdAt,
      episode.updatedAt,
      persistedAuthorshipValue(authorship.affect),
      persistedAuthorshipValue(authorship.meaning),
    ]);
  }

  private async persistEpisodeUpdate(
    episode: Episode,
    authorship: EpisodeFirstPersonAuthorship,
    current: EpisodeAuthorshipSnapshot,
  ): Promise<void> {
    // The content/authorship snapshot is the compare-and-swap token. If a
    // companion or lifecycle writer wins the race after validation, this write
    // refuses instead of erasing or misattributing the newer first-person data.
    const result = await executeQuery(this.pool, `
      UPDATE l01_episodes
      SET
        schema_version = $2, title = $3, landmark = $4, thread_id = $5,
        channel_id = $6, started_at = $7, ended_at = $8,
        participant_contact_ids = $9::jsonb, salience_score = $10,
        salience_json = $11::jsonb, affect_json = $12::jsonb,
        themes = $13::jsonb, artifact_refs = $14::jsonb,
        provenance_refs = $15::jsonb, scope_json = $16::jsonb,
        consent_flags = $17::jsonb, episode_json = $18::jsonb,
        updated_at = $19, affect_authorship = $20, meaning_authorship = $21
      WHERE id = $1
        AND episode_json = $22::jsonb
        AND affect_authorship IS NOT DISTINCT FROM $23
        AND meaning_authorship IS NOT DISTINCT FROM $24
    `, [
      episode.id,
      episode.schemaVersion,
      episode.title,
      episode.landmark,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      json(episode.participantContactIds),
      episode.salience.score,
      json(episode.salience),
      json(episode.affect),
      json(episode.themes),
      json(episode.artifactRefs),
      json(episode.provenanceRefs),
      json({}),
      json({}),
      serializeEpisode(episode),
      episode.updatedAt,
      persistedAuthorshipValue(authorship.affect),
      persistedAuthorshipValue(authorship.meaning),
      serializeEpisode(current.episode),
      persistedAuthorshipValue(current.authorship.affect),
      persistedAuthorshipValue(current.authorship.meaning),
    ]);
    if (result.rowCount !== 1) {
      throw new Error(
        `episode "${episode.id}" changed concurrently; refusing stale first-person field update`,
      );
    }
  }

  private async resolveMachineAuthorship(
    episode: Episode,
    sources: EpisodeFirstPersonFieldSources | undefined,
  ): Promise<EpisodeFirstPersonAuthorship> {
    if (!sources) {
      if (!isDeepStrictEqual(episode.affect, EMPTY_EPISODE_AFFECT)) {
        throw new Error(
          'machine episode write cannot author affect; copy a persisted field through firstPersonFieldSources',
        );
      }
      if (episode.meaning !== undefined) {
        throw new Error(
          'machine episode write cannot author meaning; use the companion-authored episodic port',
        );
      }
      return { episodeId: episode.id, affect: 'none', meaning: 'none' };
    }

    if (sources.affectEpisodeIds.length === 0) {
      throw new Error('first-person affect preservation requires at least one source episode');
    }
    const sourceIds = [...new Set([
      ...sources.affectEpisodeIds,
      ...(sources.meaningEpisodeId ? [sources.meaningEpisodeId] : []),
    ])];
    const loaded = new Map<string, EpisodeAuthorshipSnapshot>();
    await Promise.all(sourceIds.map(async (sourceId) => {
      const source = await this.getSnapshot(sourceId);
      if (!source) {
        throw new Error(`first-person field source episode "${sourceId}" does not exist`);
      }
      this.assertConsistentSource(source);
      loaded.set(sourceId, source);
    }));

    const affectSources = sources.affectEpisodeIds.map((sourceId) => {
      const source = loaded.get(sourceId);
      if (!source) throw new Error(`first-person field source episode "${sourceId}" was not loaded`);
      return source;
    });
    const affectAtoms: Array<{ value: string | number; field: string }> = [
      ...episode.affect.labels.map(value => ({ value, field: 'label' })),
      ...(['valence', 'arousal', 'dominance'] as const).flatMap((field) => {
        const value = episode.affect[field];
        return value === undefined ? [] : [{ value, field }];
      }),
    ];
    const affectAuthorship = this.resolveAffectAuthorship(affectSources, affectAtoms);

    let meaningAuthorship: EpisodeFieldAuthorship = 'none';
    if (episode.meaning !== undefined) {
      if (!sources.meaningEpisodeId) {
        throw new Error(
          'machine episode write cannot author meaning; a persisted meaning source is required',
        );
      }
      const meaningSource = loaded.get(sources.meaningEpisodeId);
      if (!meaningSource
        || !isDeepStrictEqual(episode.meaning, meaningSource.episode.meaning)) {
        throw new Error(
          'machine episode write cannot author meaning; supplied meaning does not match its persisted source',
        );
      }
      if (meaningSource.authorship.meaning === 'none') {
        throw new Error(
          `machine episode write cannot copy unauthored meaning from episode "${sources.meaningEpisodeId}"`,
        );
      }
      meaningAuthorship = meaningSource.authorship.meaning === 'legacy_unknown'
        ? 'legacy_unknown'
        : 'companion_preserved';
    }

    return { episodeId: episode.id, affect: affectAuthorship, meaning: meaningAuthorship };
  }

  private resolveAffectAuthorship(
    sources: readonly EpisodeAuthorshipSnapshot[],
    atoms: readonly { value: string | number; field: string }[],
  ): EpisodeFieldAuthorship {
    if (atoms.length === 0) {
      const emptySources = sources.filter(source => (
        isDeepStrictEqual(source.episode.affect, EMPTY_EPISODE_AFFECT)
      ));
      if (emptySources.length === 0) {
        throw new Error(
          'machine episode write cannot author affect; empty affect is absent from persisted sources',
        );
      }
      if (emptySources.every(source => source.authorship.affect === 'none')) return 'none';
      return emptySources.some(source => source.authorship.affect === 'legacy_unknown')
        ? 'legacy_unknown'
        : 'companion_preserved';
    }

    let hasUnknownAtom = false;
    for (const atom of atoms) {
      const matchingSources = sources.filter((source) => (
        atom.field === 'label'
          ? source.episode.affect.labels.includes(String(atom.value))
          : source.episode.affect[atom.field as 'valence' | 'arousal' | 'dominance'] === atom.value
      ));
      if (matchingSources.length === 0) {
        throw new Error(
          `machine episode write cannot author affect; ${atom.field} is absent from persisted sources`,
        );
      }
      if (!matchingSources.some(source => (
        source.authorship.affect === 'companion'
        || source.authorship.affect === 'companion_preserved'
      ))) {
        hasUnknownAtom = true;
      }
    }
    return hasUnknownAtom ? 'legacy_unknown' : 'companion_preserved';
  }

  private assertConsistentSource(source: EpisodeAuthorshipSnapshot): void {
    const { episode, authorship } = source;
    if (authorship.affect === 'none'
      && !isDeepStrictEqual(episode.affect, EMPTY_EPISODE_AFFECT)) {
      throw new Error(`malformed persisted episode "${episode.id}": unauthored affect is not empty`);
    }
    if (authorship.meaning === 'none' && episode.meaning !== undefined) {
      throw new Error(`malformed persisted episode "${episode.id}": meaning has no author`);
    }
    if ((authorship.meaning === 'companion' || authorship.meaning === 'companion_preserved')
      && episode.meaning === undefined) {
      throw new Error(`malformed persisted episode "${episode.id}": authored meaning is absent`);
    }
  }

  private async getSnapshot(id: string): Promise<EpisodeAuthorshipSnapshot | undefined> {
    const normalizedId = parseRequiredText(id, 'episode id');
    const row = await queryOne<PostgresEpisodeWithAuthorshipRow>(this.pool, `
      SELECT id, episode_json, affect_authorship, meaning_authorship
      FROM l01_episodes
      WHERE id = $1
      LIMIT 1
    `, [normalizedId]);
    if (!row) return undefined;
    return {
      episode: mapEpisodeRow(row),
      authorship: {
        episodeId: row.id,
        affect: parsePersistedFieldAuthorship(row.affect_authorship, row.id, 'affect'),
        meaning: parsePersistedFieldAuthorship(row.meaning_authorship, row.id, 'meaning'),
      },
    };
  }
}
