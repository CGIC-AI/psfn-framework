import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { GardenAdminDomainServices } from './admin-contract.js';

const { buildAdminApiRoutes } = vi.hoisted(() => ({
  buildAdminApiRoutes: vi.fn(() => []),
}));

vi.mock('./api-routes.js', () => ({ buildAdminApiRoutes }));

import { GardenAdminTransportServer } from './transport-server.js';

describe('GardenAdminTransportServer route service wiring', () => {
  it('supplies every residual Fleet Garden service to the agent route table', () => {
    const services = {
      auditHistory: { appendGardenEntry: vi.fn() },
      automata: { name: 'automata' },
      wishlist: { name: 'wishlist' },
      concerns: { name: 'concerns' },
      subjectAudit: { name: 'subject-audit' },
      settings: { name: 'settings' },
      intakeQuarantine: { name: 'intake-quarantine' },
      driftReviews: { name: 'drift-reviews' },
    } as unknown as GardenAdminDomainServices;

    new GardenAdminTransportServer({
      endpoint: {
        mode: 'socket',
        socketPath: '/tmp/psfn-transport-route-wiring.test.sock',
        timeoutMs: 1_000,
      },
      eventBus: new EventBus(),
      config: {} as SubstrateConfig,
      services,
    });

    expect(buildAdminApiRoutes).toHaveBeenCalledOnce();
    expect(buildAdminApiRoutes).toHaveBeenCalledWith(expect.objectContaining({
      automataService: services.automata,
      wishlistService: services.wishlist,
      concernService: services.concerns,
      subjectAuditService: services.subjectAudit,
      settingsService: services.settings,
      intakeQuarantineService: services.intakeQuarantine,
      driftReviewService: services.driftReviews,
    }));
  });
});
