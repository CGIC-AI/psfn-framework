import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  compileGardenRouteDeclarations,
} from '../../boundary/fleet-auth/garden-route-capabilities.js';
import type { FleetGardenAdmittedPrincipalRequest } from './fleet-garden-control-plane.js';
import type { FleetGardenDirectDatabasePort } from './fleet-garden-operator-router.js';
import {
  createFleetGardenDirectDatabaseServices,
  type FleetGardenDirectDatabaseServices,
} from './local-admin-contract.js';
import { buildAdminOverviewRoutes } from './routes/overview-routes.js';
import { dispatchAdminRoute, type AdminRoute } from './server-routes.js';
import type { AdminDashboardService } from './services/types.js';

const DIRECT_DATABASE_ROUTE_PATHS = Object.freeze([
  '/api/admin/model-usage',
  '/api/admin/model-usage/export',
  // Health is runtime-backed, not persistence-backed, and stays on the
  // selected companion agent so it reports that agent's live sidecar state.
  '/api/admin/evals/observer-sidecar/latest',
  '/api/admin/evals/observer-sidecar/observations',
  '/api/admin/evals/observer-sidecar/runs',
  '/api/admin/evals/observer-sidecar/export',
  '/api/admin/evals/observer-sidecar/lever-events',
]);

const UNREACHABLE_DASHBOARD: AdminDashboardService = {
  getDashboardData: () => {
    throw new Error('Fleet Garden direct database router cannot dispatch dashboard routes');
  },
};

export interface FleetGardenDirectDatabaseOptions {
  readonly config: SubstrateConfig;
  readonly companionIds: readonly CompanionId[];
  readonly createServices?: (
    config: SubstrateConfig,
    companionId: CompanionId,
  ) => FleetGardenDirectDatabaseServices;
}

/**
 * Request-scoped direct database dispatch retained by invariant 11.
 *
 * Each route table captures services constructed for exactly one companion.
 * The admitted immutable request target chooses that table, and
 * dispatchAdminRoute independently checks the same companion binding before a
 * handler can touch a store.
 */
export class FleetGardenDirectDatabase implements FleetGardenDirectDatabasePort {
  private readonly routesByCompanion = new Map<CompanionId, AdminRoute[]>();

  constructor(options: FleetGardenDirectDatabaseOptions) {
    const databaseUrl = options.config.postgresDatabaseUrl?.trim();
    if (!databaseUrl) {
      throw new Error('Fleet Garden direct database access requires POSTGRES_DATABASE_URL');
    }
    if (options.config.persistenceBackend !== 'postgres') {
      throw new Error('Fleet Garden direct database access requires the postgres persistence backend');
    }
    const createServices = options.createServices ?? ((config, companionId) =>
      createFleetGardenDirectDatabaseServices({ ...config, companionId }));
    for (const companionId of options.companionIds) {
      if (this.routesByCompanion.has(companionId)) {
        throw new Error(`Fleet Garden direct database companion is duplicated: ${companionId}`);
      }
      const services = createServices(options.config, companionId);
      const declarations = buildAdminOverviewRoutes({
        config: { ...options.config, companionId },
        dashboardService: UNREACHABLE_DASHBOARD,
        modelUsageService: services.modelUsage,
        observerEvalSidecarService: services.observerEvalSidecar,
        withBody: () => {
          throw new Error('Fleet Garden direct database routes do not accept request bodies');
        },
      }).filter(route => (
        DIRECT_DATABASE_ROUTE_PATHS.some(path => route.match(path) !== null)
      ));
      this.routesByCompanion.set(
        companionId,
        compileGardenRouteDeclarations(declarations) as AdminRoute[],
      );
    }
  }

  handleHttp(input: {
    readonly admission: FleetGardenAdmittedPrincipalRequest;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean {
    if (!DIRECT_DATABASE_ROUTE_PATHS.includes(input.admission.target.canonicalPath)) {
      return false;
    }
    const routes = this.routesByCompanion.get(input.admission.companionId);
    if (!routes) {
      throw new Error('Fleet Garden direct database request has no companion-bound services');
    }
    const originalTarget = input.req.url;
    input.req.url = input.admission.target.canonicalRequestTarget;
    try {
      return dispatchAdminRoute(
        routes,
        input.admission.target.method,
        input.admission.target.canonicalPath,
        input.req,
        input.res,
        input.admission.context,
        input.admission.companionId,
      );
    } finally {
      input.req.url = originalTarget;
    }
  }
}
