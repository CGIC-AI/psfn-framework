import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { IntrospectionAuditConfig } from '../../system/config/scheduler-config.js';
import type { IntrospectionAuditRuntime } from './runtime.js';

export const INTROSPECTION_AUDIT_TASK_ID = 'introspection.blinded_audit';

export function registerIntrospectionAuditTask(options: {
  scheduler: Scheduler;
  runtime: Pick<IntrospectionAuditRuntime, 'runOnce'>;
  valuesConsistencyRuntime?: { runOnce(): Promise<unknown> };
  config: IntrospectionAuditConfig;
  skipFirstRun?: boolean;
}): void {
  if (!options.config.enabled || options.scheduler.getTask(INTROSPECTION_AUDIT_TASK_ID)) return;
  options.scheduler.register({
    id: INTROSPECTION_AUDIT_TASK_ID,
    name: 'Private Blinded Introspection Audit',
    type: 'every',
    intervalMs: options.config.intervalMs,
    handler: async () => {
      await options.runtime.runOnce();
      await options.valuesConsistencyRuntime?.runOnce();
    },
    eligibility: { requiredTokens: ['memory.write'] },
    state: 'idle',
  }, { skipFirstRun: options.skipFirstRun ?? true });
}
