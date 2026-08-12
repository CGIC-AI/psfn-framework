import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { withPostgresClient } from '../../persistence/postgres.js';
import {
  createFilesystemExactSessionPurgeSurfaces,
  PostgresExactSessionProjectionPurgeSurface,
  RedisExactSessionTailPurgeSurface,
  type ExactSessionRedisTailPurgePort,
} from '../../persistence/sessions/exact-session-purge-surfaces.js';
import type { PostgresExactSessionPurgeSagaStore } from '../../persistence/postgres/automata-exact-session-purge-store.js';
import type { PostgresAutomataBusRuntimeStore } from './bus/runtime-store.js';
import type { AutomataRunRegistry } from './run-registry.js';
import type { AutomataSessionPurgeSurface } from './retention-contract.js';
import { AutomataRetentionCoordinator } from './retention-coordinator.js';
import type { PostgresAutomataRetentionStore } from './retention-postgres-store.js';
import {
  ProductionExactSessionPurge,
  type ExactSessionPurgeExclusiveFencePort,
  type ExactSessionSurfacePurgePort,
} from './production-exact-session-purge.js';
import {
  ProductionAutomataPermanentReferenceCustody,
  ProductionAutomataRetentionProofSource,
  ProductionExactSessionPurgeTargetAuthority,
} from './production-retention-authority.js';

function advisoryLockKey(companionId: string, sessionId: string): bigint {
  const digest = createHash('sha256')
    .update('automata-exact-session-purge-v1\0')
    .update(companionId)
    .update('\0')
    .update(sessionId)
    .digest();
  return digest.readBigInt64BE(0);
}

export class PostgresExactSessionPurgeExclusiveFence implements ExactSessionPurgeExclusiveFencePort {
  constructor(private readonly pool: Pool) {}

  async runExclusive<T>(
    input: { companionId: string; sessionId: string },
    operation: () => Promise<T>,
  ): Promise<T> {
    return await withPostgresClient(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [
        advisoryLockKey(input.companionId, input.sessionId).toString(),
      ]);
      return await operation();
    });
  }
}

function absentRedisSurface(): ExactSessionSurfacePurgePort {
  return {
    remove: async () => ({ status: 'already_absent', removedCount: 0 }),
    isAbsent: async () => true,
  };
}

export interface ProductionAutomataRetentionRuntime {
  coordinator: AutomataRetentionCoordinator;
  runBounded(nowMs?: number): ReturnType<AutomataRetentionCoordinator['run']>;
}

export function createProductionAutomataRetentionRuntime(options: {
  companionId: string;
  sessionsDir: string;
  batchLimit: number;
  registry: AutomataRunRegistry;
  bus: PostgresAutomataBusRuntimeStore;
  retentionStore: PostgresAutomataRetentionStore;
  sagaStore: PostgresExactSessionPurgeSagaStore;
  projection: {
    pool: Pool;
    flushPendingWrites(): Promise<void>;
    evictChannel(channelId: string): void;
  };
  redisTail: ExactSessionRedisTailPurgePort | null;
}): ProductionAutomataRetentionRuntime {
  if (!Number.isSafeInteger(options.batchLimit) || options.batchLimit < 1) {
    throw new Error('Automata retention batchLimit must be a positive safe integer');
  }
  const proofs = new ProductionAutomataRetentionProofSource({
    companionId: options.companionId,
    registry: options.registry,
    bus: options.bus,
  });
  const custody = new ProductionAutomataPermanentReferenceCustody({
    companionId: options.companionId,
    registry: options.registry,
    bus: options.bus,
  });
  const authority = new ProductionExactSessionPurgeTargetAuthority({
    companionId: options.companionId,
    sessionsDir: options.sessionsDir,
    classifications: options.retentionStore,
    proofs,
  });
  const filesystem = createFilesystemExactSessionPurgeSurfaces(options.sessionsDir);
  const surfaces: Record<AutomataSessionPurgeSurface, ExactSessionSurfacePurgePort> = {
    redis_tail_pointers: options.redisTail
      ? new RedisExactSessionTailPurgeSurface(options.redisTail)
      : absentRedisSurface(),
    transcript_projection: new PostgresExactSessionProjectionPurgeSurface(
      options.projection.pool,
      options.projection,
    ),
    turn_records: filesystem.turn_records,
    journal_rolls: filesystem.journal_rolls,
    journals: filesystem.journals,
    channel_index: filesystem.channel_index,
  };
  const purge = new ProductionExactSessionPurge({
    authority,
    custody,
    fence: new PostgresExactSessionPurgeExclusiveFence(options.projection.pool),
    sagaStore: options.sagaStore,
    surfaces,
  });
  const coordinator = new AutomataRetentionCoordinator({
    store: options.retentionStore,
    proofs,
    custody,
    purge,
  });
  return {
    coordinator,
    runBounded: (nowMs = Date.now()) => coordinator.run({
      companionId: options.companionId,
      nowMs,
      limit: options.batchLimit,
    }),
  };
}
