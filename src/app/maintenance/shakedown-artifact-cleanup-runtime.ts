import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, openSync, readFileSync, readdirSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { resolveSessionEntryTestingHarnessProvenance } from '../../core/session/testing-harness-provenance.js';
import {
  ProductionExactSessionPurge,
  parseExactSessionPurgeSagaRecord,
  type ExactSessionPurgeResolvedTarget,
  type ExactSessionPurgeSagaRecord,
  type ExactSessionPurgeSagaStorePort,
  type ExactSessionPurgeTargetAuthorityPort,
  type ExactSessionSurfaceDeleteResult,
  type ExactSessionSurfacePurgePort,
} from '../../faculties/automata/production-exact-session-purge.js';
import { PostgresExactSessionPurgeExclusiveFence } from '../../faculties/automata/production-retention-runtime.js';
import type {
  AutomataSessionPurgeSurface,
  ExactSessionPurgeInput,
  PermanentReferenceCustodyPort,
} from '../../faculties/automata/retention-contract.js';
import type { BackupRuntimeConfig } from '../../persistence/backups/config.js';
import { runBackupCycle } from '../../persistence/backups/service.js';
import { parseJournalText } from '../../persistence/journals/journal-utils.js';
import { createPostgresPool, withPostgresClient } from '../../persistence/postgres.js';
import { derivePostgresTenantRole } from '../../persistence/postgres/tenancy.js';
import {
  createFilesystemExactSessionPurgeSurfaces,
  RedisExactSessionTailPurgeSurface,
} from '../../persistence/sessions/exact-session-purge-surfaces.js';
import { listNumberedJsonlSegments } from '../../persistence/jsonl-segments.js';
import { FilesystemAutomataRetentionWriteBarrier } from '../../persistence/sessions/automata-retention-write-barrier.js';
import {
  CHANNEL_INDEX_FILENAME,
  type ChannelIndexEntry,
} from '../../persistence/sessions/store-primitives.js';
import { loadChannelIndex } from '../../persistence/sessions/store/channel-index.js';
import { isSessionJournalFilename } from '../../persistence/sessions/store/channel-filenames.js';
import { indexedChannelId } from '../../persistence/sessions/store/session-index-keys.js';
import { sanitizeChannelId } from '../../persistence/sessions/store-file-contracts.js';
import { normalizeTurnRecord } from '../../persistence/sessions/turn-records.js';
import { purgeTestingSessionPostgresData } from '../../persistence/sessions/testing-session-postgres-purge.js';
import { TESTING_HARNESS_SESSION_CHANNEL_ID } from '../../shared/contracts/testing-harness.js';
import {
  ensureDirectoryDurableSync,
  fsyncDirectorySync,
  writeFileDurableAtomicSync,
} from '../../shared/utils/fs.js';
import {
  ShakedownArtifactCleanupService,
  shakedownCleanupRevision,
  type ShakedownArtifactTarget,
  type ShakedownCleanupAuditRecord,
  type ShakedownCleanupBackupReceipt,
  type ShakedownCleanupInventory,
  type ShakedownCleanupTarget,
} from '../../system/lifecycle/shakedown-artifact-cleanup.js';
import { createConfiguredTailPurgePort } from './purge-testing-session.js';
import { createTestingSessionPurgePostgresAdapters } from './testing-session-purge-postgres.js';

const AUDIT_FILE_NAME = 'shakedown-cleanup-audit.jsonl';
const SAGA_DIR_NAME = 'shakedown-cleanup-sagas';

interface PostgresArtifactInventory {
  count: number;
  memoryIds: string[];
  revisionParts: string[];
  taskIds: string[];
}

interface JournalInspection {
  entryCount: number;
  eventIds: string[];
  revisionParts: string[];
  sessionEntryIds: ReadonlySet<number>;
}

interface TurnRecordInspection {
  recordCount: number;
  revisionParts: string[];
  taskIds: string[];
}

interface DurableCleanupBackupReceipt extends ShakedownCleanupBackupReceipt {
  artifactCounts: Readonly<Record<string, number>>;
  artifacts: readonly ShakedownArtifactTarget[];
}

export interface ShakedownArtifactCleanupRuntime {
  close(): Promise<void>;
  service: ShakedownArtifactCleanupService;
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactTurnRecordPaths(sessionsDir: string, channelId: string): string[] {
  const activePath = join(
    sessionsDir,
    '_turn_records',
    `${sanitizeChannelId(channelId)}.jsonl`,
  );
  const dataPaths = [
    activePath,
    ...listNumberedJsonlSegments(activePath).map(segment => segment.path),
  ];
  return [
    ...dataPaths,
    ...dataPaths.map(path => `${path}.quarantine`),
  ].filter(existsSync);
}

async function collectRows(
  client: PoolClient,
  sql: string,
  values: readonly unknown[],
): Promise<string[]> {
  const result = await client.query<{ row_json: unknown }>(sql, [...values]);
  return result.rows.map(row => JSON.stringify(row.row_json)).sort();
}

async function inspectPostgresArtifacts(
  pool: Pool,
  input: { channelId: string; sessionId: string },
): Promise<PostgresArtifactInventory> {
  return await withPostgresClient(pool, async client => {
    const rows = [
      ...await collectRows(client, `
        SELECT to_jsonb(projected) AS row_json
        FROM session_messages_projection AS projected
        WHERE channel_id = $1
        ORDER BY message_id
      `, [input.channelId]),
      ...await collectRows(client, `
        SELECT to_jsonb(drift) AS row_json
        FROM session_projection_drift AS drift
        WHERE channel_id = $1
        ORDER BY channel_id
      `, [input.channelId]),
    ];
    const availability = await client.query<{
      background_jobs: string | null;
      memories: string | null;
      recent_contact_shapes: string | null;
    }>(`
      SELECT
        to_regclass('agent_background_work_jobs')::text AS background_jobs,
        to_regclass('l2_memories')::text AS memories,
        to_regclass('recent_contact_shapes')::text AS recent_contact_shapes
    `);
    const tables = availability.rows[0];
    if (Boolean(tables?.memories) !== Boolean(tables?.recent_contact_shapes)) {
      throw new Error('Shakedown cleanup found an incomplete durable-memory schema');
    }
    let memoryIds: string[] = [];
    if (tables?.memories && tables.recent_contact_shapes) {
      const memoryIdsResult = await client.query<{ id: string }>(`
        SELECT id FROM l2_memories
        WHERE provenance_json->>'sessionId' = $1
        ORDER BY id
      `, [input.sessionId]);
      memoryIds = memoryIdsResult.rows.map(row => row.id);
      rows.push(...await collectRows(client, `
        SELECT to_jsonb(memory) AS row_json FROM l2_memories AS memory
        WHERE provenance_json->>'sessionId' = $1 ORDER BY id
      `, [input.sessionId]));
      if (memoryIds.length > 0) {
        rows.push(
          ...await collectRows(client, `
            SELECT to_jsonb(shape) AS row_json FROM recent_contact_shapes AS shape
            WHERE EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(shape.source_memory_ids) AS source_memory_id
              WHERE source_memory_id = ANY($1::text[])
            ) ORDER BY contact_id
          `, [memoryIds]),
          ...await collectRows(client, `
            SELECT to_jsonb(link) AS row_json FROM memory_links AS link
            WHERE id1 = ANY($1::text[]) OR id2 = ANY($1::text[])
            ORDER BY id1, id2
          `, [memoryIds]),
          ...await collectRows(client, `
            SELECT to_jsonb(review) AS row_json FROM l2_memory_maintenance_reviews AS review
            WHERE subject_memory_id = ANY($1::text[])
              OR candidate_memory_ids ?| $1::text[]
            ORDER BY id
          `, [memoryIds]),
        );
      }
    }
    let taskIds: string[] = [];
    if (tables?.background_jobs) {
      const jobs = await client.query<{ job_id: string; state: string }>(`
        SELECT job_id, state FROM agent_background_work_jobs
        WHERE logical_session_id = $1 ORDER BY job_id
      `, [input.sessionId]);
      if (jobs.rows.some(row => !['succeeded', 'failed', 'stale_discarded'].includes(row.state))) {
        throw new Error('Shakedown cleanup refuses non-terminal run-owned background work');
      }
      taskIds = jobs.rows.map(row => row.job_id);
      rows.push(
        ...await collectRows(client, `
          SELECT to_jsonb(job) AS row_json FROM agent_background_work_jobs AS job
          WHERE logical_session_id = $1 ORDER BY job_id
        `, [input.sessionId]),
        ...await collectRows(client, `
          SELECT to_jsonb(handoff) AS row_json FROM agent_background_work_handoffs AS handoff
          WHERE logical_session_id = $1 ORDER BY source_turn_id
        `, [input.sessionId]),
        ...await collectRows(client, `
          SELECT to_jsonb(lease) AS row_json FROM agent_background_work_foreground_leases AS lease
          WHERE logical_session_id = $1 ORDER BY lease_id
        `, [input.sessionId]),
        ...await collectRows(client, `
          SELECT to_jsonb(ref) AS row_json FROM agent_turn_subsystem_output_refs AS ref
          WHERE logical_session_id = $1 ORDER BY source_turn_id, output_ref
        `, [input.sessionId]),
        ...await collectRows(client, `
          SELECT to_jsonb(status) AS row_json FROM agent_turn_subsystem_output_status AS status
          WHERE logical_session_id = $1 ORDER BY source_turn_id
        `, [input.sessionId]),
      );
    }
    return {
      count: rows.length,
      memoryIds,
      revisionParts: rows.map(row => `postgres:${sha256(row)}`),
      taskIds,
    };
  });
}

function inspectJournalProvenance(input: {
  entry: ChannelIndexEntry;
  manifestId: string;
  runId: string;
  sessionsDir: string;
  channelId: string;
}): JournalInspection {
  let entryCount = 0;
  const eventIds: string[] = [];
  const revisionParts: string[] = [];
  const sessionEntryIds = new Set<number>();
  for (const filename of input.entry.filenames) {
    const path = join(input.sessionsDir, filename);
    if (!existsSync(path)) {
      throw new Error(`Shakedown cleanup exact journal chain is incomplete: ${filename}`);
    }
    const bytes = readFileSync(path);
    const parsed = parseJournalText(bytes.toString('utf8'));
    if (parsed.quarantined.length > 0) {
      throw new Error(`Shakedown cleanup cannot prove provenance for ${filename}`);
    }
    for (const journalEntry of parsed.entries) {
      if (journalEntry.channelId !== input.channelId) {
        throw new Error('Shakedown cleanup journal channel does not match the exact target');
      }
      if (journalEntry.type === 'compaction') {
        throw new Error('Shakedown cleanup cannot prove run provenance for compacted session content');
      }
      if (journalEntry.type !== 'message') continue;
      const provenance = resolveSessionEntryTestingHarnessProvenance(journalEntry);
      if (provenance?.runId !== input.runId || provenance.manifestId !== input.manifestId) {
        throw new Error('Shakedown cleanup session contains non-target run provenance');
      }
      entryCount += 1;
      eventIds.push(String(journalEntry.id));
      sessionEntryIds.add(journalEntry.id);
    }
    revisionParts.push(`journal:${filename}:${sha256(bytes)}`);
  }
  if (entryCount === 0) {
    throw new Error('Shakedown cleanup session has no exact testing-harness messages');
  }
  return { entryCount, eventIds, revisionParts, sessionEntryIds };
}

function inspectTurnRecordProvenance(input: {
  paths: readonly string[];
  sessionEntryIds: ReadonlySet<number>;
  sessionId: string;
  channelId: string;
}): TurnRecordInspection {
  let recordCount = 0;
  const revisionParts: string[] = [];
  const taskIds = new Set<string>();
  for (const path of input.paths) {
    if (path.endsWith('.quarantine')) {
      throw new Error('Shakedown cleanup cannot prove provenance for quarantined turn records');
    }
    const bytes = readFileSync(path);
    for (const line of bytes.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let record: ReturnType<typeof normalizeTurnRecord>;
      try {
        record = normalizeTurnRecord(JSON.parse(line), input.channelId);
      } catch {
        throw new Error('Shakedown cleanup cannot prove turn-record provenance');
      }
      if (record.sessionId !== undefined && record.sessionId !== input.sessionId) {
        throw new Error('Shakedown cleanup turn record belongs to another logical session');
      }
      const entryIds = [
        record.userMessage.sessionEntryId,
        record.assistantMessage?.sessionEntryId,
      ].filter((id): id is number => id !== undefined);
      if (entryIds.length === 0 || entryIds.some(id => !input.sessionEntryIds.has(id))) {
        throw new Error('Shakedown cleanup turn record lacks exact run-owned session references');
      }
      for (const job of record.backgroundWorkHandoff?.jobs ?? []) taskIds.add(job.jobId);
      recordCount += 1;
    }
    revisionParts.push(`turn:${basename(path)}:${sha256(bytes)}`);
  }
  return { recordCount, revisionParts, taskIds: [...taskIds].sort() };
}

function matchingRunJournalFiles(
  sessionsDir: string,
  target: Pick<ShakedownCleanupTarget, 'runId' | 'manifestId'>,
): string[] {
  if (!existsSync(sessionsDir)) return [];
  const matches: string[] = [];
  for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !isSessionJournalFilename(entry.name)) continue;
    const parsed = parseJournalText(readFileSync(join(sessionsDir, entry.name), 'utf8'));
    if (parsed.quarantined.length > 0) {
      throw new Error(`Shakedown cleanup cannot prove orphan provenance for ${entry.name}`);
    }
    const messages = parsed.entries.filter(candidate => candidate.type === 'message');
    const matching = messages.filter(candidate => {
      const provenance = resolveSessionEntryTestingHarnessProvenance(candidate);
      return provenance?.runId === target.runId && provenance.manifestId === target.manifestId;
    });
    if (matching.length === 0) continue;
    if (matching.length !== messages.length) {
      throw new Error(`Shakedown cleanup found mixed run provenance in ${entry.name}`);
    }
    matches.push(entry.name);
  }
  return matches.sort();
}

function artifactTargets(input: {
  channelId: string;
  eventIds: readonly string[];
  memoryIds: readonly string[];
  sessionId: string;
  taskIds: readonly string[];
}): ShakedownArtifactTarget[] {
  return [
    { kind: 'session', id: input.sessionId },
    { kind: 'channel', id: input.channelId },
    ...input.eventIds.map(id => ({ kind: 'event' as const, id })),
    ...input.memoryIds.map(id => ({ kind: 'memory' as const, id })),
    ...input.taskIds.map(id => ({ kind: 'task' as const, id })),
  ];
}

function appendDurableAudit(path: string, record: ShakedownCleanupAuditRecord): void {
  ensureDirectoryDurableSync(dirname(path));
  const created = !existsSync(path);
  const descriptor = openSync(path, 'a', 0o600);
  try {
    const line = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let offset = 0;
    while (offset < line.length) offset += writeSync(descriptor, line, offset, line.length - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (created) fsyncDirectorySync(dirname(path));
}

class FileShakedownCleanupSagaStore implements ExactSessionPurgeSagaStorePort {
  constructor(private readonly path: string) {}

  async load(): Promise<ExactSessionPurgeSagaRecord | null> {
    if (!existsSync(this.path)) return null;
    return parseExactSessionPurgeSagaRecord(JSON.parse(readFileSync(this.path, 'utf8')));
  }

  async create(record: ExactSessionPurgeSagaRecord): Promise<void> {
    if (existsSync(this.path)) throw new Error('Shakedown cleanup saga already exists');
    writeFileDurableAtomicSync(this.path, `${JSON.stringify(record)}\n`, { exclusive: true });
  }

  async update(record: ExactSessionPurgeSagaRecord, previousRevision: number): Promise<void> {
    const current = await this.load();
    if (!current || current.revision !== previousRevision) {
      throw new Error('Shakedown cleanup saga changed concurrently');
    }
    writeFileDurableAtomicSync(this.path, `${JSON.stringify(record)}\n`);
  }
}

function sagaPath(companionDataDir: string, target: ShakedownCleanupTarget): string {
  const identity = sha256(JSON.stringify([
    target.companionId, target.sessionId, target.runId, target.manifestId,
  ]));
  return join(companionDataDir, 'state', 'maintenance', SAGA_DIR_NAME, `${identity}.json`);
}

function backupReceiptPath(companionDataDir: string, target: ShakedownCleanupTarget): string {
  return `${sagaPath(companionDataDir, target)}.backup`;
}

function loadBackupReceipt(path: string): DurableCleanupBackupReceipt | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DurableCleanupBackupReceipt>;
  if (
    typeof parsed.backupRef !== 'string'
    || typeof parsed.rollbackRef !== 'string'
    || typeof parsed.targetRevision !== 'string'
    || typeof parsed.backupDigest !== 'string'
    || !Array.isArray(parsed.artifacts)
    || !parsed.artifactCounts
    || typeof parsed.artifactCounts !== 'object'
    || !/^[a-f0-9]{64}$/u.test(parsed.backupDigest)
  ) {
    throw new Error('Shakedown cleanup durable backup receipt is invalid');
  }
  return parsed as DurableCleanupBackupReceipt;
}

class ShakedownPostgresPurgeSurface implements ExactSessionSurfacePurgePort {
  constructor(private readonly pool: Pool, private readonly projection: {
    flushPendingWrites(): Promise<void>;
    evictChannel(channelId: string): void;
  }) {}

  async remove(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<ExactSessionSurfaceDeleteResult> {
    await this.projection.flushPendingWrites();
    const removedBackground = await withPostgresClient(this.pool, async client => {
      const outputRefs = await client.query(`
        SELECT 1 FROM agent_turn_subsystem_output_refs WHERE logical_session_id = $1 LIMIT 1
      `, [input.sessionId]);
      const outputStatus = await client.query(`
        SELECT 1 FROM agent_turn_subsystem_output_status WHERE logical_session_id = $1 LIMIT 1
      `, [input.sessionId]);
      if (outputRefs.rowCount || outputStatus.rowCount) {
        throw new Error('Shakedown cleanup refuses append-only subsystem output evidence');
      }
      const leases = await client.query(`
        DELETE FROM agent_background_work_foreground_leases WHERE logical_session_id = $1
      `, [input.sessionId]);
      const handoffs = await client.query(`
        DELETE FROM agent_background_work_handoffs WHERE logical_session_id = $1
      `, [input.sessionId]);
      const jobs = await client.query(`
        DELETE FROM agent_background_work_jobs
        WHERE logical_session_id = $1
          AND state IN ('succeeded', 'failed', 'stale_discarded')
      `, [input.sessionId]);
      return (leases.rowCount ?? 0) + (handoffs.rowCount ?? 0) + (jobs.rowCount ?? 0);
    });
    const report = await purgeTestingSessionPostgresData(this.pool, {
      sessionId: input.sessionId,
      channelId: target.channelId,
    });
    this.projection.evictChannel(target.channelId);
    const removedCount = removedBackground
      + report.removedProjectionRows
      + report.removedMemoryRows
      + report.removedRecentContactShapeRows
      + report.removedMemoryLinkRows
      + report.removedMaintenanceReviewRows;
    return removedCount > 0
      ? { status: 'removed', removedCount }
      : { status: 'already_absent', removedCount: 0 };
  }

  async isAbsent(
    input: ExactSessionPurgeInput,
    target: ExactSessionPurgeResolvedTarget,
  ): Promise<boolean> {
    return (await inspectPostgresArtifacts(this.pool, {
      channelId: target.channelId,
      sessionId: input.sessionId,
    })).count === 0;
  }
}

function absentSurface(): ExactSessionSurfacePurgePort {
  return {
    remove: async () => ({ status: 'already_absent', removedCount: 0 }),
    isAbsent: async () => true,
  };
}

function exactIndexTarget(
  sessionsDir: string,
  sessionId: string,
): { channelId: string; entry: ChannelIndexEntry } | null {
  const index = new Map<string, ChannelIndexEntry>();
  loadChannelIndex(join(sessionsDir, CHANNEL_INDEX_FILENAME), index, { persistMigration: false });
  const entry = index.get(sessionId);
  return entry ? { channelId: indexedChannelId(sessionId, entry), entry } : null;
}

export async function createShakedownArtifactCleanupRuntime(input: {
  backup?: BackupRuntimeConfig;
  companionDataDir: string;
  databaseUrl: string;
  mode: 'dry-run' | 'apply';
  multiCompanion: boolean;
  postgresSchema: string;
  sessionsDir: string;
  target: ShakedownCleanupTarget;
  env?: NodeJS.ProcessEnv;
}): Promise<ShakedownArtifactCleanupRuntime> {
  if (input.target.sessionId !== TESTING_HARNESS_SESSION_CHANNEL_ID) {
    throw new Error('Shakedown cleanup accepts only the canonical testing-harness session');
  }
  const postgresRole = input.multiCompanion
    ? derivePostgresTenantRole(input.postgresSchema)
    : undefined;
  const inspectionPool = createPostgresPool(input.databaseUrl, {
    applicationName: 'shakedown-cleanup-inspection',
    allowExitOnIdle: true,
    max: 1,
    readOnly: true,
    schema: input.postgresSchema,
    ...(postgresRole ? { role: postgresRole } : {}),
  });
  const tailCache = await createConfiguredTailPurgePort({
    companionId: input.target.companionId,
    env: input.env ?? process.env,
    sessionId: input.target.sessionId,
  });
  const sagaStore = new FileShakedownCleanupSagaStore(
    sagaPath(input.companionDataDir, input.target),
  );
  let latestTurnRecordPaths: string[] = [];

  const inspectExact = async (
    target: ShakedownCleanupTarget,
  ): Promise<ShakedownCleanupInventory> => {
    if (
      target.companionId !== input.target.companionId
      || target.sessionId !== input.target.sessionId
      || target.runId !== input.target.runId
      || target.manifestId !== input.target.manifestId
    ) {
      throw new Error('Shakedown cleanup runtime target scope mismatch');
    }
    const indexed = exactIndexTarget(input.sessionsDir, target.sessionId);
    const runJournalFiles = matchingRunJournalFiles(input.sessionsDir, target);
    const channelId = indexed?.channelId ?? target.sessionId;
    const turnRecordPaths = exactTurnRecordPaths(input.sessionsDir, channelId);
    const tailCachePresent = tailCache
      ? !(await tailCache.isChannelKeyFamilyAbsent(target.sessionId))
      : false;
    const postgres = await inspectPostgresArtifacts(inspectionPool, {
      channelId,
      sessionId: target.sessionId,
    });
    if (!indexed) {
      if (runJournalFiles.length > 0 || turnRecordPaths.length > 0 || postgres.count > 0 || tailCachePresent) {
        throw new Error('Shakedown cleanup found orphaned artifacts without session provenance authority');
      }
      latestTurnRecordPaths = [];
      const recoverySaga = await sagaStore.load();
      if (recoverySaga?.status === 'in_progress') {
        const receipt = loadBackupReceipt(backupReceiptPath(input.companionDataDir, target));
        if (!receipt || receipt.targetRevision !== recoverySaga.targetRevision) {
          throw new Error('Shakedown cleanup recovery saga is missing its exact backup receipt');
        }
        return {
          status: 'present',
          targetRevision: recoverySaga.targetRevision,
          artifactCounts: receipt.artifactCounts,
          artifacts: receipt.artifacts,
        };
      }
      return {
        status: 'absent',
        targetRevision: shakedownCleanupRevision(['absent', target.companionId, target.runId, target.manifestId]),
        artifactCounts: {},
        artifacts: [],
      };
    }
    if (channelId !== TESTING_HARNESS_SESSION_CHANNEL_ID) {
      throw new Error('Shakedown cleanup channel index does not bind the canonical test room');
    }
    const expectedJournalFiles = [...indexed.entry.filenames].sort();
    if (JSON.stringify(runJournalFiles) !== JSON.stringify(expectedJournalFiles)) {
      throw new Error('Shakedown cleanup exact-run journals do not match the channel index');
    }
    const journal = inspectJournalProvenance({
      entry: indexed.entry,
      manifestId: target.manifestId,
      runId: target.runId,
      sessionsDir: input.sessionsDir,
      channelId,
    });
    const turnRecords = inspectTurnRecordProvenance({
      paths: turnRecordPaths,
      sessionEntryIds: journal.sessionEntryIds,
      sessionId: target.sessionId,
      channelId,
    });
    const taskIds = [...new Set([...postgres.taskIds, ...turnRecords.taskIds])].sort();
    latestTurnRecordPaths = turnRecordPaths;
    const revisionParts = [
      `index:${sha256(JSON.stringify(indexed.entry))}`,
      ...journal.revisionParts,
      ...turnRecords.revisionParts,
      ...(tailCachePresent ? ['redis-tail:present'] : ['redis-tail:absent']),
      ...postgres.revisionParts,
    ];
    return {
      status: 'present',
      targetRevision: shakedownCleanupRevision(revisionParts.sort()),
      artifactCounts: {
        channel_index_entries: 1,
        journal_files: indexed.entry.filenames.length,
        session_messages: journal.entryCount,
        turn_record_files: turnRecordPaths.length,
        turn_records: turnRecords.recordCount,
        redis_tail_key_families: tailCachePresent ? 1 : 0,
        postgres_rows: postgres.count,
      },
      artifacts: artifactTargets({
        channelId,
        eventIds: journal.eventIds,
        memoryIds: postgres.memoryIds,
        sessionId: target.sessionId,
        taskIds,
      }),
    };
  };

  const service = new ShakedownArtifactCleanupService({
    inspectExact,
    captureBackup: async ({ target, inventory }) => {
      const receiptPath = backupReceiptPath(input.companionDataDir, target);
      const existingReceipt = loadBackupReceipt(receiptPath);
      if (existingReceipt) {
        if (existingReceipt.targetRevision !== inventory.targetRevision) {
          throw new Error('Shakedown cleanup backup receipt targets another revision');
        }
        return existingReceipt;
      }
      const backupConfig = input.backup;
      if (!backupConfig) throw new Error('Shakedown cleanup apply requires backup owner authority');
      const backup = await runBackupCycle({
        backupRootDir: backupConfig.rootDir,
        companionDataDir: input.companionDataDir,
        sessionsDir: input.sessionsDir,
        additionalSessionSnapshotFiles: [
          ...(existsSync(join(input.sessionsDir, CHANNEL_INDEX_FILENAME))
            ? [CHANNEL_INDEX_FILENAME]
            : []),
          ...latestTurnRecordPaths.map(path => relative(input.sessionsDir, path)),
        ],
        postgres: { databaseUrl: input.databaseUrl, schema: input.postgresSchema },
        encryption: backupConfig.encryption,
        maxRotatingBackups: backupConfig.maxRotatingBackups,
        maxDailyBackups: backupConfig.maxDailyBackups,
        maxWeeklyBackups: backupConfig.maxWeeklyBackups,
        maxMonthlyBackups: backupConfig.maxMonthlyBackups,
        mirrorDir: backupConfig.mirrorDir,
        verifyRestore: true,
        fleetArtifactIdentity: {
          schemaVersion: 1,
          kind: 'companion',
          companionId: target.companionId,
          postgresSchema: input.postgresSchema,
        },
      });
      const encrypted = backup.encryptedBackup;
      if (!encrypted || !/^[a-f0-9]{64}$/u.test(encrypted.encryptedSha256)) {
        throw new Error('Shakedown cleanup backup was not encrypted and verified');
      }
      const receipt: DurableCleanupBackupReceipt = {
        backupRef: backup.backupDir,
        backupDigest: encrypted.encryptedSha256,
        rollbackRef: backup.backupDir,
        targetRevision: inventory.targetRevision,
        artifactCounts: inventory.artifactCounts,
        artifacts: target.artifacts,
      };
      writeFileDurableAtomicSync(receiptPath, `${JSON.stringify(receipt)}\n`, { exclusive: true });
      return receipt;
    },
    removeExact: async ({ target, expectedRevision }) => {
      if (input.mode !== 'apply') throw new Error('Dry-run cleanup runtime cannot mutate');
      const adapters = await createTestingSessionPurgePostgresAdapters({
        databaseUrl: input.databaseUrl,
        multiCompanion: input.multiCompanion,
        postgresSchema: input.postgresSchema,
        sessionsDir: input.sessionsDir,
      });
      const pool = adapters.exactSessionProjection.pool;
      const barrier = new FilesystemAutomataRetentionWriteBarrier(input.sessionsDir, target.companionId);
      const authority: ExactSessionPurgeTargetAuthorityPort = {
        resolveAndAuthorize: async () => {
          const current = await inspectExact(target);
          if (current.status !== 'present' || current.targetRevision !== expectedRevision) {
            throw new Error('Shakedown cleanup target changed before deletion');
          }
          const indexed = exactIndexTarget(input.sessionsDir, target.sessionId);
          if (!indexed) throw new Error('Shakedown cleanup exact index target disappeared');
          const classification: Extract<
            ExactSessionPurgeResolvedTarget['classification'],
            { ownership: 'testing_harness' }
          > = {
            schemaVersion: 1,
            companionId: target.companionId,
            sessionId: target.sessionId,
            ownership: 'testing_harness',
            runId: target.runId,
            manifestId: target.manifestId,
            classifiedAtMs: 0,
          };
          return {
            classification,
            channelId: indexed.channelId,
            tailChannelKey: target.sessionId,
            turnRecordChannelId: indexed.channelId,
            activeJournalFilename: indexed.entry.filename,
            rolledJournalFilenames: indexed.entry.filenames.slice(0, -1),
          };
        },
        revalidate: async (request, resolved) => {
          if (
            request.companionId !== target.companionId
            || request.sessionId !== target.sessionId
            || request.runId !== target.runId
            || request.targetRevision !== expectedRevision
            || resolved.classification.ownership !== 'testing_harness'
            || resolved.classification.manifestId !== target.manifestId
          ) {
            throw new Error('Shakedown cleanup deletion authority changed');
          }
          const indexed = exactIndexTarget(input.sessionsDir, target.sessionId);
          if (indexed && (
            indexed.channelId !== resolved.channelId
            || indexed.entry.filename !== resolved.activeJournalFilename
            || JSON.stringify(indexed.entry.filenames) !== JSON.stringify([
              ...resolved.rolledJournalFilenames, resolved.activeJournalFilename,
            ])
          )) {
            throw new Error('Shakedown cleanup channel index changed after authorization');
          }
          const permitted = new Set([...resolved.rolledJournalFilenames, resolved.activeJournalFilename]);
          if (matchingRunJournalFiles(input.sessionsDir, target).some(filename => !permitted.has(filename))) {
            throw new Error('Shakedown cleanup found a new run-owned journal after authorization');
          }
          for (const filename of permitted) {
            if (!existsSync(join(input.sessionsDir, filename))) continue;
            inspectJournalProvenance({
              entry: { filename, filenames: [filename], channelId: resolved.channelId },
              manifestId: target.manifestId,
              runId: target.runId,
              sessionsDir: input.sessionsDir,
              channelId: resolved.channelId,
            });
          }
        },
      };
      const filesystem = createFilesystemExactSessionPurgeSurfaces(input.sessionsDir);
      const surfaces: Record<AutomataSessionPurgeSurface, ExactSessionSurfacePurgePort> = {
        redis_tail_pointers: tailCache ? new RedisExactSessionTailPurgeSurface(tailCache) : absentSurface(),
        transcript_projection: new ShakedownPostgresPurgeSurface(pool, adapters.exactSessionProjection),
        turn_records: filesystem.turn_records,
        journal_rolls: filesystem.journal_rolls,
        journals: filesystem.journals,
        channel_index: filesystem.channel_index,
      };
      const custody: PermanentReferenceCustodyPort = {
        assertResolvable: async references => {
          if (references.length > 0) {
            throw new Error('Shakedown cleanup does not accept unverified preserve references');
          }
        },
      };
      const purge = new ProductionExactSessionPurge({
        authority,
        custody,
        fence: new PostgresExactSessionPurgeExclusiveFence(pool),
        writeBarrier: { seal: async (request, resolved) => barrier.seal(request, resolved) },
        sagaStore,
        surfaces,
      });
      const request: ExactSessionPurgeInput = {
        companionId: target.companionId,
        sessionId: target.sessionId,
        runId: target.runId,
        targetRevision: expectedRevision,
        preserveReferences: [],
      };
      try {
        await purge.purgeExactSession(request);
      } finally {
        await pool.end();
      }
    },
    verifyAbsent: async target => {
      const inventory = await inspectExact(target);
      return {
        allRunArtifactsRemoved: inventory.status === 'absent',
        remainingArtifactCounts: inventory.artifactCounts,
      };
    },
    appendAudit: async record => {
      appendDurableAudit(
        join(input.companionDataDir, 'state', 'maintenance', AUDIT_FILE_NAME),
        record,
      );
    },
    finalize: async target => {
      const saga = await sagaStore.load();
      if (!saga) return;
      if (saga.status !== 'completed') {
        throw new Error('Shakedown cleanup cannot release an incomplete cleanup seal');
      }
      const barrier = new FilesystemAutomataRetentionWriteBarrier(
        input.sessionsDir,
        target.companionId,
      );
      barrier.unseal({
        companionId: saga.companionId,
        sessionId: saga.sessionId,
        runId: saga.runId,
        targetRevision: saga.targetRevision,
        preserveReferences: saga.preserveReferences,
      }, saga.target);
    },
  });

  return {
    service,
    close: async () => {
      await Promise.all([inspectionPool.end(), tailCache?.close()]);
    },
  };
}
