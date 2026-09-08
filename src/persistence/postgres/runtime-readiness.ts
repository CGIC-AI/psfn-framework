import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';

export type PostgresStoreReadinessRequirement = 'required' | 'optional';
export type PostgresRuntimeDdlAuthority = 'isolated_workload_migration';

interface PostgresStoreReadinessCatalogEntry {
  label: string;
  requirement: PostgresStoreReadinessRequirement;
  /**
   * An `optional` store whose terminal failure must still be visible on the
   * operator health surface rather than folded into an anonymous degraded
   * count (psfn-framework-6c6cq). The store stays optional — nothing refuses
   * to boot — but a process that finished its retry budget without this store
   * no longer advertises an unqualified healthy operator surface.
   */
  degradesOperatorReadiness?: true;
  failureDiagnostic?: {
    component: string;
    message: string;
  };
}

/**
 * One code-owned classification for every PostgreSQL store opened by a
 * production workload. Startup composition must use these identifiers rather
 * than deciding criticality from whether a particular call happens to await.
 */
export const POSTGRES_STORE_READINESS_CATALOG = {
  tenant_boundary: { label: 'tenant boundary', requirement: 'required' },
  shared_runtime_authority: { label: 'shared runtime authority', requirement: 'required' },
  memory: { label: 'memory', requirement: 'required' },
  contacts: { label: 'contacts', requirement: 'required' },
  hub_identity_enrollment: { label: 'hub identity enrollment', requirement: 'required' },
  intention: { label: 'intention', requirement: 'required' },
  icp_initiation_candidates: { label: 'ICP initiation candidates', requirement: 'required' },
  icp_felt_impulse_funnel: { label: 'ICP felt-impulse funnel', requirement: 'required' },
  emosim_proactivity_state: { label: 'EmoSim proactivity state', requirement: 'required' },
  social_impulse_outreach: { label: 'social impulse outreach', requirement: 'required' },
  internal_state: { label: 'internal state', requirement: 'required' },
  participant_trend: { label: 'participant trend', requirement: 'required' },
  reflection: { label: 'reflection mirror', requirement: 'required' },
  scheduled_prompts: { label: 'scheduled prompts', requirement: 'required' },
  companion_availability: { label: 'companion availability', requirement: 'required' },
  letters: { label: 'letters', requirement: 'required' },
  doing_mirror: { label: 'doing mirror', requirement: 'required' },
  buzz_recovery: { label: 'Buzz recovery', requirement: 'required' },
  introspection: { label: 'introspection landmarks', requirement: 'required' },
  background_work: { label: 'background work', requirement: 'required' },
  automata_runs: { label: 'automata runs', requirement: 'required' },
  automata_bus: { label: 'Automata Bus', requirement: 'required' },
  automata_retention: { label: 'Automata retention', requirement: 'required' },
  partner_affect_shadow: { label: 'partner affect shadow', requirement: 'required' },
  session_transcripts: { label: 'session transcripts', requirement: 'required' },
  companion_presence: { label: 'companion presence', requirement: 'required' },
  social_pot: { label: 'social pot', requirement: 'required' },
  speaking_arbiter: { label: 'speaking arbiter', requirement: 'required' },
  room_participation_lease: { label: 'room participation lease', requirement: 'required' },
  fleet_maintenance: { label: 'fleet maintenance', requirement: 'required' },
  icp_shared_autonomy: { label: 'ICP shared autonomy', requirement: 'required' },
  icp_fatigue_reservations: { label: 'ICP fatigue reservations', requirement: 'required' },
  icp_initiation_policy: { label: 'ICP initiation policy', requirement: 'required' },
  gateway_audit: { label: 'gateway audit', requirement: 'required' },
  fleet_auth: { label: 'fleet authentication', requirement: 'required' },
  model_usage_accounting: {
    label: 'model usage accounting',
    requirement: 'required',
    failureDiagnostic: {
      component: 'ModelUsageStore',
      message: 'Model usage schema migration failed',
    },
  },
  runtime_health_stream: {
    label: 'runtime health stream',
    requirement: 'required',
    failureDiagnostic: {
      component: 'HealthEventStore',
      message: 'Runtime health-event stream schema migration failed',
    },
  },
  human_escalations: {
    label: 'human escalation ledger',
    requirement: 'required',
    failureDiagnostic: {
      component: 'HumanEscalationStore',
      message: 'Human escalation ledger schema migration failed',
    },
  },
  shared_wiki: { label: 'shared world wiki', requirement: 'required' },
  memory_ann_index: { label: 'memory ANN index', requirement: 'optional' },
  wiki_projection: { label: 'wiki projection', requirement: 'optional' },
  model_usage_diagnostics: {
    label: 'model usage diagnostics',
    requirement: 'optional',
    // 6c6cq: a persistently unreadable model-usage ledger leaves Garden's cost
    // and budget telemetry silently blank. The reader stays optional, but the
    // operator surface must say so instead of reporting an unqualified ok.
    degradesOperatorReadiness: true,
    failureDiagnostic: {
      component: 'ModelUsageStore',
      message: 'Model usage schema migration failed',
    },
  },
  analysis_workbench_trace: {
    label: 'analysis workbench trace',
    requirement: 'optional',
    failureDiagnostic: {
      component: 'AnalysisWorkbenchTraceStore',
      message: 'Analysis-workbench trace schema migration failed',
    },
  },
  observer_eval_sidecar: { label: 'observer eval sidecar', requirement: 'optional' },
  biographical_profile_garden: { label: 'biographical profile Garden', requirement: 'optional' },
  biographical_projection: { label: 'biographical profile projection', requirement: 'required' },
  icp_admin_projection: { label: 'ICP admin projection', requirement: 'optional' },
  speaking_arbiter_admin_projection: {
    label: 'speaking arbiter admin projection',
    requirement: 'optional',
  },
  welfare_grant_verifier: { label: 'welfare grant verifier', requirement: 'optional' },
  cogsec_receipts: {
    label: 'CogSec admission receipts',
    requirement: 'required',
    failureDiagnostic: {
      component: 'CogSecReceiptStore',
      message: 'CogSec admission receipt schema migration failed',
    },
  },
  gateway_cogsec_receipts: {
    label: 'gateway CogSec admission receipts',
    requirement: 'optional',
    failureDiagnostic: {
      component: 'GatewayCogSecReceiptStore',
      message: 'Gateway CogSec admission receipt schema migration failed',
    },
  },
  custody_snapshots: {
    label: 'CogSec turn custody snapshots',
    requirement: 'required',
    failureDiagnostic: {
      component: 'CustodySnapshotStore',
      message: 'CogSec custody snapshot schema migration failed',
    },
  },
  egress_delivery_records: {
    label: 'CogSec egress delivery records',
    requirement: 'required',
    failureDiagnostic: {
      component: 'EgressDeliveryRecordStore',
      message: 'CogSec egress delivery record schema migration failed',
    },
  },
} as const satisfies Record<string, PostgresStoreReadinessCatalogEntry>;

export type PostgresStoreReadinessId = keyof typeof POSTGRES_STORE_READINESS_CATALOG;
export type OptionalPostgresStoreReadinessId = {
  [Store in PostgresStoreReadinessId]:
    typeof POSTGRES_STORE_READINESS_CATALOG[Store]['requirement'] extends 'optional'
      ? Store
      : never;
}[PostgresStoreReadinessId];
export type PostgresRuntimeReadinessPhase = 'collecting' | 'settling' | 'ready' | 'failed';

export interface PostgresStoreDegradation {
  store: PostgresStoreReadinessId;
  label: string;
  requirement: PostgresStoreReadinessRequirement;
  /** Whether this degradation must be reflected on the operator health surface. */
  degradesOperatorReadiness: boolean;
  mismatch: string;
}

export interface PostgresRuntimeReadinessSnapshot {
  phase: PostgresRuntimeReadinessPhase;
  pending: PostgresStoreReadinessId[];
  readyStores: PostgresStoreReadinessId[];
  degraded: PostgresStoreDegradation[];
}

export interface PostgresStoreReadinessHandle {
  readonly store: PostgresStoreReadinessId;
  waitUntilReady(): Promise<void>;
}

export class PostgresStoreReadinessError extends Error {
  readonly store: PostgresStoreReadinessId;
  readonly requirement: PostgresStoreReadinessRequirement;
  readonly mismatch: string;

  constructor(
    store: PostgresStoreReadinessId,
    mismatch: string,
    options: ErrorOptions = {},
  ) {
    const classification = POSTGRES_STORE_READINESS_CATALOG[store];
    const prefix = classification.requirement === 'required' ? 'Required' : 'Optional';
    super(
      `${prefix} PostgreSQL store "${classification.label}" is not ready: ${mismatch}`,
      options,
    );
    this.name = 'PostgresStoreReadinessError';
    this.store = store;
    this.requirement = classification.requirement;
    this.mismatch = mismatch;
  }
}

interface MutableReadinessEntry {
  store: PostgresStoreReadinessId;
  state: 'pending' | 'ready' | 'degraded';
  error?: PostgresStoreReadinessError;
  observed: Promise<void>;
}

function rejectedHandle(
  store: PostgresStoreReadinessId,
  mismatch: string,
): { entry: MutableReadinessEntry; handle: PostgresStoreReadinessHandle } {
  const error = new PostgresStoreReadinessError(store, mismatch);
  const entry: MutableReadinessEntry = {
    store,
    state: 'degraded',
    error,
    observed: Promise.resolve(),
  };
  return {
    entry,
    handle: {
      store,
      waitUntilReady: async () => { throw error; },
    },
  };
}

/**
 * Bounded retry budget for one readiness task (psfn-framework-6c6cq). Owned by
 * settings.json, never by a code literal: see `requirePostgresStoreReadinessRetry`.
 */
export interface PostgresStoreReadinessRetryPolicy {
  /** Total attempts including the first, so 1 means "no retry". */
  maxAttempts: number;
  /** Fixed delay between attempts. */
  backoffMs: number;
}

export interface PostgresStoreReadinessOptions {
  /**
   * Absent (the default for every existing call site) the task runs exactly
   * once, which is the historical behavior.
   */
  retry?: PostgresStoreReadinessRetryPolicy;
}

/**
 * Resolve the operator-declared readiness retry budget. There is no built-in
 * budget: a runtime that wants bounded readiness retries must declare one, the
 * same way the health stream must declare its own row cap.
 */
export function requirePostgresStoreReadinessRetry(config: {
  postgresStoreReadinessRetryAttempts?: number;
  postgresStoreReadinessRetryBackoffMs?: number;
}): PostgresStoreReadinessRetryPolicy {
  const maxAttempts = config.postgresStoreReadinessRetryAttempts;
  const backoffMs = config.postgresStoreReadinessRetryBackoffMs;
  if (maxAttempts === undefined || backoffMs === undefined) {
    throw new Error(
      'Bounded PostgreSQL store readiness retry requires settings.json '
      + 'postgresStoreReadinessRetryAttempts and postgresStoreReadinessRetryBackoffMs',
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'settings.json postgresStoreReadinessRetryAttempts must be a positive integer',
    );
  }
  if (!Number.isFinite(backoffMs) || backoffMs < 0) {
    throw new Error(
      'settings.json postgresStoreReadinessRetryBackoffMs must be a non-negative number',
    );
  }
  return { maxAttempts, backoffMs };
}

function readinessLogger(store: PostgresStoreReadinessId): ReturnType<typeof createComponentLogger> {
  const classification: PostgresStoreReadinessCatalogEntry = (
    POSTGRES_STORE_READINESS_CATALOG[store]
  );
  return createComponentLogger(
    classification.failureDiagnostic?.component ?? 'PostgresRuntimeReadiness',
  );
}

function readinessMessage(store: PostgresStoreReadinessId): string {
  const classification: PostgresStoreReadinessCatalogEntry = (
    POSTGRES_STORE_READINESS_CATALOG[store]
  );
  return classification.failureDiagnostic?.message
    ?? `PostgreSQL store "${classification.label}" readiness failed`;
}

function reportPostgresStoreReadinessFailure(
  error: PostgresStoreReadinessError,
  attempts: number,
): void {
  const classification: PostgresStoreReadinessCatalogEntry = (
    POSTGRES_STORE_READINESS_CATALOG[error.store]
  );
  const diagnostic = classification.failureDiagnostic;
  if (!diagnostic) return;
  // The terminal line. It always says how many attempts were spent, so a
  // single-attempt failure and an exhausted retry budget are distinguishable
  // in the log rather than looking like the same one-off ERROR.
  // `attempt` and `maxRetries` are already diagnostic-safe context keys, so the
  // terminal line survives the redaction filter into the diagnostic ring.
  createComponentLogger(diagnostic.component).error(diagnostic.message, {
    attempt: attempts,
    error: error.mismatch,
  });
}

async function delayReadinessRetry(backoffMs: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, backoffMs); });
}

/**
 * Run one readiness task under its declared retry budget, logging every
 * outcome. A transient first-boot failure (the credential race in 6c6cq) now
 * produces a warn per spent attempt and an explicit recovery line, instead of
 * one buried ERROR and silence. The whole budget is spent before
 * `sealBeforeReady` resolves, so the process cannot advertise Ready in the
 * middle of it.
 */
async function runReadinessTask(
  store: PostgresStoreReadinessId,
  task: () => Promise<void>,
  retry: PostgresStoreReadinessRetryPolicy | undefined,
): Promise<void> {
  const maxAttempts = retry?.maxAttempts ?? 1;
  const log = readinessLogger(store);
  const message = readinessMessage(store);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await task();
      if (attempt > 1) {
        // Deliberately `warn`, not `info`: the diagnostic ring an operator
        // actually reads retains warn and error only, and an info line here
        // would be exactly as invisible as the silence this bead is about. A
        // readiness proof that only passed after burning part of its budget is
        // a notable boot condition, not routine progress.
        log.warn('PostgreSQL store readiness recovered after retry', {
          store,
          attempt,
        });
      }
      return;
    } catch (cause) {
      if (attempt >= maxAttempts) throw cause;
      log.warn(`${message}; retrying`, {
        store,
        attempt,
        maxRetries: maxAttempts,
        error: toErrorMessage(cause),
      });
      if (retry) await delayReadinessRetry(retry.backoffMs);
    }
  }
}

/**
 * Process-lifetime readiness ledger. Every started task is observed in the
 * same tick, so a constructor cannot create an unhandled migration promise.
 * Once sealed, `start` rejects without invoking its task; this is the runtime
 * DDL fence behind the advertised Ready boundary.
 */
export class PostgresRuntimeReadiness {
  private phase: PostgresRuntimeReadinessPhase = 'collecting';
  private readonly entries: MutableReadinessEntry[] = [];

  start(
    store: PostgresStoreReadinessId,
    task: () => Promise<void>,
    options: PostgresStoreReadinessOptions = {},
  ): PostgresStoreReadinessHandle {
    if (this.phase !== 'collecting') {
      const mismatch = this.phase === 'ready'
        ? 'runtime DDL/readiness work was registered after Ready'
        : `runtime DDL/readiness work was registered while readiness was ${this.phase}`;
      const rejected = rejectedHandle(store, mismatch);
      this.entries.push(rejected.entry);
      return rejected.handle;
    }

    const entry: MutableReadinessEntry = {
      store,
      state: 'pending',
      observed: Promise.resolve(),
    };
    // Started in this same tick, exactly as before: `runReadinessTask` invokes
    // the task synchronously inside the async function it returns from, so a
    // constructor still cannot create an unobserved migration promise.
    const attempts = options.retry?.maxAttempts ?? 1;
    const execution = runReadinessTask(store, task, options.retry);
    entry.observed = execution.then(
      () => { entry.state = 'ready'; },
      (cause: unknown) => {
        entry.state = 'degraded';
        entry.error = cause instanceof PostgresStoreReadinessError && cause.store === store
          ? cause
          : new PostgresStoreReadinessError(store, toErrorMessage(cause), { cause });
        reportPostgresStoreReadinessFailure(entry.error, attempts);
      },
    );
    this.entries.push(entry);

    return {
      store,
      waitUntilReady: async () => {
        await entry.observed;
        if (entry.error) throw entry.error;
      },
    };
  }

  async sealBeforeReady(): Promise<PostgresRuntimeReadinessSnapshot> {
    if (this.phase === 'ready') return this.snapshot();
    if (this.phase === 'failed') {
      throw this.firstRequiredFailure()
        ?? new Error('PostgreSQL runtime readiness previously failed');
    }
    if (this.phase === 'settling') {
      throw new Error('PostgreSQL runtime readiness is already settling');
    }

    this.phase = 'settling';
    await Promise.all(this.entries.map(entry => entry.observed));
    const requiredFailure = this.firstRequiredFailure();
    if (requiredFailure) {
      this.phase = 'failed';
      throw requiredFailure;
    }
    this.phase = 'ready';
    return this.snapshot();
  }

  assertStartupWorkAllowed(
    operation: string,
    authority?: PostgresRuntimeDdlAuthority,
  ): void {
    // A dynamically spawned shard is its own workload. Its dedicated schema
    // lifecycle runs before that shard starts handling work, even when the
    // parent agent process is already Ready.
    if (
      authority === 'isolated_workload_migration'
      || this.phase === 'collecting'
      || this.phase === 'settling'
    ) return;
    throw new Error(
      `PostgreSQL runtime DDL "${operation}" is forbidden while readiness is ${this.phase}`,
    );
  }

  snapshot(): PostgresRuntimeReadinessSnapshot {
    const pending: PostgresStoreReadinessId[] = [];
    const readyStores: PostgresStoreReadinessId[] = [];
    const degraded: PostgresStoreDegradation[] = [];
    for (const entry of this.entries) {
      if (entry.state === 'pending') {
        pending.push(entry.store);
      } else if (entry.state === 'ready') {
        readyStores.push(entry.store);
      } else if (entry.error) {
        const classification: PostgresStoreReadinessCatalogEntry = (
          POSTGRES_STORE_READINESS_CATALOG[entry.store]
        );
        degraded.push({
          store: entry.store,
          label: classification.label,
          requirement: classification.requirement,
          degradesOperatorReadiness: classification.degradesOperatorReadiness === true,
          mismatch: entry.error.mismatch,
        });
      }
    }
    return { phase: this.phase, pending, readyStores, degraded };
  }

  private firstRequiredFailure(): PostgresStoreReadinessError | undefined {
    return this.entries.find(entry => (
      entry.error?.requirement === 'required'
    ))?.error;
  }
}

export const runtimePostgresReadiness = new PostgresRuntimeReadiness();

export function startPostgresStoreReadiness(
  store: PostgresStoreReadinessId,
  task: () => Promise<void>,
  options: PostgresStoreReadinessOptions = {},
): PostgresStoreReadinessHandle {
  return runtimePostgresReadiness.start(store, task, options);
}

export async function awaitPostgresStoreReadiness<T>(
  store: PostgresStoreReadinessId,
  task: () => Promise<T>,
  options: PostgresStoreReadinessOptions = {},
): Promise<T> {
  let value: T | undefined;
  const handle = startPostgresStoreReadiness(store, async () => {
    value = await task();
  }, options);
  await handle.waitUntilReady();
  return value as T;
}

/**
 * Resolve an optional startup store without erasing its failure. The caller can
 * omit the unavailable feature, while the process ledger retains the named
 * degradation for health and telemetry.
 */
export async function awaitOptionalPostgresStoreReadiness<T>(
  store: OptionalPostgresStoreReadinessId,
  task: () => Promise<T>,
  options: PostgresStoreReadinessOptions = {},
): Promise<T | undefined> {
  let value: T | undefined;
  const handle = startPostgresStoreReadiness(store, async () => {
    value = await task();
  }, options);
  try {
    await handle.waitUntilReady();
    return value;
  } catch (error) {
    if (error instanceof PostgresStoreReadinessError && error.requirement === 'optional') {
      return undefined;
    }
    throw error;
  }
}

export async function sealPostgresStoreReadinessBeforeReady(): Promise<PostgresRuntimeReadinessSnapshot> {
  return await runtimePostgresReadiness.sealBeforeReady();
}

export function getPostgresStoreReadinessSnapshot(): PostgresRuntimeReadinessSnapshot {
  return runtimePostgresReadiness.snapshot();
}

export function assertPostgresRuntimeDdlAllowed(
  operation: string,
  authority?: PostgresRuntimeDdlAuthority,
): void {
  runtimePostgresReadiness.assertStartupWorkAllowed(operation, authority);
}
