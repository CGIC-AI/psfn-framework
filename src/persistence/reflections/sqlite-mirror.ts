import type Database from 'better-sqlite3';
import type {
  ReflectionMetacognitionJournalEntry,
  ReflectionMetacognitionMirrorStore,
} from '../journals/reflection-metacognition-journal.js';

const REFLECTIONS_TABLE = 'reflections';

function toSqliteBoolean(value: boolean | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

function toJson(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }
  return JSON.stringify(value);
}

export class SqliteReflectionMetacognitionMirrorStore implements ReflectionMetacognitionMirrorStore {
  private readonly insertStatement: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.ensureSchema();
    this.insertStatement = this.db.prepare(`
      INSERT INTO ${REFLECTIONS_TABLE} (
        id,
        kind,
        occurred_at,
        template_id,
        template_name,
        execution_source,
        initiator_surface,
        initiated_by,
        reason,
        channel_id,
        send_to_discord_effective,
        mode,
        internal_state_snapshot_ref,
        metacognitive_flags_json,
        reflection_journal_entry_id,
        daily_journal_entry_id,
        process_id,
        mutation_before_json,
        mutation_after_json,
        prompt,
        reflection,
        deliberation_json,
        substrate_boundary,
        substrate_provenance_refs_json,
        payload_json,
        mirrored_at
      ) VALUES (
        @id,
        @kind,
        @occurred_at,
        @template_id,
        @template_name,
        @execution_source,
        @initiator_surface,
        @initiated_by,
        @reason,
        @channel_id,
        @send_to_discord_effective,
        @mode,
        @internal_state_snapshot_ref,
        @metacognitive_flags_json,
        @reflection_journal_entry_id,
        @daily_journal_entry_id,
        @process_id,
        @mutation_before_json,
        @mutation_after_json,
        @prompt,
        @reflection,
        @deliberation_json,
        @substrate_boundary,
        @substrate_provenance_refs_json,
        @payload_json,
        @mirrored_at
      )
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        occurred_at = excluded.occurred_at,
        template_id = excluded.template_id,
        template_name = excluded.template_name,
        execution_source = excluded.execution_source,
        initiator_surface = excluded.initiator_surface,
        initiated_by = excluded.initiated_by,
        reason = excluded.reason,
        channel_id = excluded.channel_id,
        send_to_discord_effective = excluded.send_to_discord_effective,
        mode = excluded.mode,
        internal_state_snapshot_ref = excluded.internal_state_snapshot_ref,
        metacognitive_flags_json = excluded.metacognitive_flags_json,
        reflection_journal_entry_id = excluded.reflection_journal_entry_id,
        daily_journal_entry_id = excluded.daily_journal_entry_id,
        process_id = excluded.process_id,
        mutation_before_json = excluded.mutation_before_json,
        mutation_after_json = excluded.mutation_after_json,
        prompt = excluded.prompt,
        reflection = excluded.reflection,
        deliberation_json = excluded.deliberation_json,
        substrate_boundary = excluded.substrate_boundary,
        substrate_provenance_refs_json = excluded.substrate_provenance_refs_json,
        payload_json = excluded.payload_json,
        mirrored_at = excluded.mirrored_at
    `);
  }

  async mirrorEntry(entry: ReflectionMetacognitionJournalEntry): Promise<void> {
    this.insertStatement.run({
      id: entry.id,
      kind: entry.kind,
      occurred_at: entry.occurredAt,
      template_id: entry.templateId ?? null,
      template_name: entry.templateName ?? null,
      execution_source: entry.executionSource ?? null,
      initiator_surface: entry.initiatorSurface,
      initiated_by: entry.initiatedBy,
      reason: entry.reason ?? null,
      channel_id: entry.channelId ?? null,
      send_to_discord_effective: toSqliteBoolean(entry.sendToDiscordEffective),
      mode: entry.mode ?? null,
      internal_state_snapshot_ref: entry.internalStateSnapshotRef ?? null,
      metacognitive_flags_json: JSON.stringify(entry.metacognitiveFlags ?? []),
      reflection_journal_entry_id: entry.reflectionJournalEntryId ?? null,
      daily_journal_entry_id: entry.dailyJournalEntryId ?? null,
      process_id: entry.processId ?? null,
      mutation_before_json: toJson(entry.mutationBefore),
      mutation_after_json: toJson(entry.mutationAfter),
      prompt: entry.prompt ?? null,
      reflection: entry.reflection ?? null,
      deliberation_json: toJson(entry.deliberation),
      substrate_boundary: entry.substrateBoundary ?? null,
      substrate_provenance_refs_json: JSON.stringify(entry.substrateProvenanceRefs ?? []),
      payload_json: JSON.stringify(entry),
      mirrored_at: new Date().toISOString(),
    });
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${REFLECTIONS_TABLE} (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        template_id TEXT,
        template_name TEXT,
        execution_source TEXT,
        initiator_surface TEXT NOT NULL,
        initiated_by TEXT NOT NULL,
        reason TEXT,
        channel_id TEXT,
        send_to_discord_effective INTEGER,
        mode TEXT,
        internal_state_snapshot_ref TEXT,
        metacognitive_flags_json TEXT NOT NULL DEFAULT '[]',
        reflection_journal_entry_id TEXT,
        daily_journal_entry_id TEXT,
        process_id TEXT,
        mutation_before_json TEXT,
        mutation_after_json TEXT,
        prompt TEXT,
        reflection TEXT,
        deliberation_json TEXT,
        substrate_boundary TEXT,
        substrate_provenance_refs_json TEXT NOT NULL DEFAULT '[]',
        payload_json TEXT NOT NULL,
        mirrored_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reflections_occurred_at ON ${REFLECTIONS_TABLE}(occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_reflections_kind ON ${REFLECTIONS_TABLE}(kind, occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_reflections_template ON ${REFLECTIONS_TABLE}(template_id, occurred_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_reflections_process ON ${REFLECTIONS_TABLE}(process_id, occurred_at DESC, id DESC);
    `);
  }
}
