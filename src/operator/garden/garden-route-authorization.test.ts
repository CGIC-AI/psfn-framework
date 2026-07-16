import { describe, expect, it } from 'vitest';
import { GARDEN_ROUTE_CAPABILITIES } from '../../boundary/fleet-auth/garden-route-capabilities.js';
import { buildAdminApiRoutes } from './api-routes.js';
import { ADMIN_TELEMETRY_ROUTE_CAPABILITY } from './server-telemetry-transport.js';

describe('constructed Garden route authorization', () => {
  it('compiles every active API declaration, including contact routes, from the canonical catalogue', () => {
    const service = {} as never;
    const routes = buildAdminApiRoutes({
      config: service,
      dashboardService: service,
      diagnosticsService: service,
      imagesService: service,
      auditHistoryService: service,
      chargeLedgerService: service,
      chargeCostReconciliationService: service,
      modelUsageService: service,
      observerEvalSidecarService: service,
      actionPipeService: service,
      shardFoldReviewService: service,
      adaptiveToolsService: service,
      wikiService: service,
      episodicMemoryService: service,
      groupMemoryService: service,
      memoryService: service,
      sessionService: service,
      contactsService: service,
      pendingContactsService: service,
      roomsService: service,
      placesService: service,
      enrollmentService: service,
      graphProposalsService: service,
      concernService: service,
      subsystemHealthService: service,
      toolConformanceService: service,
      icpAutonomyService: service,
      settingsService: service,
      sharedWorkspaceService: service,
      intakeQuarantineService: service,
      driftReviewService: service,
      identityService: service,
      promptsService: service,
      modelDiscovery: service,
      chatBootstrapService: service,
      scheduler: service,
      skillsRuntime: service,
      confirmationQueueApi: service,
      valuesJournal: service,
      reflectionMetacognitionJournal: service,
      reflectionDailyJournal: service,
      reflectionJournal: service,
      withBody: () => undefined,
    });
    const activeIds = routes.map(({ capability }) => capability.id).sort();
    const catalogueApiIds = GARDEN_ROUTE_CAPABILITIES
      .filter(({ id, method, pattern }) => (
        (pattern.startsWith('/api/admin/') || pattern.startsWith('/api/settings/'))
        && id !== 'POST /api/admin/logout'
        && method !== 'WS'
      ))
      .map(({ id }) => id)
      .sort();

    expect(activeIds).toEqual(catalogueApiIds);
    expect(activeIds).toContain('GET /api/admin/contacts');
    expect(activeIds).toContain('PATCH /api/admin/contacts/:id');
    expect(activeIds).toContain('POST /api/admin/contacts/:id/merge');
    expect(routes.every((route) => route.capability.authorization.action.length > 0)).toBe(true);
  });

  it('constructs WebSocket telemetry with the admin-only canonical classification', () => {
    expect(ADMIN_TELEMETRY_ROUTE_CAPABILITY.id).toBe('WS /api/admin/events');
    expect(ADMIN_TELEMETRY_ROUTE_CAPABILITY.authorization).toMatchObject({
      action: 'telemetry.read',
      baseRole: 'admin',
      publicAccess: 'never',
      recoveryAccess: 'forbidden',
    });
  });
});
