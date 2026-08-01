import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  compileGardenRouteDeclarations,
} from '../../boundary/fleet-auth/garden-route-capabilities.js';
import {
  createIntakeQuarantineReadStore,
} from '../../core/cogsec/intake/quarantine-store.js';
import { resolveIntakeQuarantinePath } from '../../persistence/layout.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { createOwnerFileConfigStore } from '../../system/config/config-store.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { FleetGardenAdmittedPrincipalRequest } from './fleet-garden-control-plane.js';
import type { FleetGardenIntakeQuarantineReadPort } from './fleet-garden-operator-router.js';
import {
  ADMIN_INTAKE_QUARANTINE_API_PATH,
  buildAdminIntakeQuarantineReadRoutes,
} from './routes/intake-quarantine-routes.js';
import type { AuthorizedAdminApiRoute } from './routes/types.js';
import { dispatchAdminRoute } from './server-routes.js';
import {
  createAdminIntakeQuarantineReadService,
  type AdminIntakeQuarantineReadService,
} from './services/intake-quarantine-service.js';

export interface FleetGardenIntakeQuarantineReadsOptions {
  readonly config: SubstrateConfig;
  readonly createReadService?: (
    config: SubstrateConfig,
    companionId: CompanionId,
    companionDataDir: string,
  ) => AdminIntakeQuarantineReadService;
}

/**
 * Garden-local, companion-bound quarantine read plane.
 *
 * Queue and detail GETs read the atomically replaced quarantine snapshot from
 * the selected companion's mounted data root. Confirm/decide mutations are
 * deliberately absent and continue through the authenticated agent transport.
 */
export class FleetGardenIntakeQuarantineReads
implements FleetGardenIntakeQuarantineReadPort {
  private readonly routesByCompanion = new Map<CompanionId, () => AuthorizedAdminApiRoute[]>();

  constructor(options: FleetGardenIntakeQuarantineReadsOptions) {
    const fleet = options.config.companionFleet;
    if (!fleet) {
      throw new Error('Fleet Garden quarantine reads require the complete companions registry');
    }
    const createReadService = options.createReadService ?? createDefaultReadService;
    for (const companion of fleet.companions) {
      if (this.routesByCompanion.has(companion.companionId)) {
        throw new Error(
          `Fleet Garden quarantine read companion is duplicated: ${companion.companionId}`,
        );
      }
      let routes: AuthorizedAdminApiRoute[] | undefined;
      this.routesByCompanion.set(companion.companionId, () => {
        routes ??= compileGardenRouteDeclarations(buildAdminIntakeQuarantineReadRoutes({
          quarantineService: createReadService(
            options.config,
            companion.companionId,
            companion.companionDataDir,
          ),
        }));
        return routes;
      });
    }
  }

  handleHttp(input: {
    readonly admission: FleetGardenAdmittedPrincipalRequest;
    readonly req: IncomingMessage;
    readonly res: ServerResponse;
  }): boolean {
    const { target } = input.admission;
    if (target.method !== 'GET'
      || (target.canonicalPath !== ADMIN_INTAKE_QUARANTINE_API_PATH
        && !target.canonicalPath.startsWith(`${ADMIN_INTAKE_QUARANTINE_API_PATH}/`))) {
      return false;
    }
    const getRoutes = this.routesByCompanion.get(input.admission.companionId);
    if (!getRoutes) {
      throw new Error('Fleet Garden quarantine read has no companion-bound service');
    }
    const originalTarget = input.req.url;
    input.req.url = target.canonicalRequestTarget;
    try {
      return dispatchAdminRoute(
        getRoutes(),
        target.method,
        target.canonicalPath,
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

function createDefaultReadService(
  config: SubstrateConfig,
  _companionId: CompanionId,
  companionDataDir: string,
): AdminIntakeQuarantineReadService {
  let service: AdminIntakeQuarantineReadService | undefined;
  const getService = (): AdminIntakeQuarantineReadService => {
    if (service) return service;
    const intakePolicy = createOwnerFileConfigStore({
      dataDir: config.dataDir,
      companionDataDir,
      defaultContextWindow: config.defaultContextWindow,
    }).loadIntakePolicy();
    const store = createIntakeQuarantineReadStore(
      resolveIntakeQuarantinePath(companionDataDir),
      {
        itemTtlHours: intakePolicy.quarantine.itemTtlHours,
        maxHeldItems: intakePolicy.quarantine.maxHeldItems,
      },
    );
    service = createAdminIntakeQuarantineReadService({ store });
    return service;
  };
  return {
    listItems: context => getService().listItems(context),
    getItem: (id, context) => getService().getItem(id, context),
  };
}
