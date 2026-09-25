import {
  FleetLifecycleError,
  type FleetLifecyclePlan,
  type FleetLifecycleProgress,
} from './contracts.js';
import type { FleetLifecycleRuntime } from './composition.js';
import { planFleetLifecycle } from './plan.js';
import { applyFleetLifecyclePlan } from './reconciler.js';

const FLEET_LIFECYCLE_SERVICE_PROTOCOL = Object.freeze({
  maxListedPlans: 50,
});

/**
 * `local`: this process may execute every stage. `cli_only`: the deployment's
 * workload adapter needs cluster reads this process is not granted (a
 * Kubernetes gateway), so plans and progress are served but apply refuses and
 * points at the CLI, which drives the same reconciler and plan store.
 */
export type FleetLifecycleApplyMode = 'local' | 'cli_only';

/** The one command surface shared by the CLI shape and the Fleet UI routes. */
export interface FleetLifecycleCommandPort {
  readonly applyMode: FleetLifecycleApplyMode;
  list(): Promise<readonly FleetLifecycleProgress[]>;
  progress(planId: string): Promise<FleetLifecycleProgress>;
  plan(input: { readonly request: unknown; readonly actor: string }): Promise<FleetLifecyclePlan>;
  apply(input: {
    readonly planId: string;
    readonly planDigest: string;
    readonly resume: boolean;
    readonly actor: string;
  }): Promise<FleetLifecycleProgress>;
}

function outcomeOf(error: unknown): string {
  return error instanceof FleetLifecycleError ? error.code : 'stage_error';
}

/**
 * Serializes lifecycle commands in this process and opens a fresh runtime per
 * command, so every plan and apply reads the current roster revision. Every
 * plan and apply attempt is audited with the authenticated actor.
 */
export function createFleetLifecycleService(input: {
  readonly openRuntime: () => FleetLifecycleRuntime;
  readonly applyMode: FleetLifecycleApplyMode;
}): FleetLifecycleCommandPort {
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(run: (runtime: FleetLifecycleRuntime) => Promise<T>): Promise<T> => {
    const next = tail.then(async () => {
      const runtime = input.openRuntime();
      try {
        return await run(runtime);
      } finally {
        await runtime.close();
      }
    });
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    applyMode: input.applyMode,
    list: async () => await serialize(async ({ store }) => (
      store.listPlanIds()
        .map(planId => store.progress(planId))
        .sort((left, right) => right.plan.createdAt.localeCompare(left.plan.createdAt))
        .slice(0, FLEET_LIFECYCLE_SERVICE_PROTOCOL.maxListedPlans)
    )),
    progress: async planId => await serialize(async ({ store }) => store.progress(planId)),
    plan: async ({ request, actor }) => await serialize(async ({ store, ports }) => {
      try {
        const plan = await planFleetLifecycle({ request, topology: ports.topology, icpFence: ports.icpFence });
        store.savePlan(plan);
        store.appendAudit({
          at: plan.createdAt, actor, action: 'plan', outcome: 'ok',
          planId: plan.planId, operation: plan.operation, companionId: plan.companionId,
        });
        return plan;
      } catch (error) {
        store.appendAudit({ at: new Date().toISOString(), actor, action: 'plan', outcome: outcomeOf(error) });
        throw error;
      }
    }),
    apply: async ({ planId, planDigest, resume, actor }) => await serialize(async ({ store, ports }) => {
      const audit = (outcome: string) => store.appendAudit({
        at: new Date().toISOString(), actor, action: 'apply', outcome, planId,
      });
      if (input.applyMode !== 'local') {
        audit('apply_requires_cli');
        throw new FleetLifecycleError(
          'apply_requires_cli',
          'This deployment applies lifecycle plans through the CLI (npm run ops:fleet-lifecycle)',
        );
      }
      try {
        const progress = await applyFleetLifecyclePlan({
          planId, approval: { planDigest }, resume, store, ports,
        });
        audit('ok');
        return progress;
      } catch (error) {
        audit(outcomeOf(error));
        throw error;
      }
    }),
  };
}
