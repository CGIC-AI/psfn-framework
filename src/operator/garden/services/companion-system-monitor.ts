import type { CompanionSystemMonitorEvidence, SocialOutreachHealthSummary } from '../../../shared/contracts/companion-system-monitor.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { AdminSubsystemHealthService } from './subsystem-health-service.js';

const log = createComponentLogger('CompanionSystemMonitor');

/** Extend the existing scoped health read; one failed durable read cannot hide the other lanes. */
export function withCompanionSystemMonitorEvidence(
  service: AdminSubsystemHealthService,
  options: {
    configuration(): Omit<CompanionSystemMonitorEvidence, 'proactive'>;
    readProactive?: () => Promise<SocialOutreachHealthSummary>;
  },
): AdminSubsystemHealthService {
  return {
    async getSnapshot() {
      const snapshot = await service.getSnapshot();
      const configuration = options.configuration();
      let proactive: CompanionSystemMonitorEvidence['proactive'] = { status: 'unavailable' };
      if (options.readProactive) {
        try {
          proactive = { status: 'available', summary: await options.readProactive() };
        } catch (error) {
          log.warn('Companion proactive health summary unavailable', { error });
          proactive = { status: 'error' };
        }
      }
      return { ...snapshot, monitor: { ...configuration, proactive } };
    },
  };
}
