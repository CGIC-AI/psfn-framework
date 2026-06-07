export const POSTGRES_PARITY_MATRIX_VERSION = 1 as const;

export const POSTGRES_PARITY_SURFACE_IDS = [
  'l0-session-archive',
  'session-search-projection',
  'l01-episodic-store',
  'l01-processing-watermarks',
  'l2-memory-records',
  'l2-memory-embeddings',
  'l2-memory-patch-provenance',
  'l2-memory-evolution-links',
  'scratchpad-store',
  'contact-store',
  'intention-store',
  'intention-care-reminders',
  'reflection-mirror',
  'gateway-audit',
  'backup-service',
  'startup-integrity-diagnostics',
  'cli-e2e-runtime-entrypoints',
  'maintenance-scripts',
  'config-defaults',
  'migration-audit-ledger',
  'migration-only-sqlite-reader',
] as const;

export type PostgresParitySurfaceId = (typeof POSTGRES_PARITY_SURFACE_IDS)[number];

export type PostgresParityCategory =
  | 'l0'
  | 'l01'
  | 'l2'
  | 'scratchpad'
  | 'contacts'
  | 'intentions'
  | 'reflections'
  | 'gateway'
  | 'operations'
  | 'tooling'
  | 'configuration'
  | 'migration';

export type PostgresParityStatus =
  | 'covered'
  | 'partial'
  | 'missing'
  | 'filesystem_truth'
  | 'remove_runtime_sqlite'
  | 'migration_only_exception';

export type PostgresParityCutoverAction =
  | 'preserve_filesystem_truth'
  | 'migrate_to_postgres'
  | 'add_postgres_schema'
  | 'add_postgres_adapter'
  | 'remove_runtime_sqlite'
  | 'keep_migration_only_reader';

export interface PostgresParityValidationRequirements {
  countParity: readonly string[];
  checksumParity: readonly string[];
  semanticParity: readonly string[];
}

export interface PostgresParityEntry {
  id: PostgresParitySurfaceId;
  category: PostgresParityCategory;
  title: string;
  status: PostgresParityStatus;
  cutoverAction: PostgresParityCutoverAction;
  sqliteSourceArtifacts: readonly string[];
  postgresDestinationArtifacts: readonly string[];
  codeReferences: readonly string[];
  noLossContract: readonly string[];
  validation: PostgresParityValidationRequirements;
  gaps: readonly string[];
}

export interface PostgresNoLossValidationContract {
  countParity: readonly string[];
  checksumParity: readonly string[];
  semanticParity: readonly string[];
  failClosed: readonly string[];
}

export interface MigrationOnlySqliteReaderException {
  allowedPurpose: string;
  allowedEntrypointShape: string;
  allowedSourceArtifacts: readonly string[];
  disallowedRuntimeSurfaces: readonly string[];
  requiredGuards: readonly string[];
}

const noRowChecksum = (surface: string): string => (
  `No row checksum is required for ${surface}; verify the future migration report records zero migrated database rows for this surface.`
);

export const POSTGRES_NO_LOSS_VALIDATION_CONTRACT = {
  countParity: [
    'For every migrated SQLite table, compare source row count to committed Postgres row count after filtering only documented tombstone/pruned rows.',
    'For every filesystem truth projection, compare authoritative JSONL entry counts to projection table counts per channel/session.',
    'For every relationship table, compare edge counts and endpoint existence counts after migration.',
    'For every deleted/restored/audit table, compare total rows plus active/restored status buckets.',
  ],
  checksumParity: [
    'Compute deterministic per-table checksums from canonical ordered primary keys and normalized payload columns before writing the migration manifest.',
    'Normalize JSON text to canonical JSON before checksum comparison so SQLite TEXT JSON and Postgres JSONB compare by meaning.',
    'Hash embeddings by memory id, dimension count, null/non-null state, and Float32 bytes or canonical pgvector text.',
    'Hash filesystem truth by path, line count, and per-line HMAC/integrity state without copying mutable sidecar paths into Postgres.',
  ],
  semanticParity: [
    'Run representative memory retrieval queries before and after migration and require expected memory ids in the same top-k band.',
    'Verify supersession, abstraction, deletion, restoration, and patch provenance chains can be traversed from both directions.',
    'Verify L0.1 episode overlap queries, lineage queries, and status/watermark transitions produce deterministic results.',
    'Verify contacts, trust/privacy classifications, intentions, scratchpad entries, reflections, audit history, and session search APIs return equivalent domain objects.',
  ],
  failClosed: [
    'The migration tool must stop on missing Postgres extensions, unsupported legacy schemas, malformed JSON, embedding dimension mismatch, or checksum mismatch.',
    'Post-cutover runtime startup must reject ordinary SQLite backend selection and direct SQLite runtime readers.',
    'Any allowed SQLite reader must be isolated to the one-shot migration command and must not be imported by gateway, agent, Garden/admin, e2e, or maintenance runtime commands.',
  ],
} as const satisfies PostgresNoLossValidationContract;

export const POSTGRES_PARITY_REQUIRED_CUTOVER_GAPS = [
  'l01-episodic-store',
  'l01-processing-watermarks',
  'l2-memory-patch-provenance',
  'l2-memory-evolution-links',
  'intention-care-reminders',
  'backup-service',
  'startup-integrity-diagnostics',
  'cli-e2e-runtime-entrypoints',
  'config-defaults',
  'migration-audit-ledger',
] as const satisfies readonly PostgresParitySurfaceId[];

export const POSTGRES_PARITY_MIGRATION_ONLY_SQLITE_READER_EXCEPTION = {
  allowedPurpose:
    'Read legacy SQLite files exactly once for deterministic SQLite-to-Postgres migration and validation.',
  allowedEntrypointShape:
    'A dedicated migration CLI/module with no gateway, agent, Garden/admin, e2e, scheduler, or normal maintenance imports.',
  allowedSourceArtifacts: [
    'legacy companion SQLite database',
    'legacy gateway audit SQLite database',
    'legacy session-search.sqlite projection',
    'legacy sqlite-vec l2_memory_embeddings table',
  ],
  disallowedRuntimeSurfaces: [
    'src/app/gateway/main.ts',
    'src/app/agent/main.ts',
    'src/app/startup/index.ts',
    'src/app/cli/chat-cli.ts',
    'src/app/e2e/*.ts',
    'src/operator/garden/**',
    'scheduler backup/runtime tasks',
  ],
  requiredGuards: [
    'The command must require an explicit source SQLite path and explicit Postgres target URL.',
    'The command must open SQLite read-only after checkpointing WAL sidecars or fail before migration.',
    'The command must write a Postgres migration audit row before and after every table batch.',
    'The command must refuse to run when the target Postgres schema has pending migrations or an existing incompatible migration manifest.',
  ],
} as const satisfies MigrationOnlySqliteReaderException;

export const POSTGRES_PARITY_MATRIX = [
  {
    id: 'l0-session-archive',
    category: 'l0',
    title: 'L0 append-only session archive',
    status: 'filesystem_truth',
    cutoverAction: 'preserve_filesystem_truth',
    sqliteSourceArtifacts: [
      'No SQLite source of truth; SessionStore persists channel JSONL files under state/sessions.',
      'Turn records are filesystem-backed through createFilesystemTurnRecordStorePort.',
    ],
    postgresDestinationArtifacts: [
      'No Postgres source-of-truth table by design.',
      'Postgres only owns searchable projection rows in session_messages_projection.',
    ],
    codeReferences: [
      'src/persistence/sessions/store.ts',
      'src/persistence/sessions/turn-records.ts',
      'src/persistence/sessions/postgres-adapters.ts',
    ],
    noLossContract: [
      'Keep JSONL sessions as authoritative L0 history through the cutover.',
      'Do not migrate mutable runtime truth for L0 into Postgres.',
      'Projection rebuilds must derive from JSONL, not from a previous session-search projection.',
    ],
    validation: {
      countParity: [
        'Count JSONL session entries by channel before and after migration.',
        'Count filesystem turn records by channel and compare with projected message ids.',
      ],
      checksumParity: [
        'Checksum each session JSONL file by canonical path plus ordered line hashes.',
        'Checksum turn-record files by canonical channel id and line hashes.',
      ],
      semanticParity: [
        'SessionManager.getRecent and session tools must return the same recent entries after projection rebuild.',
        'Projection repair must not mutate JSONL L0 history.',
      ],
    },
    gaps: [],
  },
  {
    id: 'session-search-projection',
    category: 'l0',
    title: 'Session search projection',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'session-search.sqlite: session_messages_index',
      'session-search.sqlite: session_fts',
      'session-search.sqlite: session_projection_drift',
    ],
    postgresDestinationArtifacts: [
      'session_messages_projection',
      'session_projection_drift',
      'tsvector generated column search_vector',
    ],
    codeReferences: [
      'src/persistence/sessions/transcript-projection.ts',
      'src/persistence/sessions/sqlite-adapters.ts',
      'src/persistence/sessions/postgres-adapters.ts',
      'src/persistence/postgres/migrations.ts',
      'src/app/maintenance/transcript-projection-repair.ts',
    ],
    noLossContract: [
      'Postgres projection must be rebuilt from L0 JSONL and must not depend on copying SQLite FTS rows.',
      'Projection drift markers must preserve channel id, reason, and marked timestamp.',
      'Search result domain fields must remain channelId, messageId, role, author, content, timestamp, visibility, score, and snippet.',
    ],
    validation: {
      countParity: [
        'Compare session_messages_index row count to session_messages_projection row count when migrating the projection.',
        'Compare per-channel projected counts to authoritative JSONL counts after rebuild.',
        'Compare session_projection_drift row counts and channel ids.',
      ],
      checksumParity: [
        'Checksum projection rows ordered by channel_id, message_id with role, author_id, author_name, content, timestamp, and visibility.',
        'Checksum drift rows ordered by channel_id with reason and marked_at.',
      ],
      semanticParity: [
        'Run keyword queries against both backends and require the same top channel/message ids for deterministic fixtures.',
        'Verify replaceChannelEntries clears stale rows and drift for the target channel.',
      ],
    },
    gaps: [],
  },
  {
    id: 'l01-episodic-store',
    category: 'l01',
    title: 'L0.1 episodic memory store',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'l01_episodes',
      'l01_episode_arcs',
      'episode_json spanRefs/artifactRefs/provenanceRefs embedded as JSON text',
    ],
    postgresDestinationArtifacts: [
      'Missing: l01_episodes Postgres table',
      'Missing: l01_episode_arcs Postgres table',
      'Missing: first-class episode spans, lineage, and status tables',
    ],
    codeReferences: [
      'src/faculties/memory/episodic/store.ts',
      'src/shared/contracts/episodic-memory.ts',
      'src/app/agent/core-runtime.ts',
      'src/app/agent/main.ts',
    ],
    noLossContract: [
      'Preserve every Episode and EpisodeArc contract field, including schemaVersion, spanRefs, artifactRefs, and provenanceRefs.',
      'Add searchable Postgres columns for thread/channel/time/salience plus JSONB payload parity.',
      'Add range/overlap-ready span representation so L0.1 overlap reconciliation can be validated without parsing opaque JSON only.',
      'Postgres runtime must instantiate an episodic store in the normal agent path.',
    ],
    validation: {
      countParity: [
        'Compare l01_episodes and l01_episode_arcs row counts.',
        'Compare counts by channel_id, thread_id, arc_kind, and status after Postgres status support lands.',
        'Compare extracted span counts from episode_json/spanRefs to first-class Postgres span rows.',
      ],
      checksumParity: [
        'Checksum canonical serialized Episode JSON by id plus searchable columns.',
        'Checksum canonical serialized EpisodeArc JSON by id plus source, target, kind, salience, and confidence.',
        'Checksum extracted span refs ordered by episode id and span id.',
      ],
      semanticParity: [
        'Verify list, get, time search, thread search, and arc direction queries return the same ids and ordering.',
        'Verify malformed payloads fail closed instead of being normalized silently.',
        'Verify Postgres mode runs episodic synthesis and exposes Garden/admin episodic memory data.',
      ],
    },
    gaps: [
      'No Postgres migration or adapter for l01_episodes.',
      'No Postgres migration or adapter for l01_episode_arcs.',
      'No first-class episode span, lineage, or status model.',
      'Postgres runtime passes null episodicStore because no SQLite db handle exists.',
    ],
  },
  {
    id: 'l01-processing-watermarks',
    category: 'l01',
    title: 'L0.1 synthesis processing watermarks',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'No durable SQLite watermark table; synthesis currently relies on runtime/session inputs.',
    ],
    postgresDestinationArtifacts: [
      'Missing: l01_processing_watermarks or equivalent per-channel/session high-water mark table.',
      'Missing: duplicate-candidate/canonical reconciliation state.',
    ],
    codeReferences: [
      'src/faculties/memory/episodic/synthesis.ts',
      'src/app/maintenance/force-episodic-synthesis.ts',
      'src/app/agent/main.ts',
    ],
    noLossContract: [
      'Persist the processed L0 range for each synthesis route so Postgres cutover does not duplicate or skip episodes.',
      'Record source session/channel, source message, processed range, previous watermark, next watermark, and reconciliation status.',
      'Treat missing or regressed watermarks as a migration/runtime diagnostic failure.',
    ],
    validation: {
      countParity: [
        'Count channels/sessions with L0 input and compare to watermark rows after migration initialization.',
        'Count candidate episodes produced from already processed ranges and require zero unexpected new canonical episodes.',
      ],
      checksumParity: [
        'Checksum watermark rows by channel/session, source range, status, and updated_at.',
        noRowChecksum('pre-existing SQLite watermarks because there is no durable source table'),
      ],
      semanticParity: [
        'Re-run synthesis against a migrated fixture and require idempotent episode/arcs counts.',
        'Verify overlap-aware reconciliation links duplicate candidates to canonical episodes instead of writing duplicates.',
      ],
    },
    gaps: [
      'No durable processing watermark storage.',
      'No persisted candidate-to-canonical reconciliation status.',
    ],
  },
  {
    id: 'l2-memory-records',
    category: 'l2',
    title: 'L2 memory records and companion memory tables',
    status: 'partial',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'l2_memories',
      'l2_memory_delete_versions',
      'l2_memory_abstraction_links',
      'l2_memory_maintenance_reviews',
      'memory_links',
      'contact_profiles',
    ],
    postgresDestinationArtifacts: [
      'l2_memories',
      'l2_memory_delete_versions',
      'l2_memory_abstraction_links',
      'l2_memory_maintenance_reviews',
      'memory_links',
      'contact_profiles',
    ],
    codeReferences: [
      'src/faculties/memory/store/schema.ts',
      'src/faculties/memory/store/read-write-operations.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve active, superseded, soft-deleted, restored, linked, abstracted, and maintenance-review state.',
      'Normalize SQLite TEXT JSON to Postgres JSONB for tags, scope_tags, provenance_refs, consent_flags, state_json, and candidate_memory_ids.',
      'Keep deletion snapshots and restoration markers sufficient to undo soft deletes after cutover.',
      'Keep contact profile synthesis artifacts and source memory ids intact.',
    ],
    validation: {
      countParity: [
        'Compare row counts for every listed table and status buckets for active, superseded, deleted, restored, pending, quarantined, resolved, and dismissed rows.',
        'Compare memory type counts and contact_id counts.',
        'Compare link endpoint counts and orphan counts before and after migration.',
      ],
      checksumParity: [
        'Checksum l2_memories ordered by id with normalized scalar and JSON columns.',
        'Checksum delete snapshots as canonical JSON plus restored fields.',
        'Checksum abstraction links, memory_links, maintenance reviews, and contact_profiles ordered by primary key.',
      ],
      semanticParity: [
        'Verify getById, listActiveMemories, countActiveMemories, getMemoriesByChannel, getMemoriesByContact, and linked-memory traversals match fixtures.',
        'Verify soft-deleted and superseded memories stay excluded from active search.',
        'Verify maintenance reviews deserialize to the same domain object shape.',
      ],
    },
    gaps: [
      'Postgres l2_memories lacks source_type and provenance_json columns required by SQLite MemoryStore.',
      'Postgres store does not currently hydrate or persist sourceType/provenance domain fields.',
    ],
  },
  {
    id: 'l2-memory-embeddings',
    category: 'l2',
    title: 'L2 vector embeddings',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'l2_memory_embeddings sqlite-vec virtual table',
    ],
    postgresDestinationArtifacts: [
      'l2_memories.embedding pgvector column',
      'Postgres schema validator rejects legacy l2_memory_embeddings tables.',
    ],
    codeReferences: [
      'src/faculties/memory/store/schema.ts',
      'src/faculties/memory/store/embeddings.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/persistence/backups/startup-checks.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'This is an intentional shape change, not a table-for-table copy.',
      'Every non-null SQLite embedding must land on the matching l2_memories.embedding row.',
      'Embedding dimension mismatch must fail the migration unless the operator explicitly runs a re-embedding migration instead of no-loss copy.',
    ],
    validation: {
      countParity: [
        'Compare non-null embedding counts by memory id.',
        'Compare missing-memory orphan embedding counts and require zero unresolved orphans after migration.',
      ],
      checksumParity: [
        'Checksum memory_id plus dimension count plus canonical Float32 vector bytes before and after conversion.',
      ],
      semanticParity: [
        'Run vector search fixture queries and require expected ids in the same top-k band.',
        'Verify pgvector dimension validation rejects wrong-sized writes and hydrates existing vectors.',
      ],
    },
    gaps: [],
  },
  {
    id: 'l2-memory-patch-provenance',
    category: 'l2',
    title: 'L2 memory patch events and write provenance',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'l2_memories.source_type',
      'l2_memories.provenance_json',
      'l2_memory_patch_events',
    ],
    postgresDestinationArtifacts: [
      'Missing: l2_memories.source_type',
      'Missing: l2_memories.provenance_json',
      'Missing: l2_memory_patch_events',
      'Missing: PostgresMemoryStore.recordPatchEvent implementation',
    ],
    codeReferences: [
      'src/faculties/memory/store/schema.ts',
      'src/faculties/memory/store/read-write-operations.ts',
      'src/faculties/memory/memory-store-port.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/faculties/memory/writer.ts',
      'src/faculties/memory/tools.ts',
    ],
    noLossContract: [
      'Preserve every memory sourceType/provenance domain field, not only provenance_refs.',
      'Preserve every patch event with source_ref, source_type, provenance_json, reason, patch_json, previous_json, next_json, and created_at.',
      'Patch API calls must remain auditable after cutover.',
      'Postgres MemoryStorePort implementation must satisfy recordPatchEvent and patch-event retrieval needs used by tooling/tests.',
    ],
    validation: {
      countParity: [
        'Compare count of memories grouped by source_type.',
        'Compare l2_memory_patch_events total row count and row count by memory_id.',
      ],
      checksumParity: [
        'Checksum source_type and canonical provenance_json per memory id.',
        'Checksum patch events ordered by id with canonical patch, previous, next, and provenance JSON.',
      ],
      semanticParity: [
        'Patch a migrated fixture memory and verify the update plus audit event are both visible.',
        'Verify source/provenance metadata survives memory write, patch, abstraction, and deletion flows.',
      ],
    },
    gaps: [
      'Missing source_type and provenance_json columns in Postgres l2_memories.',
      'Missing l2_memory_patch_events Postgres migration.',
      'Missing PostgresMemoryStore.recordPatchEvent.',
    ],
  },
  {
    id: 'l2-memory-evolution-links',
    category: 'l2',
    title: 'L2 memory evolution and lineage links',
    status: 'partial',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'l2_memories.superseded_by',
      'l2_memory_abstraction_links',
      'memory_links',
    ],
    postgresDestinationArtifacts: [
      'l2_memories.superseded_by',
      'l2_memory_abstraction_links',
      'memory_links',
      'Missing: memory_evolution_links first-class lineage table',
    ],
    codeReferences: [
      'src/faculties/memory/writer.ts',
      'src/faculties/memory/store/schema.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Existing supersession, abstraction, and related-memory links must remain queryable.',
      'Future Postgres schema must upgrade implicit superseded_by chains into explicit evolution links with reason/source/provenance when available.',
      'Retrieval must be able to expand bounded history across evolution links without reactivating deleted private content.',
    ],
    validation: {
      countParity: [
        'Compare superseded memory counts and chain endpoint counts.',
        'Compare abstraction links and memory_links row counts.',
        'Compare explicit memory_evolution_links counts to derived superseded_by/abstraction links after upgrade.',
      ],
      checksumParity: [
        'Checksum superseded_by relationships ordered by source memory id.',
        'Checksum abstraction and related links ordered by primary key.',
        'Checksum evolution links by source, target, link kind, source_ref, and provenance JSON once added.',
      ],
      semanticParity: [
        'Verify contradiction resolution chains and abstraction redaction chains can be traversed from source and target.',
        'Verify retrieval excludes inactive memories by default but can inspect bounded lineage when requested by future tooling.',
      ],
    },
    gaps: [
      'No first-class memory_evolution_links table.',
      'Existing Postgres lineage is split between superseded_by, abstraction links, and memory_links with no common source/provenance contract.',
    ],
  },
  {
    id: 'scratchpad-store',
    category: 'scratchpad',
    title: 'Scratchpad entries',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'scratchpad_entries',
      'scratchpad mirror JSON file under companion notes',
    ],
    postgresDestinationArtifacts: [
      'scratchpad_entries',
      'scratchpad mirror JSON file remains a companion-facing mirror',
    ],
    codeReferences: [
      'src/faculties/memory/store/schema.ts',
      'src/faculties/memory/store/scratchpad.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve id, content, created_at, updated_at, ordering, and pruning behavior.',
      'Keep the JSON mirror as a derived file, not an alternate source of truth.',
    ],
    validation: {
      countParity: [
        'Compare scratchpad_entries row counts.',
        'Compare post-pruning row count against configured scratchpad cap where applicable.',
      ],
      checksumParity: [
        'Checksum entries ordered by id with content, created_at, and updated_at.',
        'Checksum mirror JSON after Postgres store writes to ensure it reflects the same entry ids and ordering.',
      ],
      semanticParity: [
        'Verify add, replace, append, remove, get, and listScratchpadEntries behavior on migrated fixtures.',
      ],
    },
    gaps: [],
  },
  {
    id: 'contact-store',
    category: 'contacts',
    title: 'Contacts, channel identities, audit, and social graph',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'contacts',
      'contact_channel_ids',
      'contact_channel_activity',
      'contact_identity_link_verifications',
      'contact_mutation_audit',
      'social_graph_entities',
      'social_relationship_edges',
    ],
    postgresDestinationArtifacts: [
      'contacts',
      'contact_channel_ids',
      'contact_channel_activity',
      'contact_identity_link_verifications',
      'contact_mutation_audit',
      'social_graph_entities',
      'social_relationship_edges',
    ],
    codeReferences: [
      'src/core/contacts/store/schema.ts',
      'src/core/contacts/sqlite-adapter.ts',
      'src/core/contacts/postgres-adapter.ts',
      'src/core/contacts/postgres-adapter/schema.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve trust, relationship, emotional baseline/time series, notes, channel identities, activity privacy, identity link verification state, mutation audit, and social graph edges.',
      'Normalize JSON text columns to JSONB without losing empty object/array defaults.',
      'Legacy discord_user_id channel identity migration must be represented exactly once.',
    ],
    validation: {
      countParity: [
        'Compare row counts for all contact tables.',
        'Compare contacts grouped by trust_level, relationship_type, and presence of discord_user_id.',
        'Compare social graph node/edge counts and orphan relationship counts.',
      ],
      checksumParity: [
        'Checksum contact rows ordered by id with canonical emotional JSON and channel arrays.',
        'Checksum identity, activity, verification, audit, entity, and edge rows ordered by their primary keys.',
      ],
      semanticParity: [
        'Verify lookup by channel identity, privacy classification, mutation audit listing, trust policy export, and social graph queries match fixtures.',
      ],
    },
    gaps: [],
  },
  {
    id: 'intention-store',
    category: 'intentions',
    title: 'Active concerns, pending follow-ups, quarantine, and behavioral patterns',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'active_concerns',
      'intention_pending_follow_ups',
      'intention_pending_follow_up_quarantine',
      'behavioral_pattern_events',
    ],
    postgresDestinationArtifacts: [
      'active_concerns',
      'intention_pending_follow_ups',
      'intention_pending_follow_up_quarantine',
      'behavioral_pattern_events',
    ],
    codeReferences: [
      'src/core/intention/concerns.ts',
      'src/core/intention/pending-follow-ups.ts',
      'src/core/intention/patterns.ts',
      'src/core/intention/postgres-adapters.ts',
      'src/core/intention/postgres-adapters/schema.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve active/resolved/expired concern state, formation VAD, follow-up activation/quarantine state, and behavioral pattern promotion state.',
      'Keep priority/timing/channel/source check constraints fail-closed.',
      'Postgres runtime must inject providers and stores into the agent instead of falling back to SQLite.',
    ],
    validation: {
      countParity: [
        'Compare row counts for all listed tables.',
        'Compare active/resolved/expired concern buckets, activated/unactivated follow-up buckets, quarantine reason buckets, and behavioral outcome buckets.',
      ],
      checksumParity: [
        'Checksum concern rows by id with formation_vad canonical JSON.',
        'Checksum follow-up, quarantine, and behavioral pattern rows by id.',
      ],
      semanticParity: [
        'Verify active concern listing, recently resolved matching, follow-up enqueue/dequeue, quarantine listing, and behavioral pattern promotion fixtures.',
      ],
    },
    gaps: [],
  },
  {
    id: 'intention-care-reminders',
    category: 'intentions',
    title: 'Durable care reminders',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'intention_care_reminders',
    ],
    postgresDestinationArtifacts: [
      'Missing: intention_care_reminders Postgres migration',
      'Missing: Postgres care reminder adapter/provider',
    ],
    codeReferences: [
      'src/core/intention/care-reminders.ts',
      'src/core/intention/appraisal/input-normalization.ts',
      'src/core/intention/postgres-adapters.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve kind, classification, title, content, schedule, status, due time, provenance, contact/source linkage, activation count, and completion state.',
      'Care reminders must remain visible in appraisal prompts after Postgres cutover.',
      'Reminder status transitions must remain durable across restart.',
    ],
    validation: {
      countParity: [
        'Compare intention_care_reminders total row count.',
        'Compare counts by status, kind, classification, schedule, and contact_id.',
      ],
      checksumParity: [
        'Checksum reminder rows ordered by id with every scalar field.',
      ],
      semanticParity: [
        'Verify getActiveCareReminders, markTriggered, completion behavior, and appraisal prompt snapshots on migrated fixtures.',
      ],
    },
    gaps: [
      'No Postgres migration for intention_care_reminders.',
      'No Postgres care reminder port in createPostgresIntentionPorts.',
    ],
  },
  {
    id: 'reflection-mirror',
    category: 'reflections',
    title: 'Reflection metacognition mirror',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'reflections',
      'reflection journal JSONL remains filesystem companion truth',
    ],
    postgresDestinationArtifacts: [
      'reflections',
      'reflection journal JSONL remains filesystem companion truth',
    ],
    codeReferences: [
      'src/persistence/reflections/sqlite-mirror.ts',
      'src/persistence/reflections/postgres-mirror.ts',
      'src/persistence/journals/reflection-metacognition-journal.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Keep reflection journal JSONL as companion truth and Postgres reflections as queryable mirror.',
      'Preserve every mirror column and payload JSON, converting JSON text fields to JSONB by meaning.',
    ],
    validation: {
      countParity: [
        'Compare reflections row count to mirrored journal entry count.',
        'Compare counts by kind, template_id, process_id, and occurrence date bucket.',
      ],
      checksumParity: [
        'Checksum reflection rows ordered by id with canonical JSON for flags, mutations, deliberation, provenance, and payload.',
      ],
      semanticParity: [
        'Verify mirrorEntry upsert produces equivalent payload and queryable indexes for kind/template/process.',
      ],
    },
    gaps: [],
  },
  {
    id: 'gateway-audit',
    category: 'gateway',
    title: 'Gateway RPC audit log',
    status: 'covered',
    cutoverAction: 'migrate_to_postgres',
    sqliteSourceArtifacts: [
      'gateway_audit',
    ],
    postgresDestinationArtifacts: [
      'gateway_audit',
    ],
    codeReferences: [
      'src/boundary/gateway/audit.ts',
      'src/boundary/gateway/postgres-audit.ts',
      'src/boundary/gateway/privileged-core.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    noLossContract: [
      'Preserve id ordering, timestamp, method, decision, summarized params_json, duration_ms, and error.',
      'Preserve rotation semantics by age, count, and approximate payload size.',
      'Gateway startup must use Postgres audit store when Postgres persistence is selected.',
    ],
    validation: {
      countParity: [
        'Compare gateway_audit row count and counts by decision/method.',
        'Compare rotation-pruned row counts only after recording the documented pruned id range.',
      ],
      checksumParity: [
        'Checksum audit rows ordered by id with timestamp, method, decision, params_json, duration_ms, and error.',
      ],
      semanticParity: [
        'Verify getRecent, getByMethod, getApprovalEvents, count, and rotation behavior on migrated fixtures.',
      ],
    },
    gaps: [],
  },
  {
    id: 'backup-service',
    category: 'operations',
    title: 'Backup and restore verification',
    status: 'missing',
    cutoverAction: 'add_postgres_adapter',
    sqliteSourceArtifacts: [
      'BetterSqlite3 backup() snapshot of companion.db',
      'SQLite PRAGMA integrity_check during restore verification',
      'session JSONL snapshot',
      'optional memory journal and character-card files',
    ],
    postgresDestinationArtifacts: [
      'Missing: Postgres backup/export path or documented external backup contract',
      'Missing: Postgres restore verification checks',
    ],
    codeReferences: [
      'src/persistence/backups/service.ts',
      'src/persistence/backups/startup-checks.ts',
      'src/app/agent/scheduler-runtime.ts',
      'scripts/backup-restore-fixture.ts',
      'scripts/verify-backup-restore.ts',
    ],
    noLossContract: [
      'Backups must continue to capture database state, sessions, memory journal, character card, and history files.',
      'Postgres restore verification must validate schema version, pgvector availability, row counts/checksums, and representative semantic queries.',
      'Scheduler must not silently disable all database backup coverage in Postgres mode.',
    ],
    validation: {
      countParity: [
        'Compare counts from the live Postgres database to counts in restored backup verification.',
        'Compare session snapshot file counts and optional companion artifact counts.',
      ],
      checksumParity: [
        'Checksum backup manifest table checksums against restored Postgres table checksums.',
        'Checksum session and companion files copied into the backup.',
      ],
      semanticParity: [
        'Run restore verification against an isolated Postgres target and require schema, vector, memory retrieval, session search, contacts, intentions, reflections, and audit fixtures to pass.',
      ],
    },
    gaps: [
      'runBackupCycle requires a SQLite db handle and uses db.backup().',
      'verifyBackupRestore opens restored database with BetterSqlite3 and PRAGMA integrity_check.',
      'Agent scheduler disables scheduled SQLite backup task for non-sqlite persistence without replacing database backup coverage.',
    ],
  },
  {
    id: 'startup-integrity-diagnostics',
    category: 'operations',
    title: 'Startup integrity, dimensions, and runtime diagnostics',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'PRAGMA integrity_check',
      'l2_memory_embeddings schema/sample dimension detection',
      'startup logs for SQLite integrity and embedding mismatch',
    ],
    postgresDestinationArtifacts: [
      'Missing: Postgres runtime diagnostics table',
      'Missing: Postgres schema/version/extension health checks beyond memory schema validation',
      'Missing: migration/runtime diagnostics persistence',
    ],
    codeReferences: [
      'src/persistence/backups/startup-checks.ts',
      'src/app/agent/main.ts',
      'src/faculties/memory/postgres-store.ts',
      'src/persistence/postgres.ts',
    ],
    noLossContract: [
      'Postgres startup must fail closed on missing pgvector, unsupported schema, missing required tables, wrong embedding dimensions, and pending migration audit failures.',
      'Runtime diagnostics must record schema version, extension version, latest migration id, validation summary, and last successful no-loss verification.',
      'Diagnostics must be queryable by operations/admin surfaces after cutover.',
    ],
    validation: {
      countParity: [
        'Count diagnostics emitted during migration and startup and require at least one successful final validation record.',
        'Compare expected required-table count to discovered Postgres required-table count.',
      ],
      checksumParity: [
        'Checksum schema inventory by table, column, type, nullable/default, indexes, constraints, and extension versions.',
        noRowChecksum('SQLite PRAGMA integrity_check output because it is a status report, not a durable table'),
      ],
      semanticParity: [
        'Start a fixture runtime with missing pgvector, wrong embedding dims, and missing tables and verify each fails with a specific diagnostic.',
        'Start a valid Postgres fixture and verify diagnostics record a passed no-loss contract version.',
      ],
    },
    gaps: [
      'No shared Postgres runtime diagnostics table.',
      'Postgres startup logs skip SQLite checks but do not replace them with equivalent operational diagnostics.',
    ],
  },
  {
    id: 'cli-e2e-runtime-entrypoints',
    category: 'tooling',
    title: 'CLI and e2e runtime entrypoints',
    status: 'remove_runtime_sqlite',
    cutoverAction: 'remove_runtime_sqlite',
    sqliteSourceArtifacts: [
      'src/app/cli/chat-cli.ts opens initDatabase(config.databasePath).',
      'src/app/e2e/e2e-test.ts opens initDatabase(config.databasePath).',
      'src/app/e2e/e2e-walkthrough.ts opens initDatabase(config.databasePath).',
      'src/app/e2e/runtime-harness.ts sets DATABASE_PATH.',
    ],
    postgresDestinationArtifacts: [
      'Required: CLI/e2e should use split runtime or Postgres persistence factory.',
      'Required: isolated e2e fixtures should provision Postgres or explicitly test migration-only SQLite reader paths.',
    ],
    codeReferences: [
      'src/app/cli/chat-cli.ts',
      'src/app/e2e/e2e-test.ts',
      'src/app/e2e/e2e-walkthrough.ts',
      'src/app/e2e/runtime-harness.ts',
      'src/app/startup/composition/composition.ts',
    ],
    noLossContract: [
      'Normal CLI and e2e runtime paths must not create new SQLite companion state after cutover.',
      'Tests must exercise the same Postgres-backed persistence contracts as production runtime.',
      'Any remaining SQLite e2e fixture must be named as a migration-only fixture and must not run ordinary companion runtime.',
    ],
    validation: {
      countParity: [
        'Count direct initDatabase/better-sqlite3 runtime entrypoint imports and require zero outside migration-only readers and tests for the reader.',
        'Count e2e fixtures using Postgres persistence and require coverage for memory, sessions, contacts, intentions, and L0.1.',
      ],
      checksumParity: [
        noRowChecksum('CLI/e2e runtime entrypoints because this is code-surface deletion, not data migration'),
      ],
      semanticParity: [
        'Run CLI/e2e smoke paths against Postgres fixtures and verify they persist and retrieve data through Postgres-backed stores.',
      ],
    },
    gaps: [
      'chat-cli still opens SQLite memory state directly.',
      'e2e-test and e2e-walkthrough still open SQLite memory fixtures directly.',
      'CLI/e2e session composition now uses composeSessionRuntimeAsync with the Postgres runtime contract.',
    ],
  },
  {
    id: 'maintenance-scripts',
    category: 'tooling',
    title: 'Maintenance and repair scripts',
    status: 'partial',
    cutoverAction: 'remove_runtime_sqlite',
    sqliteSourceArtifacts: [
      'session:repair:transcript-projection supports SQLite and Postgres.',
      'migrate:embeddings opens SQLite and sqlite-vec.',
      'force-episodic-synthesis opens BetterSqlite3.',
      'session repair/import scripts may read filesystem L0 sources.',
    ],
    postgresDestinationArtifacts: [
      'Postgres transcript projection repair already exists.',
      'Required: Postgres embedding re-embedding/reindex path.',
      'Required: Postgres episodic synthesis command or removal of isolated SQLite-only command.',
    ],
    codeReferences: [
      'src/app/maintenance/transcript-projection-repair.ts',
      'src/app/maintenance/migrate-embeddings.ts',
      'src/app/maintenance/force-episodic-synthesis.ts',
      'src/faculties/memory/migration.ts',
      'scripts/import-discord-export-l0.ts',
      'scripts/import-voxta-l0.ts',
    ],
    noLossContract: [
      'Transcript projection repair remains valid because it can rebuild Postgres from L0 filesystem truth.',
      'Embedding re-embedding must target Postgres l2_memories.embedding and retain migration validation metrics.',
      'Forced episodic synthesis must use the Postgres episodic store after L0.1 Postgres support lands.',
      'SQLite readers in maintenance scripts must be migration-only or removed from normal runtime maintenance.',
    ],
    validation: {
      countParity: [
        'Count maintenance scripts that import initDatabase, better-sqlite3, or sqlite-vec and classify each as removed, Postgres-supported, test-only, or migration-only.',
        'For transcript repair, compare rebuilt projection counts as in session-search-projection.',
      ],
      checksumParity: [
        'For Postgres embedding re-embedding, checksum target embedding ids, dimensions, and vector bytes after rewrite.',
        noRowChecksum('removed maintenance script code paths'),
      ],
      semanticParity: [
        'Run transcript repair against Postgres fixtures.',
        'Run Postgres embedding re-embedding and verify retrieval validation metrics.',
        'Run forced episodic synthesis against Postgres L0.1 fixtures once the adapter exists.',
      ],
    },
    gaps: [
      'migrate-embeddings is SQLite/sqlite-vec only.',
      'force-episodic-synthesis is SQLite-only.',
    ],
  },
  {
    id: 'config-defaults',
    category: 'configuration',
    title: 'Persistence backend defaults and service/env wiring',
    status: 'partial',
    cutoverAction: 'remove_runtime_sqlite',
    sqliteSourceArtifacts: [
      'Legacy loadConfig selected local persistence when PERSISTENCE_BACKEND was empty.',
      'DATABASE_PATH remains a normal runtime env/config path.',
      'service templates and launcher allow DATABASE_PATH.',
    ],
    postgresDestinationArtifacts: [
      'Postgres default/fail-closed runtime backend contract.',
      'POSTGRES_DATABASE_URL or owner-file equivalent for Postgres runtime wiring.',
      'Required: DATABASE_PATH limited to migration-only input or removed from ordinary production runtime.',
    ],
    codeReferences: [
      'src/system/config/load-config.ts',
      'src/system/config/runtime-config-contracts.ts',
      'scripts/start-gateway-agent.sh',
      'scripts/system/install-psfn-service.sh',
      'scripts/system/user/purrsephone.service',
      '.env.example',
    ],
    noLossContract: [
      'After cutover, production/runtime startup must not silently choose SQLite when persistenceBackend is absent.',
      'Configuration should fail closed when Postgres URL/credentials or owner-file wiring is missing.',
      'DATABASE_PATH may survive only as an explicit migration source path or non-runtime compatibility input named in the live alpha boundary.',
    ],
    validation: {
      countParity: [
        'Count runtime config/service surfaces accepting DATABASE_PATH and require zero ordinary runtime consumers after cutover.',
        'Count startup paths defaulting persistenceBackend to sqlite and require zero.',
      ],
      checksumParity: [
        noRowChecksum('configuration defaults because this is fail-closed behavior, not row migration'),
      ],
      semanticParity: [
        'Start runtime with no persistence backend and verify it rejects instead of selecting SQLite.',
        'Start runtime with postgres backend and missing URL and verify the existing fail-closed error remains.',
        'Verify owner-file/Garden exposure for any new mutable Postgres settings.',
      ],
    },
    gaps: [
      'POSTGRES_DATABASE_URL is still env-owned runtime wiring.',
      'Runtime config still exposes databasePath as normal state.',
      'Launcher/service surfaces still carry DATABASE_PATH.',
    ],
  },
  {
    id: 'migration-audit-ledger',
    category: 'migration',
    title: 'Postgres migration audit ledger',
    status: 'missing',
    cutoverAction: 'add_postgres_schema',
    sqliteSourceArtifacts: [
      'No SQLite runtime table; required for the no-loss migration tool.',
    ],
    postgresDestinationArtifacts: [
      'Missing: postgres_migration_runs',
      'Missing: postgres_migration_table_checks',
      'Missing: postgres_migration_validation_failures',
    ],
    codeReferences: [
      'src/persistence/postgres/migrations.ts',
      'src/persistence/postgres.ts',
    ],
    noLossContract: [
      'Every migration run must record source file identity, source checksums, target schema version, table batch counts, validation summaries, operator options, and final status.',
      'Failed migrations must leave enough audit data to prove which rows committed and which validation failed.',
      'Runtime startup must be able to reject a Postgres database with an incomplete or failed cutover run.',
    ],
    validation: {
      countParity: [
        'Record one migration run row per attempted source-to-target migration.',
        'Record one table-check row per migrated source artifact plus one aggregate row for filesystem truth projections.',
      ],
      checksumParity: [
        'Store source checksum, target checksum, and normalized checksum algorithm id for every migrated table/projection.',
      ],
      semanticParity: [
        'Verify startup can read the latest successful migration run and reject failed/incomplete runs.',
        'Verify migration retry behavior is deterministic and idempotent for already validated batches.',
      ],
    },
    gaps: [
      'No migration audit tables exist in current Postgres migrations.',
      'No runtime check consumes a migration audit ledger.',
    ],
  },
  {
    id: 'migration-only-sqlite-reader',
    category: 'migration',
    title: 'Non-runtime SQLite reader exception',
    status: 'migration_only_exception',
    cutoverAction: 'keep_migration_only_reader',
    sqliteSourceArtifacts: [
      'Legacy companion SQLite database',
      'Legacy gateway audit SQLite database',
      'Legacy session-search.sqlite projection',
      'Legacy sqlite-vec l2_memory_embeddings table',
    ],
    postgresDestinationArtifacts: [
      'All rows copied into the Postgres destinations named by this matrix.',
      'Migration audit ledger records every source artifact, count, checksum, and semantic validation result.',
    ],
    codeReferences: [
      'src/persistence/sqlite-utils.ts',
      'src/persistence/postgres/parity-matrix.ts',
    ],
    noLossContract: [
      'SQLite remains allowed only as a read-only source for the one-shot no-loss migration tool.',
      'No gateway, agent, Garden/admin, e2e, scheduler, or normal maintenance runtime may import the migration-only reader.',
      'The reader must not create or mutate SQLite schema, WAL state, or runtime artifacts.',
    ],
    validation: {
      countParity: [
        'Count imports of the migration-only SQLite reader and require they are confined to the dedicated migration module and its tests.',
        'Count source artifacts opened by the migration tool and require every opened artifact has an audit-ledger table-check row.',
      ],
      checksumParity: [
        'Checksum every opened SQLite source artifact before and after read-only migration and require no source mutation.',
      ],
      semanticParity: [
        'Verify the migration command refuses to run from gateway, agent, Garden/admin, e2e, scheduler, or normal maintenance entrypoints.',
        'Verify missing source WAL/checkpoint prerequisites fail before any target writes.',
      ],
    },
    gaps: [
      'The exception is defined here; the dedicated migration reader and import hygiene checks still need implementation.',
    ],
  },
] as const satisfies readonly PostgresParityEntry[];

export function getPostgresParityEntry(id: PostgresParitySurfaceId): PostgresParityEntry {
  const entry = POSTGRES_PARITY_MATRIX.find(candidate => candidate.id === id);
  if (!entry) {
    throw new Error(`Unknown Postgres parity matrix surface: ${id}`);
  }
  return entry;
}

export function listPostgresParityGaps(): PostgresParityEntry[] {
  return POSTGRES_PARITY_MATRIX.filter(entry => entry.gaps.length > 0);
}
