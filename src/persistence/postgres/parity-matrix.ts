export const POSTGRES_PARITY_MATRIX_VERSION = 2 as const;

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
  'runtime-entrypoints',
  'maintenance-scripts',
  'config-defaults',
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
  | 'configuration';

export type PostgresParityStatus = 'covered' | 'partial' | 'missing' | 'filesystem_truth';

export type PostgresParityOwnership =
  | 'filesystem_truth'
  | 'postgres_projection'
  | 'postgres_runtime'
  | 'postgres_operations';

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
  ownership: PostgresParityOwnership;
  sourceOfTruthArtifacts: readonly string[];
  postgresArtifacts: readonly string[];
  codeReferences: readonly string[];
  integrityContract: readonly string[];
  validation: PostgresParityValidationRequirements;
  gaps: readonly string[];
}

export interface PostgresNoLossValidationContract {
  countParity: readonly string[];
  checksumParity: readonly string[];
  semanticParity: readonly string[];
  failClosed: readonly string[];
}

const noRowChecksum = (surface: string): string => (
  `No row checksum applies to ${surface}; validate the configured ownership and absence of alternate durable state.`
);

export const POSTGRES_NO_LOSS_VALIDATION_CONTRACT = {
  countParity: [
    'For filesystem truth projected into Postgres, compare authoritative entry counts to projection rows per channel or logical session.',
    'For each Postgres-owned aggregate, compare persisted row counts and lifecycle buckets to the domain objects accepted by the active store.',
    'For every relationship table, verify edge counts and endpoint existence after writes, deletes, and supersession.',
    'For backup restore checks, compare the captured table inventory and representative source row presence to the scratch restore.',
  ],
  checksumParity: [
    'Compute deterministic checksums from ordered primary keys and canonical payload columns for backup and repair verification.',
    'Normalize JSON values before hashing so object key order cannot hide a persistence mismatch.',
    'Hash embeddings by record id, dimension count, null state, and canonical vector values.',
    'Hash filesystem truth by canonical relative path and ordered content without treating derived projections as authority.',
  ],
  semanticParity: [
    'Exercise memory retrieval, deletion, restoration, provenance, evolution, and episodic lineage through active ports.',
    'Exercise session search by rebuilding its Postgres projection from canonical JSONL.',
    'Exercise contacts, trust classification, intentions, reflections, gateway audit, and scratchpad through their active Postgres stores.',
    'Exercise backup restoration in a scratch Postgres database with schema, extension, table, and representative row checks.',
  ],
  failClosed: [
    'Runtime startup rejects every persistence backend other than Postgres.',
    'Runtime startup rejects a missing database URL, unavailable pgvector support, schema mismatch, or embedding dimension mismatch.',
    'No gateway, agent, Garden, scheduler, e2e, smoke, or maintenance entrypoint may import a retired local-database implementation.',
    'Repository verification rejects retired persistence packages, modules, and unclassified backend references.',
  ],
} as const satisfies PostgresNoLossValidationContract;

export const POSTGRES_PARITY_REQUIRED_GAPS = [
  'intention-care-reminders',
  'backup-service',
] as const satisfies readonly PostgresParitySurfaceId[];

export const POSTGRES_PARITY_MATRIX = [
  {
    id: 'l0-session-archive',
    category: 'l0',
    title: 'L0 append-only session archive',
    status: 'filesystem_truth',
    ownership: 'filesystem_truth',
    sourceOfTruthArtifacts: [
      'Per-channel signed JSONL session journals',
      'Filesystem turn-record journals',
    ],
    postgresArtifacts: [
      'session_messages_projection is rebuildable search state, never L0 authority',
    ],
    codeReferences: [
      'src/persistence/sessions/store.ts',
      'src/persistence/sessions/store/journal-runtime.ts',
      'src/persistence/sessions/turn-records.ts',
    ],
    integrityContract: [
      'Keep signed JSONL as authoritative autobiographical history.',
      'Projection rebuild and repair must not mutate L0 history.',
    ],
    validation: {
      countParity: ['Count journal entries and turn records per channel before and after projection rebuild.'],
      checksumParity: ['Checksum each journal by canonical relative path and ordered signed lines.'],
      semanticParity: ['SessionStore recent reads and projection repair return the same active messages.'],
    },
    gaps: [],
  },
  {
    id: 'session-search-projection',
    category: 'l0',
    title: 'Session search projection',
    status: 'covered',
    ownership: 'postgres_projection',
    sourceOfTruthArtifacts: ['Signed L0 JSONL session journals'],
    postgresArtifacts: ['session_messages_projection', 'session_projection_drift'],
    codeReferences: [
      'src/persistence/sessions/postgres-adapters.ts',
      'src/persistence/sessions/transcript-projection-port.ts',
      'src/app/maintenance/transcript-projection-repair.ts',
    ],
    integrityContract: [
      'The projection is rebuilt from L0 and never becomes alternate conversation truth.',
      'Drift is explicit and repair clears it only after a successful replacement.',
      'A failed redaction-carrying write records durable redaction drift and keyword search fails closed for that channel until repair clears it.',
    ],
    validation: {
      countParity: ['Compare projected rows per channel to active journal entries.'],
      checksumParity: ['Checksum projected rows by channel id and message id with all visible fields.'],
      semanticParity: ['Keyword search and channel-scoped repair preserve result identity and ordering.'],
    },
    gaps: [],
  },
  {
    id: 'l01-episodic-store',
    category: 'l01',
    title: 'L0.1 episodic landmarks, spans, arcs, claims, and lineage',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres episodic tables'],
    postgresArtifacts: [
      'l01_episodes',
      'l01_episode_spans',
      'l01_episode_arcs',
      'l01_episode_message_claims',
      'l01_episode_lineage',
    ],
    codeReferences: [
      'src/faculties/memory/episodic/postgres-store.ts',
      'src/faculties/memory/episodic/store-port.ts',
      'src/persistence/runtime-factory.ts',
    ],
    integrityContract: [
      'Preserve episode and arc provenance, lifecycle state, claims, and lineage.',
      'Runtime composition always provides the Postgres episodic store.',
    ],
    validation: {
      countParity: ['Compare episode, span, arc, claim, and lineage counts to accepted writes.'],
      checksumParity: ['Checksum canonical episode and arc payloads with their first-class indexed columns.'],
      semanticParity: ['Exercise time, thread, overlap, lifecycle, claim-transfer, and lineage queries.'],
    },
    gaps: [],
  },
  {
    id: 'l01-processing-watermarks',
    category: 'l01',
    title: 'L0.1 processing watermarks and reconciliation decisions',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres episodic processing state'],
    postgresArtifacts: ['l01_processing_watermarks', 'l01_episode_candidates', 'l01_episode_review_decisions'],
    codeReferences: [
      'src/faculties/memory/episodic/postgres-store.ts',
      'src/faculties/memory/episodic/synthesis.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Persist processed ranges before advancing synthesis state.',
      'Retried synthesis is idempotent and cannot skip an unclaimed range.',
    ],
    validation: {
      countParity: ['Count processing scopes and durable watermark rows after each synthesis run.'],
      checksumParity: ['Checksum watermark scope, ranges, status, reconciliation state, and artifact ids.'],
      semanticParity: ['Re-running a processed range produces no duplicate canonical episode or claim.'],
    },
    gaps: [],
  },
  {
    id: 'l2-memory-records',
    category: 'l2',
    title: 'L2 typed memory records and companion memory state',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres L2 memory tables'],
    postgresArtifacts: [
      'l2_memories',
      'l2_memory_delete_versions',
      'l2_memory_abstraction_links',
      'l2_memory_maintenance_reviews',
      'memory_links',
      'contact_profiles',
    ],
    codeReferences: [
      'src/faculties/memory/postgres-store.ts',
      'src/faculties/memory/memory-store-port.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Preserve active, superseded, soft-deleted, restored, linked, abstracted, and review state.',
      'JSON and provenance fields round-trip without silent coercion.',
    ],
    validation: {
      countParity: ['Compare memory lifecycle buckets and related-table rows to accepted writes.'],
      checksumParity: ['Checksum ordered memory rows and canonical JSON fields.'],
      semanticParity: ['Exercise reads, scoped lists, links, soft delete, restoration, and review workflows.'],
    },
    gaps: [],
  },
  {
    id: 'l2-memory-embeddings',
    category: 'l2',
    title: 'L2 pgvector embeddings and retrieval',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['l2_memories.embedding'],
    postgresArtifacts: ['vector embedding column and cosine-distance index/query path'],
    codeReferences: [
      'src/faculties/memory/postgres-store.ts',
      'src/faculties/memory/retrieval.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Embedding dimensions match the configured provider and schema.',
      'Missing pgvector support or dimension mismatch fails startup.',
    ],
    validation: {
      countParity: ['Compare non-null embedding rows to embedded memory writes.'],
      checksumParity: ['Checksum memory id, dimensions, and canonical vector values.'],
      semanticParity: ['Known vectors return expected memory ids in the expected top-k band.'],
    },
    gaps: [],
  },
  {
    id: 'l2-memory-patch-provenance',
    category: 'l2',
    title: 'L2 patch provenance and processing state',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres provenance-bearing memory rows and ledgers'],
    postgresArtifacts: ['l2_memory_patch_events', 'memory_processing_watermarks'],
    codeReferences: [
      'src/faculties/memory/postgres-store.ts',
      'src/faculties/memory/postgres-store/rows.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Every durable mutation records source type, source reference, and normalized provenance.',
      'Patch events and their memory mutation commit atomically.',
    ],
    validation: {
      countParity: ['Count patch events and watermarks by memory and processor.'],
      checksumParity: ['Checksum provenance, previous values, next values, and patch payloads.'],
      semanticParity: ['A failed patch-ledger write rolls back its memory mutation.'],
    },
    gaps: [],
  },
  {
    id: 'l2-memory-evolution-links',
    category: 'l2',
    title: 'Typed memory evolution graph',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres memory evolution rows'],
    postgresArtifacts: ['memory_evolution_links'],
    codeReferences: [
      'src/faculties/memory/postgres-store/evolution.ts',
      'src/faculties/memory/memory-store-port.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Evolution is represented by typed links rather than in-place history loss.',
      'Endpoints and provenance remain queryable in both directions.',
    ],
    validation: {
      countParity: ['Count links by relation and verify both endpoints exist.'],
      checksumParity: ['Checksum link ids, endpoints, relation, confidence, and provenance.'],
      semanticParity: ['Source and target traversal return the same typed graph edges.'],
    },
    gaps: [],
  },
  {
    id: 'scratchpad-store',
    category: 'scratchpad',
    title: 'Scratchpad rows and companion-facing mirror',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['scratchpad_entries'],
    postgresArtifacts: ['scratchpad_entries', 'derived notes/scratchpad.json mirror'],
    codeReferences: [
      'src/faculties/memory/postgres-store.ts',
      'src/faculties/memory/memory-store-port.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Postgres rows are runtime authority and the JSON mirror is derived.',
      'Ordering and pruning remain deterministic.',
    ],
    validation: {
      countParity: ['Compare stored rows and configured pruning cap after mutations.'],
      checksumParity: ['Checksum row ids, content, timestamps, and derived mirror order.'],
      semanticParity: ['Exercise add, replace, append, remove, get, list, and pruning.'],
    },
    gaps: [],
  },
  {
    id: 'contact-store',
    category: 'contacts',
    title: 'Contacts, identities, audit, activity, and social graph',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres contact and social graph tables'],
    postgresArtifacts: [
      'contacts',
      'contact_channel_ids',
      'contact_channel_activity',
      'contact_mutation_audit',
      'social_graph_entities',
      'social_relationship_edges',
    ],
    codeReferences: [
      'src/core/contacts/postgres-adapter.ts',
      'src/core/contacts/postgres-adapter/store.ts',
      'src/core/contacts/contact-store-port.ts',
    ],
    integrityContract: [
      'Trust mutation remains actor-gated and primary identity cannot be demoted by ordinary upsert.',
      'Identity, activity privacy, audit, and graph edges remain durable.',
    ],
    validation: {
      countParity: ['Compare contacts and related rows by trust, identity, and lifecycle state.'],
      checksumParity: ['Checksum contacts, identities, activity, audit, entities, and edges by key.'],
      semanticParity: ['Exercise identity lookup, trust policy, privacy, audit, activity, and graph queries.'],
    },
    gaps: [],
  },
  {
    id: 'intention-store',
    category: 'intentions',
    title: 'Concerns, follow-ups, quarantine, and behavioral patterns',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres intention tables'],
    postgresArtifacts: [
      'active_concerns',
      'intention_pending_follow_ups',
      'intention_pending_follow_up_quarantine',
      'behavioral_pattern_events',
    ],
    codeReferences: [
      'src/core/intention/postgres-adapters.ts',
      'src/core/intention/concern-store-port.ts',
      'src/core/intention/pending-follow-up-store-port.ts',
    ],
    integrityContract: [
      'Concern and follow-up lifecycle, origin lineage, quarantine, and pattern state survive restart.',
      'Runtime composition injects only Postgres intention ports.',
    ],
    validation: {
      countParity: ['Compare lifecycle buckets and origin-root lineage to accepted writes.'],
      checksumParity: ['Checksum concerns, follow-ups, quarantine, and pattern rows by id.'],
      semanticParity: ['Exercise concern matching, follow-up dequeue/dampening, quarantine, and pattern promotion.'],
    },
    gaps: [],
  },
  {
    id: 'intention-care-reminders',
    category: 'intentions',
    title: 'Durable care reminders',
    status: 'missing',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['No active durable store'],
    postgresArtifacts: ['Missing: care-reminder table and Postgres adapter'],
    codeReferences: [
      'src/core/intention/care-reminders.ts',
      'src/core/intention/appraisal/input-normalization.ts',
      'src/core/intention/postgres-adapters.ts',
    ],
    integrityContract: [
      'Reminder schedule, status, provenance, contact linkage, and completion state must survive restart.',
    ],
    validation: {
      countParity: ['Compare reminder lifecycle buckets once a durable adapter exists.'],
      checksumParity: ['Checksum every reminder domain field by id once persistence exists.'],
      semanticParity: ['Exercise active listing, trigger, activation, and completion across restart.'],
    },
    gaps: ['No Postgres care-reminder schema or adapter is wired into the runtime.'],
  },
  {
    id: 'reflection-mirror',
    category: 'reflections',
    title: 'Reflection metacognition journal and Postgres mirror',
    status: 'covered',
    ownership: 'postgres_projection',
    sourceOfTruthArtifacts: ['Append-only reflection metacognition JSONL journal'],
    postgresArtifacts: ['reflections query mirror'],
    codeReferences: [
      'src/persistence/reflections/postgres-mirror.ts',
      'src/persistence/journals/reflection-metacognition-journal.ts',
      'src/persistence/runtime-factory.ts',
    ],
    integrityContract: [
      'Journal JSONL remains companion truth and the Postgres table is a queryable mirror.',
      'Mirror failures are surfaced without rewriting journal history.',
    ],
    validation: {
      countParity: ['Compare mirror rows to reflection journal entries.'],
      checksumParity: ['Checksum mirror rows and canonical payload fields by id.'],
      semanticParity: ['Mirror upsert preserves every queryable reflection field.'],
    },
    gaps: [],
  },
  {
    id: 'gateway-audit',
    category: 'gateway',
    title: 'Gateway RPC audit log',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['gateway_audit'],
    postgresArtifacts: ['gateway_audit'],
    codeReferences: [
      'src/boundary/gateway/postgres-audit.ts',
      'src/boundary/gateway/privileged-core.ts',
      'src/persistence/postgres/migrations.ts',
    ],
    integrityContract: [
      'Preserve decision, summarized parameters, duration, error, ordering, and rotation state.',
      'Gateway startup constructs only the Postgres audit store.',
    ],
    validation: {
      countParity: ['Compare audit rows and rotation buckets by decision and method.'],
      checksumParity: ['Checksum ordered audit rows with all persisted fields.'],
      semanticParity: ['Exercise recent, method, approval-event, count, and rotation queries.'],
    },
    gaps: [],
  },
  {
    id: 'backup-service',
    category: 'operations',
    title: 'Encrypted Postgres backup and restore verification',
    status: 'partial',
    ownership: 'postgres_operations',
    sourceOfTruthArtifacts: ['Postgres database', 'companion tree', 'workspace tree', 'system config tree'],
    postgresArtifacts: ['pg_dump custom archive', 'scratch-database pg_restore verification'],
    codeReferences: [
      'src/persistence/backups/service.ts',
      'src/persistence/backups/postgres-restore.ts',
      'src/persistence/backups/fleet-restore.ts',
    ],
    integrityContract: [
      'Backups are encrypted and include database plus governed filesystem roots.',
      'Restore verification uses an isolated scratch database and never mutates the source.',
    ],
    validation: {
      countParity: ['Compare captured table inventory and representative source rows to the scratch restore.'],
      checksumParity: ['Verify backup manifests and filesystem tree hashes against restored content.'],
      semanticParity: ['Verify schema, pgvector operator, critical tables, and representative row presence.'],
    },
    gaps: ['Scratch restore verification does not yet replay representative domain retrieval queries.'],
  },
  {
    id: 'startup-integrity-diagnostics',
    category: 'operations',
    title: 'Postgres startup integrity and embedding diagnostics',
    status: 'covered',
    ownership: 'postgres_operations',
    sourceOfTruthArtifacts: ['Postgres schema, pgvector extension, and configured embedding dimensions'],
    postgresArtifacts: ['Runtime schema checks and bounded diagnostic events'],
    codeReferences: [
      'src/persistence/postgres.ts',
      'src/faculties/memory/postgres-store/schema.ts',
      'src/shared/diagnostics/runtime-diagnostics.ts',
    ],
    integrityContract: [
      'Startup fails closed on unavailable database, missing extension, schema mismatch, or wrong dimensions.',
      'Diagnostics are bounded, redacted, and operator-visible.',
    ],
    validation: {
      countParity: ['Require each startup schema check to emit an explicit pass or failure.'],
      checksumParity: ['Checksum the required migration statement inventory in schema tests.'],
      semanticParity: ['Invalid database and embedding configurations fail before the agent starts.'],
    },
    gaps: [],
  },
  {
    id: 'runtime-entrypoints',
    category: 'tooling',
    title: 'Runtime, CLI, and e2e persistence entrypoints',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Postgres runtime factory and canonical filesystem roots'],
    postgresArtifacts: ['Postgres memory, episodic, contact, intention, reflection, and operational stores'],
    codeReferences: [
      'src/persistence/runtime-factory.ts',
      'src/app/startup/composition/composition.ts',
      'src/app/e2e/e2e-test.ts',
    ],
    integrityContract: [
      'All ordinary entrypoints construct persistence through the Postgres runtime factory.',
      'Unsupported backend selection is rejected before store construction.',
    ],
    validation: {
      countParity: ['Require zero imports of retired persistence implementations from active entrypoints.'],
      checksumParity: [noRowChecksum('entrypoint composition')],
      semanticParity: ['Runtime factory tests prove fail-closed selection and Postgres store wiring.'],
    },
    gaps: [],
  },
  {
    id: 'maintenance-scripts',
    category: 'tooling',
    title: 'Postgres maintenance and repair scripts',
    status: 'covered',
    ownership: 'postgres_operations',
    sourceOfTruthArtifacts: ['Canonical JSONL where applicable and Postgres-owned runtime state'],
    postgresArtifacts: ['Postgres projection repair, re-embedding, and episodic synthesis paths'],
    codeReferences: [
      'src/app/maintenance/transcript-projection-repair.ts',
      'src/app/maintenance/migrate-embeddings.ts',
      'src/app/maintenance/force-episodic-synthesis.ts',
    ],
    integrityContract: [
      'Repair commands target active Postgres stores or canonical filesystem truth.',
      'Maintenance commands fail before mutation when required Postgres wiring is absent.',
    ],
    validation: {
      countParity: ['Require zero active maintenance imports of retired persistence implementations.'],
      checksumParity: ['Validate repaired projection or embedding ids and dimensions after mutation.'],
      semanticParity: ['Exercise projection repair, re-embedding, and isolated episodic synthesis through active stores.'],
    },
    gaps: [],
  },
  {
    id: 'config-defaults',
    category: 'configuration',
    title: 'Postgres-only runtime configuration',
    status: 'covered',
    ownership: 'postgres_runtime',
    sourceOfTruthArtifacts: ['Runtime wiring plus canonical owner files'],
    postgresArtifacts: ['POSTGRES_DATABASE_URL and optional companion schema selection'],
    codeReferences: [
      'src/system/config/load-config.ts',
      'src/system/config/runtime-config-contracts.ts',
      'src/persistence/runtime-factory.ts',
    ],
    integrityContract: [
      'Postgres is the only accepted runtime persistence backend.',
      'Missing connection wiring fails closed and mutable settings remain owner-file controlled.',
    ],
    validation: {
      countParity: ['Require one supported runtime backend in config parsing and factory selection.'],
      checksumParity: [noRowChecksum('runtime configuration')],
      semanticParity: ['Unsupported backend and missing database URL tests fail before runtime composition.'],
    },
    gaps: [],
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
