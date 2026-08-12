import type { Pool } from 'pg';

import type {
  AutomataRunRecord,
  EffectiveAutomataClassDescriptor,
} from '../registry-contract.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import type { AutomataBusEvent } from './contract.js';
import { AUTOMATA_BUS_POSTGRES_RELATIONS } from './postgres-schema.js';
import {
  PostgresAutomataBusStore,
  type AppendAllocatedAutomataBusEventInput,
  type AppendAutomataBusEventInput,
  type AppendAutomataBusEventResult,
  type AutomataBusCurrentFindingReadScope,
  type AutomataBusReadScope,
  type AutomataBusSqlPool,
  type PersistedAutomataBusCurrentFinding,
} from './postgres-store.js';
import type { AutomataBusCurrentState } from './current-state.js';
import { createAutomataTextValidator } from '../validation.js';

const IMMUTABLE_EVENT_TRIGGERS = [
  'automata_bus_events_append_only',
  'automata_bus_events_no_truncate',
] as const;

export const AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS = Object.freeze({
  relations: AUTOMATA_BUS_POSTGRES_RELATIONS,
  immutableEventTriggers: IMMUTABLE_EVENT_TRIGGERS,
});

export interface AutomataBusRunAuthority {
  getRun(runId: string): AutomataRunRecord | null;
  listClasses(): EffectiveAutomataClassDescriptor[];
}

export interface AutomataBusRuntimePool extends AutomataBusSqlPool {
  end(): Promise<void>;
}

interface AutomataBusRelationReadinessRow {
  relation_name: string;
  relation: string | null;
  can_select: boolean | null;
  can_insert: boolean | null;
  can_delete: boolean | null;
}

interface AutomataBusTriggerReadinessRow {
  trigger_name: string;
}

const requiredText = createAutomataTextValidator('Automata Bus');

export function assertAutomataBusEventAuthorized(
  event: AutomataBusEvent,
  companionIdInput: string,
  authority: AutomataBusRunAuthority,
): void {
  const companionId = requiredText(companionIdInput, 'runtime companionId');
  if (event.companionId !== companionId) {
    throw new Error('Automata Bus event companionId does not match the runtime companion scope');
  }
  const run = authority.getRun(event.context.runId);
  if (!run) {
    throw new Error(`Automata Bus event requires a registered Automata run "${event.context.runId}"`);
  }
  const descriptor = authority.listClasses().find(candidate => (
    candidate.id === run.automatonClass
  ));
  if (!descriptor || descriptor.busEligibility !== 'eligible') {
    throw new Error(`Automata run class "${run.automatonClass}" is not eligible for the Automata Bus`);
  }
  if (run.companionId !== companionId) {
    throw new Error('Automata Bus run companionId does not match the runtime companion scope');
  }
  if (event.context.automatonClass !== run.automatonClass) {
    throw new Error('Automata Bus event automatonClass does not match its registered run');
  }
  if (event.context.taskId !== run.taskId) {
    throw new Error('Automata Bus event taskId does not match its registered run');
  }
  if (event.context.parentRunId !== run.parentRunId) {
    throw new Error('Automata Bus event parentRunId does not match its registered run');
  }
}

export async function assertAutomataBusPostgresReady(
  pool: Pick<AutomataBusRuntimePool, 'query'>,
): Promise<void> {
  const relations = await pool.query<AutomataBusRelationReadinessRow>(`
    SELECT
      requested.relation_name,
      to_regclass(requested.relation_name)::text AS relation,
      has_table_privilege(current_user, to_regclass(requested.relation_name), 'SELECT') AS can_select,
      has_table_privilege(current_user, to_regclass(requested.relation_name), 'INSERT') AS can_insert,
      has_table_privilege(current_user, to_regclass(requested.relation_name), 'DELETE') AS can_delete
    FROM unnest($1::text[]) AS requested(relation_name)
    ORDER BY requested.relation_name
  `, [[...AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.relations]]);
  const byName = new Map(relations.rows.map(row => [row.relation_name, row]));
  for (const relationName of AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.relations) {
    const row = byName.get(relationName);
    const needsDelete = relationName === 'automata_bus_current_findings';
    if (
      !row?.relation
      || row.can_select !== true
      || row.can_insert !== true
      || (needsDelete && row.can_delete !== true)
    ) {
      throw new Error(`Automata Bus Postgres readiness is missing required access to ${relationName}`);
    }
  }

  const triggers = await pool.query<AutomataBusTriggerReadinessRow>(`
    SELECT trigger_object.tgname AS trigger_name
    FROM pg_trigger trigger_object
    WHERE trigger_object.tgrelid = 'automata_bus_events'::regclass
      AND trigger_object.tgisinternal = FALSE
      AND trigger_object.tgenabled <> 'D'
      AND trigger_object.tgname = ANY($1::text[])
    ORDER BY trigger_object.tgname
  `, [[...AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.immutableEventTriggers]]);
  const enabledTriggers = new Set(triggers.rows.map(row => row.trigger_name));
  for (const trigger of AUTOMATA_BUS_POSTGRES_READINESS_REQUIREMENTS.immutableEventTriggers) {
    if (!enabledTriggers.has(trigger)) {
      throw new Error(`Automata Bus Postgres readiness is missing immutable trigger ${trigger}`);
    }
  }
}

/**
 * Companion-locked production surface over the canonical store. The pool is
 * owned here so agent shutdown has one explicit close target.
 */
export class PostgresAutomataBusRuntimeStore {
  private readonly store: PostgresAutomataBusStore;
  private closed = false;

  constructor(
    private readonly pool: AutomataBusRuntimePool,
    private readonly companionId: string,
    authority: AutomataBusRunAuthority,
  ) {
    this.companionId = requiredText(companionId, 'runtime companionId');
    this.store = new PostgresAutomataBusStore(pool, {
      authorizeAppend: event => assertAutomataBusEventAuthorized(
        event,
        this.companionId,
        authority,
      ),
    });
  }

  async append(input: AppendAutomataBusEventInput): Promise<AppendAutomataBusEventResult> {
    this.assertCompanion(input.companionId);
    return await this.store.append(input);
  }

  async appendAllocated(
    input: AppendAllocatedAutomataBusEventInput,
  ): Promise<AppendAutomataBusEventResult> {
    this.assertCompanion(input.companionId);
    return await this.store.appendAllocated(input);
  }

  async readHistory(input: AutomataBusReadScope): Promise<AutomataBusEvent[]> {
    this.assertCompanion(input.companionId);
    return await this.store.readHistory(input);
  }

  async readCurrentFindingsByEventIds(
    input: AutomataBusCurrentFindingReadScope,
  ): Promise<PersistedAutomataBusCurrentFinding[]> {
    this.assertCompanion(input.companionId);
    return await this.store.readCurrentFindingsByEventIds(input);
  }

  async readCurrentState(input: AutomataBusReadScope): Promise<AutomataBusCurrentState> {
    this.assertCompanion(input.companionId);
    return await this.store.readCurrentState(input);
  }

  /**
   * Share the companion-locked pool with derived query/index adapters. The
   * canonical store remains the only content authority and retains pool
   * lifecycle ownership.
   */
  getQueryPool(): AutomataBusSqlPool {
    return this.pool;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private assertCompanion(companionId: string): void {
    if (companionId !== this.companionId) {
      throw new Error('Automata Bus runtime store companion scope mismatch');
    }
  }
}

export async function connectPostgresAutomataBusRuntimeStore(
  databaseUrl: string,
  companionId: string,
  authority: AutomataBusRunAuthority,
  options: { schema?: string; role?: string } = {},
): Promise<PostgresAutomataBusRuntimeStore> {
  const pool: Pool = createPostgresPool(databaseUrl, {
    applicationName: 'automata-bus',
    allowExitOnIdle: true,
    schema: options.schema,
    role: options.role,
  });
  try {
    await assertAutomataBusPostgresReady(pool);
    return new PostgresAutomataBusRuntimeStore(pool, companionId, authority);
  } catch (error) {
    try {
      await pool.end();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Automata Bus readiness failed and its Postgres pool could not close',
      );
    }
    throw error;
  }
}
