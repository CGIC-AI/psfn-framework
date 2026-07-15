import { createComponentLogger } from '../../shared/logger.js';
import type {
  EligibilityGate,
  EligibilityRequirements,
} from '../../system/capabilities/eligibility.js';
import type { Scheduler } from './scheduler.js';
import type { ScheduledTaskOperation } from './types.js';

const log = createComponentLogger('BackgroundMaintenance');

export const BACKGROUND_MAINTENANCE_TASK_ID = 'background-maintenance';
export const BACKGROUND_MAINTENANCE_TASK_NAME = 'Bundled Background Maintenance';
export const BACKGROUND_MAINTENANCE_SCHEDULE_SOURCE =
  'scheduler.json > backgroundMaintenance.intervalMs';

interface BackgroundMaintenanceOperation extends ScheduledTaskOperation {
  eligibility?: EligibilityRequirements;
  handler: () => void | Promise<void>;
}

export interface BackgroundMaintenanceOperationInput {
  id: string;
  name: string;
  description: string;
  eligibility?: EligibilityRequirements;
  handler: () => void | Promise<void>;
}

export interface BackgroundMaintenanceRegistrar {
  registerOperation(operation: BackgroundMaintenanceOperationInput): void;
}

export interface BackgroundMaintenanceRegistryOptions {
  scheduler: Scheduler;
  eligibilityGate: EligibilityGate;
  intervalMs: number;
}

/**
 * Owns the single scheduler task used by cheap background housekeeping.
 * Eligibility and failures remain operation-local so one narrow capability or
 * broken lane cannot prevent unrelated maintenance from running.
 */
export class BackgroundMaintenanceRegistry implements BackgroundMaintenanceRegistrar {
  private readonly operations: BackgroundMaintenanceOperation[] = [];
  private readonly operationManifest: ScheduledTaskOperation[] = [];

  constructor(private readonly options: BackgroundMaintenanceRegistryOptions) {
    options.scheduler.register({
      id: BACKGROUND_MAINTENANCE_TASK_ID,
      name: BACKGROUND_MAINTENANCE_TASK_NAME,
      description:
        'Runs the listed housekeeping operations sequentially on one shared cadence; '
        + 'each operation keeps its own eligibility gate and failure boundary.',
      scheduleSource: BACKGROUND_MAINTENANCE_SCHEDULE_SOURCE,
      operations: this.operationManifest,
      type: 'every',
      intervalMs: options.intervalMs,
      handler: () => this.run(),
      state: 'idle',
    }, { skipFirstRun: true });
  }

  registerOperation(operation: BackgroundMaintenanceOperationInput): void {
    if (this.operations.some(existing => existing.id === operation.id)) {
      throw new Error(
        `Background-maintenance operation "${operation.id}" is already registered`,
      );
    }
    const registered: BackgroundMaintenanceOperation = {
      ...operation,
      ...(operation.eligibility ? { eligibility: operation.eligibility } : {}),
    };
    this.operations.push(registered);
    this.operationManifest.push({
      id: operation.id,
      name: operation.name,
      description: operation.description,
    });
  }

  private async run(): Promise<void> {
    const snapshot = [...this.operations];
    const failures: Error[] = [];

    for (const operation of snapshot) {
      const eligibility = this.options.eligibilityGate.evaluate({
        kind: 'scheduler.task',
        taskId: operation.id,
        taskName: operation.name,
        taskType: 'every',
      }, operation.eligibility);
      if (!eligibility.allowed) {
        log.debug('Background-maintenance operation skipped', {
          operationId: operation.id,
          reason: eligibility.reasonCode,
          missingTokens: eligibility.missingTokens,
        });
        continue;
      }

      try {
        await operation.handler();
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        failures.push(normalized);
        log.error('Background-maintenance operation failed', {
          operationId: operation.id,
          error: normalized.message,
        });
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} of ${snapshot.length} background-maintenance operations failed`,
      );
    }
  }
}
