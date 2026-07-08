import type { EventBus } from '../../../shared/event-bus.js';
import {
  buildRuntimeDiagnosticsSnapshot,
  wireRuntimeDiagnosticsEventCapture,
  type RuntimeDiagnosticsQuery,
  type RuntimeDiagnosticsSnapshot,
} from '../../../shared/diagnostics/runtime-diagnostics.js';
import type { AdminDiagnosticsService } from './types.js';

export interface AdminDiagnosticsDataServiceOptions {
  eventBus: EventBus;
  logsDir?: string;
  now?: () => number;
}

export class AdminDiagnosticsDataService implements AdminDiagnosticsService {
  private readonly logsDir?: string;
  private readonly now?: () => number;

  constructor(options: AdminDiagnosticsDataServiceOptions) {
    this.logsDir = options.logsDir;
    this.now = options.now;
    wireRuntimeDiagnosticsEventCapture(options.eventBus);
  }

  async getDiagnostics(query: RuntimeDiagnosticsQuery = {}): Promise<RuntimeDiagnosticsSnapshot> {
    return buildRuntimeDiagnosticsSnapshot({
      ...query,
      ...(!query.now && this.now ? { now: this.now } : {}),
      ...(!query.logsDir && this.logsDir ? { logsDir: this.logsDir } : {}),
    });
  }
}
