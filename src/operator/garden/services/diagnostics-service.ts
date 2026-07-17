import type { EventBus } from '../../../shared/event-bus.js';
import {
  buildRuntimeDiagnosticsSnapshot,
  wireRuntimeDiagnosticsEventCapture,
  type RuntimeDiagnosticsQuery,
  type RuntimeDiagnosticsSnapshot,
} from '../../../shared/diagnostics/runtime-diagnostics.js';
import type { AdminDiagnosticsService } from './types.js';
import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';

export interface AdminDiagnosticsDataServiceOptions {
  eventBus: EventBus;
  logsDir?: string;
  now?: () => number;
  contactLifecycle?: Pick<ContactStorePort, 'getContactLifecycleDiagnostics'> | null;
}

export class AdminDiagnosticsDataService implements AdminDiagnosticsService {
  private readonly logsDir?: string;
  private readonly now?: () => number;
  private readonly contactLifecycle?: Pick<ContactStorePort, 'getContactLifecycleDiagnostics'> | null;

  constructor(options: AdminDiagnosticsDataServiceOptions) {
    this.logsDir = options.logsDir;
    this.now = options.now;
    this.contactLifecycle = options.contactLifecycle;
    wireRuntimeDiagnosticsEventCapture(options.eventBus);
  }

  async getDiagnostics(query: RuntimeDiagnosticsQuery = {}): Promise<RuntimeDiagnosticsSnapshot> {
    const snapshot = buildRuntimeDiagnosticsSnapshot({
      ...query,
      ...(!query.now && this.now ? { now: this.now } : {}),
      ...(!query.logsDir && this.logsDir ? { logsDir: this.logsDir } : {}),
    });
    if (!this.contactLifecycle) return snapshot;
    try {
      const contactLifecycle = await this.contactLifecycle.getContactLifecycleDiagnostics(
        snapshot.window.limit,
      );
      snapshot.contactLifecycle = { status: 'available', ...contactLifecycle };
      const source = snapshot.sources.find(candidate => candidate.name === 'contact_lifecycle');
      if (source) {
        source.status = 'available';
        delete source.reason;
      }
    } catch {
      snapshot.contactLifecycle = {
        status: 'error',
        reason: 'contact lifecycle diagnostics unavailable',
      };
      const source = snapshot.sources.find(candidate => candidate.name === 'contact_lifecycle');
      if (source) {
        source.status = 'error';
        source.reason = 'contact lifecycle diagnostics unavailable';
      }
    }
    return snapshot;
  }
}
