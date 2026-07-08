import type { Pool } from 'pg';
import {
  createPostgresPool,
  ensurePostgresSchema,
  executeQuery,
} from '../postgres.js';
import { POSTGRES_REFLECTION_MIGRATIONS } from '../postgres/migrations.js';
import type {
  ReflectionMetacognitionJournalEntry,
  ReflectionMetacognitionMirrorStore,
} from '../journals/reflection-metacognition-journal.js';

function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class PostgresReflectionMetacognitionMirrorStore implements ReflectionMetacognitionMirrorStore {
  private constructor(private readonly pool: Pool) {}

  static async connect(
    databaseUrl: string,
    options: { schema?: string } = {},
  ): Promise<PostgresReflectionMetacognitionMirrorStore> {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-reflections',
      allowExitOnIdle: true,
      schema: options.schema,
    });
    await ensurePostgresSchema(pool, POSTGRES_REFLECTION_MIGRATIONS);
    return new PostgresReflectionMetacognitionMirrorStore(pool);
  }

  async mirrorEntry(entry: ReflectionMetacognitionJournalEntry): Promise<void> {
    await executeQuery(this.pool, `
      INSERT INTO reflections (
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
        metacognitive_flags,
        reflection_journal_entry_id,
        daily_journal_entry_id,
        process_id,
        mutation_before,
        mutation_after,
        prompt,
        reflection,
        deliberation,
        substrate_boundary,
        substrate_provenance_refs,
        payload,
        mirrored_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14::jsonb,
        $15,
        $16,
        $17,
        $18::jsonb,
        $19::jsonb,
        $20,
        $21,
        $22::jsonb,
        $23,
        $24::jsonb,
        $25::jsonb,
        $26
      )
      ON CONFLICT (id) DO UPDATE SET
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
        metacognitive_flags = excluded.metacognitive_flags,
        reflection_journal_entry_id = excluded.reflection_journal_entry_id,
        daily_journal_entry_id = excluded.daily_journal_entry_id,
        process_id = excluded.process_id,
        mutation_before = excluded.mutation_before,
        mutation_after = excluded.mutation_after,
        prompt = excluded.prompt,
        reflection = excluded.reflection,
        deliberation = excluded.deliberation,
        substrate_boundary = excluded.substrate_boundary,
        substrate_provenance_refs = excluded.substrate_provenance_refs,
        payload = excluded.payload,
        mirrored_at = excluded.mirrored_at
    `, [
      entry.id,
      entry.kind,
      entry.occurredAt,
      entry.templateId ?? null,
      entry.templateName ?? null,
      entry.executionSource ?? null,
      entry.initiatorSurface,
      entry.initiatedBy,
      entry.reason ?? null,
      entry.channelId ?? null,
      entry.sendToDiscordEffective ?? null,
      entry.mode ?? null,
      entry.internalStateSnapshotRef ?? null,
      toJson(entry.metacognitiveFlags ?? []),
      entry.reflectionJournalEntryId ?? null,
      entry.dailyJournalEntryId ?? null,
      entry.processId ?? null,
      toJson(entry.mutationBefore),
      toJson(entry.mutationAfter),
      entry.prompt ?? null,
      entry.reflection ?? null,
      toJson(entry.deliberation),
      entry.substrateBoundary ?? null,
      toJson(entry.substrateProvenanceRefs ?? []),
      JSON.stringify(entry),
      new Date().toISOString(),
    ]);
  }
}
