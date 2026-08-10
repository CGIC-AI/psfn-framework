import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';

export type PostgresStoreReadinessRequirement = 'required' | 'optional';
export type PostgresRuntimeDdlAuthority = 'isolated_workload_migration';

interface PostgresStoreReadinessCatalogEntry {
  label: string;
  requirement: PostgresStoreReadinessRequirement;
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
  internal_state: { label: 'internal state', requirement: 'required' },
  participant_trend: { label: 'participant trend', requirement: 'required' },
  reflection: { label: 'reflection mirror', requirement: 'required' },
  scheduled_prompts: { label: 'scheduled prompts', requirement: 'required' },
  companion_availability: { label: 'companion availability', requirement: 'required' },
  introspection: { label: 'introspection landmarks', requirement: 'required' },
  background_work: { label: 'background work', requirement: 'required' },
  partner_affect_shadow: { label: 'partner affect shadow', requirement: 'required' },
  session_transcripts: { label: 'session transcripts', requirement: 'required' },
  companion_presence: { label: 'companion presence', requirement: 'required' },
  social_pot: { label: 'social pot', requirement: 'required' },
  speaking_arbiter: { label: 'speaking arbiter', requirement: 'required' },
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
  shared_wiki: { label: 'shared world wiki', requirement: 'required' },
  memory_ann_index: { label: 'memory ANN index', requirement: 'optional' },
  wiki_projection: { label: 'wiki projection', requirement: 'optional' },
  model_usage_diagnostics: {
    label: 'model usage diagnostics',
    requirement: 'optional',
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
  icp_admin_projection: { label: 'ICP admin projection', requirement: 'optional' },
  speaking_arbiter_admin_projection: {
    label: 'speaking arbiter admin projection',
    requirement: 'optional',
  },
  welfare_grant_verifier: { label: 'welfare grant verifier', requirement: 'optional' },
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

function reportPostgresStoreReadinessFailure(error: PostgresStoreReadinessError): void {
  const classification: PostgresStoreReadinessCatalogEntry = (
    POSTGRES_STORE_READINESS_CATALOG[error.store]
  );
  const diagnostic = classification.failureDiagnostic;
  if (!diagnostic) return;
  createComponentLogger(diagnostic.component).error(diagnostic.message, {
    error: error.mismatch,
  });
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
    let execution: Promise<void>;
    try {
      execution = task();
    } catch (cause) {
      execution = Promise.reject(cause);
    }
    entry.observed = execution.then(
      () => { entry.state = 'ready'; },
      (cause: unknown) => {
        entry.state = 'degraded';
        entry.error = cause instanceof PostgresStoreReadinessError && cause.store === store
          ? cause
          : new PostgresStoreReadinessError(store, toErrorMessage(cause), { cause });
        reportPostgresStoreReadinessFailure(entry.error);
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
        const classification = POSTGRES_STORE_READINESS_CATALOG[entry.store];
        degraded.push({
          store: entry.store,
          label: classification.label,
          requirement: classification.requirement,
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
): PostgresStoreReadinessHandle {
  return runtimePostgresReadiness.start(store, task);
}

export async function awaitPostgresStoreReadiness<T>(
  store: PostgresStoreReadinessId,
  task: () => Promise<T>,
): Promise<T> {
  let value: T | undefined;
  const handle = startPostgresStoreReadiness(store, async () => {
    value = await task();
  });
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
): Promise<T | undefined> {
  let value: T | undefined;
  const handle = startPostgresStoreReadiness(store, async () => {
    value = await task();
  });
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
