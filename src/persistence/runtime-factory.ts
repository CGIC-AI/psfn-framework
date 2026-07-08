import { MemoryJournal } from '../faculties/memory/journal.js';
import type { MemoryStorePort } from '../faculties/memory/memory-store-port.js';
import { createPostgresMemoryStore } from '../faculties/memory/postgres-store.js';
import {
  createPostgresEpisodicStore,
  type EpisodicStorePort,
} from '../faculties/memory/episodic/index.js';
import { createPostgresContactStore } from '../core/contacts/postgres-adapter.js';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import { createPostgresIntentionPorts } from '../core/intention/postgres-adapters.js';
import type {
  IntentionRuntimeProviders,
  IntentionRuntimeWiring,
} from '../core/intention/runtime-wiring.js';
import type { WeightedThoughtStorePort } from '../core/intention/weighted-thought-store-port.js';
import type {
  PersistenceBackend,
  SubstrateConfig,
} from '../system/config/runtime-config-contracts.js';
import {
  migrateLegacyPersistenceLayout,
  resolveContactsDir,
  resolveMemoryJournalPath,
  resolveNotesDir,
  resolveReflectionMetacognitionJournalPath,
  resolveScratchpadMirrorPath,
  type RuntimePathSnapshot,
} from './layout.js';
import {
  ReflectionMetacognitionJournalStore,
} from './journals/reflection-metacognition-journal.js';
import { PostgresReflectionMetacognitionMirrorStore } from './reflections/postgres-mirror.js';
import { PostgresInternalStateStore } from './postgres/internal-state-store.js';
import type { InternalStateStorePort } from '../core/self-model/internal-state-persistence.js';
import { PostgresParticipantTrendStore } from './postgres/participant-trend-store.js';
import type { ParticipantTrendStorePort } from '../core/emotion/participant-trend-persistence.js';
import { PostgresScheduledPromptStore } from './postgres/scheduled-prompt-store.js';
import type { ScheduledPromptStorePort } from '../core/scheduler/scheduled-prompt-store-port.js';
import { createPostgresPool, ensurePostgresSchemaExists } from './postgres.js';

export interface AgentPersistenceRuntime {
  backend: PersistenceBackend;
  memoryStore: MemoryStorePort;
  episodicStore: EpisodicStorePort;
  reflectionStore: ReflectionMetacognitionJournalStore;
  contactStore?: ContactStorePort;
  intentionRuntime?: IntentionRuntimeWiring;
  intentionProviders?: IntentionRuntimeProviders;
  weightedThoughtStore?: WeightedThoughtStorePort;
  internalStateStore: InternalStateStorePort;
  participantTrendStore: ParticipantTrendStorePort;
  scheduledPromptStore: ScheduledPromptStorePort;
}

export interface CreateAgentPersistenceRuntimeOptions {
  config: Pick<
    SubstrateConfig,
    'databasePath' | 'persistenceBackend' | 'postgresDatabaseUrl' | 'postgresSchema'
  >;
  pathSnapshot: RuntimePathSnapshot;
  embeddingDims: number;
  primaryUserId?: string;
}

export async function createAgentPersistenceRuntime(
  options: CreateAgentPersistenceRuntimeOptions,
): Promise<AgentPersistenceRuntime> {
  migrateLegacyPersistenceLayout(options.pathSnapshot.companionDataDir);

  if (options.config.persistenceBackend !== 'postgres') {
    throw new Error('Agent persistence runtime requires config.persistenceBackend=postgres');
  }
  const databaseUrl = options.config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('PostgreSQL persistence requires config.postgresDatabaseUrl');
  }

  // Multi-companion tenancy (sprint 10, W2). When a per-companion schema is
  // configured, every runtime persistence pool below pins its search_path to it
  // (via the shared `schema` option) so all queries run inside the schema
  // unchanged. The schema is created here once, up front, before any store
  // connects — otherwise a store's first DDL could land in `public` (the next
  // existing entry in the search_path) instead of the not-yet-created schema.
  // When unset, `schema` stays undefined and behavior is byte-identical to
  // single-companion (the default `public` schema).
  const schema = options.config.postgresSchema?.trim() || undefined;
  if (schema) {
    const bootstrapPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-schema-bootstrap',
      allowExitOnIdle: true,
      max: 1,
      schema,
    });
    try {
      await ensurePostgresSchemaExists(bootstrapPool, schema);
    } finally {
      await bootstrapPool.end();
    }
  }

  const intentionRuntime = await createPostgresIntentionPorts(databaseUrl, { schema });
  return {
    backend: 'postgres',
    memoryStore: await createPostgresMemoryStore(databaseUrl, options.embeddingDims, {
      notesDir: resolveNotesDir(options.pathSnapshot.companionDataDir),
      scratchpadMirrorPath: resolveScratchpadMirrorPath(options.pathSnapshot.companionDataDir),
      journal: new MemoryJournal(resolveMemoryJournalPath(options.pathSnapshot.companionDataDir)),
      schema,
    }),
    episodicStore: createPostgresEpisodicStore(databaseUrl, { schema }),
    reflectionStore: new ReflectionMetacognitionJournalStore(
      resolveReflectionMetacognitionJournalPath(options.pathSnapshot.companionDataDir),
      {
        mirror: await PostgresReflectionMetacognitionMirrorStore.connect(databaseUrl, { schema }),
      },
    ),
    contactStore: await createPostgresContactStore(databaseUrl, options.primaryUserId, {
      exportDir: resolveContactsDir(options.pathSnapshot.companionDataDir),
      schema,
    }),
    intentionRuntime,
    intentionProviders: intentionRuntime,
    weightedThoughtStore: intentionRuntime.weightedThoughtStore,
    internalStateStore: await PostgresInternalStateStore.connect(databaseUrl, { schema }),
    participantTrendStore: await PostgresParticipantTrendStore.connect(databaseUrl, { schema }),
    scheduledPromptStore: await PostgresScheduledPromptStore.connect(databaseUrl, { schema }),
  };
}
