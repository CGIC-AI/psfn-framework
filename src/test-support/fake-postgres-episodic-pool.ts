import type { QueryResult } from 'pg';

interface StoredEpisodeRow {
  id: string;
  status: string | null;
  canonical_episode_id: string | null;
  merged_into_episode_id: string | null;
  superseded_by_episode_id: string | null;
  thread_id: string | null;
  started_at: string;
  ended_at: string;
  episode_json: unknown;
}

interface StoredArcRow {
  id: string;
  source_episode_id: string;
  target_episode_id: string;
  arc_kind: string;
  status: string | null;
  canonical_arc_id: string | null;
  merged_into_arc_id: string | null;
  superseded_by_arc_id: string | null;
  updated_at: string;
  arc_json: unknown;
}

interface StoredWatermarkRow {
  id: string;
  processor: string;
  source_ref: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  high_water_turn_id: string | null;
  high_water_message_id: string | null;
  processed_started_at: string | null;
  processed_ended_at: string | null;
  previous_watermark_json: unknown;
  next_watermark_json: unknown;
  status: string;
  reconciliation_status: string;
  artifacts_json: unknown;
  last_processed_at: string;
  updated_at: string;
}

interface StoredCandidateDecisionRow {
  id: string;
  candidate_episode_id: string | null;
  canonical_episode_id: string | null;
  merged_into_episode_id: string | null;
  superseded_by_episode_id: string | null;
  source_watermark_id: string | null;
  status: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  overlap_score: number | null;
  confidence: number;
  reason: string | null;
  candidate_json: unknown;
  artifact_refs: unknown;
  provenance_refs: unknown;
  created_at: string;
  updated_at: string;
}

interface StoredEpisodeLineageRow {
  id: string;
  source_episode_id: string;
  target_episode_id: string;
  relation: string;
  confidence: number;
  reason: string | null;
  source_ref: string | null;
  provenance_refs: unknown;
  lineage_json: unknown;
  created_at: string;
}

function queryResult(rows: unknown[] = [], command = 'SELECT'): QueryResult {
  return {
    rows,
    command,
    rowCount: rows.length,
    oid: 0,
    fields: [],
  } as QueryResult;
}

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseEpisodeJson(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
}

function episodeJsonMatchesSession(episodeJson: unknown, sessionId: string): boolean {
  const parsed = parseEpisodeJson(episodeJson);
  const spanRefs = Array.isArray(parsed.spanRefs) ? parsed.spanRefs : [];
  return spanRefs.some(ref => (
    ref !== null && typeof ref === 'object'
    && (ref as { sessionId?: unknown }).sessionId === sessionId
  ));
}

/**
 * Mirror the store's `jsonb_set` re-point: patch threadId (and updatedAt) inside
 * the serialized episode_json without disturbing any other field. Preserves the
 * stored representation (string in, string out) so downstream parsing matches.
 */
function patchEpisodeJsonThreadId(
  episodeJson: unknown,
  threadId: string,
  updatedAt: string,
): unknown {
  const parsed = parseEpisodeJson(episodeJson);
  const patched = { ...parsed, threadId, updatedAt };
  return typeof episodeJson === 'string' ? JSON.stringify(patched) : patched;
}

function isActiveEpisode(row: StoredEpisodeRow): boolean {
  return (
    (row.status === null || row.status === 'canonical' || row.status === 'candidate')
    && (row.canonical_episode_id === null || row.canonical_episode_id === row.id)
    && row.merged_into_episode_id === null
    && row.superseded_by_episode_id === null
  );
}

function isActiveArc(row: StoredArcRow): boolean {
  return (
    (row.status === null || row.status === 'canonical')
    && (row.canonical_arc_id === null || row.canonical_arc_id === row.id)
    && row.merged_into_arc_id === null
    && row.superseded_by_arc_id === null
  );
}

interface StoredMessageClaimRow {
  episode_id: string;
  claim_key: string;
  turn_id: string | null;
  channel_id: string | null;
  session_id: string | null;
  status: string;
  claimed_at: string;
  transferred_to_episode_id: string | null;
  transferred_at: string | null;
  reason: string | null;
}

interface StoredArcAuditRow {
  id: string;
  arc_id: string;
  action: string;
  actor: string;
  reason: string;
  details_json: unknown;
  created_at: string;
}

export class FakeEpisodicPool {
  readonly episodes = new Map<string, StoredEpisodeRow>();
  readonly arcs = new Map<string, StoredArcRow>();
  readonly watermarks = new Map<string, StoredWatermarkRow>();
  readonly candidateDecisions = new Map<string, StoredCandidateDecisionRow>();
  readonly lineages = new Map<string, StoredEpisodeLineageRow>();
  readonly messageClaims = new Map<string, StoredMessageClaimRow>();
  readonly arcAudit = new Map<string, StoredArcAuditRow>();
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  async connect(): Promise<{ query: FakeEpisodicPool['query']; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => {},
    };
  }

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    this.queries.push({ text, values });
    const normalized = normalizeSql(text);

    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      return queryResult([], normalized.toUpperCase());
    }

    if (normalized.startsWith('insert into l01_episodes')) {
      const row: StoredEpisodeRow = {
        id: String(values[0] ?? ''),
        status: values[4] === null ? null : String(values[4] ?? ''),
        canonical_episode_id: values[5] === null ? null : String(values[5] ?? ''),
        merged_into_episode_id: values[6] === null ? null : String(values[6] ?? ''),
        superseded_by_episode_id: values[7] === null ? null : String(values[7] ?? ''),
        thread_id: values[8] === null ? null : String(values[8] ?? ''),
        started_at: String(values[10] ?? ''),
        ended_at: String(values[11] ?? ''),
        episode_json: values[21],
      };
      this.episodes.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('update l01_episodes set thread_id =')) {
      // apq0 atomic thread union: re-point a set of episode ids onto the
      // winning thread and keep episode_json.threadId consistent.
      const ids = new Set(Array.isArray(values[0]) ? values[0].map(String) : []);
      const toThreadId = String(values[1] ?? '');
      const updatedAt = String(values[2] ?? '');
      const updated: unknown[] = [];
      for (const id of ids) {
        const row = this.episodes.get(id);
        if (!row) continue;
        row.thread_id = toThreadId;
        row.episode_json = patchEpisodeJsonThreadId(row.episode_json, toThreadId, updatedAt);
        updated.push({});
      }
      return queryResult(updated, 'UPDATE');
    }

    if (normalized.startsWith("update l01_episodes set status = 'superseded'")) {
      const targetId = String(values[0] ?? '');
      const sourceIds = Array.isArray(values[2]) ? values[2].map(String) : [];
      for (const sourceId of sourceIds) {
        const row = this.episodes.get(sourceId);
        if (!row) continue;
        row.status = 'superseded';
        row.superseded_by_episode_id = targetId;
      }
      return queryResult([], 'UPDATE');
    }

    if (normalized.startsWith("update l01_episodes set status = 'merged'")) {
      const row = this.episodes.get(String(values[0] ?? ''));
      if (!row) return queryResult([], 'UPDATE');
      row.status = 'merged';
      row.merged_into_episode_id = String(values[1] ?? '');
      return queryResult([{}], 'UPDATE');
    }

    if (normalized.startsWith("update l01_episodes set status = 'canonical'")) {
      const row = this.episodes.get(String(values[0] ?? ''));
      if (!row || row.merged_into_episode_id !== null || row.superseded_by_episode_id !== null) {
        return queryResult([], 'UPDATE');
      }
      row.status = 'canonical';
      return queryResult([{}], 'UPDATE');
    }

    if (normalized.startsWith('update l01_episodes set')) {
      // Content update: lifecycle columns (status, canonical/merged/
      // superseded links) are intentionally preserved.
      const row = this.episodes.get(String(values[0] ?? ''));
      if (row) {
        row.thread_id = values[4] === null ? null : String(values[4] ?? '');
        row.started_at = String(values[6] ?? '');
        row.ended_at = String(values[7] ?? '');
        row.episode_json = values[17];
      }
      return queryResult([], 'UPDATE');
    }

    if (normalized.startsWith('insert into l01_episode_arcs')) {
      const row: StoredArcRow = {
        id: String(values[0] ?? ''),
        source_episode_id: String(values[2] ?? ''),
        target_episode_id: String(values[3] ?? ''),
        arc_kind: String(values[4] ?? ''),
        status: values[5] === null ? null : String(values[5] ?? ''),
        canonical_arc_id: values[6] === null ? null : String(values[6] ?? ''),
        merged_into_arc_id: values[7] === null ? null : String(values[7] ?? ''),
        superseded_by_arc_id: values[8] === null ? null : String(values[8] ?? ''),
        arc_json: values[15],
        updated_at: String(values[17] ?? ''),
      };
      this.arcs.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_processing_watermarks')) {
      const row: StoredWatermarkRow = {
        id: String(values[0] ?? ''),
        processor: String(values[1] ?? ''),
        channel_id: values[2] === null ? null : String(values[2] ?? ''),
        thread_id: values[3] === null ? null : String(values[3] ?? ''),
        session_id: values[4] === null ? null : String(values[4] ?? ''),
        source_ref: String(values[5] ?? ''),
        high_water_turn_id: values[6] === null ? null : String(values[6] ?? ''),
        high_water_message_id: values[7] === null ? null : String(values[7] ?? ''),
        processed_started_at: values[8] === null ? null : String(values[8] ?? ''),
        processed_ended_at: values[9] === null ? null : String(values[9] ?? ''),
        previous_watermark_json: values[10],
        next_watermark_json: values[11],
        status: String(values[12] ?? ''),
        reconciliation_status: String(values[13] ?? ''),
        artifacts_json: values[14],
        last_processed_at: String(values[15] ?? ''),
        updated_at: String(values[16] ?? ''),
      };
      this.watermarks.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_episode_candidates')) {
      const row: StoredCandidateDecisionRow = {
        id: String(values[0] ?? ''),
        candidate_episode_id: values[1] === null ? null : String(values[1] ?? ''),
        canonical_episode_id: values[2] === null ? null : String(values[2] ?? ''),
        merged_into_episode_id: values[3] === null ? null : String(values[3] ?? ''),
        superseded_by_episode_id: values[4] === null ? null : String(values[4] ?? ''),
        source_watermark_id: values[5] === null ? null : String(values[5] ?? ''),
        status: String(values[6] ?? ''),
        channel_id: values[7] === null ? null : String(values[7] ?? ''),
        thread_id: values[8] === null ? null : String(values[8] ?? ''),
        session_id: values[9] === null ? null : String(values[9] ?? ''),
        started_at: values[10] === null ? null : String(values[10] ?? ''),
        ended_at: values[11] === null ? null : String(values[11] ?? ''),
        overlap_score: values[12] === null ? null : Number(values[12]),
        confidence: Number(values[13] ?? 0),
        reason: values[14] === null ? null : String(values[14] ?? ''),
        candidate_json: values[15],
        artifact_refs: values[16],
        provenance_refs: values[17],
        created_at: String(values[18] ?? ''),
        updated_at: String(values[19] ?? ''),
      };
      this.candidateDecisions.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('insert into l01_episode_lineage')) {
      const row: StoredEpisodeLineageRow = {
        id: String(values[0] ?? ''),
        source_episode_id: String(values[1] ?? ''),
        target_episode_id: String(values[2] ?? ''),
        relation: String(values[3] ?? ''),
        confidence: Number(values[4] ?? 0),
        reason: values[5] === null ? null : String(values[5] ?? ''),
        source_ref: values[6] === null ? null : String(values[6] ?? ''),
        provenance_refs: values[7],
        lineage_json: values[8],
        created_at: String(values[9] ?? ''),
      };
      this.lineages.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('select id, episode_json from l01_episodes where id = any')) {
      const ids = Array.isArray(values[0]) ? values[0].map(String) : [];
      return queryResult(ids.flatMap((id) => {
        const row = this.episodes.get(id);
        return row ? [{ id: row.id, episode_json: row.episode_json }] : [];
      }));
    }

    if (normalized.startsWith('select id, episode_json from l01_episodes where id =')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      return queryResult(row ? [{ id: row.id, episode_json: row.episode_json }] : []);
    }

    if (normalized.startsWith('select id from l01_episodes where id =')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      return queryResult(row ? [{ id: row.id }] : []);
    }

    if (normalized.startsWith('select id from l01_episodes where thread_id =')) {
      // apq0 atomic thread union: the losing thread's live members, capped.
      // The `id = any` variant restricts to specific members (legacy
      // extraction) — mirrors the store's optional $3 filter.
      const threadId = String(values[0] ?? '');
      const limit = Number(values[1] ?? this.episodes.size);
      const memberIds = normalized.includes('and id = any')
        ? new Set(Array.isArray(values[2]) ? values[2].map(String) : [])
        : null;
      const rows = [...this.episodes.values()]
        .filter(isActiveEpisode)
        .filter(row => row.thread_id === threadId)
        .filter(row => memberIds === null || memberIds.has(row.id))
        .sort((left, right) => (
          left.started_at.localeCompare(right.started_at)
          || left.id.localeCompare(right.id)
        ))
        .slice(0, limit)
        .map(row => ({ id: row.id }));
      return queryResult(rows);
    }

    if (normalized.startsWith('select id, merged_into_episode_id, superseded_by_episode_id from l01_episodes where id =')) {
      const row = this.episodes.get(String(values[0] ?? ''));
      return queryResult(row
        ? [{
          id: row.id,
          merged_into_episode_id: row.merged_into_episode_id,
          superseded_by_episode_id: row.superseded_by_episode_id,
        }]
        : []);
    }

    if (normalized.startsWith('insert into l01_episode_message_claims')) {
      const row: StoredMessageClaimRow = {
        episode_id: String(values[0] ?? ''),
        claim_key: String(values[1] ?? ''),
        turn_id: values[2] === null || values[2] === undefined ? null : String(values[2]),
        channel_id: values[3] === null || values[3] === undefined ? null : String(values[3]),
        session_id: values[4] === null || values[4] === undefined ? null : String(values[4]),
        status: 'active',
        claimed_at: String(values[5] ?? ''),
        transferred_to_episode_id: null,
        transferred_at: null,
        reason: values.length > 6 && values[6] !== null && values[6] !== undefined ? String(values[6]) : null,
      };
      const rowKey = `${row.episode_id}${row.claim_key}`;
      if (this.messageClaims.has(rowKey)) {
        throw new Error(`duplicate key value violates unique constraint "l01_episode_message_claims_pkey" (${rowKey})`);
      }
      const activeHolder = [...this.messageClaims.values()].find(claim => (
        claim.claim_key === row.claim_key && claim.status === 'active'
      ));
      if (activeHolder) {
        throw new Error('duplicate key value violates unique constraint "idx_l01_episode_message_claims_active_key"');
      }
      this.messageClaims.set(rowKey, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith("update l01_episode_message_claims set status = 'transferred'")) {
      const targetId = String(values[0] ?? '');
      const transferredAt = String(values[1] ?? '');
      const reason = values[2] === null || values[2] === undefined ? null : String(values[2]);
      const sourceIds = new Set(Array.isArray(values[3]) ? values[3].map(String) : []);
      for (const claim of this.messageClaims.values()) {
        if (claim.status !== 'active' || !sourceIds.has(claim.episode_id)) continue;
        claim.status = 'transferred';
        claim.transferred_to_episode_id = targetId;
        claim.transferred_at = transferredAt;
        claim.reason = reason;
      }
      return queryResult([], 'UPDATE');
    }

    if (normalized.startsWith('select * from l01_episode_message_claims')) {
      return queryResult(this.filterMessageClaimRows(normalized, values));
    }

    if (normalized.startsWith('select id, episode_json from l01_episodes')) {
      return queryResult(this.filterEpisodeRows(normalized, values));
    }

    if (normalized.startsWith('select id, arc_json from l01_episode_arcs')) {
      return queryResult(this.filterArcRows(normalized, values));
    }

    if (normalized.startsWith('select id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id from l01_episode_arcs where id =')) {
      const row = this.arcs.get(String(values[0] ?? ''));
      return queryResult(row
        ? [{
          id: row.id,
          arc_json: row.arc_json,
          source_episode_id: row.source_episode_id,
          target_episode_id: row.target_episode_id,
          status: row.status,
          superseded_by_arc_id: row.superseded_by_arc_id,
        }]
        : []);
    }

    if (normalized.startsWith('select id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id from l01_episode_arcs where (source_episode_id =')) {
      const episodeId = String(values[0] ?? '');
      const rows = [...this.arcs.values()]
        .filter(isActiveArc)
        .filter(row => row.source_episode_id === episodeId || row.target_episode_id === episodeId)
        .sort((left, right) => (
          left.updated_at.localeCompare(right.updated_at)
          || left.id.localeCompare(right.id)
        ))
        .map(row => ({
          id: row.id,
          arc_json: row.arc_json,
          source_episode_id: row.source_episode_id,
          target_episode_id: row.target_episode_id,
          status: row.status,
          superseded_by_arc_id: row.superseded_by_arc_id,
        }));
      return queryResult(rows);
    }

    if (normalized.startsWith('select id from l01_episode_arcs where id <>')) {
      const excludedId = String(values[0] ?? '');
      const source = String(values[1] ?? '');
      const target = String(values[2] ?? '');
      const duplicate = [...this.arcs.values()]
        .filter(isActiveArc)
        .find(row => (
          row.id !== excludedId
          && (
            (row.source_episode_id === source && row.target_episode_id === target)
            || (row.source_episode_id === target && row.target_episode_id === source)
          )
        ));
      return queryResult(duplicate ? [{ id: duplicate.id }] : []);
    }

    if (normalized.startsWith("update l01_episode_arcs set status = 'superseded'")) {
      const row = this.arcs.get(String(values[0] ?? ''));
      if (!row) return queryResult([], 'UPDATE');
      row.status = 'superseded';
      row.superseded_by_arc_id = values[1] === null || values[1] === undefined ? null : String(values[1]);
      row.updated_at = String(values[2] ?? '');
      return queryResult([{}], 'UPDATE');
    }

    if (normalized.startsWith('update l01_episode_arcs set source_episode_id =')) {
      const row = this.arcs.get(String(values[0] ?? ''));
      if (!row) return queryResult([], 'UPDATE');
      row.source_episode_id = String(values[1] ?? '');
      row.target_episode_id = String(values[2] ?? '');
      row.arc_json = values[3];
      row.updated_at = String(values[4] ?? '');
      return queryResult([{}], 'UPDATE');
    }

    if (normalized.startsWith('insert into l01_episode_arc_audit')) {
      const row: StoredArcAuditRow = {
        id: String(values[0] ?? ''),
        arc_id: String(values[1] ?? ''),
        action: String(values[2] ?? ''),
        actor: String(values[3] ?? ''),
        reason: String(values[4] ?? ''),
        details_json: values[5],
        created_at: String(values[6] ?? ''),
      };
      if (!this.arcs.has(row.arc_id)) {
        throw new Error(`insert or update on table "l01_episode_arc_audit" violates foreign key constraint (${row.arc_id})`);
      }
      this.arcAudit.set(row.id, row);
      return queryResult([], 'INSERT');
    }

    if (normalized.startsWith('select * from l01_episode_arc_audit')) {
      let cursor = 0;
      let rows = [...this.arcAudit.values()];
      if (normalized.includes('arc_id =')) {
        const arcId = String(values[cursor++] ?? '');
        rows = rows.filter(row => row.arc_id === arcId);
      }
      const limit = Number(values[cursor++] ?? rows.length);
      return queryResult(rows
        .sort((left, right) => (
          left.created_at.localeCompare(right.created_at)
          || left.id.localeCompare(right.id)
        ))
        .slice(0, limit));
    }


    if (normalized.startsWith('with requested(episode_id) as') && normalized.includes('join l01_episode_arcs arcs')) {
      return queryResult(this.filterBatchArcRows(normalized, values));
    }

    if (normalized.startsWith('select * from l01_processing_watermarks')) {
      return queryResult(this.filterWatermarkRows(values));
    }

    if (normalized.startsWith('select * from l01_episode_candidates')) {
      return queryResult(this.filterCandidateDecisionRows(normalized, values));
    }

    throw new Error(`Unhandled SQL in FakeEpisodicPool: ${text}`);
  }

  private filterEpisodeRows(normalized: string, values: readonly unknown[]): Array<Pick<StoredEpisodeRow, 'id' | 'episode_json'>> {
    let cursor = 0;
    let rows = [...this.episodes.values()].filter(isActiveEpisode);

    if (normalized.includes("and status = 'candidate'")) {
      rows = rows.filter(row => row.status === 'candidate');
    } else if (normalized.includes("and (status is null or status = 'canonical')")) {
      rows = rows.filter(row => row.status === null || row.status === 'canonical');
    }
    if (normalized.includes('ended_at >=')) {
      const from = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.ended_at >= from);
    }
    if (normalized.includes('started_at <=')) {
      const to = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.started_at <= to);
    }
    if (normalized.includes('thread_id =')) {
      const threadId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.thread_id === threadId);
    }
    if (normalized.includes('episode_json @>')) {
      // apq0 real session scope: jsonb containment on spanRefs[].sessionId.
      const containment = parseEpisodeJson(values[cursor++]);
      const spanRefs = Array.isArray(containment.spanRefs) ? containment.spanRefs : [];
      const wantedSession = spanRefs.length > 0 && spanRefs[0] !== null && typeof spanRefs[0] === 'object'
        ? String((spanRefs[0] as { sessionId?: unknown }).sessionId ?? '')
        : '';
      rows = rows.filter(row => episodeJsonMatchesSession(row.episode_json, wantedSession));
    }

    const limit = Number(values[cursor++] ?? rows.length);
    const offset = Number(values[cursor++] ?? 0);
    const descending = normalized.includes('order by started_at desc');
    return rows
      .sort((left, right) => (
        (descending ? right.started_at.localeCompare(left.started_at) : left.started_at.localeCompare(right.started_at))
        || (descending ? right.id.localeCompare(left.id) : left.id.localeCompare(right.id))
      ))
      .slice(offset, offset + limit)
      .map(row => ({ id: row.id, episode_json: row.episode_json }));
  }

  private filterArcRows(normalized: string, values: readonly unknown[]): Array<Pick<StoredArcRow, 'id' | 'arc_json'>> {
    let cursor = 0;
    let rows = [...this.arcs.values()].filter(isActiveArc);

    if (normalized.includes('(source_episode_id =')) {
      const sourceEpisodeId = String(values[cursor++] ?? '');
      const targetEpisodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_episode_id === sourceEpisodeId || row.target_episode_id === targetEpisodeId);
    } else if (normalized.includes('target_episode_id =')) {
      const episodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.target_episode_id === episodeId);
    } else if (normalized.includes('source_episode_id =')) {
      const episodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_episode_id === episodeId);
    }

    if (normalized.includes('arc_kind =')) {
      const arcKind = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.arc_kind === arcKind);
    }

    const limit = Number(values[cursor++] ?? rows.length);
    return rows
      .sort((left, right) => (
        right.updated_at.localeCompare(left.updated_at)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit)
      .map(row => ({ id: row.id, arc_json: row.arc_json }));
  }

  private filterBatchArcRows(normalized: string, values: readonly unknown[]): Array<Pick<StoredArcRow, 'id' | 'arc_json'>> {
    const episodeIds = Array.isArray(values[0]) ? values[0].map(String) : [];
    let cursor = 1;
    const arcKind = normalized.includes('arc_kind =')
      ? String(values[cursor++] ?? '')
      : undefined;
    const limit = Number(values[cursor++] ?? this.arcs.size);
    const direction = normalized.includes('arcs.source_episode_id = requested.episode_id or arcs.target_episode_id = requested.episode_id')
      ? 'both'
      : normalized.includes('arcs.target_episode_id = requested.episode_id')
        ? 'incoming'
        : 'outgoing';

    const byId = new Map<string, StoredArcRow>();
    for (const episodeId of episodeIds) {
      const matches = [...this.arcs.values()]
        .filter(isActiveArc)
        .filter(row => arcKind === undefined || row.arc_kind === arcKind)
        .filter((row) => {
          if (direction === 'incoming') return row.target_episode_id === episodeId;
          if (direction === 'outgoing') return row.source_episode_id === episodeId;
          return row.source_episode_id === episodeId || row.target_episode_id === episodeId;
        })
        .sort((left, right) => (
          right.updated_at.localeCompare(left.updated_at)
          || left.id.localeCompare(right.id)
        ))
        .slice(0, limit);
      for (const row of matches) {
        byId.set(row.id, row);
      }
    }

    return [...byId.values()]
      .sort((left, right) => (
        right.updated_at.localeCompare(left.updated_at)
        || left.id.localeCompare(right.id)
      ))
      .map(row => ({ id: row.id, arc_json: row.arc_json }));
  }

  private filterWatermarkRows(values: readonly unknown[]): StoredWatermarkRow[] {
    if (values.length <= 1) {
      const limit = Number(values[0] ?? this.watermarks.size);
      return [...this.watermarks.values()]
        .sort((left, right) => (
          left.updated_at.localeCompare(right.updated_at)
          || left.id.localeCompare(right.id)
        ))
        .slice(0, limit);
    }
    const processor = String(values[0] ?? '');
    const sourceRef = String(values[1] ?? '');
    const channelId = String(values[2] ?? '');
    const threadId = String(values[3] ?? '');
    const sessionId = String(values[4] ?? '');
    return [...this.watermarks.values()].filter(row => (
      row.processor === processor
      && row.source_ref === sourceRef
      && (row.channel_id ?? '') === channelId
      && (row.thread_id ?? '') === threadId
      && (row.session_id ?? '') === sessionId
    ));
  }

  private filterMessageClaimRows(normalized: string, values: readonly unknown[]): StoredMessageClaimRow[] {
    if (normalized.includes("where status = 'active'")) {
      const ids = Array.isArray(values[0]) ? values[0].map(String) : [];
      const idSet = new Set(ids);
      const byEpisode = normalized.includes('episode_id = any');
      return [...this.messageClaims.values()].filter(claim => (
        claim.status === 'active'
        && idSet.has(byEpisode ? claim.episode_id : claim.claim_key)
      ));
    }

    let cursor = 0;
    let rows = [...this.messageClaims.values()];
    if (normalized.includes('episode_id = $')) {
      const episodeId = String(values[cursor++] ?? '');
      rows = rows.filter(claim => claim.episode_id === episodeId);
    }
    if (normalized.includes('claim_key = any')) {
      const raw = values[cursor++];
      const claimKeys = new Set(Array.isArray(raw) ? raw.map(String) : []);
      rows = rows.filter(claim => claimKeys.has(claim.claim_key));
    }
    if (normalized.includes('status = $')) {
      const status = String(values[cursor++] ?? '');
      rows = rows.filter(claim => claim.status === status);
    }
    const limit = Number(values[cursor++] ?? rows.length);
    return rows
      .sort((left, right) => (
        left.claimed_at.localeCompare(right.claimed_at)
        || left.episode_id.localeCompare(right.episode_id)
        || left.claim_key.localeCompare(right.claim_key)
      ))
      .slice(0, limit);
  }

  private filterCandidateDecisionRows(normalized: string, values: readonly unknown[]): StoredCandidateDecisionRow[] {
    let cursor = 0;
    let rows = [...this.candidateDecisions.values()];
    if (normalized.includes('source_watermark_id =')) {
      const sourceWatermarkId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.source_watermark_id === sourceWatermarkId);
    }
    if (normalized.includes('canonical_episode_id =')) {
      const canonicalEpisodeId = String(values[cursor++] ?? '');
      rows = rows.filter(row => row.canonical_episode_id === canonicalEpisodeId);
    }
    const limit = Number(values[cursor++] ?? rows.length);
    return rows
      .sort((left, right) => (
        left.created_at.localeCompare(right.created_at)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, limit);
  }
}
