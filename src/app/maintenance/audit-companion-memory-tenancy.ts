import '../../shared/utils/load-dotenv.js';
import type { QueryResultRow } from 'pg';
import {
  createPostgresPool,
  queryRows,
} from '../../persistence/postgres.js';
import { resolveConfigTenantPoolScope } from '../../persistence/postgres/tenant-pool-scope.js';
import {
  auditCompanionMemoryProvenance,
  type CompanionMemoryAuditInput,
} from '../../faculties/memory/companion-provenance.js';
import type { MemoryProvenance } from '../../faculties/memory/types.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  bootstrapMaintenanceRuntime,
  isMaintenanceCliEntrypoint,
  parseCommonMaintenanceArgs,
  runMaintenanceCli,
} from './cli-harness.js';

interface CompanionMemoryAuditRow extends QueryResultRow {
  id: unknown;
  source_ref: unknown;
  provenance_json: unknown;
  deleted_at: unknown;
  superseded_by: unknown;
}

interface CliOptions {
  json: boolean;
  showHelp: boolean;
}

function printUsage(): void {
  console.log('Usage: npm run audit:companion-memory-tenancy [-- --json]');
  console.log('');
  console.log('Read-only audit of the exact configured companion schema for memory rows');
  console.log('whose companion-channel provenance does not include this runtime.');
  console.log('Memory bodies, raw channel ids, source refs, and session ids are never emitted.');
  console.log('This command never updates or deletes rows.');
}

function parseArgs(argv: readonly string[]): CliOptions {
  return parseCommonMaintenanceArgs<CliOptions>(argv, {
    initial: { json: false, showHelp: false },
    extraFlags: {
      '--json': ({ options }) => {
        options.json = true;
      },
    },
  });
}

function readOptionalText(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Companion memory tenancy audit encountered a non-text ${label}`);
  }
  return value;
}

function projectProvenance(value: unknown): MemoryProvenance | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(typeof value.channelId === 'string' ? { channelId: value.channelId } : {}),
    ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}),
  };
}

function projectRow(row: CompanionMemoryAuditRow): CompanionMemoryAuditInput {
  if (typeof row.id !== 'string' || !row.id.trim()) {
    throw new Error('Companion memory tenancy audit encountered a row without an exact memory id');
  }
  const sourceRef = readOptionalText(row.source_ref, 'source_ref');
  if (!sourceRef) {
    throw new Error('Companion memory tenancy audit encountered a row without an exact source_ref');
  }
  const provenance = projectProvenance(row.provenance_json);
  return {
    id: row.id,
    sourceRef,
    ...(provenance ? { provenance } : {}),
    state: row.deleted_at !== null && row.deleted_at !== undefined
      ? 'deleted'
      : row.superseded_by !== null && row.superseded_by !== undefined
        ? 'superseded'
        : 'active',
  };
}

async function run(options: CliOptions): Promise<void> {
  const { config } = await bootstrapMaintenanceRuntime();
  if (config.persistenceBackend !== 'postgres') {
    throw new Error('Companion memory tenancy audit requires PostgreSQL persistence');
  }
  const databaseUrl = config.postgresDatabaseUrl?.trim();
  if (!databaseUrl) {
    throw new Error('Companion memory tenancy audit requires config.postgresDatabaseUrl');
  }
  const tenantScope = resolveConfigTenantPoolScope(config);
  if (!tenantScope) {
    throw new Error('Companion memory tenancy audit requires exact multi-companion tenant authority');
  }
  const companionId = config.companionId?.trim();
  if (!companionId) {
    throw new Error('Companion memory tenancy audit requires config.companionId');
  }

  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-companion-memory-tenancy-audit',
    allowExitOnIdle: true,
    max: 1,
    readOnly: true,
    schema: tenantScope.schema,
    role: tenantScope.role,
  });
  try {
    const rows = await queryRows<CompanionMemoryAuditRow>(pool, `
      SELECT id, source_ref, provenance_json, deleted_at, superseded_by
      FROM l2_memories
      ORDER BY id ASC
    `);
    const report = auditCompanionMemoryProvenance(rows.map(projectRow), companionId);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Companion memory tenancy audit inspected ${report.inspectedCount} row(s).`);
      console.log(`Contaminated rows: ${report.contaminatedCount}.`);
      for (const finding of report.findings) {
        console.log(`- ${finding.memoryId}: ${finding.reason} (${finding.state}, ${finding.channelKind})`);
      }
      console.log('Report only — no rows were updated or deleted.');
    }
    process.exitCode = report.contaminatedCount > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

if (isMaintenanceCliEntrypoint(import.meta.url)) {
  void runMaintenanceCli({
    label: 'Companion memory tenancy audit',
    parseArgs,
    printUsage,
    run,
  });
}
